import type { ManagedRuntimeStatusInfo } from '@devhotel/shared'
import type { ManagedRuntimeObservation } from '@devhotel/core'

/**
 * Narrows a managed-runtime observation to what the app window may show.
 *
 * This is the boundary, not a formatting step. The runtime's identity, version
 * and verified artifact digests are what distinguish a runtime actually running
 * the pinned image from one that merely calls itself healthy, and on the clean
 * Windows machine #106 is proven on there is nothing else installed that could
 * read them. So they have to reach the renderer.
 *
 * What must not reach it is the Windows feature harness's `failure`: it carries
 * a raw DISM or elevation error, which is Host text of exactly the kind the
 * provider keeps private everywhere else. The gate's own `stage`/`detail` say
 * what the user can do about it without quoting Windows.
 */
export function managedRuntimeStatusInfo(observation: ManagedRuntimeObservation): ManagedRuntimeStatusInfo {
  const gate = observation.windowsFeature
  return {
    state: observation.state,
    phase: observation.phase,
    detail: observation.detail,
    runtimeId: observation.runtimeId,
    runtimeVersion: observation.runtimeVersion,
    artifactDigests: { ...observation.artifactDigests },
    nestedVirtualization: observation.nestedVirtualization ?? null,
    windowsFeature: gate
      ? { stage: gate.stage, restartRequired: gate.restartRequired, edition: gate.edition, detail: gate.detail }
      : null
  }
}
