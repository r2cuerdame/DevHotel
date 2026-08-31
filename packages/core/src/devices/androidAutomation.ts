import { createHash, randomUUID } from 'node:crypto'
import type {
  AndroidAutomationStatus,
  AndroidAutomationTarget,
  AndroidCommandEvidence,
  AndroidCrashScenarioResult,
  AndroidDumpUiInput,
  AndroidForceStopResult,
  AndroidForegroundInstallContext,
  AndroidInstallReceipt,
  AndroidLaunchResult,
  AndroidLogcatInput,
  AndroidLogcatResult,
  AndroidRunCrashScenarioInput,
  AndroidTapTextInput,
  AndroidTapTextResult,
  AndroidUiDumpResult,
  AndroidUiNode,
  AndroidWaitForTextInput,
  AndroidWaitForTextResult,
  AndroidExtras
} from '@devhotel/shared'
import { DeviceLeaseError } from '@devhotel/shared'
import type { ExecOutputChunk, ExecResult } from '../backend/types'
import { redactSecrets } from '../diagnostics/redact'
import { DevHotelError } from '../errors'
import type { AndroidAppInstallsRepo, AndroidInstallTarget } from '../store/androidAppInstallsRepo'

const MAX_UI_XML_BYTES = 1024 * 1024
const MAX_UI_SOURCE_NODES = 10_000
const MAX_UI_TAG_BYTES = 32 * 1024
const MAX_UI_ATTRIBUTE_BYTES = 4 * 1024
const MAX_EVIDENCE_BYTES = 4 * 1024
const MAX_LOGCAT_BYTES = 64 * 1024
const MAX_PACKAGE_DUMP_BYTES = 1024 * 1024
const MAX_USER_DUMP_BYTES = 256 * 1024
const MAX_TARGET_CLOCK_RTT_MS = 2_000
const DEFAULT_WAIT_TIMEOUT_MS = 10_000
const DEFAULT_POLL_INTERVAL_MS = 500
const TARGET_CLOCK_FORMAT = '+%s.%3N'
const INSTALL_FENCE_TAG = 'DEVHOTEL_INSTALL_FENCE'
const CRASH_FENCE_TAG = 'DEVHOTEL_CRASH_FENCE'
const USER_SWITCH_FENCE_TAG = 'DEVHOTEL_USER_FENCE'
const SCREEN_TRANSITION_EVENT_FILTERS = [
  // ActivityManager moved these records to WindowManager before the API 31
  // floor used by this witness. Keep both stable names so an older vendor
  // branch cannot hide a transition by retaining the pre-move tag.
  'am_switch_user:V',
  'am_resume_activity:V',
  'wm_resume_activity:V',
  'am_set_resumed_activity:V',
  'wm_set_resumed_activity:V',
  'am_focused_activity:V',
  // InputDispatcher records focus changes independently of resumed Activity.
  // Its payload is not package-authoritative across API/vendor versions, so
  // every occurrence is conservatively rejected, including during taps.
  'input_focus:V'
] as const
const SCREEN_TRANSITION_EVENT_TAGS = new Set(
  SCREEN_TRANSITION_EVENT_FILTERS.map((filter) => filter.slice(0, filter.lastIndexOf(':')))
)
const SCREEN_WITNESS_READER_SCRIPT = [
  'exec logcat -b main -b events -T 1 -m "$1" -D -v tag,printable',
  '-s DEVHOTEL_USER_FENCE:I am_switch_user:V am_resume_activity:V wm_resume_activity:V',
  'am_set_resumed_activity:V wm_set_resumed_activity:V am_focused_activity:V input_focus:V'
].join(' ')
const SCREEN_WITNESS_CLOSE_SCRIPT = [
  'tag="$1"',
  'shift',
  'for payload in "$@"; do log -p i -t "$tag" "$payload" || exit $?; done'
].join('\n')
const MAX_TAP_SCREEN_WITNESS_RECORDS = 16
const SCREEN_WITNESS_BOOTSTRAP_RECORD_BUDGET = 8
const SCREEN_WITNESS_BOOTSTRAP_ATTEMPTS = 8
const SCREEN_WITNESS_BOOTSTRAP_RETRY_MS = 250
const PACKAGE_DUMP_SCRIPT = `dumpsys package "$1"; status=$?; printf '\n%s\n' "$2"; exit "$status"`
const MAX_USER_SWITCH_WITNESS_BYTES = 16 * 1024
const DEFAULT_SCREEN_WITNESS_ACTION_TIMEOUT_MS = 60_000
const SCREEN_WITNESS_READY_TIMEOUT_MS = 20_000
// Two strict user-incarnation sandwiches, bounded bootstrap retries and close
// markers surround the caller-declared action window.
const SCREEN_WITNESS_NON_ACTION_BUDGET_MS = 90_000
const GUARDED_TAP_SCRIPT = [
  'expected_user="$1"',
  'x="$2"',
  'y="$3"',
  'current="$(am get-current-user)" || exit 70',
  '[ "$current" = "$expected_user" ] || exit 71',
  'input tap "$x" "$y"',
  'action_status=$?',
  'current="$(am get-current-user)" || exit 70',
  '[ "$current" = "$expected_user" ] || exit 71',
  'exit "$action_status"'
].join('; ')
const ANDROID_PER_USER_RANGE = 100_000
const ANDROID_FIRST_APPLICATION_ID = 10_000
const ANDROID_LAST_APPLICATION_ID = 19_999
const ANDROID_MAX_USER_ID = 21_474
const ANDROID_MAX_USER_SERIAL = 2_147_483_647
const MAX_PACKAGE_PROCESSES = 1_024

interface ScreenWitnessRecord {
  tag: string
  payload: string
}

interface ScreenWitnessTranscript {
  records: ScreenWitnessRecord[]
  complete: boolean
}

/** Parse only logcat's exact tag format plus its independently framed buffers. */
function parseScreenWitnessTranscript(value: string): ScreenWitnessTranscript | null {
  const normalized = value.replaceAll('\r\n', '\n')
  const complete = normalized.endsWith('\n')
  const lines = normalized.split('\n')
  // Ignore either the trailing empty item or the one still-partial streamed
  // line. Only complete newline-delimited records influence readiness.
  lines.pop()
  const seenBuffers = new Set<'main' | 'events'>()
  let currentBuffer: 'main' | 'events' | null = null
  let needsRecord = false
  const records: ScreenWitnessRecord[] = []
  for (const line of lines) {
    const divider = /^--------- (beginning of|switch to) (main|events)$/.exec(line)
    if (divider) {
      if (needsRecord) return null
      const mode = divider[1]!
      const buffer = divider[2]! as 'main' | 'events'
      if (
        (mode === 'beginning of' && seenBuffers.has(buffer)) ||
        (mode === 'switch to' && (!seenBuffers.has(buffer) || currentBuffer === buffer))
      ) return null
      seenBuffers.add(buffer)
      currentBuffer = buffer
      needsRecord = true
      continue
    }
    const record = /^I\/([A-Za-z0-9_.-]{1,64}): ([^\r\n]*)$/.exec(line)
    if (!record || !currentBuffer) return null
    const tag = record[1]!
    const expectedBuffer = tag === USER_SWITCH_FENCE_TAG
      ? 'main'
      : SCREEN_TRANSITION_EVENT_TAGS.has(tag)
        ? 'events'
        : null
    if (!expectedBuffer || currentBuffer !== expectedBuffer) return null
    needsRecord = false
    records.push({ tag, payload: record[2]! })
  }
  // A streaming chunk may end exactly after a divider. That is a valid
  // pending frame until the next record arrives; only the final transcript
  // requires the divider to have been completed by a record.
  return { records, complete: complete && !needsRecord }
}

function isAllowedAppTransition(record: ScreenWitnessRecord, applicationId: string, userId: number): boolean {
  if (record.tag === 'am_switch_user') return false
  let match: RegExpExecArray | null
  if (record.tag === 'am_resume_activity' || record.tag === 'wm_resume_activity') {
    match = /^\[(-?\d+),-?\d+,-?\d+,([^,\]\r\n]+)\]$/.exec(record.payload)
  } else if (
    record.tag === 'am_set_resumed_activity' ||
    record.tag === 'wm_set_resumed_activity' ||
    record.tag === 'am_focused_activity'
  ) {
    match = /^\[(-?\d+),([^,\]\r\n]+)(?:,[^\r\n]*)?\]$/.exec(record.payload)
  } else {
    return false
  }
  if (!match || Number(match[1]) !== userId) return false
  const component = match[2]!
  return component.startsWith(`${applicationId}/`) && /^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/.test(component)
}

export interface AndroidAutomationExecOptions {
  timeoutMs?: number
  signal?: AbortSignal
  maxStdoutBytes?: number
  maxStderrBytes?: number
  onStdout?: (chunk: ExecOutputChunk) => void
  onStderr?: (chunk: ExecOutputChunk) => void
}

export interface AndroidAutomationSessionOptions {
  roomId: string
  target: AndroidAutomationTarget
  installTarget: AndroidInstallTarget
  installs: AndroidAppInstallsRepo
  exec(args: string[], opts?: AndroidAutomationExecOptions): Promise<ExecResult>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

interface AndroidAutomationDeadline {
  at: number
  applicationId: string
}

interface AndroidDumpOptions {
  filter?: string
  maxNodes?: number
  deadline?: AndroidAutomationDeadline
  textMatch?: 'exact' | 'contains'
}

function automationError(
  code: string,
  message: string,
  recoveryHint: string,
  httpStatus = 409,
  evidence?: AndroidCommandEvidence
): DevHotelError {
  return new DevHotelError(code, message, { recoveryHint, httpStatus, evidence })
}

function waitTimeoutError(applicationId: string): DevHotelError {
  return automationError(
    'ANDROID_WAIT_TIMEOUT',
    `The requested text did not appear in ${applicationId} before the bounded timeout.`,
    'Inspect android_dump_ui for the current app-scoped hierarchy and adjust the literal text or timeout.',
    408
  )
}

function byteTail(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const data = Buffer.from(value, 'utf8')
  if (data.byteLength <= maxBytes) return { text: value, truncated: false }
  return { text: data.subarray(data.byteLength - maxBytes).toString('utf8'), truncated: true }
}

function safeEvidence(result: ExecResult): AndroidCommandEvidence {
  const stdout = byteTail(redactSecrets(result.stdout).replaceAll('emulator-5554', '[room-emulator]'), MAX_EVIDENCE_BYTES)
  const stderr = byteTail(redactSecrets(result.stderr).replaceAll('emulator-5554', '[room-emulator]'), MAX_EVIDENCE_BYTES)
  return {
    code: result.code,
    stdout: stdout.text,
    stderr: stderr.text,
    truncated: stdout.truncated || stderr.truncated
  }
}

function safeEvidenceWithoutStdout(result: ExecResult): AndroidCommandEvidence {
  const evidence = safeEvidence(result)
  return {
    ...evidence,
    stdout: '',
    // The stdout was intentionally withheld because this probe can enumerate
    // packages outside the tracked app. Make that omission explicit without
    // disclosing any of the cross-app inventory.
    truncated: evidence.truncated || result.stdout.length > 0
  }
}

function safeEvidenceWithoutOutput(result: ExecResult): AndroidCommandEvidence {
  const evidence = safeEvidence(result)
  return {
    ...evidence,
    stdout: '',
    stderr: '',
    // Package-manager dumps can contain shared-user names and cross-app
    // inventory on either stream. Preserve only bounded status metadata.
    truncated: evidence.truncated || result.stdout.length > 0 || result.stderr.length > 0
  }
}

function parsePids(value: string): number[] {
  const trimmed = value.trim()
  if (!trimmed) return []
  if (!/^\d+(?:\s+\d+)*$/.test(trimmed)) return []
  return [...new Set(trimmed
    .split(/\s+/)
    .map((part) => Number.parseInt(part, 10))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0))]
}

function componentForActivity(applicationId: string, activity: string): string {
  if (!/^(?:\.[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*|[A-Za-z][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+)$/.test(activity)) {
    throw automationError(
      'ANDROID_ACTIVITY_INVALID',
      'The requested activity is not a valid Android activity class name.',
      'Use a relative or fully qualified Java class name from the tracked application manifest.',
      400
    )
  }
  if (activity.startsWith('.')) return `${applicationId}/${activity}`
  // Android scopes a component by the package before `/`; the activity class
  // may legitimately live in a different Java namespace than applicationId.
  return `${applicationId}/${activity}`
}

function extrasArgv(extras: AndroidExtras | undefined): string[] {
  const args: string[] = []
  for (const [key, value] of Object.entries(extras ?? {})) {
    if (typeof value === 'string') {
      if (value.includes('\u0000')) {
        throw automationError(
          'ANDROID_EXTRA_INVALID',
          'Android string extras cannot contain a NUL byte.',
          'Remove the NUL byte and retry with a text value that can be represented as a process argument.',
          400
        )
      }
      args.push('--es', key, value)
    }
    else if (typeof value === 'boolean') args.push('--ez', key, String(value))
    else args.push('--ei', key, String(value))
  }
  return args
}

function literalIncludes(value: string, wanted: string, ignoreCase = false): boolean {
  return ignoreCase
    ? value.toLocaleLowerCase('en-US').includes(wanted.toLocaleLowerCase('en-US'))
    : value.includes(wanted)
}

function parseTargetEpochMillis(value: string): { epochMs: number; timestamp: string } | null {
  const match = /^(\d{10,11})\.(\d{3})\r?\n?$/.exec(value)
  if (!match) return null
  const epochMs = (Number.parseInt(match[1]!, 10) * 1000) + Number.parseInt(match[2]!, 10)
  return Number.isSafeInteger(epochMs) ? { epochMs, timestamp: `${match[1]}.${match[2]}` } : null
}

function packageIncarnation(path: string, stat: string): string {
  return createHash('sha256').update('devhotel-android-package-incarnation\0').update(path).update('\0').update(stat).digest('hex')
}

function installLogFence(authority: AndroidPackageAuthority): string {
  return `devhotel-install-u${authority.userId}-uid${authority.uid}-${randomUUID()}`
}

function installLogFenceAuthority(value: string): AndroidPackageAuthority | null {
  const match = /^devhotel-install-u(\d+)-uid(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.exec(value)
  if (!match) return null
  const userId = Number.parseInt(match[1]!, 10)
  const uid = Number.parseInt(match[2]!, 10)
  if (
    !Number.isSafeInteger(userId) ||
    !Number.isSafeInteger(uid) ||
    userId < 0 ||
    uid < 0 ||
    Math.floor(uid / ANDROID_PER_USER_RANGE) !== userId
  ) return null
  return { uid, userId }
}

function samePackageAuthority(left: AndroidPackageAuthority, right: AndroidPackageAuthority): boolean {
  return left.uid === right.uid && left.userId === right.userId
}

function logEpochMillis(line: string): number | null {
  const match = /^\s*(\d{10,11})\.(\d{3,9})\s/.exec(line)
  if (!match) return null
  const millis = Number.parseInt(match[2]!.slice(0, 3).padEnd(3, '0'), 10)
  const value = (Number.parseInt(match[1]!, 10) * 1000) + millis
  return Number.isSafeInteger(value) ? value : null
}

function commandHitOutputLimit(result: ExecResult): boolean {
  return /(?:adb stdout exceeded the \d+-byte Host safety limit|Android emulator command output exceeded its safety limit\.)/i.test(result.stderr)
}

export interface AndroidInstallEvidence {
  apkSha256: string
  packageIncarnation: string
  /** Private durable authority; never projected into AndroidInstallReceipt. */
  installUserId: number
  /** Private non-reused user incarnation; never projected into AndroidInstallReceipt. */
  installUserSerial: number
  /** Null means app-UID sequencing could not be proven; non-log primitives remain usable. */
  logFence: string | null
}

interface InstalledPackageIdentity {
  apkSha256: string
  packageIncarnation: string
  evidence: AndroidCommandEvidence
}

interface VerifiedTrackedInstall {
  receipt: AndroidInstallReceipt
  apkSha256: string
  packageIncarnation: string | null
  installUserId: number
  installUserSerial: number
}

interface AndroidUserAuthority {
  userId: number
  serial: number
}

interface AndroidPackageAuthority {
  uid: number
  userId: number
}

interface AndroidForegroundPackage {
  applicationId: string
  userId: number
}

function matchesText(node: AndroidUiNode, text: string, match: 'exact' | 'contains'): boolean {
  const values = [node.text, node.contentDescription]
  return match === 'exact'
    ? values.some((value) => value === text)
    : values.some((value) => literalIncludes(value, text))
}

/**
 * One already-resolved target. The generic executor is private so callers get
 * app-scoped primitives, not a second raw-ADB escape hatch.
 */
export class AndroidAutomationSession {
  readonly target: AndroidAutomationTarget
  private readonly now: () => number
  private readonly pause: (ms: number) => Promise<void>

  constructor(private readonly opts: AndroidAutomationSessionOptions) {
    this.target = opts.target
    this.now = opts.now ?? (() => Date.now())
    this.pause = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  private async pauseWithSignal(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason
    let abort!: () => void
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason ?? new Error('Android automation was aborted'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
    try {
      await Promise.race([this.pause(ms), aborted])
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  private async command(
    args: string[],
    opts: AndroidAutomationExecOptions & {
      deadline?: AndroidAutomationDeadline
      stdoutLimit?: number
      outputLimitRecovery?: string
      operation: string
    }
  ): Promise<ExecResult> {
    let timeoutMs = opts.timeoutMs
    if (opts.deadline) {
      const remainingMs = opts.deadline.at - this.now()
      if (remainingMs <= 0) throw waitTimeoutError(opts.deadline.applicationId)
      timeoutMs = Math.max(1, Math.min(timeoutMs ?? remainingMs, remainingMs))
    }
    let result: ExecResult
    try {
      result = await this.opts.exec(args, {
        timeoutMs,
        signal: opts.signal,
        maxStdoutBytes: opts.maxStdoutBytes ?? opts.stdoutLimit,
        maxStderrBytes: opts.maxStderrBytes ?? 64 * 1024,
        onStdout: opts.onStdout,
        onStderr: opts.onStderr
      })
    } catch (error) {
      if (error instanceof DeviceLeaseError) throw error
      if (opts.deadline && this.now() >= opts.deadline.at) {
        throw waitTimeoutError(opts.deadline.applicationId)
      }
      throw error
    }
    if (opts.deadline && this.now() >= opts.deadline.at) {
      throw waitTimeoutError(opts.deadline.applicationId)
    }
    const outputLimitExceeded = opts.stdoutLimit !== undefined &&
      Buffer.byteLength(result.stdout, 'utf8') > opts.stdoutLimit
    if (outputLimitExceeded) {
      throw automationError(
        'ANDROID_OUTPUT_LIMIT',
        `${opts.operation} exceeded its ${opts.stdoutLimit}-byte safety limit.`,
        opts.outputLimitRecovery ?? 'Narrow the filter or reduce the requested result size.'
      )
    }
    return result
  }

  private receipt(applicationId: string): AndroidInstallReceipt {
    const receipt = this.opts.installs.get(this.opts.roomId, this.opts.installTarget, applicationId)
    if (!receipt) {
      throw automationError(
        'ANDROID_APP_NOT_TRACKED',
        `${applicationId} was not installed on this exact target by this Room.`,
        'Run android_run for this application and target first.'
      )
    }
    return receipt
  }

  private async currentUserId(
    deadline?: AndroidAutomationDeadline,
    signal?: AbortSignal
  ): Promise<number> {
    const result = await this.command(
      ['shell', 'am', 'get-current-user'],
      { operation: 'Android active user probe', timeoutMs: 10_000, stdoutLimit: 256, deadline, signal }
    )
    const match = /^(0|[1-9]\d{0,4})\r?\n?$/.exec(result.stdout)
    const userId = match ? Number.parseInt(match[1]!, 10) : Number.NaN
    if (
      result.code !== 0 ||
      result.stderr.length > 0 ||
      !Number.isSafeInteger(userId) ||
      userId < 0 ||
      userId > ANDROID_MAX_USER_ID
    ) {
      throw automationError(
        'ANDROID_APP_USER_UNVERIFIED',
        'The selected Android target did not provide an exact active user ID.',
        'Restore Android activity-manager connectivity and retry; DevHotel will not guess a user context.',
        409,
        safeEvidenceWithoutOutput(result)
      )
    }
    return userId
  }

  private async userSerial(
    userId: number,
    deadline?: AndroidAutomationDeadline,
    signal?: AbortSignal
  ): Promise<number> {
    const result = await this.command(
      ['shell', 'dumpsys', 'user', '--user', String(userId)],
      {
        operation: 'Android user incarnation probe',
        timeoutMs: 15_000,
        stdoutLimit: MAX_USER_DUMP_BYTES,
        deadline,
        signal
      }
    )
    const lines = result.stdout.split(/\r?\n/)
    // UserInfo.toString() may contain a user-controlled name. Require the
    // service-owned suffix on the first line and exactly one structural match;
    // an injected newline/lookalike therefore makes the probe ambiguous.
    const structural = /^ UserInfo\{(0|[1-9]\d{0,4}):[^\r\n]*:[0-9a-fA-F]+\} serialNo=(0|[1-9]\d{0,9}) isPrimary=(?:true|false)(?: parentId=(?:0|[1-9]\d{0,4}))?(?: .*?)?$/
    const matches = lines
      .map((line, index) => ({ index, match: structural.exec(line) }))
      .filter((entry): entry is { index: number; match: RegExpExecArray } => Boolean(entry.match))
    const serial = matches.length === 1 ? Number.parseInt(matches[0]!.match[2]!, 10) : Number.NaN
    if (
      result.code !== 0 ||
      result.stderr.length > 0 ||
      commandHitOutputLimit(result) ||
      matches[0]?.index !== 0 ||
      matches[0]?.match[1] !== String(userId) ||
      !Number.isSafeInteger(serial) ||
      serial < 0 ||
      serial > ANDROID_MAX_USER_SERIAL
    ) {
      throw automationError(
        'ANDROID_APP_USER_UNVERIFIED',
        'The selected Android target did not provide an exact Android user incarnation.',
        'Restore Android user-manager connectivity and retry; DevHotel will not trust a reusable numeric user ID alone.',
        409,
        safeEvidenceWithoutOutput(result)
      )
    }
    return serial
  }

  private async currentUserAuthority(
    deadline?: AndroidAutomationDeadline,
    signal?: AbortSignal
  ): Promise<AndroidUserAuthority> {
    const userIdBefore = await this.currentUserId(deadline, signal)
    const serialBefore = await this.userSerial(userIdBefore, deadline, signal)
    const userIdAfter = await this.currentUserId(deadline, signal)
    const serialAfter = await this.userSerial(userIdAfter, deadline, signal)
    if (userIdBefore === userIdAfter && serialBefore === serialAfter) {
      return { userId: userIdAfter, serial: serialAfter }
    }
    throw automationError(
      'ANDROID_APP_USER_CHANGED',
      'The active Android user changed while its durable identity was being verified.',
      'Stop concurrent Android user changes and retry the tracked operation.',
      409
    )
  }

  private async assertActiveUser(
    expected: AndroidUserAuthority,
    deadline?: AndroidAutomationDeadline,
    signal?: AbortSignal
  ): Promise<void> {
    const current = await this.currentUserAuthority(deadline, signal)
    if (current.userId === expected.userId && current.serial === expected.serial) return
    throw automationError(
      'ANDROID_APP_USER_CHANGED',
      'The active Android user no longer matches this tracked install.',
      'Switch back to the Android user active during android_run, or rerun android_run for the active user.',
      409
    )
  }

  private async requireInstalled(
    applicationId: string,
    deadline?: AndroidAutomationDeadline,
    signal?: AbortSignal
  ): Promise<VerifiedTrackedInstall> {
    const receipt = this.receipt(applicationId)
    const installUserAuthority = this.opts.installs.installUserAuthority(
      this.opts.roomId,
      this.opts.installTarget,
      applicationId
    )
    if (installUserAuthority === null) {
      throw automationError(
        'ANDROID_APP_USER_UNVERIFIED',
        `${applicationId} has no durable Android user authority in its tracked install receipt.`,
        'Run android_run again to bind the tracked package to the active Android user.',
        409
      )
    }
    const expected = {
      receipt,
      apkSha256: receipt.apkSha256,
      packageIncarnation: this.opts.installs.packageIncarnation(
        this.opts.roomId,
        this.opts.installTarget,
        applicationId
      ),
      installUserId: installUserAuthority.userId,
      installUserSerial: installUserAuthority.serial
    }
    await this.assertTrackedInstall(applicationId, expected, deadline, signal)
    return expected
  }

  private async assertTrackedInstall(
    applicationId: string,
    expected: VerifiedTrackedInstall,
    deadline?: AndroidAutomationDeadline,
    signal?: AbortSignal
  ): Promise<void> {
    const user = { userId: expected.installUserId, serial: expected.installUserSerial }
    await this.assertActiveUser(user, deadline, signal)
    await this.assertInstalledPackageIdentity(applicationId, expected, deadline, signal)
    await this.assertActiveUser(user, deadline, signal)
  }

  private async runWithTrackedPostflight<T>(
    applicationId: string,
    expected: VerifiedTrackedInstall,
    action: () => Promise<T>,
    deadline?: AndroidAutomationDeadline,
    signal?: AbortSignal
  ): Promise<T> {
    let result: T
    try {
      result = await action()
    } catch (error) {
      // If the target action failed after taking effect, package/user
      // authority still outranks its partial output or transport error.
      await this.assertTrackedInstall(applicationId, expected, deadline, signal)
      throw error
    }
    await this.assertTrackedInstall(applicationId, expected, deadline, signal)
    return result
  }

  private async assertInstalledPackageIdentity(
    applicationId: string,
    expected: Pick<VerifiedTrackedInstall, 'apkSha256' | 'packageIncarnation' | 'installUserId'>,
    deadline?: AndroidAutomationDeadline,
    signal?: AbortSignal
  ): Promise<void> {
    const installed = await this.installedPackageIdentity(applicationId, expected.installUserId, deadline, signal)
    if (installed.apkSha256 !== expected.apkSha256 || installed.packageIncarnation !== expected.packageIncarnation) {
      this.opts.installs.remove(this.opts.roomId, this.opts.installTarget, applicationId)
      throw automationError(
        'ANDROID_APP_REPLACED',
        `${applicationId} no longer matches the exact package incarnation installed by this Room.`,
        'Run android_run again to install and authorize the current APK instance.',
        409,
        installed.evidence
      )
    }
  }

  private async installedPackageIdentity(
    applicationId: string,
    userId: number,
    deadline?: AndroidAutomationDeadline,
    signal?: AbortSignal
  ): Promise<InstalledPackageIdentity> {
    const result = await this.command(
      ['shell', 'pm', 'path', '--user', String(userId), applicationId],
      { operation: 'Android package probe', timeoutMs: 15_000, stdoutLimit: 16 * 1024, deadline, signal }
    )
    const exactPathLine = /^package:([^\r\n]+)(?:\r?\n)?$/.exec(result.stdout)
    const paths = exactPathLine ? [exactPathLine[1]!] : []
    if (result.code !== 0) {
      // A timeout/transport failure is not evidence that an installed package
      // disappeared. Only a successful exact inventory may invalidate the
      // receipt after a failed path probe.
      const inventory = await this.command(
        ['shell', 'pm', 'list', 'packages', '--user', String(userId), applicationId],
        { operation: 'Android package inventory probe', timeoutMs: 15_000, stdoutLimit: 16 * 1024, deadline, signal }
      )
      const stillInstalled = inventory.code === 0 && inventory.stdout
        .split(/\r?\n/)
        .some((line) => line.trim() === `package:${applicationId}`)
      if (inventory.code !== 0 || stillInstalled) {
        throw automationError(
          'ANDROID_APP_PROBE_FAILED',
          `${applicationId} installation state could not be established on this target.`,
          'Keep the existing install receipt, restore target connectivity, and retry.',
          409,
          safeEvidence(result)
        )
      }
    }
    if (result.code !== 0 || paths.length === 0) {
      if (result.code === 0) {
        throw automationError(
          'ANDROID_APP_IDENTITY_UNVERIFIED',
          `${applicationId} did not expose one exact installed APK path record.`,
          'Restore a standard bounded package-manager response and rerun android_run.',
          409,
          safeEvidenceWithoutOutput(result)
        )
      }
      this.opts.installs.remove(this.opts.roomId, this.opts.installTarget, applicationId)
      throw automationError(
        'ANDROID_APP_NOT_INSTALLED',
        `${applicationId} is no longer installed on this target.`,
        'Run android_run again to reinstall and renew the tracked-app receipt.',
        409,
        safeEvidence(result)
      )
    }
    const baseApks = paths.filter((path) =>
      path.startsWith('/data/app/') &&
      path.endsWith('/base.apk') &&
      Buffer.byteLength(path, 'utf8') <= 4096 &&
      !/[\p{C}\p{Zl}\p{Zp}]/u.test(path) &&
      !path.split('/').some((segment) => segment === '.' || segment === '..')
    )
    if (
      paths.length !== 1 ||
      baseApks.length !== 1 ||
      result.stderr.length > 0 ||
      commandHitOutputLimit(result)
    ) {
      throw automationError(
        'ANDROID_APP_IDENTITY_UNVERIFIED',
        `${applicationId} did not expose exactly one safe installed base APK and no split APKs.`,
        'Run android_run again with one standalone APK; DevHotel will not trust an unsealed split installation.',
        409,
        safeEvidenceWithoutOutput(result)
      )
    }
    const stat = async (): Promise<{ value: string; result: ExecResult }> => {
      const probed = await this.command(
        ['shell', 'stat', '-c', '%d:%i:%s:%Y:%Z', baseApks[0]!],
        { operation: 'Android installed APK incarnation probe', timeoutMs: 15_000, stdoutLimit: 8192, deadline, signal }
      )
      const value = probed.stdout.trim()
      if (probed.code !== 0 || !/^\d+:\d+:\d+:-?\d+:-?\d+$/.test(value)) {
        throw automationError(
          'ANDROID_APP_IDENTITY_UNVERIFIED',
          `${applicationId} installed package incarnation could not be verified.`,
          'Use an Android target with exact stat support and rerun android_run.',
          409,
          safeEvidence(probed)
        )
      }
      return { value, result: probed }
    }
    const before = await stat()
    const hashed = await this.command(
      ['shell', 'sha256sum', baseApks[0]!],
      { operation: 'Android installed APK identity probe', timeoutMs: 60_000, stdoutLimit: 8192, deadline, signal }
    )
    const installedSha256 = /^([a-fA-F0-9]{64})(?:\s|$)/.exec(hashed.stdout.trim())?.[1]?.toLowerCase()
    if (hashed.code !== 0 || !installedSha256) {
      throw automationError(
        'ANDROID_APP_IDENTITY_UNVERIFIED',
        `${applicationId} installed bytes could not be verified.`,
        'Use a target that supports sha256sum and rerun android_run; DevHotel will not trust package name alone.',
        409,
        safeEvidence(hashed)
      )
    }
    const after = await stat()
    if (before.value !== after.value) {
      throw automationError(
        'ANDROID_APP_IDENTITY_UNVERIFIED',
        `${applicationId} changed while its installed package identity was being verified.`,
        'Stop concurrent package changes and retry android_run.',
        409,
        safeEvidence(after.result)
      )
    }
    return {
      apkSha256: installedSha256,
      packageIncarnation: packageIncarnation(baseApks[0]!, before.value),
      evidence: safeEvidence(hashed)
    }
  }

  private async foregroundPackage(
    deadline?: AndroidAutomationDeadline,
    signal?: AbortSignal
  ): Promise<AndroidForegroundPackage | null> {
    const result = await this.command(
      ['shell', 'sh', '-c', "dumpsys window windows 2>/dev/null | grep -m 1 -E '^[[:space:]]*mCurrentFocus=' | head -c 2048"],
      { operation: 'Android foreground probe', timeoutMs: 15_000, stdoutLimit: 2048, deadline, signal }
    )
    const lines = result.stdout.split(/\r?\n/).filter((line) => line.length > 0)
    if (result.code !== 0 || result.stderr.length > 0 || lines.length !== 1) return null
    // mFocusedApp can remain the tracked Activity while a SystemUI/dialog
    // window owns actual input. Only the unique current-focus window is screen
    // authority; never fall back to the resumed-Activity bookkeeping field.
    const match = /^\s*mCurrentFocus=Window\{[^\r\n}]*\bu(\d+)\s+([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)\/[A-Za-z0-9_.$]+[^\r\n}]*}\s*$/.exec(lines[0]!)
    if (!match) return null
    const userId = Number.parseInt(match[1]!, 10)
    if (!Number.isSafeInteger(userId) || userId < 0 || userId > ANDROID_MAX_USER_ID) return null
    return { userId, applicationId: match[2]! }
  }

  private async requireForeground(
    applicationId: string,
    userId: number,
    deadline?: AndroidAutomationDeadline,
    signal?: AbortSignal
  ): Promise<void> {
    const foreground = await this.foregroundPackage(deadline, signal)
    if (foreground?.applicationId === applicationId && foreground.userId === userId) return
    throw automationError(
      foreground
        ? 'ANDROID_APP_NOT_FOREGROUND'
        : 'ANDROID_FOREGROUND_UNKNOWN',
      foreground
        ? `${applicationId} is not the foreground application.`
        : 'DevHotel could not establish which application owns the foreground window.',
      `Launch ${applicationId}, dismiss any system overlay, and retry.`
    )
  }

  async status(): Promise<AndroidAutomationStatus> {
    const activeUser = await this.currentUserAuthority()
    const installedApplicationIds: string[] = []
    const installed = new Map<string, VerifiedTrackedInstall>()
    for (const candidate of this.opts.installs.list(this.opts.roomId, this.opts.installTarget)) {
      // A target may retain tracked apps from several Android users. Status is
      // one active-screen snapshot: preserve other-user receipts, but never
      // verify or project them into this user's installed/foreground context.
      const candidateUser = this.opts.installs.installUserAuthority(
        this.opts.roomId,
        this.opts.installTarget,
        candidate.applicationId
      )
      if (
        !candidateUser ||
        candidateUser.userId !== activeUser.userId ||
        candidateUser.serial !== activeUser.serial
      ) continue
      try {
        const tracked = await this.requireInstalled(candidate.applicationId)
        installedApplicationIds.push(candidate.applicationId)
        installed.set(candidate.applicationId, tracked)
      } catch (error) {
        if (
          !(error instanceof DevHotelError) ||
          (error.code !== 'ANDROID_APP_NOT_INSTALLED' && error.code !== 'ANDROID_APP_REPLACED')
        ) throw error
      }
    }
    const localeResult = await this.command(
      ['shell', 'getprop', 'persist.sys.locale'],
      { operation: 'Android locale probe', timeoutMs: 10_000, stdoutLimit: 256 }
    )
    const locale = localeResult.code === 0 && /^[A-Za-z0-9_-]{2,35}$/.test(localeResult.stdout.trim())
      ? localeResult.stdout.trim()
      : null
    const foreground = await this.foregroundPackage()
    for (const [applicationId, tracked] of installed) {
      await this.assertTrackedInstall(applicationId, tracked)
    }
    await this.assertActiveUser(activeUser)
    const foregroundTracked = foreground ? installed.get(foreground.applicationId) : undefined
    const foregroundApplicationId = foreground && foregroundTracked?.installUserId === foreground.userId
      ? foreground.applicationId
      : null
    if (foregroundApplicationId && foregroundTracked) {
      await this.requireForeground(foregroundApplicationId, foregroundTracked.installUserId)
      await this.assertTrackedInstall(foregroundApplicationId, foregroundTracked)
    }
    return {
      target: this.target,
      installedApplicationIds,
      foregroundApplicationId,
      locale
    }
  }

  /** Safe metadata composition for lock-held artifact/acceptance workflows. */
  async foregroundInstallContext(): Promise<AndroidForegroundInstallContext> {
    const status = await this.status()
    const tracked = status.foregroundApplicationId
      ? await this.requireInstalled(status.foregroundApplicationId)
      : null
    if (tracked) {
      await this.requireForeground(status.foregroundApplicationId!, tracked.installUserId)
      await this.assertTrackedInstall(status.foregroundApplicationId!, tracked)
    }
    const receipt = tracked?.receipt ?? null
    return { status, receipt }
  }

  /**
   * Bracket one lock-held screen-sensitive Core action with a Host-private,
   * live Android user-switch witness. The callback receives no adb, lease, or
   * serial capability. Its value (or original error) is released only after
   * the exact session and durable Android user incarnation are sealed again.
   */
  async withActiveUserScreenWitness<T>(
    action: (signal: AbortSignal) => Promise<T>,
    opts: { actionTimeoutMs?: number } = {}
  ): Promise<T> {
    return this.withActiveUserScreenWitnessDeadline(
      action,
      undefined,
      undefined,
      opts.actionTimeoutMs ?? DEFAULT_SCREEN_WITNESS_ACTION_TIMEOUT_MS
    )
  }

  private async withActiveUserScreenWitnessDeadline<T>(
    action: (signal: AbortSignal) => Promise<T>,
    deadline?: AndroidAutomationDeadline,
    allowApplicationIdTransitions?: string,
    actionTimeoutMs = DEFAULT_SCREEN_WITNESS_ACTION_TIMEOUT_MS
  ): Promise<T> {
    if ((this.target.apiLevel ?? 0) < 31) {
      throw automationError(
        'ANDROID_SCREEN_WITNESS_UNSUPPORTED',
        'This Android target cannot prove a globally ordered active-user screen witness.',
        'Use Android 12 or newer for screen-sensitive tracked automation.',
        409
      )
    }
    const authority = await this.currentUserAuthority(deadline)
    const emitMarkers = async (payloads: string[], signal?: AbortSignal): Promise<void> => {
      if (payloads.length === 0) throw new Error('Android screen witness requires at least one marker')
      const emitted = await this.command(
        payloads.length === 1
          ? ['shell', 'log', '-p', 'i', '-t', USER_SWITCH_FENCE_TAG, payloads[0]!]
          : [
              'shell', 'sh', '-c', SCREEN_WITNESS_CLOSE_SCRIPT, 'devhotel-screen-close',
              USER_SWITCH_FENCE_TAG, ...payloads
            ],
        { operation: 'Android active-user witness marker', timeoutMs: 10_000, stdoutLimit: 1024, deadline, signal }
      )
      if (
        emitted.code !== 0 ||
        emitted.stdout.length > 0 ||
        emitted.stderr.length > 0 ||
        commandHitOutputLimit(emitted)
      ) {
        throw automationError(
          'ANDROID_SCREEN_WITNESS_FAILED',
          'The selected Android target could not establish a private active-user screen witness.',
          'Retry while the target is connected and no other actor is changing Android users.',
          409,
          safeEvidenceWithoutOutput(emitted)
        )
      }
    }
    if (!Number.isSafeInteger(actionTimeoutMs) || actionTimeoutMs < 1 || actionTimeoutMs > 120_000) {
      throw new Error('Android screen witness action timeout must be between 1ms and 120000ms')
    }
    const readerTimeoutMs = deadline
      ? Math.max(1, deadline.at - this.now())
      : actionTimeoutMs + SCREEN_WITNESS_NON_ACTION_BUDGET_MS
    const maxActionRecords = allowApplicationIdTransitions ? MAX_TAP_SCREEN_WITNESS_RECORDS : 2
    const maxActionTransitions = maxActionRecords - 2
    const witnessRecordLimit = maxActionRecords + SCREEN_WITNESS_BOOTSTRAP_RECORD_BUDGET
    type CompletedReader = { result: ExecResult | null; error: unknown }
    interface ActiveReader {
      begin: string
      beginIndex: number
      issuedBegins: Set<string>
      controller: AbortController
      transcript: Buffer
      witnessStderrBytes: number
      witnessOverflow: boolean
      readerSettled: boolean
      closing: boolean
      reader: Promise<CompletedReader>
    }
    let activeReader: ActiveReader | null = null
    // Start the reader first. `logcat -T 1` chooses the newest raw row before
    // applying client tag filters, so a marker written before a slow fenced
    // helper starts can be displaced by unrelated buffer traffic. Fresh
    // bootstrap markers are emitted until one is observed in this same live
    // stream; every pre-action record consumes a small fixed budget.
    {
      const state = {
        begin: '',
        beginIndex: -1,
        issuedBegins: new Set<string>(),
        controller: new AbortController(),
        transcript: Buffer.alloc(0),
        witnessStderrBytes: 0,
        witnessOverflow: false,
        readerSettled: false,
        closing: false,
        reader: Promise.resolve({ result: null, error: null }) as Promise<CompletedReader>
      }
      let markReady!: () => void
      let markUnready!: (error: unknown) => void
      let readySettled = false
      let readyObserved = false
      const ready = new Promise<void>((resolve, reject) => {
        markReady = () => {
          if (readySettled) return
          readySettled = true
          readyObserved = true
          resolve()
        }
        markUnready = (error) => {
          if (readySettled) return
          readySettled = true
          reject(error)
        }
      })
      const inspectReadiness = (): void => {
        const parsed = parseScreenWitnessTranscript(state.transcript.toString('utf8'))
        if (!parsed) {
          const error = new Error('active-user witness framing was invalid')
          markUnready(error)
          state.controller.abort(error)
          return
        }
        if (!readySettled) {
          const observedBegins = parsed.records.flatMap((record, index) =>
            record.tag === USER_SWITCH_FENCE_TAG && state.issuedBegins.has(record.payload)
              ? [{ index, payload: record.payload }]
              : []
          )
          const observed = observedBegins.at(-1)
          if (observed) {
            const suffix = parsed.records.slice(observed.index + 1)
            const suffixAllowed = observed.index < SCREEN_WITNESS_BOOTSTRAP_RECORD_BUDGET &&
              suffix.length <= maxActionTransitions && suffix.every((record) =>
              record.tag !== USER_SWITCH_FENCE_TAG &&
              Boolean(allowApplicationIdTransitions) &&
              isAllowedAppTransition(record, allowApplicationIdTransitions!, authority.userId)
            )
            if (!suffixAllowed) {
              const error = new Error('active-user witness observed a forbidden bootstrap transition')
              markUnready(error)
              state.controller.abort(error)
              return
            }
            state.begin = observed.payload
            state.beginIndex = observed.index
            markReady()
            return
          }
          if (parsed.records.length >= SCREEN_WITNESS_BOOTSTRAP_RECORD_BUDGET) {
            const error = new Error('active-user witness exhausted its pre-action record budget')
            markUnready(error)
            state.controller.abort(error)
          }
          return
        }
        if (readyObserved && !state.closing) {
          const beginIndexes = parsed.records.flatMap((record, index) =>
            record.tag === USER_SWITCH_FENCE_TAG && record.payload === state.begin ? [index] : []
          )
          const transitions = parsed.records.slice(state.beginIndex + 1)
          const allowed = beginIndexes.length === 1 && beginIndexes[0] === state.beginIndex &&
            transitions.length <= maxActionTransitions && transitions.every((record) =>
            record.tag !== USER_SWITCH_FENCE_TAG &&
            Boolean(allowApplicationIdTransitions) &&
            isAllowedAppTransition(record, allowApplicationIdTransitions!, authority.userId)
          )
          if (allowed) return
          state.controller.abort(new Error('active-user witness observed a forbidden live transition'))
          return
        }
        markUnready(new Error('active-user witness did not begin with the private marker'))
      }
      const appendWitnessStdout = (chunk: ExecOutputChunk): void => {
        const data = Buffer.from(chunk)
        const remaining = Math.max(0, MAX_USER_SWITCH_WITNESS_BYTES - state.transcript.byteLength)
        if (data.byteLength > remaining) state.witnessOverflow = true
        if (remaining > 0) {
          state.transcript = Buffer.concat([state.transcript, data.subarray(0, remaining)])
        }
        if (state.witnessOverflow) {
          const error = new Error('active-user witness overflowed')
          markUnready(error)
          state.controller.abort(error)
        }
        inspectReadiness()
      }
      const appendWitnessStderr = (chunk: ExecOutputChunk): void => {
        const bytes = Buffer.byteLength(Buffer.from(chunk))
        if (bytes === 0) return
        state.witnessStderrBytes += bytes
        const error = new Error('active-user witness reader wrote diagnostics')
        markUnready(error)
        state.controller.abort(error)
      }
      state.reader = this.opts.exec(
        [
          'shell', 'sh', '-c', SCREEN_WITNESS_READER_SCRIPT, 'devhotel-screen-witness',
          String(witnessRecordLimit)
        ],
        {
          timeoutMs: readerTimeoutMs,
          signal: state.controller.signal,
          maxStdoutBytes: MAX_USER_SWITCH_WITNESS_BYTES,
          maxStderrBytes: 1024,
          onStdout: appendWitnessStdout,
          onStderr: appendWitnessStderr
        }
      ).then(
        (result) => {
          state.readerSettled = true
          if (!readySettled) markUnready(new Error('active-user witness reader exited before readiness'))
          return { result, error: null }
        },
        (error: unknown) => {
          state.readerSettled = true
          if (!readySettled) markUnready(error)
          return { result: null, error }
        }
      )
      let readyTimer: ReturnType<typeof setTimeout> | null = null
      const readyTimeoutMs = deadline
        ? Math.max(1, Math.min(SCREEN_WITNESS_READY_TIMEOUT_MS, deadline.at - this.now()))
        : SCREEN_WITNESS_READY_TIMEOUT_MS
      try {
        readyTimer = setTimeout(() => {
          const error = new Error('active-user witness readiness timed out')
          markUnready(error)
          state.controller.abort(error)
        }, readyTimeoutMs)
        readyTimer.unref?.()
        // Avoid an unhandled rejection if the live reader fails while a marker
        // helper is still unwinding; the awaited races below retain the error.
        void ready.catch(() => undefined)
        for (let attempt = 0; attempt < SCREEN_WITNESS_BOOTSTRAP_ATTEMPTS && !readyObserved; attempt += 1) {
          const begin = `devhotel-user-begin-${randomUUID()}`
          state.issuedBegins.add(begin)
          await emitMarkers([begin], state.controller.signal)
          if (readyObserved) break
          await Promise.race([
            ready,
            this.pauseWithSignal(SCREEN_WITNESS_BOOTSTRAP_RETRY_MS, state.controller.signal)
          ])
        }
        if (!readyObserved) {
          const error = new Error('active-user witness bootstrap marker was not observed')
          state.controller.abort(error)
          throw error
        }
        if (state.readerSettled || state.witnessOverflow || state.witnessStderrBytes > 0) {
          throw new Error('active-user witness reader was not live at the action boundary')
        }
        activeReader = state
      } catch (error) {
        state.controller.abort(error)
        const completed = await state.reader
        const leaseError = error instanceof DeviceLeaseError
          ? error
          : completed.error instanceof DeviceLeaseError
            ? completed.error
            : null
        if (leaseError) throw leaseError
        if (
          deadline && error instanceof DevHotelError && error.code === 'ANDROID_WAIT_TIMEOUT'
        ) throw error
      } finally {
        if (readyTimer) clearTimeout(readyTimer)
      }
    }
    if (!activeReader) {
      throw automationError(
        'ANDROID_SCREEN_WITNESS_FAILED',
        'The selected Android target could not establish a live active-user screen witness.',
        'Retry while the target is connected and its Android event buffers are responsive.',
        409
      )
    }

    let actionValue!: T
    let actionError: unknown
    let actionThrew = false
    let witnessFailure: unknown
    let closingReader = false
    void activeReader.reader.then((completed) => {
      if (
        !closingReader ||
        completed.error ||
        !completed.result ||
        completed.result.code !== 0 ||
        commandHitOutputLimit(completed.result) ||
        completed.result.stderr.length > 0
      ) {
        activeReader!.controller.abort(
          completed.error instanceof Error
            ? completed.error
            : new Error('active-user witness reader exited before its close boundary')
        )
      }
    })
    const actionTimeoutError = new Error('Android screen witness action exceeded its declared timeout')
    const actionTimer = setTimeout(() => {
      activeReader!.controller.abort(actionTimeoutError)
    }, deadline
      ? Math.max(1, Math.min(actionTimeoutMs, deadline.at - this.now()))
      : actionTimeoutMs)
    actionTimer.unref?.()
    try {
      await this.assertActiveUser(authority, deadline, activeReader.controller.signal)
      try {
        actionValue = await action(activeReader.controller.signal)
      } catch (error) {
        actionThrew = true
        actionError = error
      }
    } catch (error) {
      witnessFailure = error
    } finally {
      clearTimeout(actionTimer)
    }
    if (activeReader.controller.signal.aborted) {
      witnessFailure ??= activeReader.controller.signal.reason
    }

    // The end capability is created only after the action has settled. A
    // concurrent shell can learn the begin marker and cause a denial, but it
    // cannot pre-log the unknown end marker around an A -> B -> A switch.
    const end = `devhotel-user-end-${randomUUID()}`
    const closePadding = Array.from(
      { length: witnessRecordLimit - 1 },
      (_unused, index) => `devhotel-user-close-${randomUUID()}-${index}`
    )
    if (witnessFailure instanceof DeviceLeaseError || actionError instanceof DeviceLeaseError) {
      activeReader.controller.abort(witnessFailure ?? actionError)
    } else if (activeReader.controller.signal.aborted) {
      // Reader/action timeout or transport failure already owns cleanup.
    } else {
      closingReader = true
      activeReader.closing = true
      try {
        await emitMarkers([end, ...closePadding], activeReader.controller.signal)
      } catch (error) {
        witnessFailure ??= error
        activeReader.controller.abort(error)
      }
    }
    const completedReader = await activeReader.reader
    const parsedTranscript = parseScreenWitnessTranscript(activeReader.transcript.toString('utf8'))
    const witnessRecords = parsedTranscript?.records ?? []
    const beginIndexes = witnessRecords.flatMap((record, index) =>
      record.tag === USER_SWITCH_FENCE_TAG && record.payload === activeReader.begin ? [index] : []
    )
    const beginIndex = beginIndexes[0] ?? -1
    const endIndexes = witnessRecords.flatMap((record, index) =>
      record.tag === USER_SWITCH_FENCE_TAG && record.payload === end ? [index] : []
    )
    const endIndex = endIndexes[0] ?? -1
    const transitions = endIndex > beginIndex && beginIndex >= 0
      ? witnessRecords.slice(beginIndex + 1, endIndex)
      : []
    const padding = endIndex >= 0 ? witnessRecords.slice(endIndex + 1) : []
    const exactMarkers =
      parsedTranscript?.complete === true &&
      witnessRecords.length === witnessRecordLimit &&
      beginIndexes.length === 1 &&
      beginIndex === activeReader.beginIndex &&
      endIndexes.length === 1 &&
      endIndex > beginIndex &&
      transitions.length <= maxActionTransitions &&
      transitions.every((record) => record.tag !== USER_SWITCH_FENCE_TAG) &&
      padding.every((record, index) =>
        record.tag === USER_SWITCH_FENCE_TAG && record.payload === closePadding[index]
      )
    const transitionsAllowed = exactMarkers && (
      allowApplicationIdTransitions
        ? transitions.every((record) => isAllowedAppTransition(
            record,
            allowApplicationIdTransitions,
            authority.userId
          ))
        : transitions.length === 0
    )
    if (
      completedReader.error ||
      !completedReader.result ||
      completedReader.result.code !== 0 ||
      commandHitOutputLimit(completedReader.result) ||
      completedReader.result.stderr.length > 0 ||
      activeReader.witnessStderrBytes > 0 ||
      activeReader.witnessOverflow ||
      !exactMarkers ||
      !transitionsAllowed
    ) {
      witnessFailure ??= new Error('active-user witness transcript was not exact')
    }
    try {
      await this.assertActiveUser(authority, deadline)
    } catch (error) {
      witnessFailure ??= error
    }
    const leaseError = witnessFailure instanceof DeviceLeaseError
      ? witnessFailure
      : actionError instanceof DeviceLeaseError
        ? actionError
        : completedReader.error instanceof DeviceLeaseError
          ? completedReader.error
          : null
    if (leaseError) throw leaseError
    if (
      deadline &&
      witnessFailure instanceof DevHotelError &&
      witnessFailure.code === 'ANDROID_WAIT_TIMEOUT'
    ) throw witnessFailure
    if (witnessFailure) {
      throw automationError(
        'ANDROID_SCREEN_WITNESS_FAILED',
        'The screen-sensitive Android action crossed an unverified active-user boundary.',
        'Retry while no other actor is changing Android users or interfering with the bounded witness.',
        409
      )
    }
    if (actionThrew) throw actionError
    return actionValue
  }

  async launch(
    applicationId: string,
    activity?: string,
    extras?: AndroidExtras
  ): Promise<AndroidLaunchResult> {
    const tracked = await this.requireInstalled(applicationId)
    let component: string
    if (activity) {
      component = componentForActivity(applicationId, activity)
    } else {
      const resolved = await this.runWithTrackedPostflight(
        applicationId,
        tracked,
        () => this.command(
          [
            'shell', 'cmd', 'package', 'resolve-activity', '--brief', '--components',
            '--user', String(tracked.installUserId),
            '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', applicationId
          ],
          { operation: 'Android launcher resolution', timeoutMs: 20_000, stdoutLimit: 16 * 1024 }
        )
      )
      const prefix = `${applicationId}/`
      component = resolved.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.startsWith(prefix) && /^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/.test(line)) ?? ''
      if (resolved.code !== 0 || !component) {
        throw automationError(
          'ANDROID_LAUNCHER_NOT_FOUND',
          `No launcher activity belonging to ${applicationId} was resolved.`,
          'Pass an explicit activity inside the tracked application package.',
          409,
          safeEvidence(resolved)
        )
      }
    }
    await this.assertTrackedInstall(applicationId, tracked)
    const result = await this.runWithTrackedPostflight(
      applicationId,
      tracked,
      () => this.command(
        ['shell', 'am', 'start', '-W', '--user', String(tracked.installUserId), '-n', component, ...extrasArgv(extras)],
        { operation: 'Android app launch', timeoutMs: 60_000, stdoutLimit: 64 * 1024 }
      )
    )
    // `am start -W` reports dispatch, not durable foreground ownership. Seal
    // the exact installed incarnation again after proving the tracked package
    // owns the selected user's foreground before releasing success or output.
    await this.requireForeground(applicationId, tracked.installUserId)
    await this.assertTrackedInstall(applicationId, tracked)
    if (result.code !== 0) {
      throw automationError(
        'ANDROID_LAUNCH_FAILED',
        `${applicationId} could not be launched on the selected target.`,
        'Inspect the bounded command evidence and verify the activity is exported.',
        409,
        safeEvidence(result)
      )
    }
    return { target: this.target, applicationId, component, evidence: safeEvidence(result) }
  }

  async forceStop(applicationId: string): Promise<AndroidForceStopResult> {
    const tracked = await this.requireInstalled(applicationId)
    const result = await this.runWithTrackedPostflight(
      applicationId,
      tracked,
      () => this.command(
        ['shell', 'am', 'force-stop', '--user', String(tracked.installUserId), applicationId],
        { operation: 'Android force-stop', timeoutMs: 30_000, stdoutLimit: 16 * 1024 }
      )
    )
    if (result.code !== 0) {
      throw automationError(
        'ANDROID_FORCE_STOP_FAILED',
        `${applicationId} could not be force-stopped.`,
        'Verify the selected target is healthy and retry.',
        409,
        safeEvidence(result)
      )
    }
    const stopped = await this.runWithTrackedPostflight(
      applicationId,
      tracked,
      () => this.packageStoppedState(applicationId, tracked.installUserId)
    )
    const foreground = await this.foregroundPackage()
    await this.assertTrackedInstall(applicationId, tracked)
    if (
      !stopped ||
      !foreground ||
      (foreground.applicationId === applicationId && foreground.userId === tracked.installUserId)
    ) {
      throw automationError(
        'ANDROID_FORCE_STOP_FAILED',
        `${applicationId} did not reach a proven stopped state for the tracked Android user.`,
        'Dismiss overlays, stop concurrent package changes, and retry while the exact target remains connected.',
        409,
        safeEvidence(result)
      )
    }
    return { target: this.target, applicationId, evidence: safeEvidence(result) }
  }

  private async packageStoppedState(applicationId: string, userId: number): Promise<boolean> {
    const completionFence = `devhotel-force-stop-${randomUUID()}`
    let result: ExecResult
    try {
      result = await this.command(
        ['shell', 'sh', '-c', PACKAGE_DUMP_SCRIPT, 'devhotel-force-stop', applicationId, completionFence],
        {
          operation: 'Android force-stop state proof',
          timeoutMs: 15_000,
          stdoutLimit: MAX_PACKAGE_DUMP_BYTES,
          outputLimitRecovery: 'Use an app with a bounded package-manager record and retry force-stop.'
        }
      )
    } catch (error) {
      if (!(error instanceof DevHotelError) || error.code !== 'ANDROID_OUTPUT_LIMIT') throw error
      throw automationError(
        'ANDROID_FORCE_STOP_FAILED',
        `${applicationId} did not expose a bounded stopped-state record.`,
        'Restore package-manager responsiveness and retry while the exact target remains connected.',
        409
      )
    }
    const lines = result.stdout.split(/\n/).map((line) => line.replace(/\r$/, ''))
    const lastContentIndex = lines.reduce((last, line, index) => line ? index : last, -1)
    const completionIndexes = lines.flatMap((line, index) => line === completionFence ? [index] : [])
    const escaped = applicationId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const header = new RegExp(`^ {2}Package \\[${escaped}\\] \\([0-9a-fA-F]+\\):$`)
    const headerIndexes = lines.flatMap((line, index) => header.test(line) ? [index] : [])
    const userRecord = new RegExp(`^ {4}User ${userId}: (.+)$`)
    const userRows = lines.flatMap((line, index) => {
      const match = userRecord.exec(line)
      return match ? [{ index, fields: match[1]! }] : []
    })
    const stoppedFields = [...(userRows[0]?.fields ?? '').matchAll(/(?:^| )stopped=(true|false)(?= |$)/g)]
    if (
      result.code !== 0 ||
      result.stderr.length > 0 ||
      commandHitOutputLimit(result) ||
      completionIndexes.length !== 1 ||
      completionIndexes[0] !== lastContentIndex ||
      headerIndexes.length !== 1 ||
      userRows.length !== 1 ||
      userRows[0]!.index <= headerIndexes[0]! ||
      userRows[0]!.index >= completionIndexes[0]! ||
      stoppedFields.length !== 1
    ) {
      throw automationError(
        'ANDROID_FORCE_STOP_FAILED',
        `${applicationId} did not expose one exact stopped-state record for its tracked Android user.`,
        'Restore package-manager responsiveness and retry while the exact target remains connected.',
        409,
        safeEvidenceWithoutOutput(result)
      )
    }
    return stoppedFields[0]![1] === 'true'
  }

  private async readTrackedUiHierarchy(
    applicationId: string,
    tracked: VerifiedTrackedInstall,
    signal: AbortSignal,
    opts: AndroidDumpOptions = {}
  ): Promise<AndroidUiDumpResult> {
    const { deadline } = opts
    const path = `/data/local/tmp/devhotel-ui-${randomUUID()}.xml`
    let result!: AndroidUiDumpResult
    try {
      // The hierarchy command owns only its XML temp file. User-switch evidence
      // is streamed concurrently into Host-private memory by the surrounding
      // witness; no transcript path or end token exists in the Android guest.
      const dumpScript = [
        'path="$1"',
        'child=',
        'cleanup() { if [ -n "$child" ]; then kill "$child" 2>/dev/null; wait "$child" 2>/dev/null; child=; fi; rm -f "$path"; }',
        'trap cleanup 0 1 2 15',
        'uiautomator dump --compressed "$path" >/dev/null 2>&1 & child=$!',
        'wait "$child"; status=$?; child=',
        '[ "$status" -eq 0 ] || exit "$status"',
        `head -c ${MAX_UI_XML_BYTES + 1} "$path"`
      ].join('; ')
      const read = await this.runWithTrackedPostflight(
        applicationId,
        tracked,
        () => this.command(
          ['exec-out', 'sh', '-c', dumpScript, 'devhotel-ui-dump', path],
          {
            operation: 'Android UI dump and hierarchy read',
            timeoutMs: 60_000,
            stdoutLimit: MAX_UI_XML_BYTES + 1,
            deadline,
            signal
          }
        ),
        deadline,
        signal
      )
      await this.requireForeground(applicationId, tracked.installUserId, deadline, signal)
      if (read.code !== 0) {
        throw automationError(
          'ANDROID_UI_DUMP_FAILED',
          'Android UIAutomator hierarchy evidence could not be read.',
          'Retry the dump while the selected target remains connected.',
          409,
          safeEvidence(read)
        )
      }
      if (Buffer.byteLength(read.stdout, 'utf8') > MAX_UI_XML_BYTES) {
        throw automationError(
          'ANDROID_UI_DUMP_LIMIT',
          `The UI hierarchy exceeded the ${MAX_UI_XML_BYTES}-byte safety limit.`,
          'Narrow the screen state or remove an unexpectedly large accessibility tree.'
        )
      }
      const parsed = parseAndroidUiHierarchy(read.stdout, applicationId, {
        filter: opts.filter,
        maxNodes: opts.maxNodes ?? 500,
        textMatch: opts.textMatch
      })
      if (deadline && this.now() >= deadline.at) throw waitTimeoutError(applicationId)
      await this.assertTrackedInstall(applicationId, tracked, deadline, signal)
      await this.requireForeground(applicationId, tracked.installUserId, deadline, signal)
      result = { target: this.target, applicationId, ...parsed }
    } finally {
      const cleanupTimeoutMs = deadline
        ? Math.max(0, Math.min(10_000, deadline.at - this.now()))
        : 10_000
      if (cleanupTimeoutMs > 0) {
        await this.opts.exec(['shell', 'rm', '-f', path], {
          timeoutMs: cleanupTimeoutMs,
          maxStdoutBytes: 1024,
          maxStderrBytes: 1024
        }).catch(() => undefined)
      }
    }
    // The best-effort cleanup is still an awaited exact-target operation. Seal
    // the captured result after it so a replacement during cleanup cannot be
    // published as trusted UI from the old receipt.
    await this.requireForeground(applicationId, tracked.installUserId, deadline, signal)
    await this.assertTrackedInstall(applicationId, tracked, deadline, signal)
    return result
  }

  private async dump(
    applicationId: string,
    opts: AndroidDumpOptions = {}
  ): Promise<AndroidUiDumpResult> {
    const tracked = await this.requireInstalled(applicationId, opts.deadline)
    await this.requireForeground(applicationId, tracked.installUserId, opts.deadline)
    return this.withActiveUserScreenWitnessDeadline(
      (signal) => this.readTrackedUiHierarchy(applicationId, tracked, signal, opts),
      opts.deadline
    )
  }

  dumpUi(input: AndroidDumpUiInput): Promise<AndroidUiDumpResult> {
    return this.dump(input.applicationId, { filter: input.filter, maxNodes: input.maxNodes ?? 200 })
  }

  async waitForText(input: AndroidWaitForTextInput): Promise<AndroidWaitForTextResult> {
    const startedAt = this.now()
    const deadline: AndroidAutomationDeadline = {
      at: startedAt + (input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
      applicationId: input.applicationId
    }
    const match = input.match ?? 'exact'
    let attempts = 0
    do {
      attempts += 1
      const dumped = await this.dump(input.applicationId, {
        filter: input.text,
        maxNodes: 500,
        deadline,
        textMatch: match
      })
      const matched = dumped.nodes.find((node) => matchesText(node, input.text, match))
      if (matched) {
        return {
          target: this.target,
          applicationId: input.applicationId,
          matched,
          elapsedMs: Math.max(0, this.now() - startedAt),
          attempts
        }
      }
      if (this.now() >= deadline.at) break
      await this.pause(Math.min(input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, Math.max(0, deadline.at - this.now())))
    } while (this.now() <= deadline.at)
    throw waitTimeoutError(input.applicationId)
  }

  async tapText(input: AndroidTapTextInput): Promise<AndroidTapTextResult> {
    const match = input.match ?? 'exact'
    const dumped = await this.dump(input.applicationId, {
      filter: input.text,
      maxNodes: 500,
      textMatch: match
    })
    if (dumped.truncated) {
      throw automationError(
        'ANDROID_UI_TEXT_AMBIGUOUS',
        'The bounded UI evidence was truncated before text uniqueness could be established.',
        'Use a more specific text or simplify the screen before tapping.'
      )
    }
    const matches = dumped.nodes.filter((node) => matchesText(node, input.text, match))
    if (matches.length === 0) {
      throw automationError(
        'ANDROID_UI_TEXT_NOT_FOUND',
        `No app-scoped UI node matched the requested text in ${input.applicationId}.`,
        'Call android_dump_ui to inspect the current sanitized hierarchy.'
      )
    }
    if (matches.length !== 1) {
      throw automationError(
        'ANDROID_UI_TEXT_AMBIGUOUS',
        `${matches.length} app-scoped UI nodes matched the requested text.`,
        'Use a more specific text or make the screen state unambiguous before tapping.'
      )
    }
    const first = matches[0]!
    // Re-read after the tap witness is live. Foreground can remain unchanged
    // while a same-app animation/list update silently moves a node during
    // witness bootstrap or authority probes.
    const tracked = await this.requireInstalled(input.applicationId)
    await this.requireForeground(input.applicationId, tracked.installUserId)
    let tapped!: AndroidUiNode
    const inputBoundary: { attempted: boolean; result: ExecResult | null; commandError: unknown } = {
      attempted: false,
      result: null,
      commandError: null
    }
    let result: ExecResult
    try {
      result = await this.withActiveUserScreenWitnessDeadline(async (signal) => {
      const confirmedDump = await this.readTrackedUiHierarchy(input.applicationId, tracked, signal, {
        filter: input.text,
        maxNodes: 500,
        textMatch: match
      })
      if (confirmedDump.truncated) {
        throw automationError(
          'ANDROID_UI_TEXT_AMBIGUOUS',
          'The confirming UI evidence was truncated before text uniqueness could be established.',
          'Use a more specific text or simplify the screen before tapping.'
        )
      }
      const confirmedMatches = confirmedDump.nodes.filter((node) => matchesText(node, input.text, match))
      if (confirmedMatches.length !== 1) {
        throw automationError(
          confirmedMatches.length === 0 ? 'ANDROID_UI_TEXT_NOT_FOUND' : 'ANDROID_UI_TEXT_AMBIGUOUS',
          confirmedMatches.length === 0
            ? `The requested text disappeared before input in ${input.applicationId}.`
            : `${confirmedMatches.length} app-scoped UI nodes matched immediately before input.`,
          'Wait for the screen to settle and retry with unambiguous text.'
        )
      }
      tapped = confirmedMatches[0]!
      if (
        first.text !== tapped.text ||
        first.contentDescription !== tapped.contentDescription ||
        first.resourceId !== tapped.resourceId ||
        first.className !== tapped.className ||
        first.bounds.left !== tapped.bounds.left ||
        first.bounds.top !== tapped.bounds.top ||
        first.bounds.right !== tapped.bounds.right ||
        first.bounds.bottom !== tapped.bounds.bottom
      ) {
        throw automationError(
          'ANDROID_UI_TEXT_MOVED',
          'The requested UI node changed or moved before input could be injected.',
          'Wait for animations and live content to settle, then retry.'
        )
      }
      inputBoundary.attempted = true
      const guardedResult = await this.runWithTrackedPostflight(
        input.applicationId,
        tracked,
        async () => {
          let commandResult: ExecResult
          try {
            commandResult = await this.command(
              // InputShellCommand has no Android-user selector. Keep a same-shell
              // current-user guard on both sides of input, while the outer live
              // witness streams globally ordered switch evidence into Host memory.
              [
                'shell', 'sh', '-c', GUARDED_TAP_SCRIPT, 'devhotel-tap',
                String(tracked.installUserId), String(tapped.center.x), String(tapped.center.y)
              ],
              { operation: 'Android text tap', timeoutMs: 15_000, stdoutLimit: 16 * 1024, signal }
            )
          } catch (error) {
            inputBoundary.commandError = error
            throw error
          }
          // Capture the Android command boundary before package postflight. A
          // later witness/identity failure must not turn an already committed,
          // non-idempotent tap into a generic retryable failure.
          inputBoundary.result = commandResult
          return commandResult
        },
        undefined,
        signal
      )
        return guardedResult
      },
        undefined,
        input.applicationId
      )
      if (result.code !== 0) {
        return {
          target: this.target,
          applicationId: input.applicationId,
          tapped,
          outcome: 'indeterminate',
          retrySafe: false,
          evidence: null
        }
      }
      // Give input-triggered Activity/window work one bounded scheduling turn,
      // then observe its package under fresh user/install/lease fences.
      await this.pause(250)
      await this.requireForeground(input.applicationId, tracked.installUserId)
      // Foreground evidence can name the same applicationId after a concurrent
      // reinstall. Keep exact package identity as the final awaited authority
      // check before any tap result or command evidence crosses the boundary.
      await this.assertTrackedInstall(input.applicationId, tracked)
    } catch (error) {
      if (
        inputBoundary.attempted &&
        (
          inputBoundary.commandError === error ||
          (error instanceof DevHotelError &&
            (error.code === 'ANDROID_SCREEN_WITNESS_FAILED' || error.code === 'ANDROID_APP_NOT_FOREGROUND'))
        )
      ) {
        return {
          target: this.target,
          applicationId: input.applicationId,
          tapped,
          outcome: inputBoundary.result?.code === 0 ? 'committed' : 'indeterminate',
          retrySafe: false,
          evidence: null
        }
      }
      throw error
    }
    return {
      target: this.target,
      applicationId: input.applicationId,
      tapped,
      outcome: 'confirmed',
      retrySafe: false,
      evidence: safeEvidence(result)
    }
  }

  private async packageUid(applicationId: string, userId: number): Promise<AndroidPackageAuthority> {
    const completionFence = `devhotel-package-dump-${randomUUID()}`
    let packageDump: ExecResult
    try {
      packageDump = await this.command(
        [
          'shell', 'sh', '-c', PACKAGE_DUMP_SCRIPT,
          'devhotel-package-dump', applicationId, completionFence
        ],
        {
          operation: 'Android package shared-UID declaration probe',
          timeoutMs: 15_000,
          stdoutLimit: MAX_PACKAGE_DUMP_BYTES,
          outputLimitRecovery: 'Use an app with a bounded package-manager record and rerun android_run.'
        }
      )
    } catch (error) {
      if (!(error instanceof DevHotelError) || error.code !== 'ANDROID_OUTPUT_LIMIT') throw error
      throw automationError(
        'ANDROID_LOGCAT_UNSUPPORTED',
        'The selected Android target did not provide a bounded package shared-UID record.',
        'Use Android 12 or newer with a bounded package-manager record; DevHotel will not infer UID isolation.',
        409
      )
    }
    const escaped = applicationId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const dumpLines = packageDump.stdout.split(/\n/).map((line) => line.replace(/\r$/, ''))
    const completionIndexes = dumpLines
      .map((line, index) => line === completionFence ? index : -1)
      .filter((index) => index >= 0)
    const lastContentIndex = dumpLines.reduce((last, line, index) => line ? index : last, -1)
    const header = new RegExp(`^ {2}Package \\[${escaped}\\] \\([0-9a-fA-F]+\\):$`)
    const headerIndexes = dumpLines
      .map((line, index) => header.test(line) ? index : -1)
      .filter((index) => index >= 0)
    if (
      packageDump.code !== 0 ||
      Boolean(packageDump.stderr.trim()) ||
      commandHitOutputLimit(packageDump) ||
      completionIndexes.length !== 1 ||
      completionIndexes[0] !== lastContentIndex ||
      headerIndexes.length !== 1
    ) {
      throw automationError(
        'ANDROID_LOGCAT_UNSUPPORTED',
        'The selected Android target did not expose an exact package shared-UID record.',
        'Use Android 12 or newer with package-manager dump support; DevHotel will not infer UID isolation.',
        409,
        safeEvidenceWithoutOutput(packageDump)
      )
    }
    let fieldIndex = headerIndexes[0]! + 1
    if (/^ {4}compat name=/.test(dumpLines[fieldIndex] ?? '')) fieldIndex += 1
    // Settings.dumpPackageLPr renamed this exact structural field in Android
    // 14. Bind the accepted spelling to the positively probed API so an
    // APK-controlled lookalike cannot make an incompatible dump authoritative.
    const packageIdLabel = (this.target.apiLevel ?? 0) >= 34 ? 'appId' : 'userId'
    const packageIdField = new RegExp(`^ {4}${packageIdLabel}=(\\d+)$`).exec(dumpLines[fieldIndex] ?? '')
    fieldIndex += 1
    const hasSharedUser = /^ {4}sharedUser=\S/.test(dumpLines[fieldIndex] ?? '')
    if (hasSharedUser) fieldIndex += 1
    const hasStablePackageFields =
      /^ {4}pkg=\S/.test(dumpLines[fieldIndex] ?? '') &&
      /^ {4}codePath=\S/.test(dumpLines[fieldIndex + 1] ?? '')
    if (!packageIdField || !hasStablePackageFields) {
      throw automationError(
        'ANDROID_LOGCAT_UNSUPPORTED',
        'The selected Android target returned an ambiguous package shared-UID record.',
        'Use Android 12 or newer with the standard package-manager dump format; DevHotel will not infer UID isolation.',
        409,
        safeEvidenceWithoutOutput(packageDump)
      )
    }
    // AOSP retains this scoped PackageSetting field even when the active
    // SharedUserSetting currently has only one package. Rejecting the
    // declaration itself prevents a same-signed companion from joining,
    // logging, and leaving the UID between current-owner probes (an ABA).
    if (hasSharedUser) {
      throw automationError(
        'ANDROID_LOGCAT_SHARED_UID',
        `${applicationId} belongs to a declared shared UID on this target.`,
        'Use an application with its own UID; DevHotel will not expose logs from a legacy shared-user group.',
        409,
        safeEvidenceWithoutOutput(packageDump)
      )
    }

    const uidResult = await this.command(
      ['shell', 'pm', 'list', 'packages', '-U', '--user', String(userId), applicationId],
      { operation: 'Android package UID probe', timeoutMs: 15_000, stdoutLimit: 16 * 1024 }
    )
    const match = new RegExp(`^package:${escaped}\\s+uid[:=](\\d+)$`, 'm').exec(uidResult.stdout)
    const uid = match ? Number.parseInt(match[1]!, 10) : Number.NaN
    const appId = Number.isSafeInteger(uid) && uid >= 0 ? uid % ANDROID_PER_USER_RANGE : Number.NaN
    if (
      uidResult.code !== 0 ||
      !match ||
      !Number.isSafeInteger(uid) ||
      appId < ANDROID_FIRST_APPLICATION_ID ||
      appId > ANDROID_LAST_APPLICATION_ID ||
      Math.floor(uid / ANDROID_PER_USER_RANGE) !== userId ||
      String(appId) !== packageIdField[1]
    ) {
      throw automationError(
        'ANDROID_LOGCAT_UNSUPPORTED',
        'The selected Android target did not expose an exact package UID.',
        'Use a target with package-manager UID filtering support.',
        409,
        safeEvidenceWithoutStdout(uidResult)
      )
    }
    const owners = await this.command(
      ['shell', 'pm', 'list', 'packages', '-U', '--user', String(userId), '--uid', String(uid)],
      { operation: 'Android shared UID probe', timeoutMs: 15_000, stdoutLimit: 64 * 1024 }
    )
    const ownerLines = owners.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    const ownerRecords = ownerLines.map((line) =>
      /^package:([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)\s+uid[:=](\d+)$/.exec(line)
    )
    if (
      owners.code !== 0 ||
      ownerRecords.length !== 1 ||
      !ownerRecords[0] ||
      ownerRecords[0][1] !== applicationId ||
      ownerRecords[0][2] !== String(uid)
    ) {
      throw automationError(
        'ANDROID_LOGCAT_SHARED_UID',
        `${applicationId} cannot be isolated to a single package UID on this target.`,
        'Use an application UID that is not shared with another package; DevHotel will not fall back to global logcat.',
        409,
        safeEvidenceWithoutStdout(owners)
      )
    }
    return { uid, userId }
  }

  /** Trusted install-time proof. It never grants a receipt by itself. */
  async establishInstallEvidence(applicationId: string): Promise<AndroidInstallEvidence> {
    const installUser = await this.currentUserAuthority()
    const installUserId = installUser.userId
    const identity = await this.installedPackageIdentity(applicationId, installUserId)
    let provenLogFence: string | null = null
    let authority: AndroidPackageAuthority | null = null
    if ((this.target.apiLevel ?? 0) >= 31) {
      try {
        authority = await this.packageUid(applicationId, installUserId)
      } catch (error) {
        if (
          !(error instanceof DevHotelError) ||
          (error.code !== 'ANDROID_LOGCAT_UNSUPPORTED' && error.code !== 'ANDROID_LOGCAT_SHARED_UID')
        ) {
          throw error
        }
      }
      if (authority) {
        const candidate = installLogFence(authority)
        const emitted = await this.command(
          [
            'shell', 'run-as', applicationId, '--user', String(authority.userId),
            'log', '-p', 'i', '-t', INSTALL_FENCE_TAG, candidate
          ],
          { operation: 'Android install log fence', timeoutMs: 15_000, stdoutLimit: 16 * 1024 }
        )
        if (emitted.code === 0) {
          let proof: ExecResult | null = null
          try {
            proof = await this.command(
              ['logcat', '-d', '-v', 'raw,printable', `--uid=${authority.uid}`],
              { operation: 'Android install log fence proof', timeoutMs: 30_000, stdoutLimit: 1024 * 1024 }
            )
          } catch (error) {
            if (!(error instanceof DevHotelError) || error.code !== 'ANDROID_OUTPUT_LIMIT') throw error
          }
          if (proof && proof.code === 0 && !commandHitOutputLimit(proof)) {
            const occurrences = proof.stdout.split(/\r?\n/).filter((line) => line === candidate).length
            if (occurrences === 1) provenLogFence = candidate
          }
        }
      }
    }

    // The marker, readback and authority proof are fallible target operations.
    // A concurrent reinstall can otherwise seal the preflight incarnation
    // together with evidence from another package incarnation.
    if (provenLogFence && authority) {
      try {
        const postflightAuthority = await this.packageUid(applicationId, installUserId)
        if (!samePackageAuthority(postflightAuthority, authority)) provenLogFence = null
      } catch (error) {
        if (
          !(error instanceof DevHotelError) ||
          (error.code !== 'ANDROID_LOGCAT_UNSUPPORTED' && error.code !== 'ANDROID_LOGCAT_SHARED_UID')
        ) throw error
        provenLogFence = null
      }
    }
    // Identity must be the final target-side proof after every UID/fence
    // operation, not merely a check before the authority postflight.
    await this.assertInstalledPackageIdentity(applicationId, { ...identity, installUserId })
    await this.assertActiveUser(installUser)
    return {
      apkSha256: identity.apkSha256,
      packageIncarnation: identity.packageIncarnation,
      installUserId,
      installUserSerial: installUser.serial,
      logFence: provenLogFence
    }
  }

  /** Lock-held post-commit seal for the orchestrator's durable receipt write. */
  async confirmInstallEvidence(
    applicationId: string,
    evidence: AndroidInstallEvidence
  ): Promise<void> {
    const installUser = { userId: evidence.installUserId, serial: evidence.installUserSerial }
    await this.assertActiveUser(installUser)
    if (evidence.logFence) {
      const expectedAuthority = installLogFenceAuthority(evidence.logFence)
      if (!expectedAuthority || expectedAuthority.userId !== evidence.installUserId) {
        throw this.logFenceError(applicationId)
      }
      const currentAuthority = await this.packageUid(applicationId, evidence.installUserId)
      if (!samePackageAuthority(currentAuthority, expectedAuthority)) {
        throw automationError(
          'ANDROID_LOGCAT_USER_CHANGED',
          'The tracked Android package authority changed before install evidence was committed.',
          'Retry android_run without concurrent package or Android-user changes.',
          409
        )
      }
    }
    // Keep exact package identity last because the package-authority probes
    // above are independently mutable target state.
    await this.assertInstalledPackageIdentity(applicationId, evidence)
    await this.assertActiveUser(installUser)
  }

  private logFenceError(applicationId: string): DevHotelError {
    return automationError(
      'ANDROID_LOG_FENCE_UNSUPPORTED',
      `Clock-independent log ordering is not available for ${applicationId} on this tracked install.`,
      'Use Android 12 or newer with a debuggable app, then rerun android_run to establish a fresh app-UID log fence.',
      409
    )
  }

  private targetClockError(result: ExecResult): DevHotelError {
    return automationError(
      'ANDROID_TARGET_CLOCK_UNVERIFIED',
      'The selected Android target did not provide a timely, exact millisecond clock sample.',
      'Restore target responsiveness and retry on Android 11 or newer; DevHotel will not mix Host-clock and target-clock log evidence.',
      409,
      safeEvidence(result)
    )
  }

  private async targetCutoffForHostTime(hostCutoffMs: number): Promise<number> {
    const hostBefore = this.now()
    const result = await this.command(
      ['shell', 'date', TARGET_CLOCK_FORMAT],
      { operation: 'Android target clock probe', timeoutMs: 5_000, stdoutLimit: 256 }
    )
    const hostAfter = this.now()
    const target = parseTargetEpochMillis(result.stdout)
    const rttMs = hostAfter - hostBefore
    if (
      result.code !== 0 ||
      result.stderr.trim() ||
      !target ||
      rttMs < 0 ||
      rttMs > MAX_TARGET_CLOCK_RTT_MS
    ) {
      throw this.targetClockError(result)
    }
    // The target sampled its clock at some point after hostBefore. Using the
    // upper offset bound prevents an install/request fence from moving earlier
    // than the equivalent target-clock instant; at worst a bounded RTT sliver
    // is omitted instead of admitting pre-fence evidence.
    const targetCutoffMs = hostCutoffMs + (target.epochMs - hostBefore)
    if (!Number.isSafeInteger(targetCutoffMs)) throw this.targetClockError(result)
    return targetCutoffMs
  }

  private async assertLogAuthority(
    applicationId: string,
    tracked: VerifiedTrackedInstall,
    expected: AndroidPackageAuthority
  ): Promise<void> {
    const current = await this.packageUid(applicationId, tracked.installUserId)
    if (!samePackageAuthority(current, expected)) {
      throw automationError(
        'ANDROID_LOGCAT_USER_CHANGED',
        'The tracked Android package authority changed while evidence was being read.',
        'Restore the Android user active during android_run and retry; DevHotel will not return cross-user evidence.',
        409
      )
    }
    // packageUid is itself a multi-command target probe. Re-seal exact bytes,
    // incarnation and active user after it so a replacement during the UID
    // proof cannot make same-UID rows authoritative.
    await this.assertTrackedInstall(applicationId, tracked)
  }

  private async readLogcat(
    input: AndroidLogcatInput,
    exactLogFence?: string,
    exactAuthority?: AndroidPackageAuthority
  ): Promise<AndroidLogcatResult> {
    const tracked = await this.requireInstalled(input.applicationId)
    const receipt = tracked.receipt
    const requestedSince = input.since ? Date.parse(input.since) : Date.parse(receipt.installedAt)
    const sinceMs = Math.max(Number.isFinite(requestedSince) ? requestedSince : 0, Date.parse(receipt.installedAt))
    const since = new Date(sinceMs).toISOString()
    if ((this.target.apiLevel ?? 0) < 31) throw this.logFenceError(input.applicationId)
    const logFence = exactLogFence ?? this.opts.installs.logFence(
      this.opts.roomId,
      this.opts.installTarget,
      input.applicationId
    )
    if (!logFence) throw this.logFenceError(input.applicationId)
    const sealedAuthority = exactAuthority ?? installLogFenceAuthority(logFence)
    if (!sealedAuthority) throw this.logFenceError(input.applicationId)
    if (sealedAuthority.userId !== tracked.installUserId) throw this.logFenceError(input.applicationId)
    const authority = await this.packageUid(input.applicationId, tracked.installUserId)
    if (!samePackageAuthority(authority, sealedAuthority)) {
      throw automationError(
        'ANDROID_LOGCAT_USER_CHANGED',
        'The active Android user changed before package-scoped log evidence could be read.',
        'Restore the original Android user and rerun the scenario; DevHotel will not cross user boundaries.',
        409
      )
    }
    const targetRequestedSince = !exactLogFence && input.since && sinceMs > Date.parse(receipt.installedAt)
      ? await this.targetCutoffForHostTime(sinceMs)
      : null
    const result = await this.runWithTrackedPostflight(
      input.applicationId,
      tracked,
      () => this.command(
        [
          'logcat', '-d', '-v', 'epoch,UTC,printable', `--uid=${authority.uid}`
        ],
        {
          operation: 'Android package logcat',
          timeoutMs: 30_000,
          stdoutLimit: 1024 * 1024,
          outputLimitRecovery: 'Reduce app logging and rerun android_run to establish a fresh bounded log fence.'
        }
      )
    )
    await this.assertLogAuthority(input.applicationId, tracked, authority)
    if (commandHitOutputLimit(result)) {
      throw automationError(
        'ANDROID_OUTPUT_LIMIT',
        'Android package logcat exceeded its 1048576-byte safety limit.',
        'Reduce app logging and rerun android_run to establish a fresh bounded log fence.'
      )
    }
    if (result.code !== 0) {
      throw automationError(
        'ANDROID_LOGCAT_UNSUPPORTED',
        'The selected Android target rejected package-scoped logcat.',
        'Use current platform-tools and an Android target that supports logcat --uid; global fallback is intentionally disabled.',
        409,
        safeEvidence(result)
      )
    }
    const source = result.stdout.split(/\r?\n/).filter(Boolean)
    const fenceIndexes = source
      .map((line, index) => line.includes(logFence) ? index : -1)
      .filter((index) => index >= 0)
    if (fenceIndexes.length !== 1) throw this.logFenceError(input.applicationId)
    const fenced = source.slice(fenceIndexes[0]! + 1)
    const timeScoped = targetRequestedSince === null
      ? fenced
      : fenced.filter((line) => {
          const at = logEpochMillis(line)
          return at !== null && at >= targetRequestedSince
        })
    const filtered = input.filter
      ? timeScoped.filter((line) => literalIncludes(line, input.filter!))
      : timeScoped
    const lines: string[] = []
    const maxLines = input.maxLines ?? 200
    let bytes = 0
    let truncated = false
    for (const line of filtered) {
      if (lines.length >= maxLines) {
        truncated = true
        break
      }
      const safe = redactSecrets(line).replaceAll('emulator-5554', '[room-emulator]')
      const size = Buffer.byteLength(`${safe}\n`, 'utf8')
      if (bytes + size > MAX_LOGCAT_BYTES) {
        truncated = true
        break
      }
      lines.push(safe)
      bytes += size
    }
    // Logd can retain an app-UID marker across a same-package reinstall. Seal
    // the capture to the same package incarnation on both sides of the read so
    // old authorization can never be used to return rows from a replacement.
    await this.assertLogAuthority(input.applicationId, tracked, authority)
    return {
      target: this.target,
      applicationId: input.applicationId,
      since,
      lines,
      sourceLines: timeScoped.length,
      truncated
    }
  }

  async logcat(input: AndroidLogcatInput): Promise<AndroidLogcatResult> {
    return this.readLogcat(input)
  }

  private async pids(applicationId: string, authority: AndroidPackageAuthority): Promise<number[]> {
    const result = await this.command(
      ['shell', 'pgrep', '-u', String(authority.uid)],
      { operation: 'Android app process probe', timeoutMs: 15_000, stdoutLimit: 16 * 1024 }
    )
    const parsed = parsePids(result.stdout)
    const tokens = result.stdout.trim() ? result.stdout.trim().split(/\s+/) : []
    // Android 12+ toybox pgrep accepts a UID selector without a pattern. Exit
    // 1 with empty streams is its authoritative no-match result. Exact EUID
    // selection keeps both the main and remote app processes inside the
    // already-proven package/user authority without exposing other users.
    if (result.code === 1 && result.stdout.length === 0 && result.stderr.length === 0) return []
    if (
      result.code !== 0 ||
      result.stderr.length > 0 ||
      parsed.length === 0 ||
      parsed.length !== tokens.length ||
      parsed.length > MAX_PACKAGE_PROCESSES
    ) {
      throw automationError(
        'ANDROID_PROCESS_PROBE_FAILED',
        `${applicationId} process state could not be established on this target.`,
        'Restore target connectivity and exact-user process visibility, then retry; DevHotel will not infer a crash from a failed PID probe.',
        409,
        safeEvidenceWithoutOutput(result)
      )
    }
    return parsed
  }

  async crashScenario(input: AndroidRunCrashScenarioInput): Promise<AndroidCrashScenarioResult> {
    const tracked = await this.requireInstalled(input.applicationId)
    const installFence = this.opts.installs.logFence(this.opts.roomId, this.opts.installTarget, input.applicationId)
    const installAuthority = installFence ? installLogFenceAuthority(installFence) : null
    if (
      (this.target.apiLevel ?? 0) < 31 ||
      !installAuthority ||
      installAuthority.userId !== tracked.installUserId
    ) {
      throw this.logFenceError(input.applicationId)
    }
    const crashAuthority = await this.packageUid(input.applicationId, tracked.installUserId)
    if (!samePackageAuthority(crashAuthority, installAuthority)) {
      throw automationError(
        'ANDROID_LOGCAT_USER_CHANGED',
        'The active Android user no longer matches the tracked install log authority.',
        'Restore the Android user used by android_run or rerun android_run for the active user.',
        409
      )
    }
    const pidsBefore = await this.runWithTrackedPostflight(
      input.applicationId,
      tracked,
      () => this.pids(input.applicationId, crashAuthority)
    )
    if (pidsBefore.length === 0) {
      throw automationError(
        'ANDROID_APP_NOT_RUNNING',
        `${input.applicationId} has no running process for the tracked Android user.`,
        'Launch the tracked application for the active Android user before running the crash scenario.'
      )
    }
    await this.assertTrackedInstall(input.applicationId, tracked)
    const crashStartedAt = this.now()
    const crashLogFence = `devhotel-crash-${randomUUID()}`
    const crashResult = await this.runWithTrackedPostflight(
      input.applicationId,
      tracked,
      () => this.command(
        [
          'shell', 'sh', '-c',
          `run-as "$1" --user "$2" log -p i -t ${CRASH_FENCE_TAG} "$3" && exec am crash --user "$2" "$1"`,
          'devhotel-crash', input.applicationId, String(crashAuthority.userId), crashLogFence
        ],
        { operation: 'Android crash scenario', timeoutMs: 30_000, stdoutLimit: 64 * 1024 }
      )
    )
    const result = crashResult
    let pidsAfter = pidsBefore
    let observed = false
    for (let attempt = 0; attempt < 20; attempt++) {
      pidsAfter = await this.runWithTrackedPostflight(
        input.applicationId,
        tracked,
        () => this.pids(input.applicationId, crashAuthority)
      )
      if (pidsBefore.every((pid) => !pidsAfter.includes(pid))) {
        observed = true
        break
      }
      await this.pause(250)
    }
    const logcat = await this.readLogcat({
      applicationId: input.applicationId,
      since: new Date(crashStartedAt).toISOString(),
      maxLines: 200
    }, crashLogFence, crashAuthority)
    return {
      target: this.target,
      applicationId: input.applicationId,
      scenario: input.scenario,
      runId: input.runId,
      observed: result.code === 0 && observed,
      pidsBefore,
      pidsAfter,
      evidence: safeEvidence(result),
      logcat
    }
  }
}

interface ParsedUi {
  nodes: AndroidUiNode[]
  scannedNodes: number
  truncated: boolean
}

interface ParseUiOptions {
  filter?: string
  maxNodes?: number
  textMatch?: 'exact' | 'contains'
}

function decodeXml(value: string): string {
  const entityPattern = /&(?:quot|apos|lt|gt|amp|#\d+|#x[0-9A-Fa-f]+);/g
  // Validate the encoded source. Re-validating after a one-pass decode would
  // mistake literal text such as `&amp;name;` for a source entity.
  if (value.replace(entityPattern, '').includes('&')) {
    throw automationError('ANDROID_UI_DUMP_INVALID', 'The UI hierarchy contains an unsupported XML entity.', 'Retry after the app UI changes.')
  }
  const decoded = value.replace(entityPattern, (entity) => {
    switch (entity) {
      case '&quot;': return '"'
      case '&apos;': return "'"
      case '&lt;': return '<'
      case '&gt;': return '>'
      case '&amp;': return '&'
      default: {
        const hex = entity.startsWith('&#x')
        const raw = entity.slice(hex ? 3 : 2, -1)
        const codePoint = Number.parseInt(raw, hex ? 16 : 10)
        if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
          throw automationError('ANDROID_UI_DUMP_INVALID', 'The UI hierarchy contains an invalid XML entity.', 'Retry after the app UI changes.')
        }
        return String.fromCodePoint(codePoint)
      }
    }
  })
  // ZWJ and ZWNJ are legitimate join controls in emoji and complex scripts.
  // Keep rejecting other invisible/control code points, including bidi marks.
  if (/[\p{C}\p{Zl}\p{Zp}]/u.test(decoded.replace(/[\u200c\u200d]/g, ''))) {
    throw automationError('ANDROID_UI_DUMP_INVALID', 'The UI hierarchy contains a control character.', 'Retry after the app UI changes.')
  }
  return decoded
}

function parseAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>()
  let index = 4
  while (index < tag.length) {
    while (/\s/.test(tag[index] ?? '')) index++
    if (tag[index] === '/' || index >= tag.length) break
    const nameStart = index
    while (/[A-Za-z0-9_.:-]/.test(tag[index] ?? '')) index++
    const name = tag.slice(nameStart, index)
    if (!name || !/^[A-Za-z_:][A-Za-z0-9_.:-]*$/.test(name)) {
      throw automationError('ANDROID_UI_DUMP_INVALID', 'The UI hierarchy contains a malformed attribute.', 'Retry the UI dump.')
    }
    while (/\s/.test(tag[index] ?? '')) index++
    if (tag[index++] !== '=') {
      throw automationError('ANDROID_UI_DUMP_INVALID', 'The UI hierarchy contains a malformed attribute assignment.', 'Retry the UI dump.')
    }
    while (/\s/.test(tag[index] ?? '')) index++
    const quote = tag[index++]
    if (quote !== '"' && quote !== "'") {
      throw automationError('ANDROID_UI_DUMP_INVALID', 'The UI hierarchy contains an unquoted attribute.', 'Retry the UI dump.')
    }
    const valueStart = index
    while (index < tag.length && tag[index] !== quote) {
      if (tag[index] === '<') {
        throw automationError('ANDROID_UI_DUMP_INVALID', 'The UI hierarchy contains an invalid attribute value.', 'Retry the UI dump.')
      }
      index++
    }
    if (index >= tag.length) {
      throw automationError('ANDROID_UI_DUMP_INVALID', 'The UI hierarchy contains an unterminated attribute.', 'Retry the UI dump.')
    }
    const raw = tag.slice(valueStart, index++)
    if (Buffer.byteLength(raw, 'utf8') > MAX_UI_ATTRIBUTE_BYTES) {
      throw automationError('ANDROID_UI_DUMP_LIMIT', 'A UI attribute exceeded its safety limit.', 'Reduce unusually large accessibility text.')
    }
    attributes.set(name, decodeXml(raw))
  }
  return attributes
}

function parseBounds(value: string | undefined): AndroidUiNode['bounds'] | null {
  const match = /^\[(\d{1,6}),(\d{1,6})\]\[(\d{1,6}),(\d{1,6})\]$/.exec(value ?? '')
  if (!match) return null
  const [left, top, right, bottom] = match.slice(1).map((part) => Number.parseInt(part, 10)) as [number, number, number, number]
  if (right <= left || bottom <= top || right > 100_000 || bottom > 100_000) return null
  return { left, top, right, bottom }
}

/** Purpose-built, bounded parser for UIAutomator's flat `<node ...>` tags. */
export function parseAndroidUiHierarchy(
  xml: string,
  applicationId: string,
  opts: ParseUiOptions = {}
): ParsedUi {
  if (Buffer.byteLength(xml, 'utf8') > MAX_UI_XML_BYTES) {
    throw automationError('ANDROID_UI_DUMP_LIMIT', 'The UI hierarchy exceeded its byte limit.', 'Narrow the UI state and retry.')
  }
  const declaration = /^\s*<\?xml\s+[^?]{1,240}\?>/i.exec(xml)
  const source = declaration ? xml.slice(declaration[0].length) : xml
  if (/<!DOCTYPE|<!ENTITY|<\?/i.test(source)) {
    throw automationError('ANDROID_UI_DUMP_INVALID', 'Unsafe XML declarations are not accepted in UI evidence.', 'Retry with a normal UIAutomator hierarchy.')
  }
  const nodes: AndroidUiNode[] = []
  let sourceNodes = 0
  let scannedNodes = 0
  let matchedNodes = 0
  let index = 0
  const maxNodes = opts.maxNodes ?? 200
  while (index < source.length) {
    const open = source.indexOf('<', index)
    if (open < 0) break
    if (source.startsWith('<!--', open)) {
      const close = source.indexOf('-->', open + 4)
      if (close < 0) throw automationError('ANDROID_UI_DUMP_INVALID', 'The UI hierarchy contains an unterminated comment.', 'Retry the UI dump.')
      index = close + 3
      continue
    }
    if (!source.startsWith('<node', open) || /[A-Za-z0-9_.:-]/.test(source[open + 5] ?? '')) {
      const close = source.indexOf('>', open + 1)
      if (close < 0) throw automationError('ANDROID_UI_DUMP_INVALID', 'The UI hierarchy contains an unterminated tag.', 'Retry the UI dump.')
      index = close + 1
      continue
    }
    let cursor = open + 5
    let quote: string | null = null
    for (; cursor < source.length; cursor++) {
      const char = source[cursor]!
      if (quote) {
        if (char === quote) quote = null
      } else if (char === '"' || char === "'") quote = char
      else if (char === '>') break
    }
    if (cursor >= source.length || quote) {
      throw automationError('ANDROID_UI_DUMP_INVALID', 'The UI hierarchy contains an unterminated node tag.', 'Retry the UI dump.')
    }
    const tag = source.slice(open + 1, cursor)
    if (Buffer.byteLength(tag, 'utf8') > MAX_UI_TAG_BYTES) {
      throw automationError('ANDROID_UI_DUMP_LIMIT', 'A UI node tag exceeded its safety limit.', 'Reduce unusually large accessibility content.')
    }
    index = cursor + 1
    sourceNodes += 1
    if (sourceNodes > MAX_UI_SOURCE_NODES) {
      throw automationError('ANDROID_UI_DUMP_LIMIT', `The UI hierarchy exceeded ${MAX_UI_SOURCE_NODES} nodes.`, 'Reduce the screen hierarchy and retry.')
    }
    const attributes = parseAttributes(tag)
    if (attributes.get('package') !== applicationId) continue
    scannedNodes += 1
    const bounds = parseBounds(attributes.get('bounds'))
    if (!bounds) continue
    const node: AndroidUiNode = {
      text: attributes.get('text') ?? '',
      contentDescription: attributes.get('content-desc') ?? '',
      resourceId: attributes.get('resource-id') ?? '',
      className: attributes.get('class') ?? '',
      clickable: attributes.get('clickable') === 'true',
      enabled: attributes.get('enabled') !== 'false',
      bounds,
      center: {
        x: Math.floor((bounds.left + bounds.right) / 2),
        y: Math.floor((bounds.top + bounds.bottom) / 2)
      }
    }
    if (opts.filter) {
      if (opts.textMatch) {
        if (!matchesText(node, opts.filter, opts.textMatch)) continue
      } else {
        const searchable = [node.text, node.contentDescription, node.resourceId, node.className].join('\n')
        if (!literalIncludes(searchable, opts.filter)) continue
      }
    }
    matchedNodes += 1
    if (nodes.length < maxNodes) nodes.push(node)
  }
  return { nodes, scannedNodes, truncated: matchedNodes > nodes.length }
}
