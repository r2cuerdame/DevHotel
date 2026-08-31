import { describe, expect, it } from 'vitest'
import {
  AndroidLocaleReadinessTracker,
  androidAppLocaleCapability,
  buildAndroidGetAppLocalesArgs,
  buildAndroidSetAppLocalesArgs,
  isExactAndroidDeviceState,
  isExactAndroidLocaleMutationSuccess,
  parseAndroidApiLevel,
  parseAndroidAppLocales
} from '../devices/androidLocales'

const APP_ID = 'com.example.locale'

describe('Android app locale command boundary', () => {
  it('builds typed package- and numeric-user-scoped LocaleManager argv', () => {
    expect(buildAndroidGetAppLocalesArgs(APP_ID, 10)).toEqual([
      'shell', 'cmd', 'locale', 'get-app-locales', APP_ID, '--user', '10'
    ])
    expect(buildAndroidSetAppLocalesArgs(APP_ID, 10, ['ko-kr', 'en-US'])).toEqual([
      'shell', 'cmd', 'locale', 'set-app-locales', APP_ID, '--user', '10', '--locales', 'ko-KR,en-US'
    ])
    expect(buildAndroidSetAppLocalesArgs(APP_ID, 10, [])).toEqual([
      'shell', 'cmd', 'locale', 'set-app-locales', APP_ID, '--user', '10'
    ])
  })

  it('rejects command injection and invalid user/list authority before argv construction', () => {
    expect(() => buildAndroidGetAppLocalesArgs(`${APP_ID};id`, 10)).toThrow(/application ID/)
    expect(() => buildAndroidGetAppLocalesArgs(APP_ID, -2)).toThrow(/user ID/)
    expect(() => buildAndroidSetAppLocalesArgs(APP_ID, 10, ['en-US', 'en-us'])).toThrow(/locale list/)
  })

  it('parses only the exact package and exact user LocaleManager response', () => {
    expect(parseAndroidAppLocales(APP_ID, 10, `Locales for ${APP_ID} for user 10 are [ko-KR,en-US]\n`))
      .toEqual(['ko-KR', 'en-US'])
    expect(parseAndroidAppLocales(APP_ID, 10, `Locales for ${APP_ID} for user 10 are []\r\n`)).toEqual([])
    expect(parseAndroidAppLocales(APP_ID, 10, `Locales for ${APP_ID} for user 0 are [ko-KR]\n`)).toBeNull()
    expect(parseAndroidAppLocales(APP_ID, 10, 'Locales for com.other.app for user 10 are [ko-KR]\n')).toBeNull()
  })

  it.each([
    `Unknown package ${APP_ID} for userId 10\n`,
    `Locales for ${APP_ID} for user 10 are [en_US]\n`,
    `Locales for ${APP_ID} for user 10 are [en-US,en-us]\n`,
    `warning\nLocales for ${APP_ID} for user 10 are [en-US]\n`,
    `Locales for ${APP_ID} for user 10 are [en-US]\nprivate trailer\n`,
    `Locales for ${APP_ID} for user 10 are [en-US] `,
    'x'.repeat(4 * 1024 + 1)
  ])('fails closed for non-exact LocaleManager output', (stdout) => {
    expect(parseAndroidAppLocales(APP_ID, 10, stdout)).toBeNull()
  })

  it('does not trust LocaleManager code zero when either bounded stream has content', () => {
    expect(isExactAndroidLocaleMutationSuccess({ code: 0, stdout: '', stderr: '' })).toBe(true)
    expect(isExactAndroidLocaleMutationSuccess({
      code: 0,
      stdout: `Unknown package ${APP_ID} for userId 10\n`,
      stderr: ''
    })).toBe(false)
    expect(isExactAndroidLocaleMutationSuccess({ code: 0, stdout: '', stderr: 'warning' })).toBe(false)
    expect(isExactAndroidLocaleMutationSuccess({ code: 0, stdout: '', stderr: '', outputLimitExceeded: true }))
      .toBe(false)
    expect(isExactAndroidLocaleMutationSuccess({ code: 1, stdout: '', stderr: '' })).toBe(false)
  })

  it('gates the app-scoped operation on a strict live API and ADB state', () => {
    expect(parseAndroidApiLevel('33\n')).toBe(33)
    expect(parseAndroidApiLevel('033\n')).toBeNull()
    expect(parseAndroidApiLevel('33 private\n')).toBeNull()
    expect(androidAppLocaleCapability(32)).toMatchObject({
      supported: false,
      code: 'ANDROID_LOCALE_UNSUPPORTED',
      apiLevel: 32
    })
    expect(androidAppLocaleCapability(null)).toMatchObject({
      supported: false,
      code: 'ANDROID_LOCALE_API_UNKNOWN',
      apiLevel: null
    })
    expect(androidAppLocaleCapability(33)).toEqual({ supported: true, apiLevel: 33, minimumApiLevel: 33 })
    expect(isExactAndroidDeviceState('device\n')).toBe(true)
    expect(isExactAndroidDeviceState('device unauthorized\n')).toBe(false)
  })
})

describe('Android locale readiness tracker', () => {
  const ready = (overrides: Partial<Parameters<AndroidLocaleReadinessTracker['observe']>[0]> = {}) => ({
    adbState: 'device',
    localeTags: ['ko-KR'],
    foreground: { applicationId: APP_ID, userId: 10 },
    pids: [42, 84],
    elapsedMs: 250,
    ...overrides
  })

  it('requires two consecutive exact observations with a stable PID set', () => {
    const tracker = new AndroidLocaleReadinessTracker({
      applicationId: APP_ID,
      userId: 10,
      localeTags: ['ko-KR']
    })
    expect(tracker.observe(ready({ pids: [84, 42] }))).toBeNull()
    expect(tracker.observe(ready({ elapsedMs: 500 }))).toEqual({
      adb: 'device',
      localeService: 'ready',
      application: 'foreground',
      process: 'running',
      attempts: 2,
      consecutiveReadyChecks: 2,
      elapsedMs: 500,
      pids: [42, 84]
    })
  })

  it('resets readiness on locale, foreground-user, transport, process, or PID-set drift', () => {
    const tracker = new AndroidLocaleReadinessTracker({
      applicationId: APP_ID,
      userId: 10,
      localeTags: ['ko-KR']
    })
    expect(tracker.observe(ready())).toBeNull()
    expect(tracker.observe(ready({ pids: [43, 84] }))).toBeNull()
    expect(tracker.observe(ready({ localeTags: ['en-US'] }))).toBeNull()
    expect(tracker.observe(ready({ foreground: { applicationId: APP_ID, userId: 0 } }))).toBeNull()
    expect(tracker.observe(ready({ adbState: 'offline' }))).toBeNull()
    expect(tracker.observe(ready({ pids: [] }))).toBeNull()
    expect(tracker.observe(ready())).toBeNull()
    expect(tracker.observe(ready({ elapsedMs: 2_000 }))).toMatchObject({ attempts: 8, pids: [42, 84] })
  })

  it('returns only secret-safe failure diagnostics', () => {
    const tracker = new AndroidLocaleReadinessTracker({
      applicationId: APP_ID,
      userId: 10,
      localeTags: ['ko-KR']
    })
    tracker.observe(ready({
      foreground: { applicationId: 'com.private.other', userId: 10 },
      localeTags: null,
      pids: []
    }))
    const diagnostic = tracker.diagnostic()
    expect(diagnostic).toEqual({
      attempts: 1,
      adbReady: true,
      localeVerified: false,
      appForeground: false,
      processRunning: false,
      processStable: false
    })
    expect(JSON.stringify(diagnostic)).not.toContain('com.private.other')
  })
})
