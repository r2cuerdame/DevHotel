import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import type { RoomRecord } from '@devhotel/shared'
import { buildHostFootprint } from '../src/lifecycle/footprint'
import { planHostGc } from '../src/lifecycle/gc'
import { emptyObservation, type LifecycleObservation } from '../src/lifecycle/observations'
import { isSharedCacheVolumeName, provesSharedCacheOwnership, sharedCachePurpose } from '../src/lifecycle/sharedCache'
import { parseVolumeNameAndLabels, reconcileVolumesState } from '../src/volumeGc'
import type { DockerVolumeUsage } from '../src/backend/types'

/**
 * Reads this Host's real owned artifacts and prints the footprint and the GC
 * plan it produces. Read-only: it observes, plans, and removes nothing.
 *
 * Opt-in, because it needs a live engine and it is a diagnostic rather than a
 * test of behaviour:
 *
 *   DEVHOTEL_FOOTPRINT_REPORT=1 pnpm --filter @devhotel/core report:host-footprint
 *
 * Rooms are taken from `DEVHOTEL_FOOTPRINT_ROOMS`, a comma-separated list of
 * `<roomId>:<status>` pairs, so the report can be run against the Room table the
 * live app is showing without this script reaching into the app's database.
 * Rooms it is not told about are unknown rather than absent, and the footprint
 * fails closed on them — which is itself worth seeing.
 */

const ENABLED = process.env['DEVHOTEL_FOOTPRINT_REPORT'] === '1'

function docker(args: string[]): string {
  const result = spawnSync('docker', args, { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr?.slice(0, 300)}`)
  return result.stdout
}

function jsonLines(raw: string): Record<string, unknown>[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function labelsOf(raw: unknown): Record<string, string> {
  if (typeof raw !== 'string' || raw.length === 0) return {}
  const labels: Record<string, string> = {}
  for (const pair of raw.split(',')) {
    const index = pair.indexOf('=')
    if (index > 0) labels[pair.slice(0, index)] = pair.slice(index + 1)
  }
  return labels
}

function rooms(): RoomRecord[] {
  const raw = process.env['DEVHOTEL_FOOTPRINT_ROOMS'] ?? ''
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [id, status] = entry.split(':')
      return { id, status: status ?? 'sleeping', provider: 'web', workspaceVolumeRevision: 0, runtime: { kind: 'node', version: '22' } } as RoomRecord
    })
}

describe.skipIf(!ENABLED)('Host footprint report', () => {
  it('enumerates this Host’s owned artifacts and refuses what it cannot prove', () => {
    const volumeUsage: DockerVolumeUsage[] = jsonLines(docker(['volume', 'ls', '--format', '{{json .}}'])).map((entry) => {
      const name = String(entry['Name'])
      const labels = labelsOf(entry['Labels'])
      const parsed = parseVolumeNameAndLabels(name, labels)
      const managed =
        labels['devhotel.managed'] === '1' && labels['devhotel.role'] === 'volume' && Boolean(parsed.roomId)
      return {
        name,
        driver: String(entry['Driver'] ?? 'local'),
        scope: String(entry['Scope'] ?? 'local'),
        mountpoint: String(entry['Mountpoint'] ?? ''),
        // `docker volume ls` does not compute sizes. Reporting that honestly is
        // the point: an unknown size is what blocks a bounded collection.
        sizeBytes: 0,
        sizeKnown: false,
        ownership: managed ? 'managed-labels' : 'unowned',
        links: 0,
        linksKnown: false,
        labels
      }
    })

    const known = rooms()
    const classified = reconcileVolumesState({
      volumes: volumeUsage,
      rooms: known,
      settings: { get: () => null },
      activeOperations: [],
      changes: { list: () => [] }
    })

    const sharedCaches = volumeUsage.filter((entry) => isSharedCacheVolumeName(entry.name)).map((entry) => ({
      name: entry.name,
      purpose: sharedCachePurpose(entry.name) ?? 'unknown',
      sizeBytes: entry.sizeBytes,
      sizeKnown: entry.sizeKnown,
      ownershipProved: provesSharedCacheOwnership(entry.name, entry.labels),
      attachments: entry.linksKnown ? entry.links : null
    }))
    const sharedNames = new Set(sharedCaches.map((cache) => cache.name))

    const observation: LifecycleObservation = {
      ...emptyObservation(new Date().toISOString(), 'compatibility'),
      containers: jsonLines(
        docker(['ps', '-a', '--filter', 'label=devhotel.managed=1', '--format', '{{json .}}'])
      ).map((entry) => {
        const labels = labelsOf(entry['Labels'])
        return {
          name: String(entry['Names']),
          roomId: labels['devhotel.room'] ?? null,
          role: labels['devhotel.role'] ?? 'unknown',
          state: String(entry['State'] ?? 'unknown')
        }
      }),
      networks: jsonLines(
        docker(['network', 'ls', '--filter', 'label=devhotel.managed=1', '--format', '{{json .}}'])
      ).map((entry) => {
        const labels = labelsOf(entry['Labels'])
        return { name: String(entry['Name']), roomId: labels['devhotel.room'] ?? null }
      }),
      volumes: classified.volumes.filter((volume) => !sharedNames.has(volume.name)),
      sharedCaches
    }

    const footprint = buildHostFootprint(observation, { rooms: known })
    const plan = planHostGc(footprint, { maxArtifacts: 100, maxBytes: 100 * 1024 * 1024 * 1024 })

    const lines = [
      `runtime mode        ${footprint.runtimeMode}`,
      `observed at         ${footprint.observedAt}`,
      `complete            ${footprint.complete}`,
      `artifacts           ${footprint.totals.artifactCount}`,
      `  owned             ${footprint.totals.ownedCount}`,
      `  undetermined      ${footprint.totals.undeterminedCount}`,
      `  collectable       ${footprint.totals.collectableCount}`,
      ...Object.entries(footprint.byKind).map(([kind, totals]) => `  ${kind.padEnd(16)}${totals.artifactCount}`),
      `rooms               ${footprint.rooms.length} (${footprint.rooms.filter((room) => room.exists).length} with a record)`,
      `gc authorized       ${plan.authorized}`,
      `gc would collect    ${plan.collect.length}`,
      `gc refused          ${plan.refused.length}`
    ]
    console.log(`\n${lines.join('\n')}\n`)
    console.log(
      plan.refused
        .slice(0, 12)
        .map((refusal) => `  refused ${refusal.artifactId}\n          ${refusal.reason}`)
        .join('\n')
    )

    // The invariants this report exists to demonstrate on real data.
    expect(footprint.artifacts).toHaveLength(
      observation.containers.length + observation.networks.length + observation.volumes.length + sharedCaches.length
    )
    expect(new Set(footprint.artifacts.map((artifact) => artifact.id)).size).toBe(footprint.artifacts.length)
    for (const artifact of plan.collect) {
      expect(artifact.ownership.proved).toBe(true)
      expect(artifact.reachability.known).toBe(true)
      expect(artifact.reachability.reachable).toBe(false)
      expect(artifact.sizeKnown).toBe(true)
    }
  })
})
