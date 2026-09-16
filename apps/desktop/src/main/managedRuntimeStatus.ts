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
 * what the user can do about it without quoting Windows. An update's `failure`
 * is dropped for the same reason: it can carry the provider's own message about
 * a Hyper-V object, and the summary's `detail` already says what happened and
 * which runtime the user is now on.
 */
export function managedRuntimeStatusInfo(observation: ManagedRuntimeObservation): ManagedRuntimeStatusInfo {
  const gate = observation.windowsFeature
  const update = observation.update
  return {
    state: observation.state,
    phase: observation.phase,
    detail: observation.detail,
    runtimeId: observation.runtimeId,
    runtimeVersion: observation.runtimeVersion,
    artifactDigests: { ...observation.artifactDigests },
    nestedVirtualization: observation.nestedVirtualization ?? null,
    update: update
      ? {
          stage: update.stage,
          fromVersion: update.fromVersion,
          toVersion: update.toVersion,
          attempts: update.attempts,
          detail: update.detail
        }
      : null,
    windowsFeature: gate
      ? { stage: gate.stage, restartRequired: gate.restartRequired, edition: gate.edition, detail: gate.detail }
      : null
  }
}
