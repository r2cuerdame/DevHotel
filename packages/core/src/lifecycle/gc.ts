import type { HostFootprint, HostGcBounds, HostGcPlan, HostGcRefusal, HostGcResult, HotelArtifact } from '@devhotel/shared'

/**
 * Garbage collection that has to show its work.
 *
 * The acceptance condition for #109 is stated as a prohibition — GC cannot
 * remove anything without proving ownership and reachability — so the code is
 * shaped as one. There is no path from a footprint to a removal that does not
 * go through `planHostGc`, the plan carries a refusal line for every artifact
 * it declined and the proof that was missing, and the executor re-checks the
 * same gate against freshly observed state immediately before each removal,
 * because a plan is a statement about the moment it was made.
 *
 * The bounds are not a safety valve, they are part of the proof. "This is
 * unreachable" is a claim; "and removing it reclaims exactly these bytes" is
 * what makes the claim actionable, and an artifact whose size nobody could
 * establish fails the gate for that reason alone.
 */

/** Re-checks one artifact under a lock and removes it. Returns bytes reclaimed. */
export interface HostGcExecutor {
  /**
   * Must re-observe, re-prove and only then remove. Throwing is the correct
   * response to anything that changed since the plan was made; the pass records
   * the error and moves on rather than forcing the removal through.
   */
  collect(artifact: HotelArtifact, remainingBytes: number): Promise<number>
}

/**
 * Chooses what may be collected, in a stable order, within the bounds.
 *
 * An incomplete footprint refuses to plan at all rather than planning
 * cautiously. Caution would still be a guess: unreachability is a claim about
 * everything that could reach a thing, and a list that is missing entries
 * cannot support it no matter how conservatively it is read.
 */
export function planHostGc(footprint: HostFootprint, bounds: HostGcBounds): HostGcPlan {
  const refused: HostGcRefusal[] = []

  if (!footprint.complete) {
    return {
      collect: [],
      refused: footprint.artifacts.map((artifact) => ({
        artifactId: artifact.id,
        reason: 'The Host footprint is incomplete, so nothing in it can be proved unreachable.'
      })),
      plannedBytes: 0,
      authorized: false,
      authorizationDetail: `Host footprint is incomplete: ${footprint.incompleteReasons.join('; ')}`
    }
  }

  if (
    !Number.isSafeInteger(bounds.maxArtifacts) ||
    bounds.maxArtifacts <= 0 ||
    bounds.maxArtifacts > 500 ||
    !Number.isSafeInteger(bounds.maxBytes) ||
    bounds.maxBytes <= 0
  ) {
    return {
      collect: [],
      refused: [],
      plannedBytes: 0,
      authorized: false,
      authorizationDetail: 'Host GC requires explicit, finite bounds on both artifacts and bytes.'
    }
  }

  // Smallest first. A single huge disk would otherwise consume the byte budget
  // and starve every other reclaim in the pass, and the point of a bounded pass
  // is to make progress on many things, not maximum bytes on one.
  const candidates = [...footprint.artifacts].sort((a, b) =>
    a.sizeBytes !== b.sizeBytes ? a.sizeBytes - b.sizeBytes : a.id < b.id ? -1 : 1
  )

  const collect: HotelArtifact[] = []
  let plannedBytes = 0

  for (const artifact of candidates) {
    if (!artifact.collectable) {
      refused.push({ artifactId: artifact.id, reason: artifact.reason })
      continue
    }
    // Re-derived rather than trusted, so a footprint built by some future caller
    // cannot smuggle a `collectable: true` past the gate it is supposed to name.
    if (!artifact.ownership.proved) {
      refused.push({ artifactId: artifact.id, reason: 'Ownership is not proved.' })
      continue
    }
    if (!artifact.reachability.known || artifact.reachability.reachable) {
      refused.push({ artifactId: artifact.id, reason: 'Unreachability is not proved.' })
      continue
    }
    if (!artifact.sizeKnown) {
      refused.push({ artifactId: artifact.id, reason: 'Size is unknown, so the pass cannot stay bounded.' })
      continue
    }
    if (collect.length >= bounds.maxArtifacts) {
      refused.push({ artifactId: artifact.id, reason: 'This pass reached its artifact bound.' })
      continue
    }
    if (plannedBytes + artifact.sizeBytes > bounds.maxBytes) {
      refused.push({ artifactId: artifact.id, reason: 'This pass reached its byte bound.' })
      continue
    }
    collect.push(artifact)
    plannedBytes += artifact.sizeBytes
  }

  return {
    collect,
    refused,
    plannedBytes,
    authorized: true,
    authorizationDetail: `Host footprint is complete: ${footprint.totals.artifactCount} artifact(s) accounted for.`
  }
}

export interface HostGcOptions extends Partial<HostGcBounds> {
  /** Defaults to true. A real pass must opt in, and must bring bounds with it. */
  dryRun?: boolean
}

/**
 * Runs a pass. Dry by default, and dry unconditionally when unauthorized.
 *
 * `dryRun: false` without an executor is a programming error rather than a
 * degraded mode — a caller that asked for real removals and got silent
 * no-op removals would report reclaimed space that never came back.
 */
export async function executeHostGc(
  footprint: HostFootprint,
  opts: HostGcOptions = {},
  executor?: HostGcExecutor
): Promise<HostGcResult> {
  const dryRun = opts.dryRun !== false
  const bounds: HostGcBounds = {
    maxArtifacts: opts.maxArtifacts ?? 50,
    maxBytes: opts.maxBytes ?? Number.MAX_SAFE_INTEGER
  }
  const plan = planHostGc(footprint, bounds)

  if (dryRun || !plan.authorized) {
    return { dryRun: true, plan, collectedIds: [], reclaimedBytes: 0, errors: [] }
  }
  if (opts.maxArtifacts === undefined || opts.maxBytes === undefined) {
    throw new Error('A real Host GC pass requires explicit maxArtifacts and maxBytes bounds')
  }
  if (!executor) throw new Error('A real Host GC pass requires a re-proving removal executor')

  const collectedIds: string[] = []
  const errors: string[] = []
  let reclaimedBytes = 0

  for (const artifact of plan.collect) {
    try {
      const reclaimed = await executor.collect(artifact, bounds.maxBytes - reclaimedBytes)
      collectedIds.push(artifact.id)
      reclaimedBytes += reclaimed
    } catch (error) {
      errors.push(`Could not collect ${artifact.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return { dryRun: false, plan, collectedIds, reclaimedBytes, errors }
}
