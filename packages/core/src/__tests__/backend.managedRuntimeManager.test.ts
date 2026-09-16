import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
import { MANAGED_RUNTIME_UPDATE_FILE, type ManagedRuntimeUpdateJournal } from '../backend/managedRuntimeUpdate'

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

  async beginProvision(runtimeVersion: string): Promise<ManagedRuntimeManifest> {
    this.calls.push('beginProvision')
    if (this.current.status === 'broken') this.current = { ...this.current, status: 'provisioning', phase: 'checking-windows-capabilities' }
    // The real bootstrap refuses to re-stamp a live runtime; only an authorised
    // update may change the version, and it does that through adoptVersion.
    if (this.current.runtimeVersion !== runtimeVersion) throw new Error('Managed runtime update requires an explicit migration')
    return this.current
  }

  async adoptVersion(
    _runtimeId: string,
    runtimeVersion: string,
    artifactDigests: Record<string, string>
  ): Promise<ManagedRuntimeManifest> {
    this.calls.push(`adoptVersion:${runtimeVersion}`)
    this.current = {
      ...this.current,
      status: 'provisioning',
      phase: 'provisioning-runtime-provider',
      runtimeVersion,
      artifactDigests: { ...artifactDigests },
      failure: undefined
    }
    return this.current
  }

  async verifyRelease(): Promise<ManagedRuntimeManifest> {
    this.calls.push('verifyRelease')
    this.current = {
      ...this.current,
      phase: 'provisioning-runtime-provider',
      artifactDigests: { [MANAGED_HYPERV_BOOT_ISO.id]: MANAGED_HYPERV_BOOT_ISO.sha256 }
    }
    return this.current
  }

  async advance(_runtimeId: string, phase: 'starting-private-daemon' | 'health-checking'): Promise<ManagedRuntimeManifest> {
    this.calls.push(`advance:${phase}`)
    this.current = { ...this.current, status: 'provisioning', phase }
    return this.current
  }

  async markReady(): Promise<ManagedRuntimeManifest> {
    this.calls.push('markReady')
    this.current = { ...this.current, status: 'ready', phase: 'ready', failure: undefined }
    return this.current
  }

  async markBroken(_runtimeId: string, failure: string): Promise<ManagedRuntimeManifest> {
    this.calls.push(`markBroken:${failure}`)
    this.current = { ...this.current, status: 'broken', phase: 'broken', failure }
    return this.current
  }
}

function readyProviderObservation(runtimeVersion = MANAGED_HYPERV_RUNTIME_VERSION): ManagedHyperVRuntimeObservation {
  return {
    state: 'ready',
    runtimeId: 'runtime-owned',
    runtimeVersion,
    daemonVersion: runtimeVersion,
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

/** The version installs provisioned before the guest gained a container engine. */
const PREVIOUS_RUNTIME_VERSION = '0.1.0'

const temps: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'devhotel-runtime-update-'))
  temps.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/**
 * Writes the journal a killed process leaves behind.
 *
 * Built by hand on purpose: an in-process failure is caught and rolled back, so
 * the only way to test what a crash or a reboot leaves is to put that state on
 * disk and start a manager over it, exactly as the next launch does.
 */
async function writeJournal(
  userData: string,
  overrides: Partial<ManagedRuntimeUpdateJournal> & { stage: ManagedRuntimeUpdateJournal['stage']; attempts: number }
): Promise<void> {
  const root = path.join(userData, 'runtime', 'managed-linux')
  await mkdir(root, { recursive: true })
  const journal: ManagedRuntimeUpdateJournal = {
    schemaVersion: 1,
    owner: 'devhotel',
    installId: 'install-owned',
    runtimeId: 'runtime-owned',
    updateId: 'b5e0b3ee-0000-4000-8000-00000000abcd',
    fromVersion: PREVIOUS_RUNTIME_VERSION,
    toVersion: MANAGED_HYPERV_RUNTIME_VERSION,
    fromArtifactDigests: { [MANAGED_HYPERV_BOOT_ISO.id]: MANAGED_HYPERV_BOOT_ISO.sha256 },
    createdAt: '2026-09-17T00:00:00.000Z',
    updatedAt: '2026-09-17T00:00:00.000Z',
    ...overrides
  }
  await writeFile(path.join(root, MANAGED_RUNTIME_UPDATE_FILE), `${JSON.stringify(journal, null, 2)}\n`, 'utf8')
}

async function readJournal(userData: string): Promise<ManagedRuntimeUpdateJournal | null> {
  const file = path.join(userData, 'runtime', 'managed-linux', MANAGED_RUNTIME_UPDATE_FILE)
  if (!existsSync(file)) return null
  return JSON.parse(await readFile(file, 'utf8')) as ManagedRuntimeUpdateJournal
}

/**
 * A provider fleet the way the real factory builds one: a separate provider per
 * manifest, each pinned to the version that manifest names. That is the seam a
 * version change actually turns on, so faking anything coarser would prove
 * nothing about it.
 */
function versionedProviders(opts: { unhealthy?: readonly string[] } = {}): {
  factory: (manifest: ManagedRuntimeManifest) => ManagedRuntimeProviderController
  migrations: string[]
  repaired: string[]
  pruned: number
} {
  const fleet = {
    migrations: [] as string[],
    repaired: [] as string[],
    pruned: 0,
    factory: (current: ManagedRuntimeManifest): ManagedRuntimeProviderController => ({
      observe: vi.fn(async () => readyProviderObservation(current.runtimeVersion)),
      provision: vi.fn(async () => {
        throw new Error('an update must migrate an existing runtime, never provision over it')
      }),
      migrateFrom: vi.fn(async (fromVersion: string) => {
        fleet.migrations.push(`${fromVersion}->${current.runtimeVersion}`)
        return {} as never
      }),
      repair: vi.fn(async () => {
        if (opts.unhealthy?.includes(current.runtimeVersion)) throw new Error('guest never became healthy')
        fleet.repaired.push(current.runtimeVersion)
        return readyProviderObservation(current.runtimeVersion)
      }),
      stop: vi.fn(async () => ({ ...readyProviderObservation(current.runtimeVersion), state: 'stopped' as const })),
      remove: vi.fn(async (): Promise<ManagedHyperVRemovalOutcome> => 'removed'),
      pruneUnreferencedImages: vi.fn(async () => {
        fleet.pruned += 1
        return 1
      })
    })
  }
  return fleet
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
      // The version this install has is read before anything is provisioned:
      // it is what decides between "stand this up" and "update it".
      'readManifest',
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
  it('updates an older install to the shipped runtime, keeping its identity and Room state', async () => {
    const userData = await tempDir()
    const bootstrap = new FakeBootstrap()
    bootstrap.current = { ...manifest('ready'), runtimeVersion: PREVIOUS_RUNTIME_VERSION }
    const fleet = versionedProviders()
    const manager = new ManagedRuntimeManager({
      userData,
      installId: 'install-owned',
      windowsFeature: completedWindowsFeature,
      bootstrap,
      downloadArtifact: vi.fn(async () => downloaded),
      providerFactory: fleet.factory
    })

    const observation = await manager.prepare()

    expect(observation).toMatchObject({ state: 'ready', runtimeVersion: MANAGED_HYPERV_RUNTIME_VERSION })
    // The runtime the install owns is the same runtime, moved: a new identity
    // would mean a new state disk, and a new state disk means no Rooms.
    expect(observation.runtimeId).toBe('runtime-owned')
    expect(fleet.migrations).toEqual([`${PREVIOUS_RUNTIME_VERSION}->${MANAGED_HYPERV_RUNTIME_VERSION}`])
    expect(bootstrap.current).toMatchObject({ status: 'ready', runtimeVersion: MANAGED_HYPERV_RUNTIME_VERSION })
    // Committed updates leave nothing behind to explain.
    expect(await readJournal(userData)).toBeNull()
    expect(fleet.pruned).toBe(1)
  })

  it('rolls an install back to the runtime that worked when the new one will not come up', async () => {
    const userData = await tempDir()
    const bootstrap = new FakeBootstrap()
    bootstrap.current = { ...manifest('ready'), runtimeVersion: PREVIOUS_RUNTIME_VERSION }
    const fleet = versionedProviders({ unhealthy: [MANAGED_HYPERV_RUNTIME_VERSION] })
    const manager = new ManagedRuntimeManager({
      userData,
      installId: 'install-owned',
      windowsFeature: completedWindowsFeature,
      bootstrap,
      downloadArtifact: vi.fn(async () => downloaded),
      providerFactory: fleet.factory
    })

    const observation = await manager.prepare()

    expect(observation).toMatchObject({ state: 'ready', runtimeVersion: PREVIOUS_RUNTIME_VERSION })
    expect(fleet.migrations).toEqual([
      `${PREVIOUS_RUNTIME_VERSION}->${MANAGED_HYPERV_RUNTIME_VERSION}`,
      `${MANAGED_HYPERV_RUNTIME_VERSION}->${PREVIOUS_RUNTIME_VERSION}`
    ])
    expect(observation.update).toMatchObject({
      stage: 'rolled-back',
      fromVersion: PREVIOUS_RUNTIME_VERSION,
      toVersion: MANAGED_HYPERV_RUNTIME_VERSION,
      failure: 'guest never became healthy'
    })
    // The image the old runtime boots from is still needed, so nothing is
    // pruned on a rollback.
    expect(fleet.pruned).toBe(0)
  })

  it('does not walk back into an update that already failed, across a restart', async () => {
    const userData = await tempDir()
    const bootstrap = new FakeBootstrap()
    bootstrap.current = { ...manifest('ready'), runtimeVersion: PREVIOUS_RUNTIME_VERSION }
    const shared = { manifest: bootstrap.current }
    const first = versionedProviders({ unhealthy: [MANAGED_HYPERV_RUNTIME_VERSION] })
    await new ManagedRuntimeManager({
      userData,
      installId: 'install-owned',
      windowsFeature: completedWindowsFeature,
      bootstrap,
      downloadArtifact: vi.fn(async () => downloaded),
      providerFactory: first.factory
    }).prepare()
    shared.manifest = bootstrap.current

    // A fresh manager over the same data root is exactly what the next launch,
    // or the reboot after it, brings.
    const second = versionedProviders({ unhealthy: [MANAGED_HYPERV_RUNTIME_VERSION] })
    const observation = await new ManagedRuntimeManager({
      userData,
      installId: 'install-owned',
      windowsFeature: completedWindowsFeature,
      bootstrap,
      downloadArtifact: vi.fn(async () => downloaded),
      providerFactory: second.factory
    }).prepare()

    expect(shared.manifest.runtimeVersion).toBe(PREVIOUS_RUNTIME_VERSION)
    expect(observation).toMatchObject({ state: 'ready', runtimeVersion: PREVIOUS_RUNTIME_VERSION })
    // No second attempt at the update, and the working runtime is still started.
    expect(second.migrations).toEqual([])
    expect(second.repaired).toEqual([PREVIOUS_RUNTIME_VERSION])
    expect(observation.update).toMatchObject({ stage: 'rolled-back', attempts: 1 })
  })

  it('retries an update that was interrupted before it touched the Host', async () => {
    const userData = await tempDir()
    // Staging touches nothing: the previous process died while downloading, so
    // the install is exactly where it was and the update is simply re-run.
    await writeJournal(userData, { stage: 'staging', attempts: 1 })
    const bootstrap = new FakeBootstrap()
    bootstrap.current = { ...manifest('ready'), runtimeVersion: PREVIOUS_RUNTIME_VERSION }
    const fleet = versionedProviders()

    const observation = await new ManagedRuntimeManager({
      userData,
      installId: 'install-owned',
      windowsFeature: completedWindowsFeature,
      bootstrap,
      downloadArtifact: vi.fn(async () => downloaded),
      providerFactory: fleet.factory
    }).prepare()

    expect(observation).toMatchObject({ state: 'ready', runtimeVersion: MANAGED_HYPERV_RUNTIME_VERSION })
    expect(fleet.migrations).toEqual([`${PREVIOUS_RUNTIME_VERSION}->${MANAGED_HYPERV_RUNTIME_VERSION}`])
    expect(await readJournal(userData)).toBeNull()
  })

  it('finishes an update whose migration landed but whose health proof never did', async () => {
    const userData = await tempDir()
    // What a Host that lost power between the migration and the health check
    // leaves behind: a journal mid-apply and a manifest already on the target.
    await writeJournal(userData, { stage: 'applying', attempts: 1 })
    const bootstrap = new FakeBootstrap()
    bootstrap.current = {
      ...manifest('provisioning-runtime-provider'),
      runtimeVersion: MANAGED_HYPERV_RUNTIME_VERSION
    }
    const fleet = versionedProviders()

    const observation = await new ManagedRuntimeManager({
      userData,
      installId: 'install-owned',
      windowsFeature: completedWindowsFeature,
      bootstrap,
      downloadArtifact: vi.fn(async () => downloaded),
      providerFactory: fleet.factory
    }).prepare()

    expect(observation).toMatchObject({ state: 'ready', runtimeVersion: MANAGED_HYPERV_RUNTIME_VERSION })
    // Finished forward, never migrated again: the version swap had landed, and
    // re-running a migration over it would be the destructive answer.
    expect(fleet.migrations).toEqual([])
    expect(fleet.repaired).toEqual([MANAGED_HYPERV_RUNTIME_VERSION])
    expect(await readJournal(userData)).toBeNull()
  })

  it('gives up and restores the previous runtime after repeated interrupted attempts', async () => {
    const userData = await tempDir()
    await writeJournal(userData, { stage: 'applying', attempts: 2 })
    const bootstrap = new FakeBootstrap()
    bootstrap.current = {
      ...manifest('provisioning-runtime-provider'),
      runtimeVersion: MANAGED_HYPERV_RUNTIME_VERSION
    }
    // The target would come up healthy this time — and it is still put back,
    // because a Host that cannot survive this update twice has already cost the
    // user two launches without a runtime.
    const fleet = versionedProviders()

    const observation = await new ManagedRuntimeManager({
      userData,
      installId: 'install-owned',
      windowsFeature: completedWindowsFeature,
      bootstrap,
      downloadArtifact: vi.fn(async () => downloaded),
      providerFactory: fleet.factory
    }).prepare()

    expect(observation).toMatchObject({ state: 'ready', runtimeVersion: PREVIOUS_RUNTIME_VERSION })
    expect(fleet.migrations).toEqual([`${MANAGED_HYPERV_RUNTIME_VERSION}->${PREVIOUS_RUNTIME_VERSION}`])
    expect(observation.update).toMatchObject({ stage: 'rolled-back', attempts: 2 })
  })

  it('stops and keeps the runtime for an app-only removal, and deletes it for a complete one', async () => {
    const bootstrap = new FakeBootstrap()
    bootstrap.current = manifest('ready')
    const hyperv = provider()
    const manager = new ManagedRuntimeManager({
      userData: 'C:\\DevHotelData',
      installId: 'install-owned',
      windowsFeature: completedWindowsFeature,
      bootstrap,
      providerFactory: () => hyperv
    })

    await expect(manager.remove('app-only')).resolves.toBe('preserved')
    expect(hyperv.stop).toHaveBeenCalledOnce()
    expect(hyperv.remove).not.toHaveBeenCalled()

    await expect(manager.remove('complete')).resolves.toBe('removed')
    expect(hyperv.remove).toHaveBeenCalledOnce()
  })

  it('reports nothing owned rather than stopping a runtime this Host never had', async () => {
    const bootstrap = new FakeBootstrap()
    bootstrap.current = manifest('ready')
    const hyperv = provider({
      observe: vi.fn(async () => ({ ...readyProviderObservation(), state: 'not-installed' as const }))
    })
    const manager = new ManagedRuntimeManager({
      userData: 'C:\\DevHotelData',
      installId: 'install-owned',
      windowsFeature: completedWindowsFeature,
      bootstrap,
      providerFactory: () => hyperv
    })

    await expect(manager.remove('app-only')).resolves.toBe('nothing-owned')
    expect(hyperv.stop).not.toHaveBeenCalled()
  })
})
