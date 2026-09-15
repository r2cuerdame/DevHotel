import { describe, expect, it, vi } from 'vitest'
import type { ManagedHyperVRuntimeMarker, ManagedHyperVRuntimeObservation } from '../backend/managedHyperVRuntime'
import type {
  ManagedRuntimeManifest,
  ManagedRuntimeObservation,
  ManagedRuntimeSupport
} from '../backend/managedRuntime'
import {
  MANAGED_HYPERV_BASE_IMAGE,
  MANAGED_HYPERV_RUNTIME_VERSION,
  ManagedRuntimeManager,
  type ManagedRuntimeBootstrapController,
  type ManagedRuntimeProviderController
} from '../backend/managedRuntimeManager'

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
    artifactDigests: phase === 'checking-windows-capabilities' ? {} : { [MANAGED_HYPERV_BASE_IMAGE.id]: MANAGED_HYPERV_BASE_IMAGE.sha256 },
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
    return this.current
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
    baseImageDigest: MANAGED_HYPERV_BASE_IMAGE.sha256,
    detail: 'ready'
  }
}

function provider(overrides: Partial<ManagedRuntimeProviderController> = {}): ManagedRuntimeProviderController {
  const marker = {
    schemaVersion: 1,
    owner: 'devhotel',
    backend: 'hyper-v',
    installId: 'install-owned',
    runtimeId: 'runtime-owned',
    runtimeVersion: MANAGED_HYPERV_RUNTIME_VERSION,
    vmName: 'DevHotel-0123456789abcdef',
    vmId: '11111111-2222-3333-4444-555555555555',
    vmPath: 'C:\\runtime\\machine',
    diskPath: 'C:\\runtime\\machine\\runtime.vhd',
    seedPath: 'C:\\runtime\\machine\\seed.vhdx',
    pipePath: '\\\\.\\pipe\\devhotel-runtime-0123456789abcdef',
    baseImageDigest: MANAGED_HYPERV_BASE_IMAGE.sha256,
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
    ...overrides
  }
}

const downloaded = {
  id: MANAGED_HYPERV_BASE_IMAGE.id,
  file: 'C:\\runtime\\downloads\\base.vhd',
  sha256: MANAGED_HYPERV_BASE_IMAGE.sha256,
  sha512: MANAGED_HYPERV_BASE_IMAGE.sha512,
  sizeBytes: MANAGED_HYPERV_BASE_IMAGE.sizeBytes
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
      bootstrap,
      downloadArtifact: vi.fn(async () => downloaded),
      providerFactory: () => hyperv
    })

    await expect(manager.prepare()).rejects.toThrow('guest boot failed')
    expect(bootstrap.current).toMatchObject({ status: 'broken', phase: 'broken', failure: 'guest boot failed' })
  })
})
