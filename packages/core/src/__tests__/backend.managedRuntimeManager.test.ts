import { describe, expect, it, vi } from 'vitest'
import type {
  ManagedHyperVRemovalOutcome,
  ManagedHyperVRuntimeMarker,
  ManagedHyperVRuntimeObservation
} from '../backend/managedHyperVRuntime'
import type {
  ManagedRuntimeManifest,
  ManagedRuntimeObservation,
  ManagedRuntimeSupport
} from '../backend/managedRuntime'
import {
  MANAGED_HYPERV_BOOT_ISO,
  MANAGED_HYPERV_RUNTIME_VERSION,
  ManagedRuntimeManager,
  type ManagedRuntimeBootstrapController,
  type ManagedRuntimeProviderController
} from '../backend/managedRuntimeManager'

/**
 * The Windows optional-feature gate is exercised by its own suite; here it is
 * stubbed so these tests never spawn PowerShell against the developer's Host.
 */
const completedWindowsFeature = {
  observe: async () => ({
    stage: 'completed' as const,
    missing: [],
    restartRequired: false,
    edition: 'Microsoft Windows 11 Pro',
    detail: 'Windows virtualization features required by the DevHotel runtime are enabled.'
  }),
  enable: async () => ({
    stage: 'completed' as const,
    missing: [],
    restartRequired: false,
    edition: 'Microsoft Windows 11 Pro',
    detail: 'Windows virtualization features required by the DevHotel runtime are enabled.'
  })
}


function support(code: ManagedRuntimeSupport['code'] = 'ready'): ManagedRuntimeSupport {
  return {
    supported: code === 'ready' || code === 'virtualization-ready' || code === 'elevation-required',
    code,
    detail: code,
    hypervisorPresent: code === 'ready',
    virtualizationFirmwareEnabled: true,
    slat: true,
    hyperVPowerShellAvailable: code === 'ready' || code === 'elevation-required',
    hyperVManagementAccessible: code === 'ready'
  }
}

function manifest(phase: ManagedRuntimeManifest['phase'] = 'checking-windows-capabilities'): ManagedRuntimeManifest {
  return {
    schemaVersion: 2,
    owner: 'devhotel',
    backend: 'managed-linux',
    installId: 'install-owned',
    runtimeId: 'runtime-owned',
    status: phase === 'ready' ? 'ready' : phase === 'broken' ? 'broken' : 'provisioning',
    phase,
    runtimeVersion: MANAGED_HYPERV_RUNTIME_VERSION,
    artifactDigests: phase === 'checking-windows-capabilities' ? {} : { [MANAGED_HYPERV_BOOT_ISO.id]: MANAGED_HYPERV_BOOT_ISO.sha256 },
    createdAt: '2026-09-16T00:00:00Z',
    updatedAt: '2026-09-16T00:00:00Z'
  }
}

function observation(current: ManagedRuntimeManifest, currentSupport = support()): ManagedRuntimeObservation {
  return {
    state: current.status === 'ready' ? 'ready' : current.status === 'broken' ? 'broken' : 'preparing',
    phase: current.phase,
    detail: current.status,
    support: currentSupport,
    runtimeId: current.runtimeId,
    runtimeVersion: current.runtimeVersion,
    artifactDigests: { ...current.artifactDigests }
  }
}

class FakeBootstrap implements ManagedRuntimeBootstrapController {
  current = manifest()
  currentSupport = support()
  /** A Host this install never provisioned: no ownership manifest exists. */
  manifestMissing = false
  readonly calls: string[] = []

  async support(): Promise<ManagedRuntimeSupport> {
    this.calls.push('support')
    return this.currentSupport
  }

  async observe(): Promise<ManagedRuntimeObservation> {
    this.calls.push('observe')
    return observation(this.current, this.currentSupport)
  }

  async readManifest(): Promise<ManagedRuntimeManifest | null> {
    this.calls.push('readManifest')
    return this.manifestMissing ? null : this.current
  }

  async beginProvision(): Promise<ManagedRuntimeManifest> {
    this.calls.push('beginProvision')
    if (this.current.status === 'broken') this.current = manifest()
    return this.current
  }

  async verifyRelease(): Promise<ManagedRuntimeManifest> {
    this.calls.push('verifyRelease')
    this.current = manifest('provisioning-runtime-provider')
    return this.current
  }

  async advance(_runtimeId: string, phase: 'starting-private-daemon' | 'health-checking'): Promise<ManagedRuntimeManifest> {
    this.calls.push(`advance:${phase}`)
    this.current = manifest(phase)
    return this.current
  }

  async markReady(): Promise<ManagedRuntimeManifest> {
    this.calls.push('markReady')
    this.current = manifest('ready')
    return this.current
  }

  async markBroken(_runtimeId: string, failure: string): Promise<ManagedRuntimeManifest> {
    this.calls.push(`markBroken:${failure}`)
    this.current = { ...manifest('broken'), failure }
    return this.current
  }
}

function readyProviderObservation(): ManagedHyperVRuntimeObservation {
  return {
    state: 'ready',
    runtimeId: 'runtime-owned',
    runtimeVersion: MANAGED_HYPERV_RUNTIME_VERSION,
    daemonVersion: MANAGED_HYPERV_RUNTIME_VERSION,
    baseImageDigest: MANAGED_HYPERV_BOOT_ISO.sha256,
    nestedVirtualization: true,
    detail: 'ready'
  }
}

function provider(overrides: Partial<ManagedRuntimeProviderController> = {}): ManagedRuntimeProviderController {
  const marker = {
    schemaVersion: 2,
    owner: 'devhotel',
    backend: 'hyper-v',
    installId: 'install-owned',
    runtimeId: 'runtime-owned',
    runtimeVersion: MANAGED_HYPERV_RUNTIME_VERSION,
    vmName: 'DevHotel-0123456789abcdef',
    vmId: '11111111-2222-3333-4444-555555555555',
    vmPath: 'C:\\runtime\\machine',
    isoPath: 'C:\\runtime\\images\\alpine.iso',
    seedPath: 'C:\\runtime\\machine\\seed.vhdx',
    statePath: 'C:\\runtime\\machine\\state.vhdx',
    pipePath: '\\\\.\\pipe\\devhotel-runtime-0123456789abcdef',
    baseImageDigest: MANAGED_HYPERV_BOOT_ISO.sha256,
    overlayDigest: 'a'.repeat(64),
    status: 'stopped',
    createdAt: '2026-09-16T00:00:00Z',
    updatedAt: '2026-09-16T00:00:00Z'
  } satisfies ManagedHyperVRuntimeMarker
  return {
    observe: vi.fn(async () => readyProviderObservation()),
    provision: vi.fn(async () => marker),
    repair: vi.fn(async () => readyProviderObservation()),
    stop: vi.fn(
      async (): Promise<ManagedHyperVRuntimeObservation> => ({ ...readyProviderObservation(), state: 'stopped' })
    ),
    remove: vi.fn(async (): Promise<ManagedHyperVRemovalOutcome> => 'removed'),
    ...overrides
  }
}

const downloaded = {
  id: MANAGED_HYPERV_BOOT_ISO.id,
  file: 'C:\\runtime\\downloads\\alpine.iso',
  sha256: MANAGED_HYPERV_BOOT_ISO.sha256,
  sha512: MANAGED_HYPERV_BOOT_ISO.sha512,
  sizeBytes: MANAGED_HYPERV_BOOT_ISO.sizeBytes
}

describe('ManagedRuntimeManager', () => {
  it('does not download or mutate when Hyper-V still needs Windows provisioning', async () => {
    const bootstrap = new FakeBootstrap()
    bootstrap.currentSupport = support('virtualization-ready')
    const downloadArtifact = vi.fn()
    const providerFactory = vi.fn()
    const manager = new ManagedRuntimeManager({
      userData: 'C:\\DevHotelData',
      installId: 'install-owned',
      windowsFeature: completedWindowsFeature,
      bootstrap,
      downloadArtifact,
      providerFactory
    })

    await expect(manager.prepare()).resolves.toMatchObject({ state: 'preparing' })
    expect(downloadArtifact).not.toHaveBeenCalled()
    expect(providerFactory).not.toHaveBeenCalled()
  })

  it('drives verified download, provision, daemon start, health and readiness in order', async () => {
    const bootstrap = new FakeBootstrap()
    const hyperv = provider()
    const manager = new ManagedRuntimeManager({
      userData: 'C:\\DevHotelData',
      installId: 'install-owned',
      windowsFeature: completedWindowsFeature,
      bootstrap,
      downloadArtifact: vi.fn(async () => downloaded),
      providerFactory: () => hyperv
    })

    await expect(manager.prepare()).resolves.toMatchObject({ state: 'ready', runtimeId: 'runtime-owned' })
    expect(bootstrap.calls).toEqual([
      'support',
      'beginProvision',
      'verifyRelease',
      'advance:starting-private-daemon',
      'advance:health-checking',
      'markReady',
      'observe',
      'readManifest'
    ])
    expect(hyperv.provision).toHaveBeenCalledOnce()
    expect(hyperv.repair).toHaveBeenCalledOnce()
  })

  it('revalidates and repairs a previously ready runtime after app or Host restart', async () => {
    const bootstrap = new FakeBootstrap()
    bootstrap.current = manifest('ready')
    const hyperv = provider()
    const manager = new ManagedRuntimeManager({
      userData: 'C:\\DevHotelData',
      installId: 'install-owned',
      windowsFeature: completedWindowsFeature,
      bootstrap,
      downloadArtifact: vi.fn(async () => downloaded),
      providerFactory: () => hyperv
    })

    await expect(manager.prepare()).resolves.toMatchObject({ state: 'ready' })
    expect(hyperv.repair).toHaveBeenCalledOnce()
  })

  it('records a broken recoverable phase when provider startup fails', async () => {
    const bootstrap = new FakeBootstrap()
    const hyperv = provider({ repair: vi.fn(async () => Promise.reject(new Error('guest boot failed'))) })
    const manager = new ManagedRuntimeManager({
      userData: 'C:\\DevHotelData',
      installId: 'install-owned',
      windowsFeature: completedWindowsFeature,
      bootstrap,
      downloadArtifact: vi.fn(async () => downloaded),
      providerFactory: () => hyperv
    })

    await expect(manager.prepare()).rejects.toThrow('guest boot failed')
    expect(bootstrap.current).toMatchObject({ status: 'broken', phase: 'broken', failure: 'guest boot failed' })
  })

  it('still saves an owned VM when guest health is broken during shutdown', async () => {
    const bootstrap = new FakeBootstrap()
    bootstrap.current = manifest('ready')
    const stop = vi.fn(async (): Promise<ManagedHyperVRuntimeObservation> => ({
      ...readyProviderObservation(),
      state: 'stopped'
    }))
    const hyperv = provider({
      observe: vi.fn(async () => ({ ...readyProviderObservation(), state: 'broken' as const })),
      stop
    })
    const manager = new ManagedRuntimeManager({
      userData: 'C:\\DevHotel',
      installId: 'install-1234',
      windowsFeature: completedWindowsFeature,
      bootstrap,
      providerFactory: () => hyperv
    })

    await manager.stop()

    expect(stop).toHaveBeenCalledOnce()
  })
  it('removes the owned runtime for uninstall, and reports a refusal instead of guessing', async () => {
    const bootstrap = new FakeBootstrap()
    bootstrap.current = manifest('ready')
    const remove = vi.fn(async (): Promise<ManagedHyperVRemovalOutcome> => 'removed')
    const manager = new ManagedRuntimeManager({
      userData: 'C:\\DevHotel',
      installId: 'install-1234',
      windowsFeature: completedWindowsFeature,
      bootstrap,
      providerFactory: () => provider({ remove })
    })

    await expect(manager.remove()).resolves.toBe('removed')
    expect(remove).toHaveBeenCalledOnce()

    // A refusal is passed through rather than smoothed into success: uninstall
    // has to be able to stop and tell the user a VM was left behind.
    const refusing = new ManagedRuntimeManager({
      userData: 'C:\\DevHotel',
      installId: 'install-1234',
      windowsFeature: completedWindowsFeature,
      bootstrap,
      providerFactory: () => provider({ remove: vi.fn(async (): Promise<ManagedHyperVRemovalOutcome> => 'refused') })
    })
    await expect(refusing.remove()).resolves.toBe('refused')
  })

  it('never reaches the provider to remove a runtime that was never provisioned', async () => {
    const bootstrap = new FakeBootstrap()
    bootstrap.manifestMissing = true
    const remove = vi.fn(async (): Promise<ManagedHyperVRemovalOutcome> => 'removed')
    const manager = new ManagedRuntimeManager({
      userData: 'C:\\DevHotel',
      installId: 'install-1234',
      windowsFeature: completedWindowsFeature,
      bootstrap,
      providerFactory: () => provider({ remove })
    })

    await expect(manager.remove()).resolves.toBe('nothing-owned')
    expect(remove).not.toHaveBeenCalled()
  })

  it('reports the Windows approval gate instead of provisioning on a Host without Hyper-V', async () => {
    const bootstrap = new FakeBootstrap()
    bootstrap.currentSupport = support('virtualization-ready')
    const downloadArtifact = vi.fn()
    const providerFactory = vi.fn()
    const manager = new ManagedRuntimeManager({
      userData: 'C:\\DevHotelData',
      installId: 'install-owned',
      windowsFeature: {
        observe: async () => ({
          stage: 'elevation-required' as const,
          missing: ['Microsoft-Hyper-V-All'],
          restartRequired: false,
          edition: 'Microsoft Windows 11 Pro',
          detail: 'DevHotel needs one-time Windows approval to enable the virtualization features its runtime requires.'
        }),
        enable: async () => {
          throw new Error('enable must not run without the caller asking')
        }
      },
      bootstrap,
      downloadArtifact,
      providerFactory
    })

    const observation = await manager.prepare()
    expect(observation.windowsFeature?.stage).toBe('elevation-required')
    expect(observation.detail).toContain('approval')
    expect(downloadArtifact).not.toHaveBeenCalled()
    expect(providerFactory).not.toHaveBeenCalled()
  })

  it('surfaces a pending restart without touching the provider', async () => {
    const bootstrap = new FakeBootstrap()
    bootstrap.currentSupport = support('virtualization-ready')
    const providerFactory = vi.fn()
    const manager = new ManagedRuntimeManager({
      userData: 'C:\\DevHotelData',
      installId: 'install-owned',
      windowsFeature: {
        observe: async () => ({
          stage: 'awaiting-restart' as const,
          missing: ['Microsoft-Hyper-V-All'],
          restartRequired: true,
          edition: 'Microsoft Windows 11 Pro',
          detail: 'Windows must restart to finish enabling the DevHotel runtime features.'
        }),
        enable: async () => {
          throw new Error('enable must not run while a restart is pending')
        }
      },
      bootstrap,
      downloadArtifact: vi.fn(),
      providerFactory
    })

    const observation = await manager.prepare()
    expect(observation.windowsFeature?.restartRequired).toBe(true)
    expect(providerFactory).not.toHaveBeenCalled()
  })

  it('returns the gate from enableWindowsFeatures without waiting for provisioning', async () => {
    const bootstrap = new FakeBootstrap()
    bootstrap.currentSupport = support('virtualization-ready')
    let enabled = false
    // A download that never settles stands in for the minutes a real provision
    // takes; the call must still return.
    const downloadArtifact = vi.fn(async () => await new Promise<never>(() => {}))
    const manager = new ManagedRuntimeManager({
      userData: 'C:\\DevHotelData',
      installId: 'install-owned',
      windowsFeature: {
        observe: async () =>
          enabled
            ? {
                stage: 'awaiting-restart' as const,
                missing: ['Microsoft-Hyper-V-All'],
                restartRequired: true,
                edition: 'Microsoft Windows 11 Pro',
                detail: 'Windows must restart to finish enabling the DevHotel runtime features.'
              }
            : {
                stage: 'elevation-required' as const,
                missing: ['Microsoft-Hyper-V-All'],
                restartRequired: false,
                edition: 'Microsoft Windows 11 Pro',
                detail: 'DevHotel needs one-time Windows approval.'
              },
        enable: async () => {
          enabled = true
          return {
            stage: 'awaiting-restart' as const,
            missing: ['Microsoft-Hyper-V-All'],
            restartRequired: true,
            edition: 'Microsoft Windows 11 Pro',
            detail: 'Windows must restart to finish enabling the DevHotel runtime features.'
          }
        }
      },
      bootstrap,
      downloadArtifact,
      providerFactory: vi.fn()
    })

    const observation = await manager.enableWindowsFeatures()
    expect(observation.windowsFeature?.stage).toBe('awaiting-restart')
    expect(observation.windowsFeature?.restartRequired).toBe(true)

  })

  it('reports an unsupported Host when the Windows edition cannot offer Hyper-V', async () => {
    const bootstrap = new FakeBootstrap()
    bootstrap.currentSupport = support('virtualization-ready')
    const manager = new ManagedRuntimeManager({
      userData: 'C:\\DevHotelData',
      installId: 'install-owned',
      windowsFeature: {
        observe: async () => ({
          stage: 'unsupported-edition' as const,
          missing: ['Microsoft-Hyper-V-All'],
          restartRequired: false,
          edition: 'Microsoft Windows 11 Home',
          detail: 'This Windows edition does not offer Hyper-V, so the managed DevHotel runtime cannot be provisioned here.'
        }),
        enable: async () => {
          throw new Error('enable must not run on an unsupported edition')
        }
      },
      bootstrap,
      downloadArtifact: vi.fn(),
      providerFactory: vi.fn()
    })

    const observation = await manager.prepare()
    expect(observation.state).toBe('unsupported')
    expect(observation.windowsFeature?.edition).toBe('Microsoft Windows 11 Home')
  })
})
