import type { HostFootprint, LifecycleQuotas, QuotaBreach, QuotaVerdict } from '@devhotel/shared'

/**
 * Limits DevHotel places on itself, and refuses to enforce by deleting.
 *
 * A quota answers one question: may this Host take on one more of something?
 * It never answers "what should be removed", and it is deliberately given no
 * way to. Quotas know how much is being used; they do not know what any of it
 * is for, and a limit that starts deleting to stay under itself would be doing
 * exactly what this issue exists to make impossible — reclaiming without proof.
 *
 * So a breach blocks a creation and names the limit, the allowance and the
 * observed value. What to free is then a decision someone makes with the
 * footprint in front of them, and freeing it still goes through GC's proofs.
 */

/**
 * Deliberately generous. These exist to catch a runaway — a clone loop, a Room
 * that keeps staging generations it never publishes — long before a Host runs
 * out of disk, not to ration ordinary use. A developer who genuinely wants a
 * 200GB monorepo Room should not meet a limit DevHotel invented for them.
 */
export const DEFAULT_LIFECYCLE_QUOTAS: LifecycleQuotas = {
  maxRoomBytes: 256 * 1024 * 1024 * 1024,
  maxRoomArtifacts: 64,
  maxRoomWorkspaceGenerations: 8,
  maxHotelBytes: 2 * 1024 * 1024 * 1024 * 1024,
  maxHotelArtifacts: 1024,
  maxIngressRoutes: 64
}

export interface QuotaRequest {
  /** The Room the new thing would belong to, when it belongs to one. */
  roomId?: string | null
  /** Additional durable bytes the creation is expected to cost, if known. */
  bytes?: number
  /** Additional owned artifacts the creation would add. */
  artifacts?: number
  /** True when the creation publishes one more workspace generation. */
  workspaceGeneration?: boolean
  /** True when the creation opens one more Host ingress port. */
  ingressRoute?: boolean
}

function breach(
  limit: QuotaBreach['limit'],
  scope: QuotaBreach['scope'],
  roomId: string | null,
  allowed: number,
  observed: number,
  detail: string
): QuotaBreach {
  return { limit, scope, roomId, allowed, observed, detail }
}

/**
 * Evaluates the footprint, plus whatever the caller is about to add, against
 * the quotas.
 *
 * `conclusive` matters more than `ok`. An incomplete footprint can only
 * *understate* what a Host is holding, so a clean verdict computed from one is
 * not evidence of headroom — it is evidence that the question could not be
 * answered. Callers that must not over-commit should require both.
 */
export function evaluateQuotas(
  footprint: HostFootprint,
  quotas: LifecycleQuotas = DEFAULT_LIFECYCLE_QUOTAS,
  request: QuotaRequest = {}
): QuotaVerdict {
  const breaches: QuotaBreach[] = []
  const addedBytes = Math.max(0, request.bytes ?? 0)
  const addedArtifacts = Math.max(0, request.artifacts ?? 0)

  const hotelBytes = footprint.totals.bytes + addedBytes
  if (hotelBytes > quotas.maxHotelBytes) {
    breaches.push(
      breach(
        'maxHotelBytes',
        'hotel',
        null,
        quotas.maxHotelBytes,
        hotelBytes,
        `The Hotel would hold ${hotelBytes} bytes, over its ${quotas.maxHotelBytes} byte limit.`
      )
    )
  }

  const hotelArtifacts = footprint.totals.ownedCount + addedArtifacts
  if (hotelArtifacts > quotas.maxHotelArtifacts) {
    breaches.push(
      breach(
        'maxHotelArtifacts',
        'hotel',
        null,
        quotas.maxHotelArtifacts,
        hotelArtifacts,
        `The Hotel would own ${hotelArtifacts} artifacts, over its ${quotas.maxHotelArtifacts} artifact limit.`
      )
    )
  }

  const ingress = footprint.byKind['ingress-route'].artifactCount + (request.ingressRoute ? 1 : 0)
  if (ingress > quotas.maxIngressRoutes) {
    breaches.push(
      breach(
        'maxIngressRoutes',
        'hotel',
        null,
        quotas.maxIngressRoutes,
        ingress,
        `The Host would publish ${ingress} Room ingress ports, over its ${quotas.maxIngressRoutes} port limit.`
      )
    )
  }

  const roomId = request.roomId ?? null
  if (roomId) {
    const room = footprint.rooms.find((candidate) => candidate.roomId === roomId)
    const roomBytes = (room?.totals.bytes ?? 0) + addedBytes
    if (roomBytes > quotas.maxRoomBytes) {
      breaches.push(
        breach(
          'maxRoomBytes',
          'room',
          roomId,
          quotas.maxRoomBytes,
          roomBytes,
          `Room ${roomId} would hold ${roomBytes} bytes, over its ${quotas.maxRoomBytes} byte limit.`
        )
      )
    }

    const roomArtifacts = (room?.totals.ownedCount ?? 0) + addedArtifacts
    if (roomArtifacts > quotas.maxRoomArtifacts) {
      breaches.push(
        breach(
          'maxRoomArtifacts',
          'room',
          roomId,
          quotas.maxRoomArtifacts,
          roomArtifacts,
          `Room ${roomId} would own ${roomArtifacts} artifacts, over its ${quotas.maxRoomArtifacts} artifact limit.`
        )
      )
    }

    if (request.workspaceGeneration) {
      const generations =
        footprint.artifacts.filter(
          (artifact) => artifact.roomId === roomId && artifact.kind === 'room-disk' && artifact.id.includes('-src')
        ).length + 1
      if (generations > quotas.maxRoomWorkspaceGenerations) {
        breaches.push(
          breach(
            'maxRoomWorkspaceGenerations',
            'room',
            roomId,
            quotas.maxRoomWorkspaceGenerations,
            generations,
            `Room ${roomId} would retain ${generations} workspace generations, over its ${quotas.maxRoomWorkspaceGenerations} generation limit.`
          )
        )
      }
    }
  }

  return { ok: breaches.length === 0, breaches, conclusive: footprint.complete }
}
