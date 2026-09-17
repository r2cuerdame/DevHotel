import type { VolumeRecord } from '@devhotel/shared'

/**
 * What an engine adapter has to report, and nothing more.
 *
 * This is the whole seam #109 introduces. Above it, DevHotel reasons about
 * Rooms, disks, isolation domains and ingress in its own terms; below it, an
 * adapter translates one engine's nouns into these shapes. The compatibility
 * Docker backend and the DevHotel-managed runtime both produce this, which is
 * what makes the lifecycle above it backend-neutral in a checkable sense rather
 * than an aspirational one: nothing in `footprint.ts`, `gc.ts`, `quotas.ts` or
 * `reconcilePlan.ts` imports a backend, spawns a process or knows the word
 * "docker".
 */

/**
 * A container the engine has already proved DevHotel owns.
 *
 * Proof is a precondition of appearing here, not a field. The listing paths
 * these come from re-validate the complete ownership label set and throw on
 * anything they cannot vouch for, so a container that reaches this type has
 * been vouched for. Carrying a `proved: boolean` instead would invite a caller
 * to construct an unproved one and hand it to GC.
 */
export interface OwnedContainerObservation {
  name: string
  /** Null when the labels prove DevHotel ownership but name no Room. */
  roomId: string | null
  role: string
  state: string
}

/** A per-Room isolation domain the engine has already proved DevHotel owns. */
export interface OwnedNetworkObservation {
  name: string
  roomId: string | null
}

/**
 * A Host ingress port DevHotel published for one Room.
 *
 * No engine knows about these — the Host owns them — so the proof is DevHotel's
 * own durable ledger. That is exactly why they need to be in the inventory: a
 * crash between publishing a port and recording the Room awake leaves a
 * listening socket that nothing else on the Host can attribute or reclaim.
 */
export interface IngressRouteObservation {
  roomId: string
  hostPort: number
  /** Where the route forwards to, for diagnostics. Never a Host filesystem path. */
  target: string
  /** The runtime generation that published it; a different one means it is stale. */
  runtimeId: string | null
  createdAt: string
}

/**
 * A Hotel-scoped disk shared by many Rooms.
 *
 * A shared cache is the one owned disk no single Room can be allowed to delete,
 * because "this Room is gone" says nothing about the twelve Rooms still using
 * it. It is therefore scoped to the Hotel and reachable for as long as the
 * Hotel exists.
 */
export interface SharedCacheObservation {
  name: string
  /** What the cache holds: a package manager's store, an SDK, a build cache. */
  purpose: string
  sizeBytes: number
  sizeKnown: boolean
  /** True when the engine reports DevHotel's complete shared-scope label set. */
  ownershipProved: boolean
  /** Engine-reported live attachments; unknown blocks any conclusion. */
  attachments: number | null
}

/**
 * One complete observation of the Host.
 *
 * `gaps` is the honest part. An engine call that failed, a listing that was
 * truncated, a runtime that is still starting — each one belongs here, and each
 * one makes the resulting footprint incomplete. An incomplete footprint can
 * still be *shown*; it just cannot authorize a deletion, because unreachability
 * is a claim about everything that exists, and a partial list is not everything.
 */
export interface LifecycleObservation {
  observedAt: string
  runtimeMode: 'managed' | 'compatibility' | 'unknown'
  containers: OwnedContainerObservation[]
  networks: OwnedNetworkObservation[]
  /**
   * Disks, already classified by the existing fail-closed volume reconciler.
   *
   * #109 deliberately does not re-decide disk liveness. That logic carries the
   * recovery fences, the undo-history retention and the sleeping-Room
   * protections earned across several issues, and a second opinion about the
   * same disk is a second chance to be wrong about it. The footprint translates
   * its verdict into this layer's vocabulary and preserves it exactly.
   */
  volumes: VolumeRecord[]
  ingress: IngressRouteObservation[]
  sharedCaches: SharedCacheObservation[]
  gaps: string[]
}

/** An observation with nothing in it — the base every adapter builds onto. */
export function emptyObservation(
  observedAt: string,
  runtimeMode: LifecycleObservation['runtimeMode'] = 'unknown'
): LifecycleObservation {
  return {
    observedAt,
    runtimeMode,
    containers: [],
    networks: [],
    volumes: [],
    ingress: [],
    sharedCaches: [],
    gaps: []
  }
}
