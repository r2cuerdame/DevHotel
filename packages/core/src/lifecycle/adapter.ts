import type { VolumeRecord } from '@devhotel/shared'
import { managedContainerInventory, type DockerVolumeUsage, type IsolationBackend } from '../backend/types'
import type { IngressRouteObservation, LifecycleObservation, SharedCacheObservation } from './observations'
import { isSharedCacheVolumeName, provesSharedCacheOwnership, sharedCachePurpose } from './sharedCache'

/**
 * The one place in this layer that talks to an engine.
 *
 * Everything else — the footprint, the quota verdict, the GC plan, the
 * reconciliation plan — is a pure function of a `LifecycleObservation`, and
 * that is what lets those rules be tested exhaustively without a container
 * runtime and shared unchanged between the compatibility backend and the
 * DevHotel-managed one. This file is the cost of that: it knows an
 * `IsolationBackend` exists, and it turns what one reports into the shapes
 * above it.
 *
 * Its other job is to be honest about failure. An engine call that throws does
 * not abort the observation and does not silently shrink it — it records a gap,
 * and a gap makes the footprint incomplete, which is what stops a partial
 * inventory from authorizing a deletion.
 */

export interface ObserveHostOptions {
  backend: IsolationBackend
  /** Disks already classified by the fail-closed volume reconciler. */
  classifiedVolumes: readonly VolumeRecord[]
  /** The raw engine volume listing, needed for Hotel-scoped shared caches. */
  volumeUsage: readonly DockerVolumeUsage[]
  /** Routes from the durable ingress ledger. */
  ingress: readonly IngressRouteObservation[]
  /** True when the ledger file exists but could not be read. */
  ingressLedgerDamaged?: boolean
  runtimeMode: LifecycleObservation['runtimeMode']
  now?: () => Date
}

function sharedCacheFrom(usage: DockerVolumeUsage): SharedCacheObservation {
  return {
    name: usage.name,
    purpose: sharedCachePurpose(usage.name) ?? 'unknown',
    sizeBytes: usage.sizeBytes,
    sizeKnown: usage.sizeKnown,
    ownershipProved: provesSharedCacheOwnership(usage.name, usage.labels),
    attachments: usage.linksKnown ? usage.links : null
  }
}

export async function observeHost(opts: ObserveHostOptions): Promise<LifecycleObservation> {
  const now = opts.now ?? (() => new Date())
  const gaps: string[] = []

  let containers: LifecycleObservation['containers'] = []
  try {
    const inventory = await managedContainerInventory(opts.backend)
    containers = inventory.owned.map((container) => ({
      name: container.name,
      roomId: container.roomId || null,
      role: container.role,
      state: container.state
    }))
    for (const entry of inventory.invalid) {
      gaps.push(`Container ${entry.name} carries the DevHotel label but is not owned by DevHotel: ${entry.reason}`)
    }
  } catch (error) {
    gaps.push(`Owned containers could not be listed: ${error instanceof Error ? error.message : String(error)}`)
  }

  let networks: LifecycleObservation['networks'] = []
  try {
    networks = (await opts.backend.listManagedNetworks()).map((network) => ({
      name: network.name,
      roomId: network.roomId || null
    }))
  } catch (error) {
    gaps.push(`Owned isolation domains could not be listed: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (opts.ingressLedgerDamaged) {
    gaps.push('The durable ingress ledger exists but could not be read, so published Host ports cannot be enumerated.')
  }

  // A shared cache is Hotel-scoped, so the Room disk reconciler correctly
  // declines to attribute it to any Room. It is enumerated here instead, from
  // the raw listing, so that it appears in the footprint exactly once rather
  // than as an anonymous external volume nobody can account for.
  const sharedCaches = opts.volumeUsage.filter((usage) => isSharedCacheVolumeName(usage.name)).map(sharedCacheFrom)
  const sharedNames = new Set(sharedCaches.map((cache) => cache.name))
  const volumes = opts.classifiedVolumes.filter((volume) => !sharedNames.has(volume.name))

  return {
    observedAt: now().toISOString(),
    runtimeMode: opts.runtimeMode,
    containers,
    networks,
    volumes,
    ingress: opts.ingress.map((route) => ({ ...route })),
    sharedCaches,
    gaps
  }
}
