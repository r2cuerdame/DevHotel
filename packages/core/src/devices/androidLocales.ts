import {
  ANDROID_APP_LOCALE_MIN_API,
  canonicalAndroidLocaleTags,
  type AndroidLocaleReadiness
} from '@devhotel/shared'

const MAX_APP_LOCALE_RESPONSE_BYTES = 4 * 1024
const MAX_ANDROID_API_LEVEL = 100
const MAX_ANDROID_USER_ID = 21_474
const REQUIRED_READY_CHECKS = 2
const APPLICATION_ID = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/

export type AndroidAppLocaleCapability =
  | { supported: true; apiLevel: number; minimumApiLevel: typeof ANDROID_APP_LOCALE_MIN_API }
  | {
      supported: false
      code: 'ANDROID_LOCALE_API_UNKNOWN' | 'ANDROID_LOCALE_UNSUPPORTED'
      apiLevel: number | null
      minimumApiLevel: typeof ANDROID_APP_LOCALE_MIN_API
    }

export interface AndroidLocaleCommandResult {
  code: number
  stdout: string
  stderr: string
  outputLimitExceeded?: boolean
}

export interface AndroidLocaleReadinessExpectation {
  applicationId: string
  userId: number
  localeTags: readonly string[]
}

export interface AndroidLocaleReadinessObservation {
  adbState: string | null
  localeTags: readonly string[] | null
  foreground: { applicationId: string; userId: number } | null
  pids: readonly number[]
  elapsedMs: number
}

export interface AndroidLocaleReadinessDiagnostic {
  attempts: number
  adbReady: boolean
  localeVerified: boolean
  appForeground: boolean
  processRunning: boolean
  processStable: boolean
}

function assertApplicationId(applicationId: string): void {
  if (!APPLICATION_ID.test(applicationId)) throw new TypeError('invalid Android application ID')
}

function assertUserId(userId: number): void {
  if (!Number.isSafeInteger(userId) || userId < 0 || userId > MAX_ANDROID_USER_ID) {
    throw new RangeError('invalid Android user ID')
  }
}

function regexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function normalizePids(pids: readonly number[]): number[] | null {
  if (
    pids.length === 0 ||
    pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0) ||
    new Set(pids).size !== pids.length
  ) return null
  return [...pids].sort((left, right) => left - right)
}

export function androidAppLocaleCapability(apiLevel: number | null | undefined): AndroidAppLocaleCapability {
  if (!Number.isSafeInteger(apiLevel) || (apiLevel ?? 0) < 1 || (apiLevel ?? 0) > MAX_ANDROID_API_LEVEL) {
    return {
      supported: false,
      code: 'ANDROID_LOCALE_API_UNKNOWN',
      apiLevel: null,
      minimumApiLevel: ANDROID_APP_LOCALE_MIN_API
    }
  }
  if (apiLevel! < ANDROID_APP_LOCALE_MIN_API) {
    return {
      supported: false,
      code: 'ANDROID_LOCALE_UNSUPPORTED',
      apiLevel: apiLevel!,
      minimumApiLevel: ANDROID_APP_LOCALE_MIN_API
    }
  }
  return { supported: true, apiLevel: apiLevel!, minimumApiLevel: ANDROID_APP_LOCALE_MIN_API }
}

export function parseAndroidApiLevel(stdout: string): number | null {
  if (!/^[1-9]\d{0,2}(?:\r?\n)?$/.test(stdout)) return null
  const apiLevel = Number.parseInt(stdout, 10)
  return androidAppLocaleCapability(apiLevel).apiLevel
}

export function isExactAndroidDeviceState(stdout: string): boolean {
  return /^device(?:\r?\n)?$/.test(stdout)
}

export function buildAndroidGetAppLocalesArgs(applicationId: string, userId: number): string[] {
  assertApplicationId(applicationId)
  assertUserId(userId)
  return ['shell', 'cmd', 'locale', 'get-app-locales', applicationId, '--user', String(userId)]
}

export function buildAndroidSetAppLocalesArgs(
  applicationId: string,
  userId: number,
  localeTags: readonly string[]
): string[] {
  assertApplicationId(applicationId)
  assertUserId(userId)
  const canonical = canonicalAndroidLocaleTags(localeTags, { allowEmpty: true })
  if (!canonical) throw new TypeError('invalid Android app locale list')
  const args = ['shell', 'cmd', 'locale', 'set-app-locales', applicationId, '--user', String(userId)]
  if (canonical.length > 0) args.push('--locales', canonical.join(','))
  return args
}

/** Parse only LocaleManagerShellCommand's package- and user-bound output. */
export function parseAndroidAppLocales(
  applicationId: string,
  userId: number,
  stdout: string
): string[] | null {
  assertApplicationId(applicationId)
  assertUserId(userId)
  if (Buffer.byteLength(stdout, 'utf8') > MAX_APP_LOCALE_RESPONSE_BYTES) return null
  const line = stdout.replace(/\r?\n$/, '')
  if (line.includes('\n') || line.includes('\r')) return null
  const match = new RegExp(
    `^Locales for ${regexLiteral(applicationId)} for user ${userId} are \\[([^\\]\\r\\n]*)\\]$`
  ).exec(line)
  if (!match) return null
  const value = match[1] ?? ''
  return canonicalAndroidLocaleTags(value ? value.split(',') : [], { allowEmpty: true })
}

/**
 * LocaleManager's shell command prints service/package failures to stdout and
 * can still return zero. A mutation is admissible only with completely empty,
 * bounded streams; exact readback remains mandatory afterwards.
 */
export function isExactAndroidLocaleMutationSuccess(result: AndroidLocaleCommandResult): boolean {
  return result.code === 0 &&
    result.stdout === '' &&
    result.stderr === '' &&
    result.outputLimitExceeded !== true
}

/** Pure readiness tracker; the caller owns the bounded deadline and probes. */
export class AndroidLocaleReadinessTracker {
  private attempts = 0
  private consecutiveReadyChecks = 0
  private stablePids: number[] = []
  private last: AndroidLocaleReadinessDiagnostic = {
    attempts: 0,
    adbReady: false,
    localeVerified: false,
    appForeground: false,
    processRunning: false,
    processStable: false
  }
  private readonly expectedLocales: string[]

  constructor(private readonly expected: AndroidLocaleReadinessExpectation) {
    assertApplicationId(expected.applicationId)
    assertUserId(expected.userId)
    const canonical = canonicalAndroidLocaleTags(expected.localeTags, { allowEmpty: true })
    if (!canonical || !sameStrings(canonical, expected.localeTags)) {
      throw new TypeError('expected Android locale list must already be canonical and unique')
    }
    this.expectedLocales = canonical
  }

  observe(observation: AndroidLocaleReadinessObservation): AndroidLocaleReadiness | null {
    if (!Number.isFinite(observation.elapsedMs) || observation.elapsedMs < 0) {
      throw new RangeError('Android locale readiness elapsed time must be non-negative')
    }
    this.attempts += 1
    const pids = normalizePids(observation.pids)
    const adbReady = observation.adbState === 'device'
    const localeVerified = observation.localeTags !== null &&
      sameStrings(observation.localeTags, this.expectedLocales)
    const appForeground = observation.foreground?.applicationId === this.expected.applicationId &&
      observation.foreground.userId === this.expected.userId
    const processRunning = pids !== null
    const ready = adbReady && localeVerified && appForeground && processRunning

    if (ready) {
      if (this.consecutiveReadyChecks === 0 || !sameNumbers(pids, this.stablePids)) {
        this.consecutiveReadyChecks = 1
        this.stablePids = pids
      } else {
        this.consecutiveReadyChecks += 1
      }
    } else {
      this.consecutiveReadyChecks = 0
      this.stablePids = []
    }

    this.last = {
      attempts: this.attempts,
      adbReady,
      localeVerified,
      appForeground,
      processRunning,
      processStable: ready && this.consecutiveReadyChecks >= REQUIRED_READY_CHECKS
    }

    if (this.consecutiveReadyChecks < REQUIRED_READY_CHECKS) return null
    return {
      adb: 'device',
      localeService: 'ready',
      application: 'foreground',
      process: 'running',
      attempts: this.attempts,
      consecutiveReadyChecks: 2,
      elapsedMs: observation.elapsedMs,
      pids: [...this.stablePids]
    }
  }

  diagnostic(): AndroidLocaleReadinessDiagnostic {
    return { ...this.last }
  }
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
