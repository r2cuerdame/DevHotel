import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MANAGED_RUNTIME_WINDOWS_FEATURES,
  ManagedRuntimeWindowsFeatureHarness,
  classifyWindowsFeatureFailure,
  type ManagedRuntimeFeatureRecord,
  type ManagedRuntimeVirtualizationPolicy
} from '../backend/managedRuntimeWindowsFeature'
import type { ManagedRuntimeCommandRunner } from '../backend/managedRuntime'

const temps: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'devhotel-windows-feature-'))
  temps.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function decodeScript(args: readonly string[]): string {
  expect(args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'])
  return Buffer.from(args[5]!, 'base64').toString('utf16le')
}

/** Recovers the elevated child's script from the literals the outer script passes to Start-Process. */
function decodeElevatedScript(outer: string): string {
  const match = outer.match(/\$psArgs=@\((.+?)\);\$p=Start-Process/s)
  if (!match) throw new Error('outer script did not pass elevated arguments')
  const literals = [...match[1]!.matchAll(/'((?:''|[^'])*)'/g)].map((entry) => entry[1]!.replaceAll("''", "'"))
  return Buffer.from(literals[literals.length - 1]!, 'base64').toString('utf16le')
}

interface FakeWindowsOptions {
  featureState?: string
  caption?: string
  /** Result the elevated child writes, or `null` to write nothing. */
  elevatedResult?: { Ok: boolean; RestartNeeded: boolean; Error?: string; HResult?: number } | null
  /** Servicing policy this fake Host reports; absent means an unmanaged Host. */
  policy?: { Wsus?: boolean; RepairRestricted?: boolean; LocalSource?: boolean; Readable?: boolean }
  /**
   * Which source answered for the feature states. `cim` is the unelevated
   * fallback a real DevHotel launch actually gets, because the DISM online
   * query requires elevation the app does not have.
   */
  featureRead?: 'dism' | 'cim' | 'none'
  /** Non-zero simulates a declined UAC prompt. */
  elevatedExitCode?: number
}

/**
 * Models the part of Windows this harness depends on: DISM reports
 * `EnablePending` between an enable with `-NoRestart` and the restart, and the
 * boot identity only changes when the Host actually restarts.
 */
class FakeWindows {
  readonly scripts: string[] = []
  readonly elevatedScripts: string[] = []
  featureState: string
  bootId = 'boot-1'

  constructor(private readonly opts: FakeWindowsOptions & { resultPath: string }) {
    this.featureState = opts.featureState ?? 'Disabled'
  }

  /** Simulates the user restarting Windows, which activates a pending feature. */
  restart(): void {
    this.bootId = `boot-${Number(this.bootId.split('-')[1]) + 1}`
    if (this.featureState === 'EnablePending') this.featureState = 'Enabled'
  }

  get elevations(): number {
    return this.elevatedScripts.length
  }

  readonly runner: ManagedRuntimeCommandRunner = async (executable, args) => {
    expect(executable).toBe('powershell.exe')
    const script = decodeScript(args)
    this.scripts.push(script)

    if (script.includes('Get-WindowsOptionalFeature')) {
      const states: Record<string, string> = {}
      for (const feature of MANAGED_RUNTIME_WINDOWS_FEATURES) states[feature] = this.featureState
      return {
        code: 0,
        stdout: JSON.stringify({
          Features: states,
          Edition: this.opts.caption ?? 'Microsoft Windows 11 Pro',
          Sku: 48,
          BootId: this.bootId,
          Elevated: false,
          Policy: {
            Wsus: this.opts.policy?.Wsus ?? false,
            RepairRestricted: this.opts.policy?.RepairRestricted ?? false,
            LocalSource: this.opts.policy?.LocalSource ?? false,
            Readable: this.opts.policy?.Readable ?? true
          },
          FeatureRead: this.opts.featureRead ?? 'dism'
        }),
        stderr: ''
      }
    }

    if (script.includes('Start-Process')) {
      this.elevatedScripts.push(decodeElevatedScript(script))
      if ((this.opts.elevatedExitCode ?? 0) !== 0) {
        return { code: 1, stdout: '', stderr: 'The operation was canceled by the user.' }
      }
      const result = this.opts.elevatedResult === undefined ? { Ok: true, RestartNeeded: true } : this.opts.elevatedResult
      if (result) {
        if (result.Ok) this.featureState = result.RestartNeeded ? 'EnablePending' : 'Enabled'
        await writeFile(this.opts.resultPath, JSON.stringify(result), 'utf8')
      }
      return { code: 0, stdout: JSON.stringify({ ExitCode: 0 }), stderr: '' }
    }

    throw new Error(`unexpected script: ${script}`)
  }
}

async function harness(opts: FakeWindowsOptions = {}): Promise<{
  userData: string
  fake: FakeWindows
  subject: ManagedRuntimeWindowsFeatureHarness
  record: () => Promise<ManagedRuntimeFeatureRecord | null>
}> {
  const userData = await tempDir()
  const resultPath = path.join(userData, 'runtime', 'managed-linux', 'windows-feature-result.json')
  const fake = new FakeWindows({ ...opts, resultPath })
  const subject = new ManagedRuntimeWindowsFeatureHarness({
    userData,
    installId: 'install-abcdef01',
    platform: 'win32',
    runner: fake.runner
  })
  return { userData, fake, subject, record: () => subject.readRecord() }
}

describe('managed runtime Windows feature harness', () => {
  it('reports an elevation gate when the Hyper-V features are not enabled', async () => {
    const { subject } = await harness({ featureState: 'Disabled' })
    const observation = await subject.observe()
    expect(observation.stage).toBe('elevation-required')
    expect(observation.missing).toEqual([...MANAGED_RUNTIME_WINDOWS_FEATURES])
    expect(observation.restartRequired).toBe(false)
  })

  it('reports completion without mutating Windows when the features are already enabled', async () => {
    const { subject, fake } = await harness({ featureState: 'Enabled' })
    const observation = await subject.observe()
    expect(observation.stage).toBe('completed')
    expect(observation.missing).toEqual([])
    expect(fake.elevations).toBe(0)
  })

  it('refuses the managed runtime on a Windows edition that does not offer Hyper-V', async () => {
    const { subject, fake } = await harness({ featureState: 'Absent', caption: 'Microsoft Windows 11 Home' })
    const observation = await subject.observe()
    expect(observation.stage).toBe('unsupported-edition')
    expect(observation.edition).toBe('Microsoft Windows 11 Home')

    const enabled = await subject.enable()
    expect(enabled.stage).toBe('unsupported-edition')
    expect(fake.elevations).toBe(0)
  })

  it('records an awaiting-restart gate after one elevated enable and never reboots the Host', async () => {
    const { subject, fake, record } = await harness({ featureState: 'Disabled' })

    const observation = await subject.enable()
    expect(observation.stage).toBe('awaiting-restart')
    expect(observation.restartRequired).toBe(true)

    const stored = await record()
    expect(stored?.stage).toBe('awaiting-restart')
    expect(stored?.bootId).toBe('boot-1')

    const elevated = fake.elevatedScripts.join('\n')
    expect(elevated).toContain('Enable-WindowsOptionalFeature')
    expect(elevated).toContain('-NoRestart')
    expect(fake.scripts.concat(fake.elevatedScripts).join('\n')).not.toMatch(/Restart-Computer|shutdown\.exe|shutdown\s+\/r/i)
  })

  it('does not prompt again while the earned restart is still pending', async () => {
    const { subject, fake } = await harness({ featureState: 'Disabled' })

    await subject.enable()
    expect(fake.elevations).toBe(1)
    expect(fake.featureState).toBe('EnablePending')

    const again = await subject.enable()
    expect(again.stage).toBe('awaiting-restart')
    expect(fake.elevations).toBe(1)
  })

  it('still reports the pending restart when the local record is lost', async () => {
    const { subject, fake, userData } = await harness({ featureState: 'Disabled' })
    await subject.enable()
    await rm(path.join(userData, 'runtime', 'managed-linux', 'windows-feature.json'), { force: true })

    const observation = await subject.observe()
    expect(observation.stage).toBe('awaiting-restart')
    expect(observation.restartRequired).toBe(true)
    expect(fake.elevations).toBe(1)
  })

  it('resumes to completed once the Host has actually restarted', async () => {
    const { subject, fake, record } = await harness({ featureState: 'Disabled' })
    await subject.enable()
    expect((await record())?.stage).toBe('awaiting-restart')

    fake.restart()

    const resumed = await subject.observe()
    expect(resumed.stage).toBe('completed')
    expect(resumed.restartRequired).toBe(false)
    expect((await record())?.stage).toBe('completed')
    expect(fake.elevations).toBe(1)
  })

  it('completes without a restart when Windows does not ask for one', async () => {
    const { subject, fake } = await harness({
      featureState: 'Disabled',
      elevatedResult: { Ok: true, RestartNeeded: false }
    })
    const observation = await subject.enable()
    expect(observation.stage).toBe('completed')
    expect(observation.restartRequired).toBe(false)
    expect(fake.elevations).toBe(1)
  })

  it('records a declined elevation as retryable rather than failing the app', async () => {
    const { subject, fake, record } = await harness({ featureState: 'Disabled', elevatedExitCode: 1 })

    const observation = await subject.enable()
    expect(observation.stage).toBe('failed')
    expect(observation.failure).toContain('declined')
    expect((await record())?.stage).toBe('failed')
    expect(fake.featureState).toBe('Disabled')

    const retry = await subject.enable()
    expect(fake.elevations).toBe(2)
    expect(retry.stage).toBe('failed')
  })

  it('records an elevated enable failure with the Windows reason', async () => {
    const { subject, record } = await harness({
      featureState: 'Disabled',
      elevatedResult: { Ok: false, RestartNeeded: false, Error: 'Feature name Microsoft-Hyper-V-All is unknown.' }
    })
    const observation = await subject.enable()
    expect(observation.stage).toBe('failed')
    expect(observation.failure).toContain('Microsoft-Hyper-V-All')
    expect((await record())?.failure).toContain('Microsoft-Hyper-V-All')
  })

  it('treats a missing elevated result as a failure instead of silent success', async () => {
    const { subject } = await harness({ featureState: 'Disabled', elevatedResult: null })
    const observation = await subject.enable()
    expect(observation.stage).toBe('failed')
    expect(observation.failure).toContain('no result')
  })

  it('rejects a feature record belonging to a different installation', async () => {
    const { subject, userData } = await harness({ featureState: 'Disabled' })
    await subject.enable()
    const recordPath = path.join(userData, 'runtime', 'managed-linux', 'windows-feature.json')
    const forged = JSON.parse(await readFile(recordPath, 'utf8')) as ManagedRuntimeFeatureRecord
    await writeFile(recordPath, JSON.stringify({ ...forged, installId: 'install-someoneelse' }), 'utf8')

    await expect(subject.readRecord()).rejects.toThrow(/installation identity changed/i)
  })

  it('never enables a feature outside the declared Hyper-V set', async () => {
    const { subject, fake } = await harness({ featureState: 'Disabled' })
    await subject.enable()
    const elevated = fake.elevatedScripts[0]
    expect(elevated).toBeDefined()
    for (const feature of MANAGED_RUNTIME_WINDOWS_FEATURES) expect(elevated).toContain(feature)
    expect(elevated).not.toMatch(/Microsoft-Windows-Subsystem-Linux|Containers-DisposableClientVM|VirtualMachinePlatform/)
  })

  it('reports a probe failure instead of guessing the Host state', async () => {
    const userData = await tempDir()
    const subject = new ManagedRuntimeWindowsFeatureHarness({
      userData,
      installId: 'install-abcdef01',
      platform: 'win32',
      runner: async () => ({ code: 1, stdout: '', stderr: 'access denied' })
    })
    const observation = await subject.observe()
    expect(observation.stage).toBe('failed')
    expect(observation.missing).toEqual([...MANAGED_RUNTIME_WINDOWS_FEATURES])
  })

  it('refuses to inspect a non-Windows Host', async () => {
    const userData = await tempDir()
    const subject = new ManagedRuntimeWindowsFeatureHarness({
      userData,
      installId: 'install-abcdef01',
      platform: 'linux',
      runner: async () => ({ code: 0, stdout: '{}', stderr: '' })
    })
    await expect(subject.inspect()).rejects.toThrow(/Windows 11/)
  })
})

/**
 * The enterprise case #111 names: a Host where the user *can* elevate and
 * Windows still refuses, because an administrator decided the answer. The
 * distinction that matters is retryable vs. not — a policy refusal must never
 * be dressed up as a failed attempt with a button next to it.
 */
/**
 * DevHotel runs unelevated, so `Get-WindowsOptionalFeature -Online` — a DISM
 * online operation — is refused on every ordinary launch. Reading that refusal
 * as "Absent" is what made a Host that had already enabled Hyper-V, and already
 * restarted for it, ask for the same approval again.
 */
describe('managed runtime Windows feature state without elevation', () => {
  it('resumes to completed across the restart when only the unelevated read is available', async () => {
    const { subject, fake } = await harness({ featureState: 'Disabled', featureRead: 'cim' })
    await subject.enable()
    expect((await subject.observe()).stage).toBe('awaiting-restart')

    // Windows restarts. The unelevated read now reports the feature enabled;
    // it never reported EnablePending, because CIM cannot express it.
    fake.featureState = 'Enabled'
    fake.restart()

    const resumed = await subject.observe()
    expect(resumed.stage).toBe('completed')
    // One approval for one piece of work: the restart must not cost a second.
    expect(fake.elevations).toBe(1)
  })

  it('does not call an un-restarted Host ready when the unelevated read cannot see the pending restart', async () => {
    const { subject, fake } = await harness({ featureState: 'Disabled', featureRead: 'cim' })
    await subject.enable()

    // CIM reports the feature enabled the moment DISM stages it, with the
    // restart still outstanding. The recorded boot identity is what proves it.
    fake.featureState = 'Enabled'

    const observation = await subject.observe()
    expect(observation.stage).toBe('awaiting-restart')
    expect(observation.restartRequired).toBe(true)
  })

  it('reports which source answered so a pending restart is never inferred from CIM', async () => {
    const dism = await harness({ featureState: 'Enabled' })
    expect((await dism.subject.inspect()).featureRead).toBe('dism')

    const cim = await harness({ featureState: 'Enabled', featureRead: 'cim' })
    expect((await cim.subject.inspect()).featureRead).toBe('cim')
  })
})

describe('managed runtime Windows feature policy refusals', () => {
  const unmanaged: ManagedRuntimeVirtualizationPolicy = {
    wsusManaged: false,
    repairSourceRestricted: false,
    localSourceConfigured: false,
    readable: true
  }

  it('classifies the DISM source HRESULTs an administrator policy produces', () => {
    for (const hresult of [0x800f0906, 0x800f0954, 0x800f081f, 0x80070005]) {
      expect(classifyWindowsFeatureFailure(hresult, 'Enable-WindowsOptionalFeature failed', unmanaged)).toMatch(
        /Ask whoever manages this machine/
      )
    }
  })

  it('reads a negative signed HRESULT as the unsigned code Windows meant', () => {
    // PowerShell surfaces 0x80070005 as -2147024891 through Exception.HResult.
    expect(classifyWindowsFeatureFailure(-2147024891, 'denied', unmanaged)).not.toBeNull()
  })

  it('leaves an ordinary failure retryable', () => {
    expect(classifyWindowsFeatureFailure(0x800f0922, 'A rollback occurred', unmanaged)).toBeNull()
    expect(classifyWindowsFeatureFailure(null, 'The download timed out', unmanaged)).toBeNull()
  })

  it('recognises a policy refusal from Windows wording when no HRESULT arrives', () => {
    expect(classifyWindowsFeatureFailure(null, 'This setting is managed by your system administrator', unmanaged)).toMatch(
      /Ask whoever manages this machine/
    )
  })

  it('names the managed servicing source when the Host has one', () => {
    const managed: ManagedRuntimeVirtualizationPolicy = { ...unmanaged, wsusManaged: true }
    expect(classifyWindowsFeatureFailure(0x800f0954, 'failed', managed)).toMatch(/servicing source is set by administrator policy/)
    expect(classifyWindowsFeatureFailure(0x800f0954, 'failed', unmanaged)).not.toMatch(/servicing source/)
  })

  it('treats an unreadable policy surface as no finding rather than as a managed Host', () => {
    const unreadable: ManagedRuntimeVirtualizationPolicy = { ...unmanaged, wsusManaged: true, readable: false }
    expect(classifyWindowsFeatureFailure(0x800f0954, 'failed', unreadable)).not.toMatch(/servicing source/)
  })

  it('records a policy refusal as blocked-by-policy, not as a failed attempt', async () => {
    const { subject, record } = await harness({
      featureState: 'Disabled',
      elevatedResult: { Ok: false, RestartNeeded: false, Error: 'DISM failed', HResult: 0x800f0954 },
      policy: { Wsus: true, Readable: true }
    })

    const observation = await subject.enable()
    expect(observation.stage).toBe('blocked-by-policy')
    expect(observation.restartRequired).toBe(false)
    expect(observation.detail).toMatch(/servicing source is set by administrator policy/)

    const stored = await record()
    expect(stored?.stage).toBe('blocked-by-policy')
    // The raw Windows text is kept for diagnostics but is not the user's sentence.
    expect(stored?.failure).toBe('DISM failed')
    expect(stored?.policyReason).not.toContain('DISM failed')
  })

  it('keeps reporting the refusal on the next launch without asking for approval again', async () => {
    const { subject, fake } = await harness({
      featureState: 'Disabled',
      elevatedResult: { Ok: false, RestartNeeded: false, Error: 'DISM failed', HResult: 0x800f0906 },
      policy: { Wsus: true, Readable: true }
    })
    await subject.enable()
    const elevations = fake.elevations

    const observation = await subject.observe()
    expect(observation.stage).toBe('blocked-by-policy')
    expect(fake.elevations).toBe(elevations)
  })

  it('still reports a non-policy failure as failed and therefore retryable', async () => {
    const { subject } = await harness({
      featureState: 'Disabled',
      elevatedResult: { Ok: false, RestartNeeded: false, Error: 'The download timed out', HResult: 0x800f0922 },
      policy: { Readable: true }
    })
    const observation = await subject.enable()
    expect(observation.stage).toBe('failed')
  })

  it('clears a recorded refusal once an administrator has enabled the features', async () => {
    const { subject, fake } = await harness({
      featureState: 'Disabled',
      elevatedResult: { Ok: false, RestartNeeded: false, Error: 'DISM failed', HResult: 0x800f0954 },
      policy: { Wsus: true, Readable: true }
    })
    expect((await subject.enable()).stage).toBe('blocked-by-policy')

    // The administrator lifts the policy and enables Hyper-V out of band.
    fake.featureState = 'Enabled'
    expect((await subject.observe()).stage).toBe('completed')
  })

  it('reports an unmanaged Host as unmanaged rather than assuming policy', async () => {
    const { subject } = await harness({ featureState: 'Disabled' })
    const inspection = await subject.inspect()
    expect(inspection.policy).toEqual({
      wsusManaged: false,
      repairSourceRestricted: false,
      localSourceConfigured: false,
      readable: true
    })
  })
})
