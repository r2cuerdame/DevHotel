import { describe, expect, it } from 'vitest'
import type { ManagedRuntimeObservation } from '@devhotel/core'
import { managedRuntimeStatusInfo } from './managedRuntimeStatus'

function observation(overrides: Partial<ManagedRuntimeObservation> = {}): ManagedRuntimeObservation {
  return {
    state: 'ready',
    phase: 'ready',
    detail: 'The DevHotel-managed separate-kernel runtime is ready.',
    support: {
      supported: true,
      code: 'ready',
      detail: 'ready',
      hypervisorPresent: true,
      virtualizationFirmwareEnabled: true,
      slat: true,
      hyperVPowerShellAvailable: true,
      hyperVManagementAccessible: true
    },
    runtimeId: 'runtime-owned',
    runtimeVersion: '0.1.0',
    artifactDigests: { 'alpine-3.22.5-virt-iso': 'b'.repeat(64) },
    ...overrides
  }
}

describe('managedRuntimeStatusInfo', () => {
  it('carries the identity, version and verified digests the acceptance run has to read', () => {
    // On a clean Windows machine nothing else is installed that could read
    // these, so the app window is the only place they can be seen.
    expect(managedRuntimeStatusInfo(observation())).toMatchObject({
      state: 'ready',
      runtimeId: 'runtime-owned',
      runtimeVersion: '0.1.0',
      artifactDigests: { 'alpine-3.22.5-virt-iso': 'b'.repeat(64) }
    })
  })

  it('reports an unrecorded nested-virtualization outcome as unknown, not as refused', () => {
    expect(managedRuntimeStatusInfo(observation()).nestedVirtualization).toBeNull()
    expect(managedRuntimeStatusInfo(observation({ nestedVirtualization: false })).nestedVirtualization).toBe(false)
    expect(managedRuntimeStatusInfo(observation({ nestedVirtualization: true })).nestedVirtualization).toBe(true)
  })

  it('keeps the raw Windows failure text out of the renderer', () => {
    const status = managedRuntimeStatusInfo(
      observation({
        state: 'preparing',
        windowsFeature: {
          stage: 'failed',
          missing: ['Microsoft-Hyper-V-All'],
          restartRequired: false,
          edition: 'Microsoft Windows 11 Pro',
          detail: 'Enabling the Windows virtualization features did not complete.',
          failure: 'DISM failed opening C:\\Users\\someone\\private\\thing'
        }
      })
    )

    // The gate still says what the user can do; it just does not quote Windows
    // back at them, which is the one field here that carries Host text.
    expect(status.windowsFeature).toMatchObject({ stage: 'failed', restartRequired: false })
    expect(JSON.stringify(status)).not.toContain('private')
    expect(JSON.stringify(status)).not.toContain('DISM')
  })
})
