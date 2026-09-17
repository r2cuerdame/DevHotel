import type {
  FootprintTotals,
  HostFootprint,
  HotelArtifact,
  HotelArtifactKind,
  OwnershipProof,
  Reachability,
  RoomFootprint,
  RoomRecord,
  VolumeRecord
} from '@devhotel/shared'
import type { LifecycleObservation } from './observations'

/**
 * The Host footprint: everything DevHotel owns, in one list, once each.
 *
 * "Once each" is the property worth stating. A Room's disks were enumerable
 * before, and its containers were enumerable somewhere else, and its Host
 * ingress port was enumerable nowhere at all — so no single answer to "what is
 * DevHotel costing this machine, and what of it is still needed" existed, and
 * GC could only ever be as complete as the one list it happened to read. Here
 * every observation the engine made lands in exactly one artifact, the counts
 * are checked against the inputs, and a footprint that could not account for
 * something says so instead of quietly shrinking.
 */

export interface FootprintContext {
  /** Every Room DevHotel knows about, including ones being deleted. */
  rooms: readonly RoomRecord[]
  /**
   * Whether a Room's Host directory exists. A missing Room record plus a
   * missing directory is the only combination that proves a Room is gone; the
   * absence of an answer is not, so `undefined` keeps its artifacts.
   */
  roomDirExists?: (roomId: string) => boolean
  /**
   * The runtime generation currently serving Rooms. An ingress route published
   * by a different generation forwards to a guest that no longer exists.
   */
  currentRuntimeId?: string | null
}

const KINDS: HotelArtifactKind[] = ['room-network', 'room-container', 'room-disk', 'shared-cache', 'ingress-route']

function emptyTotals(): FootprintTotals {
  return {
    artifactCount: 0,
    bytes: 0,
    ownedCount: 0,
    ownedBytes: 0,
    collectableCount: 0,
    collectableBytes: 0,
    undeterminedCount: 0
  }
}

function accumulate(into: FootprintTotals, artifact: HotelArtifact): void {
  into.artifactCount += 1
  into.bytes += artifact.sizeBytes
  if (artifact.ownership.proved) {
    into.ownedCount += 1
    into.ownedBytes += artifact.sizeBytes
  }
  if (artifact.collectable) {
    into.collectableCount += 1
    into.collectableBytes += artifact.sizeBytes
  }
  if (!artifact.reachability.known || !artifact.sizeKnown) into.undeterminedCount += 1
}

/**
 * Whether this Room is still a thing DevHotel is keeping.
 *
 * A Room mid-deletion counts as present on purpose. Its artifacts are about to
 * be removed by the operation that owns that removal, and a GC pass that raced
 * it would be removing the same things twice under two different sets of rules.
 */
function roomPresence(
  roomId: string | null,
  context: FootprintContext
): { room: RoomRecord | null; state: 'present' | 'gone' | 'unknown' } {
  if (!roomId) return { room: null, state: 'unknown' }
  const room = context.rooms.find((candidate) => candidate.id === roomId) ?? null
  if (room) return { room, state: 'present' }
  const onDisk = context.roomDirExists?.(roomId)
  if (onDisk === false) return { room: null, state: 'gone' }
  return { room: null, state: 'unknown' }
}

function reachable(kind: Reachability['kind'], detail: string): Reachability {
  return { kind, reachable: true, known: true, detail }
}

function unreachable(detail: string): Reachability {
  return { kind: 'unreachable', reachable: false, known: true, detail }
}

function undetermined(detail: string): Reachability {
  return { kind: 'undetermined', reachable: false, known: false, detail }
}

/**
 * The single gate every artifact passes through.
 *
 * Four conditions, all required, none of them inferable from another: DevHotel
 * proved it owns the thing; it established whether anything reaches it; nothing
 * does; and it knows what removing it would reclaim, because an unbounded
 * removal cannot be bounded. Callers read `collectable` — they never rebuild
 * this expression, so there is one place to look when asking why something was
 * or was not collected.
 */
function gate(ownership: OwnershipProof, reachability: Reachability, sizeKnown: boolean): boolean {
  return ownership.proved && reachability.known && !reachability.reachable && sizeKnown
}

function refusalReason(ownership: OwnershipProof, reachability: Reachability, sizeKnown: boolean): string {
  if (!ownership.proved) return `Ownership is not proved (${ownership.kind}): ${ownership.detail}`
  if (!reachability.known) return `Reachability could not be established: ${reachability.detail}`
  if (reachability.reachable) return reachability.detail
  if (!sizeKnown) return 'Size is unknown, so a bounded collection cannot account for it.'
  return reachability.detail
}

function finish(
  partial: Omit<HotelArtifact, 'collectable' | 'reason'>
): HotelArtifact {
  const collectable = gate(partial.ownership, partial.reachability, partial.sizeKnown)
  return {
    ...partial,
    collectable,
    reason: collectable ? partial.reachability.detail : refusalReason(partial.ownership, partial.reachability, partial.sizeKnown)
  }
}

/**
 * Translates one already-classified disk into this layer's vocabulary.
 *
 * The verdict is carried across, never recomputed. `collectable` is ANDed with
 * the existing `safeToDelete`, so this layer can only ever be more conservative
 * than the reconciler whose fences it inherits — a bug here can hold a disk
 * forever, which is annoying, but it cannot delete one the old rules protected.
 */
function diskArtifact(volume: VolumeRecord): HotelArtifact {
  const ownership: OwnershipProof =
    volume.ownership === 'managed-labels'
      ? { kind: 'managed-labels', proved: true, detail: 'The engine reports DevHotel’s complete ownership label set.' }
      : volume.ownership === 'legacy-adoption'
        ? { kind: 'ledger', proved: true, detail: 'DevHotel’s engine-pinned adoption ledger records this disk.' }
        : volume.purpose === 'external'
          ? { kind: 'none', proved: false, detail: 'Nothing identifies this disk as DevHotel’s.' }
          : { kind: 'name-only', proved: false, detail: 'The name matches a DevHotel pattern but no proof corroborates it.' }

  let reachability: Reachability
  switch (volume.class) {
    case 'retained-current':
      reachability = reachable('current-generation', volume.reason)
      break
    case 'retained-active':
      reachability = reachable('active-operation', volume.reason)
      break
    case 'retained-sleeping':
      reachability = reachable('room-record', volume.reason)
      break
    case 'retained-recovery':
      reachability = reachable('retained-recovery', volume.reason)
      break
    case 'fenced':
      reachability = reachable('fenced', volume.reason)
      break
    case 'unowned':
      reachability = undetermined(volume.reason)
      break
    default:
      // An orphan class the reconciler declined to clear still has something
      // undetermined about it — an unknown attachment count, an unknown size,
      // a missing ownership proof — and its own reason says which.
      reachability = volume.safeToDelete
        ? unreachable(volume.reason)
        : volume.linksKnown && volume.links > 0
          ? reachable('attached', volume.reason)
          : undetermined(volume.reason)
      break
  }

  const artifact = finish({
    id: `disk:${volume.name}`,
    kind: 'room-disk',
    scope: 'room',
    roomId: volume.roomId,
    sizeBytes: volume.sizeBytes,
    sizeKnown: volume.sizeKnown,
    ownership,
    reachability
  })

  if (artifact.collectable && !volume.safeToDelete) {
    // Belt and braces: the inherited verdict wins, always.
    return { ...artifact, collectable: false, reason: `Held by the disk reconciler: ${volume.reason}` }
  }
  return artifact
}

function containerArtifact(
  observed: LifecycleObservation['containers'][number],
  context: FootprintContext
): HotelArtifact {
  const ownership: OwnershipProof = {
    kind: 'managed-labels',
    proved: true,
    detail: 'The engine re-validated DevHotel’s complete ownership label set when listing it.'
  }
  const { room, state } = roomPresence(observed.roomId, context)
  const running = observed.state === 'running' || observed.state === 'paused' || observed.state === 'restarting'

  const reachability: Reachability = running
    ? reachable('attached', `Container ${observed.name} is ${observed.state}.`)
    : state === 'present' && room
      ? reachable('room-record', `Room ${room.id} still exists (${room.status}).`)
      : state === 'gone'
        ? unreachable(`Room ${observed.roomId} has no record and no Host directory.`)
        : observed.roomId
          ? undetermined(`Room ${observed.roomId} has no record but its Host directory state is unknown.`)
          : undetermined(`Container ${observed.name} proves DevHotel ownership but names no Room.`)

  return finish({
    id: `container:${observed.name}`,
    kind: 'room-container',
    scope: 'room',
    roomId: observed.roomId,
    // A container's own layer cost is not separately attributable here; its
    // durable bytes live in the disks it mounts, which are counted once, there.
    sizeBytes: 0,
    sizeKnown: true,
    ownership,
    reachability
  })
}

function networkArtifact(
  observed: LifecycleObservation['networks'][number],
  context: FootprintContext
): HotelArtifact {
  const ownership: OwnershipProof = {
    kind: 'managed-labels',
    proved: true,
    detail: 'The engine re-validated DevHotel’s complete ownership label set when listing it.'
  }
  const { room, state } = roomPresence(observed.roomId, context)
  const reachability: Reachability =
    state === 'present' && room
      ? reachable('room-record', `Room ${room.id} still exists (${room.status}).`)
      : state === 'gone'
        ? unreachable(`Room ${observed.roomId} has no record and no Host directory.`)
        : observed.roomId
          ? undetermined(`Room ${observed.roomId} has no record but its Host directory state is unknown.`)
          : undetermined(`Network ${observed.name} proves DevHotel ownership but names no Room.`)

  return finish({
    id: `network:${observed.name}`,
    kind: 'room-network',
    scope: 'room',
    roomId: observed.roomId,
    sizeBytes: 0,
    sizeKnown: true,
    ownership,
    reachability
  })
}

/** Room statuses for which a Host ingress port is legitimately listening. */
const AWAKE: ReadonlySet<string> = new Set(['running', 'ready', 'attention', 'preparing'])

function ingressArtifact(
  observed: LifecycleObservation['ingress'][number],
  context: FootprintContext
): HotelArtifact {
  const ownership: OwnershipProof = {
    kind: 'ledger',
    proved: true,
    detail: 'DevHotel’s durable ingress ledger records publishing this Host port.'
  }
  const { room, state } = roomPresence(observed.roomId, context)
  const current = context.currentRuntimeId ?? null

  const reachability: Reachability =
    observed.runtimeId !== null && current !== null && observed.runtimeId !== current
      ? unreachable(
          `Route was published by runtime ${observed.runtimeId}, which is no longer the runtime serving Rooms.`
        )
      : state === 'gone'
        ? unreachable(`Room ${observed.roomId} has no record and no Host directory.`)
        : state === 'unknown'
          ? undetermined(`Room ${observed.roomId} has no record but its Host directory state is unknown.`)
          : room && AWAKE.has(room.status)
            ? reachable('room-record', `Room ${room.id} is ${room.status} and is served through this port.`)
            : unreachable(`Room ${observed.roomId} is ${room?.status ?? 'absent'}; nothing is listening behind this port.`)

  return finish({
    id: `ingress:${observed.roomId}:${observed.hostPort}`,
    kind: 'ingress-route',
    scope: 'room',
    roomId: observed.roomId,
    sizeBytes: 0,
    sizeKnown: true,
    ownership,
    reachability
  })
}

function sharedCacheArtifact(
  observed: LifecycleObservation['sharedCaches'][number],
  context: FootprintContext
): HotelArtifact {
  const ownership: OwnershipProof = observed.ownershipProved
    ? { kind: 'managed-labels', proved: true, detail: 'The engine reports DevHotel’s Hotel-scope ownership label set.' }
    : { kind: 'name-only', proved: false, detail: 'The name matches a DevHotel shared cache but no proof corroborates it.' }

  const reachability: Reachability =
    observed.attachments === null
      ? undetermined(`Attachment state for shared cache ${observed.name} is unknown.`)
      : observed.attachments > 0
        ? reachable('attached', `Shared cache ${observed.name} has ${observed.attachments} live attachment(s).`)
        : context.rooms.length > 0
          ? reachable(
              'shared',
              `Shared ${observed.purpose} cache is reachable by all ${context.rooms.length} Room(s) in the Hotel.`
            )
          : unreachable(`No Room remains that could reach the shared ${observed.purpose} cache.`)

  return finish({
    id: `shared-cache:${observed.name}`,
    kind: 'shared-cache',
    scope: 'hotel',
    roomId: null,
    sizeBytes: observed.sizeBytes,
    sizeKnown: observed.sizeKnown,
    ownership,
    reachability
  })
}

/**
 * Builds the footprint, and checks its own arithmetic before returning it.
 *
 * The completeness check is not ceremony. Everything downstream — the quota
 * verdict, and above all the GC authorization — is a claim about a *closed*
 * world. If the list is not closed, those claims are not true, and the cheapest
 * moment to notice is here, while the inputs are still in hand.
 */
export function buildHostFootprint(observation: LifecycleObservation, context: FootprintContext): HostFootprint {
  const artifacts: HotelArtifact[] = [
    ...observation.networks.map((network) => networkArtifact(network, context)),
    ...observation.containers.map((container) => containerArtifact(container, context)),
    ...observation.volumes.map(diskArtifact),
    ...observation.sharedCaches.map((cache) => sharedCacheArtifact(cache, context)),
    ...observation.ingress.map((route) => ingressArtifact(route, context))
  ]
  // A stable order so two footprints of the same Host compare and diff cleanly.
  artifacts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const incompleteReasons = [...observation.gaps]

  const expected =
    observation.networks.length +
    observation.containers.length +
    observation.volumes.length +
    observation.sharedCaches.length +
    observation.ingress.length
  if (artifacts.length !== expected) {
    incompleteReasons.push(`Expected ${expected} artifacts from the observation but enumerated ${artifacts.length}.`)
  }

  const seen = new Set<string>()
  for (const artifact of artifacts) {
    if (seen.has(artifact.id)) incompleteReasons.push(`Artifact ${artifact.id} was reported more than once.`)
    seen.add(artifact.id)
  }

  const byKind = Object.fromEntries(KINDS.map((kind) => [kind, emptyTotals()])) as Record<HotelArtifactKind, FootprintTotals>
  const totals = emptyTotals()
  const hotel = emptyTotals()
  const roomTotals = new Map<string, FootprintTotals>()
  const roomArtifactIds = new Map<string, string[]>()

  for (const artifact of artifacts) {
    accumulate(totals, artifact)
    accumulate(byKind[artifact.kind], artifact)
    if (artifact.scope === 'hotel' || !artifact.roomId) {
      accumulate(hotel, artifact)
      continue
    }
    let bucket = roomTotals.get(artifact.roomId)
    if (!bucket) {
      bucket = emptyTotals()
      roomTotals.set(artifact.roomId, bucket)
      roomArtifactIds.set(artifact.roomId, [])
    }
    accumulate(bucket, artifact)
    roomArtifactIds.get(artifact.roomId)?.push(artifact.id)
  }

  // Rooms with no artifacts at all still belong in the footprint: a Room that
  // owns nothing is a fact worth being able to see, not an absence.
  for (const room of context.rooms) {
    if (!roomTotals.has(room.id)) {
      roomTotals.set(room.id, emptyTotals())
      roomArtifactIds.set(room.id, [])
    }
  }

  const known = new Set(context.rooms.map((room) => room.id))
  const rooms: RoomFootprint[] = [...roomTotals.entries()]
    .map(([roomId, bucket]) => ({
      roomId,
      exists: known.has(roomId),
      totals: bucket,
      artifactIds: roomArtifactIds.get(roomId) ?? []
    }))
    .sort((a, b) => (a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0))

  return {
    observedAt: observation.observedAt,
    runtimeMode: observation.runtimeMode,
    artifacts,
    byKind,
    rooms,
    hotel,
    totals,
    complete: incompleteReasons.length === 0,
    incompleteReasons
  }
}
