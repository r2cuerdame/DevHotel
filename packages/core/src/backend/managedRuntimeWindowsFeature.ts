import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ManagedRuntimeCommandResult, ManagedRuntimeCommandRunner } from './managedRuntime'

/**
 * Windows optional features the managed Hyper-V provider requires. The
 * umbrella feature pulls in the hypervisor, the management services and the
 * PowerShell module the provider drives; DevHotel never enables anything
 * outside this list.
 */
export const MANAGED_RUNTIME_WINDOWS_FEATURES = ['Microsoft-Hyper-V-All'] as const

const RECORD_FILE = 'windows-feature.json'
const RESULT_FILE = 'windows-feature-result.json'
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'] as const

/**
 * `pending` is what DISM reports between `Enable-WindowsOptionalFeature
 * -NoRestart` and the restart that actually activates the feature. Treating it
 * as enabled would start the provider against a hypervisor that is not running
 * yet; treating it as disabled would ask for elevation a second time.
 */
export type ManagedRuntimeFeatureState = 'enabled' | 'pending' | 'disabled' | 'absent'

export interface ManagedRuntimeWindowsEdition {
  /** Windows edition identifier, e.g. `Professional`. */
  edition: string
  /** Hyper-V is not offered on Home editions; this is a hard acceptance gate. */
  supportsHyperV: boolean
}

export interface ManagedRuntimeWindowsFeatureInspection {
  features: Record<string, ManagedRuntimeFeatureState>
  edition: ManagedRuntimeWindowsEdition
  /** Opaque host boot identity used to prove a restart actually happened. */
  bootId: string
  elevated: boolean
}

export type ManagedRuntimeFeatureStage =
  | 'not-required'
  | 'elevation-required'
  | 'awaiting-restart'
  | 'completed'
  | 'unsupported-edition'
  | 'failed'

export interface ManagedRuntimeFeatureRecord {
  schemaVersion: 1
  owner: 'devhotel'
  installId: string
  stage: Exclude<ManagedRuntimeFeatureStage, 'not-required'>
  features: readonly string[]
  /** Boot identity captured when a restart became required. */
  bootId: string | null
  requestedAt: string
  updatedAt: string
  failure?: string
}

export interface ManagedRuntimeFeatureObservation {
  stage: ManagedRuntimeFeatureStage
  /** Features still disabled or absent on this Host. */
  missing: readonly string[]
  /** True once DevHotel has enabled the features and only a restart remains. */
  restartRequired: boolean
  edition: string | null
  detail: string
  failure?: string
}

export interface ManagedRuntimeWindowsFeatureOptions {
  userData: string
  installId: string
  platform?: NodeJS.Platform
  runner?: ManagedRuntimeCommandRunner
  now?: () => Date
}

function psLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function encodedPowerShell(script: string): string[] {
  return [...POWERSHELL_ARGS, Buffer.from(script, 'utf16le').toString('base64')]
}

function parseJsonRecord(stdout: string, message: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(stdout.trim())
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
    return value as Record<string, unknown>
  } catch {
    throw new Error(message)
  }
}

function readFeatureState(value: unknown): ManagedRuntimeFeatureState {
  const text = typeof value === 'string' ? value.toLocaleLowerCase('en-US') : ''
  if (text === 'enabled') return 'enabled'
  if (text === 'enablepending') return 'pending'
  if (text === 'disabled' || text === 'disabledwithpayloadremoved' || text === 'disablepending') return 'disabled'
  return 'absent'
}

function validateRecord(value: unknown, installId: string): ManagedRuntimeFeatureRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Managed runtime Windows feature record is invalid')
  }
  const record = value as Partial<ManagedRuntimeFeatureRecord>
  if (
    record.schemaVersion !== 1 ||
    record.owner !== 'devhotel' ||
    typeof record.installId !== 'string' ||
    !['elevation-required', 'awaiting-restart', 'completed', 'unsupported-edition', 'failed'].includes(record.stage ?? '') ||
    !Array.isArray(record.features) ||
    record.features.some((feature) => typeof feature !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(feature)) ||
    (record.bootId !== null && typeof record.bootId !== 'string') ||
    typeof record.requestedAt !== 'string' ||
    typeof record.updatedAt !== 'string'
  ) {
    throw new Error('Managed runtime Windows feature record is invalid')
  }
  if (record.installId !== installId) throw new Error('Managed runtime installation identity changed')
  return record as ManagedRuntimeFeatureRecord
}

/**
 * Owns the one Host mutation DevHotel cannot avoid on a clean Windows 11 VM:
 * turning on the Hyper-V optional features, through a single consented
 * elevation, and resuming across the restart Windows demands afterwards.
 *
 * The harness never reboots the Host, never schedules a reboot and never
 * re-prompts while a restart it already earned is still pending. A restart is
 * proven by a change in the Host boot identity, not by elapsed time, so a user
 * who defers the reboot is never asked to elevate twice for the same work.
 */
export class ManagedRuntimeWindowsFeatureHarness {
  private readonly root: string
  private readonly recordPath: string
  private readonly resultPath: string
  private readonly installId: string
  private readonly platform: NodeJS.Platform
  private readonly runner: ManagedRuntimeCommandRunner
  private readonly now: () => Date

  constructor(opts: ManagedRuntimeWindowsFeatureOptions) {
    this.root = path.resolve(opts.userData, 'runtime', 'managed-linux')
    this.recordPath = path.join(this.root, RECORD_FILE)
    this.resultPath = path.join(this.root, RESULT_FILE)
    this.installId = opts.installId
    this.platform = opts.platform ?? process.platform
    this.runner = opts.runner ?? defaultRunner
    this.now = opts.now ?? (() => new Date())
  }

  async inspect(): Promise<ManagedRuntimeWindowsFeatureInspection> {
    if (this.platform !== 'win32') throw new Error('The managed local runtime currently targets Windows 11.')
    const names = MANAGED_RUNTIME_WINDOWS_FEATURES.map((feature) => psLiteral(feature)).join(',')
    const script = [
      `$names=@(${names})`,
      '$states=@{}',
      'foreach ($n in $names) { $f=Get-WindowsOptionalFeature -Online -FeatureName $n -ErrorAction SilentlyContinue; $states[$n]=if ($f) { [string]$f.State } else { "Absent" } }',
      '$os=Get-CimInstance Win32_OperatingSystem',
      '$edition=(Get-CimInstance Win32_OperatingSystem).OperatingSystemSKU',
      '$name=[string]$os.Caption',
      '$identity=[Security.Principal.WindowsIdentity]::GetCurrent()',
      '$elevated=(New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
      '[pscustomobject]@{Features=$states;Edition=$name;Sku=$edition;BootId=([string]$os.LastBootUpTime);Elevated=[bool]$elevated}|ConvertTo-Json -Compress -Depth 4'
    ].join(';')
    const result = await this.runner('powershell.exe', encodedPowerShell(script))
    if (result.code !== 0) throw new Error('Windows optional feature inspection failed')
    const value = parseJsonRecord(result.stdout, 'Windows optional feature inspection returned invalid evidence')
    const rawFeatures = value['Features']
    if (!rawFeatures || typeof rawFeatures !== 'object' || Array.isArray(rawFeatures)) {
      throw new Error('Windows optional feature inspection returned invalid evidence')
    }
    const features: Record<string, ManagedRuntimeFeatureState> = {}
    for (const feature of MANAGED_RUNTIME_WINDOWS_FEATURES) {
      features[feature] = readFeatureState((rawFeatures as Record<string, unknown>)[feature])
    }
    const caption = typeof value['Edition'] === 'string' ? value['Edition'] : ''
    return {
      features,
      edition: { edition: caption, supportsHyperV: !/\bhome\b/i.test(caption) },
      bootId: typeof value['BootId'] === 'string' ? value['BootId'] : '',
      elevated: value['Elevated'] === true
    }
  }

  async readRecord(): Promise<ManagedRuntimeFeatureRecord | null> {
    if (!existsSync(this.recordPath)) return null
    const info = await lstat(this.recordPath)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Managed runtime Windows feature record is not a regular file')
    return validateRecord(JSON.parse(await readFile(this.recordPath, 'utf8')), this.installId)
  }

  /**
   * Reports the Host feature gate without mutating Windows. Safe to call on
   * every launch: it is what turns a deferred reboot into a resumed provision.
   */
  async observe(): Promise<ManagedRuntimeFeatureObservation> {
    let inspection: ManagedRuntimeWindowsFeatureInspection
    try {
      inspection = await this.inspect()
    } catch (error) {
      return {
        stage: 'failed',
        missing: MANAGED_RUNTIME_WINDOWS_FEATURES,
        restartRequired: false,
        edition: null,
        detail: 'DevHotel could not read the Windows virtualization feature state.',
        failure: error instanceof Error ? error.message : String(error)
      }
    }
    const missing = MANAGED_RUNTIME_WINDOWS_FEATURES.filter((feature) => inspection.features[feature] !== 'enabled')
    const record = await this.readRecord().catch(() => null)

    if (missing.length === 0) {
      if (record && record.stage !== 'completed') await this.writeRecord({ ...record, stage: 'completed', failure: undefined })
      return {
        stage: 'completed',
        missing: [],
        restartRequired: false,
        edition: inspection.edition.edition,
        detail: 'Windows virtualization features required by the DevHotel runtime are enabled.'
      }
    }

    if (!inspection.edition.supportsHyperV) {
      return {
        stage: 'unsupported-edition',
        missing,
        restartRequired: false,
        edition: inspection.edition.edition,
        detail: 'This Windows edition does not offer Hyper-V, so the managed DevHotel runtime cannot be provisioned here.'
      }
    }

    // A restart DevHotel already earned is pending until the Host boot identity
    // changes. Re-prompting before that would ask the user to approve work that
    // is already done. Windows' own `EnablePending` is the stronger proof and is
    // honoured even if the local record was lost.
    const pending = MANAGED_RUNTIME_WINDOWS_FEATURES.some((feature) => inspection.features[feature] === 'pending')
    if (pending || (record?.stage === 'awaiting-restart' && record.bootId && record.bootId === inspection.bootId)) {
      return {
        stage: 'awaiting-restart',
        missing,
        restartRequired: true,
        edition: inspection.edition.edition,
        detail: 'Windows must restart to finish enabling the DevHotel runtime features.'
      }
    }

    if (record?.stage === 'failed') {
      return {
        stage: 'failed',
        missing,
        restartRequired: false,
        edition: inspection.edition.edition,
        detail: 'Enabling the Windows virtualization features for the DevHotel runtime did not complete.',
        failure: record.failure
      }
    }

    return {
      stage: 'elevation-required',
      missing,
      restartRequired: false,
      edition: inspection.edition.edition,
      detail: 'DevHotel needs one-time Windows approval to enable the virtualization features its runtime requires.'
    }
  }

  /**
   * Requests the single elevated Windows feature enablement. Returns the
   * resulting gate; the caller decides how to surface a pending restart.
   * A declined UAC prompt is a recorded, retryable outcome, never a crash.
   */
  async enable(): Promise<ManagedRuntimeFeatureObservation> {
    const before = await this.observe()
    if (before.stage === 'completed' || before.stage === 'awaiting-restart' || before.stage === 'unsupported-edition') {
      return before
    }

    const now = this.now().toISOString()
    const existing = await this.readRecord().catch(() => null)
    await this.writeRecord({
      schemaVersion: 1,
      owner: 'devhotel',
      installId: this.installId,
      stage: 'elevation-required',
      features: [...before.missing],
      bootId: null,
      requestedAt: existing?.requestedAt ?? now,
      updatedAt: now
    })

    await rm(this.resultPath, { force: true })
    const inner = [
      `$ErrorActionPreference=${psLiteral('Stop')}`,
      '$restart=$false',
      `$names=@(${before.missing.map((feature) => psLiteral(feature)).join(',')})`,
      'try {',
      '  foreach ($n in $names) { $r=Enable-WindowsOptionalFeature -Online -FeatureName $n -All -NoRestart; if ($r.RestartNeeded) { $restart=$true } }',
      `  [IO.File]::WriteAllText(${psLiteral(this.resultPath)},([pscustomobject]@{Ok=$true;RestartNeeded=$restart}|ConvertTo-Json -Compress))`,
      '} catch {',
      `  [IO.File]::WriteAllText(${psLiteral(this.resultPath)},([pscustomobject]@{Ok=$false;RestartNeeded=$false;Error=[string]$_.Exception.Message}|ConvertTo-Json -Compress))`,
      '  exit 1',
      '}'
    ].join('\n')
    // Elevation runs in a separate console whose stdout DevHotel cannot read,
    // so the elevated child reports through an owned result file instead.
    const outer = [
      `$psArgs=@(${encodedPowerShell(inner).map((arg) => psLiteral(arg)).join(',')})`,
      '$p=Start-Process -FilePath powershell.exe -ArgumentList $psArgs -Verb RunAs -Wait -PassThru',
      '[pscustomobject]@{ExitCode=$p.ExitCode}|ConvertTo-Json -Compress'
    ].join(';')

    const elevated = await this.runner('powershell.exe', encodedPowerShell(outer))
    if (elevated.code !== 0) {
      // A cancelled UAC prompt fails Start-Process; that is a user decision,
      // recorded so the next launch can offer it again rather than loop.
      await this.fail('Windows approval was declined or the elevated request could not start.')
      return await this.observe()
    }

    const result = await this.readResult()
    if (!result.ok) {
      await this.fail(result.error ?? 'Windows could not enable the required virtualization features.')
      return await this.observe()
    }

    const after = await this.inspect()
    const missing = MANAGED_RUNTIME_WINDOWS_FEATURES.filter((feature) => after.features[feature] !== 'enabled')
    if (missing.length === 0 && !result.restartNeeded) {
      await this.writeRecord({
        schemaVersion: 1,
        owner: 'devhotel',
        installId: this.installId,
        stage: 'completed',
        features: [...before.missing],
        bootId: after.bootId,
        requestedAt: existing?.requestedAt ?? now,
        updatedAt: this.now().toISOString()
      })
      return await this.observe()
    }

    await this.writeRecord({
      schemaVersion: 1,
      owner: 'devhotel',
      installId: this.installId,
      stage: 'awaiting-restart',
      features: [...before.missing],
      bootId: after.bootId,
      requestedAt: existing?.requestedAt ?? now,
      updatedAt: this.now().toISOString()
    })
    return await this.observe()
  }

  private async readResult(): Promise<{ ok: boolean; restartNeeded: boolean; error?: string }> {
    if (!existsSync(this.resultPath)) return { ok: false, restartNeeded: false, error: 'The elevated request produced no result.' }
    const info = await lstat(this.resultPath)
    if (!info.isFile() || info.isSymbolicLink()) return { ok: false, restartNeeded: false, error: 'The elevated result is not a regular file.' }
    try {
      const value = parseJsonRecord(await readFile(this.resultPath, 'utf8'), 'invalid')
      return {
        ok: value['Ok'] === true,
        restartNeeded: value['RestartNeeded'] === true,
        error: typeof value['Error'] === 'string' ? value['Error'] : undefined
      }
    } catch {
      return { ok: false, restartNeeded: false, error: 'The elevated request returned invalid evidence.' }
    } finally {
      await rm(this.resultPath, { force: true })
    }
  }

  private async fail(failure: string): Promise<void> {
    const existing = await this.readRecord().catch(() => null)
    const now = this.now().toISOString()
    await this.writeRecord({
      schemaVersion: 1,
      owner: 'devhotel',
      installId: this.installId,
      stage: 'failed',
      features: existing?.features ?? [...MANAGED_RUNTIME_WINDOWS_FEATURES],
      bootId: existing?.bootId ?? null,
      requestedAt: existing?.requestedAt ?? now,
      updatedAt: now,
      failure
    })
  }

  private async writeRecord(record: ManagedRuntimeFeatureRecord): Promise<ManagedRuntimeFeatureRecord> {
    await mkdir(this.root, { recursive: true })
    const info = await lstat(this.root)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Managed runtime root is not a real directory')
    const root = await realpath(this.root)
    const next = { ...record, updatedAt: this.now().toISOString() }
    const temporary = path.join(root, `.windows-feature-${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      await rename(temporary, path.join(root, RECORD_FILE))
    } finally {
      await rm(temporary, { force: true })
    }
    return next
  }
}

function defaultRunner(executable: string, args: readonly string[]): Promise<ManagedRuntimeCommandResult> {
  return new Promise((resolve) => {
    import('node:child_process')
      .then(({ spawn }) => {
        const child = spawn(executable, [...args], { windowsHide: true })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk) => (stdout += chunk))
        child.stderr.on('data', (chunk) => (stderr += chunk))
        child.on('error', (error) => resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` }))
        child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
      })
      .catch((error: unknown) => resolve({ code: -1, stdout: '', stderr: String(error) }))
  })
}
