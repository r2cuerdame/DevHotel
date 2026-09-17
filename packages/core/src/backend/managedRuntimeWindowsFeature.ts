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

/**
 * The parts of a managed Host's servicing policy that decide whether
 * `Enable-WindowsOptionalFeature` can obtain the Hyper-V payload at all.
 *
 * A locked-down enterprise Host is usually not a Host "without Hyper-V". It is
 * a Host pointed at an update server that does not carry the feature payload,
 * or forbidden from reaching Windows Update for it. DISM then fails with a
 * source error that reads like a transient network fault — which is the wrong
 * thing to tell the user, because no retry and no restart will change it and
 * the person who can change it is an administrator, not them.
 *
 * Read without elevation; these are policy keys, not secrets.
 */
export interface ManagedRuntimeVirtualizationPolicy {
  /** `UseWUServer=1` — this Host takes servicing content from WSUS, not Windows Update. */
  wsusManaged: boolean
  /** `RepairContentServerSource=2` — policy forbids Windows Update as a feature payload source. */
  repairSourceRestricted: boolean
  /** A policy-set local payload path: an administrator has chosen where features come from. */
  localSourceConfigured: boolean
  /** False when the policy surface could not be read. The flags above are then defaults, not findings. */
  readable: boolean
}

export interface ManagedRuntimeWindowsFeatureInspection {
  features: Record<string, ManagedRuntimeFeatureState>
  edition: ManagedRuntimeWindowsEdition
  /** Opaque host boot identity used to prove a restart actually happened. */
  bootId: string
  elevated: boolean
  policy: ManagedRuntimeVirtualizationPolicy
  /**
   * Which source answered for the feature states.
   *
   * `dism` is the only one that can report `EnablePending`, and it needs
   * elevation DevHotel does not have on an ordinary launch. `cim` is the
   * unelevated fallback: it reports enabled/disabled truthfully but cannot see
   * a pending restart, so the recorded restart is what proves that instead.
   */
  featureRead: 'dism' | 'cim' | 'none'
}

export type ManagedRuntimeFeatureStage =
  | 'not-required'
  | 'elevation-required'
  | 'awaiting-restart'
  | 'completed'
  | 'unsupported-edition'
  /** Windows refused by administrator policy: approval was given and still denied. */
  | 'blocked-by-policy'
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
  /**
   * DevHotel's own sentence for a policy refusal. Unlike `failure` it quotes no
   * Windows text, so it is the half of a `blocked-by-policy` record that may
   * cross the renderer boundary.
   */
  policyReason?: string
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

/**
 * DISM results that mean an administrator decided this, rather than that
 * something went wrong. Each is a refusal a retry and a restart cannot change.
 *
 * The sentences are DevHotel's, not Windows'. The raw DISM text stays in the
 * record's `failure`, which the renderer boundary drops, so a policy refusal
 * can be explained to the user without quoting Host error strings at them.
 */
const POLICY_DENIED_HRESULTS: ReadonlyMap<number, string> = new Map([
  [0x800f0906, 'Windows could not obtain the virtualization feature files from the source this Host is allowed to use.'],
  [0x800f0954, 'Windows could not reach the update server this Host is required by policy to take features from.'],
  [0x800f081f, 'The virtualization feature files are not available from the source this Host is restricted to.'],
  [0x80070005, 'Windows refused to enable the virtualization features even after approval was given.']
])

/** Windows' own wording when a feature is withheld by policy rather than by a fault. */
const POLICY_DENIED_TEXT = /group policy|by your (?:system )?administrator|blocked by policy|policy setting/i

/**
 * Decides whether a failed enablement was a policy refusal, and says why in
 * DevHotel's words. Returns `null` when the failure is an ordinary one — being
 * wrong in that direction costs a retry, while being wrong in the other tells a
 * user their machine is locked down when it is merely broken.
 */
export function classifyWindowsFeatureFailure(
  hresult: number | null,
  message: string | undefined,
  policy: ManagedRuntimeVirtualizationPolicy | null
): string | null {
  // PowerShell reports HRESULTs through a signed int; 0x80070005 arrives negative.
  const code = typeof hresult === 'number' && Number.isFinite(hresult) ? hresult >>> 0 : null
  const known = code === null ? undefined : POLICY_DENIED_HRESULTS.get(code)
  const reason = known ?? (message && POLICY_DENIED_TEXT.test(message) ? 'An administrator policy on this Host forbids enabling the virtualization features.' : null)
  if (!reason) return null

  const managed =
    policy?.readable === true && (policy.wsusManaged || policy.repairSourceRestricted || policy.localSourceConfigured)
  return managed
    ? `${reason} This Host's servicing source is set by administrator policy, so DevHotel cannot change it. Ask whoever manages this machine to enable Hyper-V for it.`
    : `${reason} DevHotel cannot work around this. Ask whoever manages this machine to enable Hyper-V for it.`
}

function readPolicy(value: unknown): ManagedRuntimeVirtualizationPolicy {
  const absent: ManagedRuntimeVirtualizationPolicy = {
    wsusManaged: false,
    repairSourceRestricted: false,
    localSourceConfigured: false,
    readable: false
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return absent
  const raw = value as Record<string, unknown>
  return {
    wsusManaged: raw['Wsus'] === true,
    repairSourceRestricted: raw['RepairRestricted'] === true,
    localSourceConfigured: raw['LocalSource'] === true,
    readable: raw['Readable'] === true
  }
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
    !['elevation-required', 'awaiting-restart', 'completed', 'unsupported-edition', 'blocked-by-policy', 'failed'].includes(
      record.stage ?? ''
    ) ||
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
      // `Get-WindowsOptionalFeature -Online` is a DISM online operation and
      // requires elevation. DevHotel runs unelevated, so it fails on every
      // ordinary launch — and reading that failure as "Absent" is how a Host
      // that already has Hyper-V enabled gets asked to enable it again.
      // `Win32_OptionalFeature` answers the same question without elevation;
      // DISM is kept because it is the only source that reports EnablePending.
      '$read="none"',
      'foreach ($n in $names) { $f=$null; try { $f=Get-WindowsOptionalFeature -Online -FeatureName $n -ErrorAction Stop } catch { $f=$null }; ' +
        'if ($f) { $states[$n]=[string]$f.State; $read="dism" } else { ' +
        '$c=Get-CimInstance Win32_OptionalFeature -Filter ("Name=\'"+$n+"\'") -ErrorAction SilentlyContinue; ' +
        'if ($c) { $states[$n]=switch ([int]$c.InstallState) { 1 {"Enabled"} 2 {"Disabled"} 3 {"Absent"} default {"Absent"} }; if ($read -ne "dism") { $read="cim" } } ' +
        'else { $states[$n]="Absent" } } }',
      '$os=Get-CimInstance Win32_OperatingSystem',
      '$edition=(Get-CimInstance Win32_OperatingSystem).OperatingSystemSKU',
      '$name=[string]$os.Caption',
      '$identity=[Security.Principal.WindowsIdentity]::GetCurrent()',
      '$elevated=(New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
      // Servicing policy decides whether the feature payload can be obtained at
      // all. Reading it here means a refusal later can be explained instead of
      // being reported as a download that failed.
      '$policy=@{Wsus=$false;RepairRestricted=$false;LocalSource=$false;Readable=$false}',
      "try { $au=Get-ItemProperty 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU' -ErrorAction SilentlyContinue; " +
        "$sv=Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\Servicing' -ErrorAction SilentlyContinue; " +
        '$policy.Wsus=[bool]($au -and $au.UseWUServer -eq 1); ' +
        '$policy.RepairRestricted=[bool]($sv -and $sv.RepairContentServerSource -eq 2); ' +
        '$policy.LocalSource=[bool]($sv -and $sv.LocalSourcePath); ' +
        '$policy.Readable=$true } catch { $policy.Readable=$false }',
      '[pscustomobject]@{Features=$states;Edition=$name;Sku=$edition;BootId=([string]$os.LastBootUpTime);Elevated=[bool]$elevated;Policy=$policy;FeatureRead=$read}|ConvertTo-Json -Compress -Depth 4'
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
      elevated: value['Elevated'] === true,
      policy: readPolicy(value['Policy']),
      featureRead: value['FeatureRead'] === 'dism' ? 'dism' : value['FeatureRead'] === 'cim' ? 'cim' : 'none'
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

    // A restart DevHotel already earned is pending until the Host boot identity
    // changes. This is checked before the features themselves, because the
    // unelevated `cim` read cannot see `EnablePending`: it reports a feature
    // enabled with the restart still outstanding, and acting on that would
    // start the provider against a hypervisor that is not running yet.
    const unrestarted = record?.stage === 'awaiting-restart' && !!record.bootId && record.bootId === inspection.bootId
    const pending = MANAGED_RUNTIME_WINDOWS_FEATURES.some((feature) => inspection.features[feature] === 'pending')
    if (pending || unrestarted) {
      return {
        stage: 'awaiting-restart',
        missing,
        restartRequired: true,
        edition: inspection.edition.edition,
        detail: 'Windows must restart to finish enabling the DevHotel runtime features.'
      }
    }

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

    // A policy refusal outranks the elevation gate: asking for approval again
    // would send the user through a UAC prompt to reach the same refusal.
    if (record?.stage === 'blocked-by-policy') {
      return {
        stage: 'blocked-by-policy',
        missing,
        restartRequired: false,
        edition: inspection.edition.edition,
        detail:
          record.policyReason ??
          'An administrator policy on this Host forbids enabling the virtualization features the DevHotel runtime requires.',
        failure: record.failure
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
      // The HRESULT is what separates "an administrator forbade this" from "the
      // download failed"; the message alone is localized and cannot be trusted
      // to carry that distinction.
      `  [IO.File]::WriteAllText(${psLiteral(this.resultPath)},([pscustomobject]@{Ok=$false;RestartNeeded=$false;Error=[string]$_.Exception.Message;HResult=[int]$_.Exception.HResult}|ConvertTo-Json -Compress))`,
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
      // A policy refusal is not a failed attempt. Recording it as one would put
      // a retry button in front of a user who cannot change the outcome.
      const policy = await this.inspect().then((inspection) => inspection.policy).catch(() => null)
      const policyReason = classifyWindowsFeatureFailure(result.hresult, result.error, policy)
      await this.fail(
        result.error ?? 'Windows could not enable the required virtualization features.',
        policyReason ?? undefined
      )
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

  private async readResult(): Promise<{ ok: boolean; restartNeeded: boolean; error?: string; hresult: number | null }> {
    const missing = { ok: false, restartNeeded: false, hresult: null }
    if (!existsSync(this.resultPath)) return { ...missing, error: 'The elevated request produced no result.' }
    const info = await lstat(this.resultPath)
    if (!info.isFile() || info.isSymbolicLink()) return { ...missing, error: 'The elevated result is not a regular file.' }
    try {
      const value = parseJsonRecord(await readFile(this.resultPath, 'utf8'), 'invalid')
      return {
        ok: value['Ok'] === true,
        restartNeeded: value['RestartNeeded'] === true,
        error: typeof value['Error'] === 'string' ? value['Error'] : undefined,
        hresult: typeof value['HResult'] === 'number' ? value['HResult'] : null
      }
    } catch {
      return { ...missing, error: 'The elevated request returned invalid evidence.' }
    } finally {
      await rm(this.resultPath, { force: true })
    }
  }

  /**
   * Records an enablement that did not happen. `policyReason` decides which of
   * the two it was: an attempt that can be made again, or a refusal that no
   * number of attempts will change.
   */
  private async fail(failure: string, policyReason?: string): Promise<void> {
    const existing = await this.readRecord().catch(() => null)
    const now = this.now().toISOString()
    await this.writeRecord({
      schemaVersion: 1,
      owner: 'devhotel',
      installId: this.installId,
      stage: policyReason ? 'blocked-by-policy' : 'failed',
      features: existing?.features ?? [...MANAGED_RUNTIME_WINDOWS_FEATURES],
      bootId: existing?.bootId ?? null,
      requestedAt: existing?.requestedAt ?? now,
      updatedAt: now,
      failure,
      policyReason
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
