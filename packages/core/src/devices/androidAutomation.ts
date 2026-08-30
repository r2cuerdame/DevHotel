import { randomUUID } from 'node:crypto'
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
import type { ExecResult } from '../backend/types'
import { redactSecrets } from '../diagnostics/redact'
import { DevHotelError } from '../errors'
import type { AndroidAppInstallsRepo, AndroidInstallTarget } from '../store/androidAppInstallsRepo'

const MAX_UI_XML_BYTES = 1024 * 1024
const MAX_UI_SOURCE_NODES = 10_000
const MAX_UI_TAG_BYTES = 32 * 1024
const MAX_UI_ATTRIBUTE_BYTES = 4 * 1024
const MAX_EVIDENCE_BYTES = 4 * 1024
const MAX_LOGCAT_BYTES = 64 * 1024
const DEFAULT_WAIT_TIMEOUT_MS = 10_000
const DEFAULT_POLL_INTERVAL_MS = 500

export interface AndroidAutomationExecOptions {
  timeoutMs?: number
  maxStdoutBytes?: number
  maxStderrBytes?: number
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

function parsePids(value: string): number[] {
  const trimmed = value.trim()
  if (!trimmed) return []
  if (!/^\d+(?:\s+\d+)*$/.test(trimmed)) return []
  return [...new Set(trimmed.split(/\s+/).map((part) => Number.parseInt(part, 10)).filter(Number.isSafeInteger))]
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
  private readonly verifiedApkHashes = new Map<string, string>()

  constructor(private readonly opts: AndroidAutomationSessionOptions) {
    this.target = opts.target
    this.now = opts.now ?? (() => Date.now())
    this.pause = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  private async command(
    args: string[],
    opts: AndroidAutomationExecOptions & {
      deadline?: AndroidAutomationDeadline
      stdoutLimit?: number
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
        maxStdoutBytes: opts.maxStdoutBytes ?? opts.stdoutLimit,
        maxStderrBytes: opts.maxStderrBytes ?? 64 * 1024
      })
    } catch (error) {
      if (opts.deadline && this.now() >= opts.deadline.at) {
        throw waitTimeoutError(opts.deadline.applicationId)
      }
      throw error
    }
    if (opts.deadline && this.now() >= opts.deadline.at) {
      throw waitTimeoutError(opts.deadline.applicationId)
    }
    if (opts.stdoutLimit !== undefined && Buffer.byteLength(result.stdout, 'utf8') > opts.stdoutLimit) {
      throw automationError(
        'ANDROID_OUTPUT_LIMIT',
        `${opts.operation} exceeded its ${opts.stdoutLimit}-byte safety limit.`,
        'Narrow the filter or reduce the requested result size.'
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

  private async requireInstalled(
    applicationId: string,
    deadline?: AndroidAutomationDeadline
  ): Promise<AndroidInstallReceipt> {
    const receipt = this.receipt(applicationId)
    if (this.verifiedApkHashes.get(applicationId) === receipt.apkSha256) return receipt
    const result = await this.command(
      ['shell', 'pm', 'path', '--user', 'current', applicationId],
      { operation: 'Android package probe', timeoutMs: 15_000, stdoutLimit: 16 * 1024, deadline }
    )
    const paths = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('package:'))
      .map((line) => line.slice('package:'.length))
    if (result.code !== 0 || paths.length === 0) {
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
    if (baseApks.length !== 1) {
      throw automationError(
        'ANDROID_APP_IDENTITY_UNVERIFIED',
        `${applicationId} did not expose one safe installed base APK path.`,
        'Run android_run again on a supported Android target; DevHotel will not trust package name alone.',
        409,
        safeEvidence(result)
      )
    }
    const hashed = await this.command(
      ['shell', 'sha256sum', baseApks[0]!],
      { operation: 'Android installed APK identity probe', timeoutMs: 60_000, stdoutLimit: 8192, deadline }
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
    if (installedSha256 !== receipt.apkSha256) {
      this.opts.installs.remove(this.opts.roomId, this.opts.installTarget, applicationId)
      this.verifiedApkHashes.delete(applicationId)
      throw automationError(
        'ANDROID_APP_REPLACED',
        `${applicationId} no longer matches the APK installed by this Room.`,
        'Run android_run again to install and authorize the current APK bytes.',
        409,
        safeEvidence(hashed)
      )
    }
    this.verifiedApkHashes.set(applicationId, receipt.apkSha256)
    return receipt
  }

  private async foregroundPackage(deadline?: AndroidAutomationDeadline): Promise<string | null> {
    const result = await this.command(
      ['shell', 'sh', '-c', "dumpsys window windows 2>/dev/null | grep -m 1 -E 'mCurrentFocus|mFocusedApp' | head -c 2048"],
      { operation: 'Android foreground probe', timeoutMs: 15_000, stdoutLimit: 2048, deadline }
    )
    if (result.code !== 0) return null
    const match = /\bu\d+\s+([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)\/[A-Za-z0-9_.$]+/.exec(result.stdout)
    return match?.[1] ?? null
  }

  private async requireForeground(
    applicationId: string,
    deadline?: AndroidAutomationDeadline
  ): Promise<void> {
    const foreground = await this.foregroundPackage(deadline)
    if (foreground === applicationId) return
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
    const installedApplicationIds: string[] = []
    for (const candidate of this.opts.installs.list(this.opts.roomId, this.opts.installTarget)) {
      try {
        await this.requireInstalled(candidate.applicationId)
        installedApplicationIds.push(candidate.applicationId)
      } catch (error) {
        if (
          !(error instanceof DevHotelError) ||
          (error.code !== 'ANDROID_APP_NOT_INSTALLED' && error.code !== 'ANDROID_APP_REPLACED')
        ) throw error
      }
    }
    const foreground = await this.foregroundPackage()
    const localeResult = await this.command(
      ['shell', 'getprop', 'persist.sys.locale'],
      { operation: 'Android locale probe', timeoutMs: 10_000, stdoutLimit: 256 }
    )
    const locale = localeResult.code === 0 && /^[A-Za-z0-9_-]{2,35}$/.test(localeResult.stdout.trim())
      ? localeResult.stdout.trim()
      : null
    return {
      target: this.target,
      installedApplicationIds,
      foregroundApplicationId: foreground && installedApplicationIds.includes(foreground) ? foreground : null,
      locale
    }
  }

  /** Safe metadata composition for lock-held artifact/acceptance workflows. */
  async foregroundInstallContext(): Promise<AndroidForegroundInstallContext> {
    const status = await this.status()
    const receipt = status.foregroundApplicationId
      ? this.opts.installs.get(
          this.opts.roomId,
          this.opts.installTarget,
          status.foregroundApplicationId
        )
      : null
    return { status, receipt }
  }

  async launch(
    applicationId: string,
    activity?: string,
    extras?: AndroidExtras
  ): Promise<AndroidLaunchResult> {
    await this.requireInstalled(applicationId)
    let component: string
    if (activity) {
      component = componentForActivity(applicationId, activity)
    } else {
      const resolved = await this.command(
        [
          'shell', 'cmd', 'package', 'resolve-activity', '--brief', '--components',
          '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', applicationId
        ],
        { operation: 'Android launcher resolution', timeoutMs: 20_000, stdoutLimit: 16 * 1024 }
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
    const result = await this.command(
      ['shell', 'am', 'start', '-W', '--user', 'current', '-n', component, ...extrasArgv(extras)],
      { operation: 'Android app launch', timeoutMs: 60_000, stdoutLimit: 64 * 1024 }
    )
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
    await this.requireInstalled(applicationId)
    const result = await this.command(
      ['shell', 'am', 'force-stop', '--user', 'current', applicationId],
      { operation: 'Android force-stop', timeoutMs: 30_000, stdoutLimit: 16 * 1024 }
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
    return { target: this.target, applicationId, evidence: safeEvidence(result) }
  }

  private async dump(
    applicationId: string,
    filter?: string,
    maxNodes = 500,
    deadline?: AndroidAutomationDeadline
  ): Promise<AndroidUiDumpResult> {
    await this.requireInstalled(applicationId, deadline)
    await this.requireForeground(applicationId, deadline)
    const path = `/data/local/tmp/devhotel-ui-${randomUUID()}.xml`
    try {
      const dumped = await this.command(
        ['shell', 'uiautomator', 'dump', '--compressed', path],
        { operation: 'Android UI dump', timeoutMs: 30_000, stdoutLimit: 16 * 1024, deadline }
      )
      if (dumped.code !== 0) {
        throw automationError(
          'ANDROID_UI_DUMP_FAILED',
          'Android UIAutomator could not produce a hierarchy dump.',
          'Ensure the app is unlocked and foreground, then retry.',
          409,
          safeEvidence(dumped)
        )
      }
      const read = await this.command(
        ['exec-out', 'sh', '-c', `head -c ${MAX_UI_XML_BYTES + 1} ${path}`],
        { operation: 'Android UI hierarchy read', timeoutMs: 30_000, stdoutLimit: MAX_UI_XML_BYTES + 1, deadline }
      )
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
      const parsed = parseAndroidUiHierarchy(read.stdout, applicationId, { filter, maxNodes })
      if (deadline && this.now() >= deadline.at) throw waitTimeoutError(applicationId)
      return { target: this.target, applicationId, ...parsed }
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
  }

  dumpUi(input: AndroidDumpUiInput): Promise<AndroidUiDumpResult> {
    return this.dump(input.applicationId, input.filter, input.maxNodes ?? 200)
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
      const dumped = await this.dump(input.applicationId, input.text, 500, deadline)
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
    const dumped = await this.dump(input.applicationId, input.text, 500)
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
    // Re-read immediately before input: foreground can remain the same while
    // an animation/list update moves the requested node under stale coordinates.
    const confirmedDump = await this.dump(input.applicationId, input.text, 500)
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
    const tapped = confirmedMatches[0]!
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
    // A system dialog may still have appeared after the confirming hierarchy.
    await this.requireForeground(input.applicationId)
    const result = await this.command(
      ['shell', 'input', 'tap', String(tapped.center.x), String(tapped.center.y)],
      { operation: 'Android text tap', timeoutMs: 15_000, stdoutLimit: 16 * 1024 }
    )
    if (result.code !== 0) {
      throw automationError(
        'ANDROID_TAP_FAILED',
        'Android input rejected the app-scoped tap.',
        'Confirm the selected target is still connected and the app remains foreground.',
        409,
        safeEvidence(result)
      )
    }
    return { target: this.target, applicationId: input.applicationId, tapped, evidence: safeEvidence(result) }
  }

  private async packageUid(applicationId: string): Promise<number> {
    const uidResult = await this.command(
      ['shell', 'pm', 'list', 'packages', '-U', '--user', 'current', applicationId],
      { operation: 'Android package UID probe', timeoutMs: 15_000, stdoutLimit: 16 * 1024 }
    )
    const escaped = applicationId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = new RegExp(`^package:${escaped}\\s+uid[:=](\\d+)$`, 'm').exec(uidResult.stdout)
    if (uidResult.code !== 0 || !match) {
      throw automationError(
        'ANDROID_LOGCAT_UNSUPPORTED',
        'The selected Android target did not expose an exact package UID.',
        'Use a target with package-manager UID filtering support.',
        409,
        safeEvidence(uidResult)
      )
    }
    const uid = Number.parseInt(match[1]!, 10)
    const owners = await this.command(
      ['shell', 'pm', 'list', 'packages', '-U', '--user', 'current', '--uid', String(uid)],
      { operation: 'Android shared UID probe', timeoutMs: 15_000, stdoutLimit: 64 * 1024 }
    )
    const packages = owners.stdout
      .split(/\r?\n/)
      .map((line) => /^package:([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)\s+uid[:=]\d+$/.exec(line.trim())?.[1])
      .filter((value): value is string => Boolean(value))
    if (owners.code !== 0 || packages.length !== 1 || packages[0] !== applicationId) {
      throw automationError(
        'ANDROID_LOGCAT_SHARED_UID',
        `${applicationId} cannot be isolated to a single package UID on this target.`,
        'Use an application UID that is not shared with another package; DevHotel will not fall back to global logcat.',
        409,
        safeEvidence(owners)
      )
    }
    return uid
  }

  async logcat(input: AndroidLogcatInput): Promise<AndroidLogcatResult> {
    const receipt = await this.requireInstalled(input.applicationId)
    const uid = await this.packageUid(input.applicationId)
    const requestedSince = input.since ? Date.parse(input.since) : Date.parse(receipt.installedAt)
    const sinceMs = Math.max(Number.isFinite(requestedSince) ? requestedSince : 0, Date.parse(receipt.installedAt))
    const since = new Date(sinceMs).toISOString()
    const result = await this.command(
      [
        'logcat', '-d', '-v', 'epoch,UTC,printable', `--uid=${uid}`,
        '-t', `${Math.floor(sinceMs / 1000)}.000`, '-m', String(input.maxLines ?? 200)
      ],
      { operation: 'Android package logcat', timeoutMs: 30_000, stdoutLimit: 1024 * 1024 }
    )
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
    const filtered = input.filter
      ? source.filter((line) => literalIncludes(line, input.filter!))
      : source
    const lines: string[] = []
    let bytes = 0
    let truncated = false
    for (const line of filtered) {
      const safe = redactSecrets(line).replaceAll('emulator-5554', '[room-emulator]')
      const size = Buffer.byteLength(`${safe}\n`, 'utf8')
      if (bytes + size > MAX_LOGCAT_BYTES) {
        truncated = true
        break
      }
      lines.push(safe)
      bytes += size
    }
    return {
      target: this.target,
      applicationId: input.applicationId,
      since,
      lines,
      sourceLines: source.length,
      truncated
    }
  }

  private async pids(applicationId: string): Promise<number[]> {
    const result = await this.command(
      ['shell', 'pidof', applicationId],
      { operation: 'Android app process probe', timeoutMs: 15_000, stdoutLimit: 16 * 1024 }
    )
    return result.code === 0 ? parsePids(result.stdout) : []
  }

  async crashScenario(input: AndroidRunCrashScenarioInput): Promise<AndroidCrashScenarioResult> {
    await this.requireInstalled(input.applicationId)
    const pidsBefore = await this.pids(input.applicationId)
    if (pidsBefore.length === 0) {
      throw automationError(
        'ANDROID_APP_NOT_RUNNING',
        `${input.applicationId} has no running process to crash.`,
        'Launch the tracked application before running the crash scenario.'
      )
    }
    const crashStartedAt = this.now()
    const result = await this.command(
      ['shell', 'am', 'crash', '--user', 'current', input.applicationId],
      { operation: 'Android crash scenario', timeoutMs: 30_000, stdoutLimit: 64 * 1024 }
    )
    let pidsAfter = pidsBefore
    let observed = false
    for (let attempt = 0; attempt < 20; attempt++) {
      pidsAfter = await this.pids(input.applicationId)
      if (pidsBefore.every((pid) => !pidsAfter.includes(pid))) {
        observed = true
        break
      }
      await this.pause(250)
    }
    const logcat = await this.logcat({
      applicationId: input.applicationId,
      since: new Date(crashStartedAt).toISOString(),
      maxLines: 200
    })
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
      const searchable = [node.text, node.contentDescription, node.resourceId, node.className].join('\n')
      if (!literalIncludes(searchable, opts.filter)) continue
    }
    matchedNodes += 1
    if (nodes.length < maxNodes) nodes.push(node)
  }
  return { nodes, scannedNodes, truncated: matchedNodes > nodes.length }
}
