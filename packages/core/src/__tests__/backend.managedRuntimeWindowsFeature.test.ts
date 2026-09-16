import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MANAGED_RUNTIME_WINDOWS_FEATURES,
  ManagedRuntimeWindowsFeatureHarness,
  type ManagedRuntimeFeatureRecord
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
  elevatedResult?: { Ok: boolean; RestartNeeded: boolean; Error?: string } | null
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
          Elevated: false
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
