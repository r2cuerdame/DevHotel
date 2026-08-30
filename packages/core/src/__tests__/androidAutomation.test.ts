import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { AndroidAutomationTarget } from '@devhotel/shared'
import {
  AndroidAutomationSession,
  parseAndroidUiHierarchy,
  type AndroidAutomationSessionOptions
} from '../devices/androidAutomation'
import { androidAppInstallsRepo } from '../store/androidAppInstallsRepo'
import { roomsRepo } from '../store/roomsRepo'
import type { Db } from '../store/db'
import { makeRoom, testDb } from './fakes'

const APP_ID = 'com.example.app'
const INSTALLED_AT = '2026-08-31T01:02:03.000Z'
const HOST_NOW_MS = Date.parse('2026-08-31T01:10:00.000Z')
const BASE_APK_PATH = '/data/app/base.apk'
const BASE_APK_STAT = '103:4242:123456:1788157200:1788157201'
const PACKAGE_INCARNATION = createHash('sha256')
  .update('devhotel-android-package-incarnation\0')
  .update(BASE_APK_PATH)
  .update('\0')
  .update(BASE_APK_STAT)
  .digest('hex')
const INSTALL_LOG_FENCE = 'devhotel-install-11111111-2222-4333-8444-555555555555'
const EXCLUSIVE_PACKAGE_DUMP = [
  'Packages:',
  `  Package [${APP_ID}] (abc123):`,
  '    userId=10123',
  `    pkg=Package{abc123 ${APP_ID}}`,
  `    codePath=${BASE_APK_PATH}`
].join('\n')

function targetEpoch(epochMs: number): string {
  const seconds = Math.floor(epochMs / 1000)
  return `${seconds}.${String(epochMs - (seconds * 1000)).padStart(3, '0')}`
}

const target: AndroidAutomationTarget = {
  kind: 'emulator',
  deviceId: null,
  nickname: 'Room emulator',
  model: 'Pixel 7',
  androidVersion: '14.0',
  apiLevel: 34
}

describe('bounded Android UI hierarchy parsing', () => {
  it('returns only exact-package sanitized nodes and decodes entities', () => {
    const parsed = parseAndroidUiHierarchy(
      `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
       <hierarchy rotation="0">
         <node package="com.android.systemui" text="Secret overlay" bounds="[0,0][50,50]" />
         <node package="${APP_ID}" text="Crash &amp; Recover" content-desc="Primary" resource-id="${APP_ID}:id/crash" class="android.widget.Button" clickable="true" enabled="true" bounds="[10,20][110,80]" />
       </hierarchy>`,
      APP_ID
    )

    expect(parsed).toEqual({
      nodes: [{
        text: 'Crash & Recover',
        contentDescription: 'Primary',
        resourceId: `${APP_ID}:id/crash`,
        className: 'android.widget.Button',
        clickable: true,
        enabled: true,
        bounds: { left: 10, top: 20, right: 110, bottom: 80 },
        center: { x: 60, y: 50 }
      }],
      scannedNodes: 1,
      truncated: false
    })
    expect(JSON.stringify(parsed)).not.toContain('Secret overlay')
  })

  it('rejects active declarations, malformed entities and oversized evidence', () => {
    expect(() => parseAndroidUiHierarchy('<!DOCTYPE x [<!ENTITY steal SYSTEM "file:///etc/passwd">]><node />', APP_ID))
      .toThrow(/Unsafe XML declarations/)
    expect(() => parseAndroidUiHierarchy(
      `<node package="${APP_ID}" text="&unknown;" bounds="[0,0][1,1]" />`,
      APP_ID
    )).toThrow(/unsupported XML entity/)
    expect(() => parseAndroidUiHierarchy('x'.repeat(1024 * 1024 + 1), APP_ID)).toThrow(/byte limit/)
  })

  it('preserves Unicode join controls while rejecting unsafe bidi controls', () => {
    const joinedEmoji = '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}'
    const parsed = parseAndroidUiHierarchy(
      `<node package="${APP_ID}" text="${joinedEmoji}" bounds="[0,0][20,20]" />`,
      APP_ID
    )

    expect(parsed.nodes[0]?.text).toBe(joinedEmoji)
    expect(() => parseAndroidUiHierarchy(
      `<node package="${APP_ID}" text="unsafe\u202econtrol" bounds="[0,0][20,20]" />`,
      APP_ID
    )).toThrow(/control character/)
  })

  it('validates raw XML entities before decoding literal entity-shaped text', () => {
    const parsed = parseAndroidUiHierarchy(
      `<node package="${APP_ID}" text="&amp;quot; &amp;name;" bounds="[0,0][20,20]" />`,
      APP_ID
    )

    expect(parsed.nodes[0]?.text).toBe('&quot; &name;')
    expect(() => parseAndroidUiHierarchy(
      `<node package="${APP_ID}" text="&name;" bounds="[0,0][20,20]" />`,
      APP_ID
    )).toThrow(/unsupported XML entity/)
  })

  it('counts all app nodes while bounding what is returned', () => {
    const xml = `<hierarchy>${Array.from({ length: 4 }, (_, index) =>
      `<node package="${APP_ID}" text="Item ${index}" bounds="[0,${index}][10,${index + 1}]" />`
    ).join('')}</hierarchy>`
    expect(parseAndroidUiHierarchy(xml, APP_ID, { maxNodes: 2 })).toMatchObject({
      scannedNodes: 4,
      truncated: true,
      nodes: [{ text: 'Item 0' }, { text: 'Item 1' }]
    })
  })

  it('does not call an intentionally filtered app node a truncated result', () => {
    const xml = `<hierarchy>
      <node package="${APP_ID}" text="Keep" bounds="[0,0][10,10]" />
      <node package="${APP_ID}" text="Ignore" bounds="[0,10][10,20]" />
    </hierarchy>`

    expect(parseAndroidUiHierarchy(xml, APP_ID, { filter: 'Keep', maxNodes: 1 })).toMatchObject({
      scannedNodes: 2,
      truncated: false,
      nodes: [{ text: 'Keep' }]
    })
  })
})

describe('tracked Android automation session', () => {
  const dbs: Db[] = []

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close()
  })

  function setup(
    handler: (args: string[]) => { code: number; stdout: string; stderr: string },
    timing: Pick<AndroidAutomationSessionOptions, 'now' | 'sleep'> = {},
    targetOverride: AndroidAutomationTarget = target
  ) {
    const db = testDb()
    dbs.push(db)
    roomsRepo(db).create(makeRoom({
      id: 'aaaa1111',
      provider: 'android',
      sourceType: 'empty',
      sourceRef: '',
      workspaceMode: 'empty'
    }))
    const installs = androidAppInstallsRepo(db)
    installs.record({
      roomId: 'aaaa1111',
      target: { kind: 'emulator', targetId: 'aaaa1111', deviceId: null },
      applicationId: APP_ID,
      changeId: '11111111-2222-4333-8444-555555555555',
      apkSha256: 'a'.repeat(64),
      installedAt: INSTALLED_AT,
      packageIncarnation: PACKAGE_INCARNATION,
      logFence: INSTALL_LOG_FENCE
    })
    const calls: string[][] = []
    const timeouts: Array<number | undefined> = []
    const session = new AndroidAutomationSession({
      roomId: 'aaaa1111',
      target: targetOverride,
      installTarget: { kind: 'emulator', targetId: 'aaaa1111', deviceId: null },
      installs,
      exec: async (args, opts) => {
        calls.push(args)
        timeouts.push(opts?.timeoutMs)
        const result = handler(args)
        if (
          args[1] === 'sh' &&
          args[3]?.startsWith('dumpsys package "$1"') &&
          result.code === 0 &&
          !result.stdout.trim()
        ) {
          return { code: 0, stdout: `${EXCLUSIVE_PACKAGE_DUMP}\n\n${args.at(-1)}\n`, stderr: '' }
        }
        if (args[1] === 'stat' && result.code === 0 && !/^\d+:\d+:\d+:-?\d+:-?\d+\r?\n?$/.test(result.stdout)) {
          return { code: 0, stdout: `${BASE_APK_STAT}\n`, stderr: '' }
        }
        if (args[1] === 'sha256sum' && result.code === 0 && !/^[a-fA-F0-9]{64}(?:\s|$)/.test(result.stdout)) {
          return { code: 0, stdout: `${'a'.repeat(64)}  ${args[2]}\n`, stderr: '' }
        }
        return result
      },
      ...timing
    })
    return { db, installs, calls, session, timeouts }
  }

  it('seals install identity and a unique app-UID log fence on Android 12+', async () => {
    let emittedFence = ''
    const { calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'pm' && args.includes('--uid')) return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'pm' && args[2] === 'list') return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'run-as') {
        emittedFence = args.at(-1)!
        return { code: 0, stdout: '', stderr: '' }
      }
      if (args[0] === 'logcat') return { code: 0, stdout: `${emittedFence}\n`, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })

    const evidence = await session.establishInstallEvidence(APP_ID)
    expect(evidence).toEqual({
      apkSha256: 'a'.repeat(64),
      packageIncarnation: PACKAGE_INCARNATION,
      logFence: emittedFence
    })
    expect(emittedFence).toMatch(/^devhotel-install-[0-9a-f-]{36}$/)
    expect(calls.find((args) => args[1] === 'run-as')).toEqual([
      'shell', 'run-as', APP_ID, 'log', '-p', 'i', '-t', 'DEVHOTEL_INSTALL_FENCE', emittedFence
    ])
    expect(calls.find((args) => args[0] === 'logcat')).toEqual([
      'logcat', '-d', '-v', 'raw,printable', '--uid=10123'
    ])
  })

  it('keeps non-log install evidence when the bounded fence proof overflows', async () => {
    const { session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'pm' && args.includes('--uid')) return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'pm' && args[2] === 'list') return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'run-as') return { code: 0, stdout: '', stderr: '' }
      if (args[0] === 'logcat') return { code: 0, stdout: 'x'.repeat((1024 * 1024) + 1), stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.establishInstallEvidence(APP_ID)).resolves.toEqual({
      apkSha256: 'a'.repeat(64),
      packageIncarnation: PACKAGE_INCARNATION,
      logFence: null
    })
  })

  it('keeps non-log install evidence when the package dump is incomplete', async () => {
    let pathProbes = 0
    const { calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') {
        pathProbes += 1
        return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      }
      if (args[1] === 'sh' && args[3]?.startsWith('dumpsys package "$1"')) {
        return { code: 0, stdout: `${EXCLUSIVE_PACKAGE_DUMP}\n`, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.establishInstallEvidence(APP_ID)).resolves.toEqual({
      apkSha256: 'a'.repeat(64),
      packageIncarnation: PACKAGE_INCARNATION,
      logFence: null
    })
    expect(pathProbes).toBe(2)
    expect(calls.some((args) => args[1] === 'run-as' || args[0] === 'logcat')).toBe(false)
  })

  it('rejects install evidence when the package path changes during log-fence proof', async () => {
    let pathProbes = 0
    let emittedFence = ''
    const { installs, calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') {
        pathProbes += 1
        const path = pathProbes === 1 ? BASE_APK_PATH : '/data/app/replaced/base.apk'
        return { code: 0, stdout: `package:${path}\n`, stderr: '' }
      }
      if (args[1] === 'pm' && args.includes('--uid')) return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'pm' && args[2] === 'list') return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'run-as') {
        emittedFence = args.at(-1)!
        return { code: 0, stdout: '', stderr: '' }
      }
      if (args[0] === 'logcat') return { code: 0, stdout: `${emittedFence}\n`, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.establishInstallEvidence(APP_ID)).rejects.toMatchObject({
      code: 'ANDROID_APP_REPLACED'
    })
    expect(pathProbes).toBe(2)
    expect(calls.findIndex((args) => args[0] === 'logcat')).toBeLessThan(
      calls.map((args) => args[1] === 'pm' && args[2] === 'path').lastIndexOf(true)
    )
    expect(installs.get(
      'aaaa1111',
      { kind: 'emulator', targetId: 'aaaa1111', deviceId: null },
      APP_ID
    )).toBeNull()
  })

  it('gates authoritative log fencing on Android 12 without weakening non-log receipts', async () => {
    const { calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }, {}, { ...target, androidVersion: '11.0', apiLevel: 30 })

    await expect(session.establishInstallEvidence(APP_ID)).resolves.toEqual({
      apkSha256: 'a'.repeat(64),
      packageIncarnation: PACKAGE_INCARNATION,
      logFence: null
    })
    expect(calls.some((args) => args[1] === 'run-as' || args[0] === 'logcat')).toBe(false)
  })

  it('launches with typed argv and never constructs a shell command from extras', async () => {
    const { calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: 'package:/data/app/base.apk\n', stderr: '' }
      if (args[1] === 'stat') return { code: 0, stdout: `${BASE_APK_STAT}\n`, stderr: '' }
      if (args[1] === 'sha256sum') return { code: 0, stdout: `${'a'.repeat(64)}  /data/app/base.apk\n`, stderr: '' }
      if (args[1] === 'cmd') return { code: 0, stdout: `${APP_ID}/.MainActivity\n`, stderr: '' }
      return { code: 0, stdout: 'Status: ok\n', stderr: '' }
    })

    const result = await session.launch(APP_ID, undefined, { label: 'A $HOME; id', retries: 2, enabled: true })

    expect(result.component).toBe(`${APP_ID}/.MainActivity`)
    expect(calls.at(-1)).toEqual([
      'shell', 'am', 'start', '-W', '--user', 'current', '-n', `${APP_ID}/.MainActivity`,
      '--es', 'label', 'A $HOME; id', '--ei', 'retries', '2', '--ez', 'enabled', 'true'
    ])
    expect(calls.at(-1)?.[2]).toBe('start')
  })

  it('rejects a NUL string extra before invoking an Android launch command', async () => {
    const { calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: 'package:/data/app/base.apk\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.launch(APP_ID, '.MainActivity', {
      label: 'before\u0000after'
    })).rejects.toMatchObject({ code: 'ANDROID_EXTRA_INVALID' })
    expect(calls.some((args) => args[1] === 'am' && args[2] === 'start')).toBe(false)
  })

  it('scopes a fully qualified activity from another Java namespace to the tracked app', async () => {
    const { calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: 'package:/data/app/base.apk\n', stderr: '' }
      if (args[1] === 'sha256sum') return { code: 0, stdout: `${'a'.repeat(64)}  /data/app/base.apk\n`, stderr: '' }
      return { code: 0, stdout: 'Status: ok\n', stderr: '' }
    })

    const result = await session.launch(APP_ID, 'com.vendor.auth.LoginActivity')

    expect(result.component).toBe(`${APP_ID}/com.vendor.auth.LoginActivity`)
    expect(calls.at(-1)).toEqual([
      'shell', 'am', 'start', '-W', '--user', 'current', '-n',
      `${APP_ID}/com.vendor.auth.LoginActivity`
    ])
  })

  it('returns only bounded redacted evidence when a launch command fails', async () => {
    const secret = `ghp_${'A'.repeat(24)}`
    const { session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: 'package:/data/app/base.apk\n', stderr: '' }
      if (args[1] === 'stat') return { code: 0, stdout: `${BASE_APK_STAT}\n`, stderr: '' }
      if (args[1] === 'sha256sum') return { code: 0, stdout: `${'a'.repeat(64)}  /data/app/base.apk\n`, stderr: '' }
      if (args[1] === 'cmd') return { code: 0, stdout: `${APP_ID}/.MainActivity\n`, stderr: '' }
      return { code: 1, stdout: 'x'.repeat(5_000), stderr: `token=${secret}` }
    })

    await expect(session.launch(APP_ID)).rejects.toMatchObject({
      code: 'ANDROID_LAUNCH_FAILED',
      evidence: {
        code: 1,
        stderr: 'token=•••',
        truncated: true
      }
    })
    await session.launch(APP_ID).catch((error: unknown) => {
      expect(JSON.stringify(error)).not.toContain(secret)
    })
  })

  it('filters cross-app UI and refuses an ambiguous text tap before input', async () => {
    const { calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: 'package:/data/app/base.apk\n', stderr: '' }
      if (args[1] === 'sh' && args[2] === '-c' && args[3]?.includes('dumpsys window')) {
        return { code: 0, stdout: `mCurrentFocus=Window{1 u0 ${APP_ID}/.MainActivity}\n`, stderr: '' }
      }
      if (args[0] === 'exec-out') {
        return {
          code: 0,
          stdout: `<hierarchy>
            <node package="other.app" text="Crash" bounds="[0,0][20,20]" />
            <node package="${APP_ID}" text="Crash" bounds="[0,0][20,20]" />
            <node package="${APP_ID}" content-desc="Crash" bounds="[20,0][40,20]" />
          </hierarchy>`,
          stderr: ''
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.tapText({ applicationId: APP_ID, text: 'Crash' })).rejects.toMatchObject({
      code: 'ANDROID_UI_TEXT_AMBIGUOUS'
    })
    expect(calls.some((args) => args[1] === 'input')).toBe(false)
    expect(calls.some((args) => args[1] === 'rm')).toBe(true)
  })

  it('refuses stale coordinates when the unique text node moves between dumps', async () => {
    let hierarchy = 0
    const { calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: 'package:/data/app/base.apk\n', stderr: '' }
      if (args[1] === 'sh' && args[2] === '-c' && args[3]?.includes('dumpsys window')) {
        return { code: 0, stdout: `mCurrentFocus=Window{1 u0 ${APP_ID}/.MainActivity}\n`, stderr: '' }
      }
      if (args[0] === 'exec-out') {
        hierarchy += 1
        const left = hierarchy === 1 ? 0 : 20
        return {
          code: 0,
          stdout: `<hierarchy><node package="${APP_ID}" text="Crash" resource-id="${APP_ID}:id/crash" class="android.widget.Button" bounds="[${left},0][${left + 20},20]" /></hierarchy>`,
          stderr: ''
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.tapText({ applicationId: APP_ID, text: 'Crash' })).rejects.toMatchObject({
      code: 'ANDROID_UI_TEXT_MOVED'
    })
    expect(hierarchy).toBe(2)
    expect(calls.some((args) => args[1] === 'input')).toBe(false)
  })

  it('applies the text predicate before the cap and refuses a truncated candidate dump', async () => {
    const nodes = Array.from({ length: 501 }, (_, index) =>
      `<node package="${APP_ID}" text="Crash" bounds="[${index},0][${index + 1},20]" />`
    )
    let hierarchyReads = 0
    const { calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: 'package:/data/app/base.apk\n', stderr: '' }
      if (args[1] === 'sh' && args[2] === '-c' && args[3]?.includes('dumpsys window')) {
        return { code: 0, stdout: `mCurrentFocus=Window{1 u0 ${APP_ID}/.MainActivity}\n`, stderr: '' }
      }
      if (args[0] === 'exec-out') {
        hierarchyReads += 1
        return { code: 0, stdout: `<hierarchy>${nodes.join('')}</hierarchy>`, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.tapText({ applicationId: APP_ID, text: 'Crash' })).rejects.toMatchObject({
      code: 'ANDROID_UI_TEXT_AMBIGUOUS'
    })
    expect(hierarchyReads).toBe(1)
    expect(calls.some((args) => args[1] === 'input')).toBe(false)
  })

  it('clamps every wait-for-text command to the remaining request deadline', async () => {
    let now = 1_000
    const { calls, session, timeouts } = setup((args) => {
      if (args[1] !== 'stat') now += 80
      if (args[1] === 'pm' && args[2] === 'path') {
        return { code: 0, stdout: 'package:/data/app/base.apk\n', stderr: '' }
      }
      if (args[1] === 'sha256sum') {
        return { code: 0, stdout: `${'a'.repeat(64)}  /data/app/base.apk\n`, stderr: '' }
      }
      if (args[1] === 'sh' && args[2] === '-c' && args[3]?.includes('dumpsys window')) {
        return { code: 0, stdout: `mCurrentFocus=Window{1 u0 ${APP_ID}/.MainActivity}\n`, stderr: '' }
      }
      if (args[0] === 'exec-out') {
        return { code: 0, stdout: `<hierarchy><node package="${APP_ID}" text="Other" bounds="[0,0][20,20]" /></hierarchy>`, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    }, {
      now: () => now,
      sleep: async (ms) => { now += ms }
    })

    await expect(session.waitForText({
      applicationId: APP_ID,
      text: 'Ready',
      timeoutMs: 250,
      pollIntervalMs: 250
    })).rejects.toMatchObject({ code: 'ANDROID_WAIT_TIMEOUT' })

    expect(timeouts).toEqual([250, 170, 170, 90, 90, 10])
    expect(calls.some((args) => args[1] === 'rm')).toBe(false)
    const trappedDump = calls.find((args) => args[0] === 'exec-out')
    expect(trappedDump?.[3]).toContain('trap cleanup 0 1 2 15')
    expect(trappedDump?.[3]).toContain('kill "$child"')
    expect(trappedDump?.[5]).toMatch(/^\/data\/local\/tmp\/devhotel-ui-[a-f0-9-]+\.xml$/)
  })

  it('uses an exact unshared UID, clamps time to install, and redacts log secrets', async () => {
    const { calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: 'package:/data/app/base.apk\n', stderr: '' }
      if (args[1] === 'pm' && args.includes('--uid')) return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'pm' && args[2] === 'list') return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[0] === 'logcat') {
        return {
          code: 0,
          stdout: [
            '1999999999.999 pre-install clock-jump row',
            `1690000000.000 I/${INSTALL_LOG_FENCE}`,
            '1690000000.001 token=ghp_ABCDEFGHIJKLMNOPQRSTUVWX123456',
            '1690000000.002 normal line',
            ''
          ].join('\n'),
          stderr: ''
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    }, { now: () => HOST_NOW_MS })

    const result = await session.logcat({
      applicationId: APP_ID,
      since: '2020-01-01T00:00:00.000Z',
      maxLines: 20
    })

    expect(result.since).toBe(INSTALLED_AT)
    expect(result.lines.join('\n')).not.toContain('ghp_')
    expect(result.lines).toEqual(['1690000000.001 token=•••', '1690000000.002 normal line'])
    expect(calls.find((args) => args[0] === 'logcat')).toEqual([
      'logcat', '-d', '-v', 'epoch,UTC,printable', '--uid=10123'
    ])
    expect(calls.some((args) => args[1] === 'date')).toBe(false)
    expect(calls.filter((args) => args[1] === 'pm' && args[2] === 'list')).toEqual([
      ['shell', 'pm', 'list', 'packages', '-U', '--user', 'current', APP_ID],
      ['shell', 'pm', 'list', 'packages', '-U', '--user', 'current', '--uid', '10123']
    ])
  })

  it('invalidates the receipt when the package incarnation changes during a log read', async () => {
    const replacementStat = '103:5252:123456:1788157200:1788157300'
    let statProbes = 0
    const { installs, calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'stat') {
        statProbes += 1
        return { code: 0, stdout: `${statProbes <= 2 ? BASE_APK_STAT : replacementStat}\n`, stderr: '' }
      }
      if (args[1] === 'pm' && args.includes('--uid')) return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'pm' && args[2] === 'list') return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[0] === 'logcat') {
        return {
          code: 0,
          stdout: `1690000000.000 ${INSTALL_LOG_FENCE}\n1690000000.001 replacement row\n`,
          stderr: ''
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.logcat({ applicationId: APP_ID })).rejects.toMatchObject({
      code: 'ANDROID_APP_REPLACED'
    })
    expect(statProbes).toBe(4)
    expect(calls.findIndex((args) => args[0] === 'logcat')).toBeLessThan(
      calls.map((args) => args[1] === 'stat').lastIndexOf(true)
    )
    expect(installs.get(
      'aaaa1111',
      { kind: 'emulator', targetId: 'aaaa1111', deviceId: null },
      APP_ID
    )).toBeNull()
  })

  it('preserves a fractional cutoff and applies the requested line cap after literal filtering', async () => {
    const { calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: 'package:/data/app/base.apk\n', stderr: '' }
      if (args[1] === 'pm' && args.includes('--uid')) return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'pm' && args[2] === 'list') return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'date') return { code: 0, stdout: `${targetEpoch(HOST_NOW_MS)}\n`, stderr: '' }
      if (args[0] === 'logcat') {
        return {
          code: 0,
          stdout: [
            `1690000000.000 I/${INSTALL_LOG_FENCE}`,
            `${targetEpoch(Date.parse('2026-08-31T01:02:04.566Z'))} old MATCH`,
            `${targetEpoch(Date.parse('2026-08-31T01:02:04.567Z'))} late MATCH one`,
            `${targetEpoch(Date.parse('2026-08-31T01:02:04.568Z'))} late MATCH two`,
            ''
          ].join('\n'),
          stderr: ''
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    }, { now: () => HOST_NOW_MS })
    const requestedSince = '2026-08-31T01:02:04.567Z'

    const result = await session.logcat({
      applicationId: APP_ID,
      since: requestedSince,
      filter: 'MATCH',
      maxLines: 1
    })

    expect(result).toMatchObject({
      since: requestedSince,
      lines: [`${targetEpoch(Date.parse(requestedSince))} late MATCH one`],
      sourceLines: 2,
      truncated: true
    })
    const logcat = calls.find((args) => args[0] === 'logcat')
    expect(logcat).not.toContain('-t')
    expect(logcat).not.toContain('-m')
  })

  it('translates an explicit Host cutoff into the current target clock after the install fence', async () => {
    const skewMs = 5 * 60_000
    const since = '2026-08-31T01:05:04.567Z'
    const expectedHostSince = Date.parse(since)
    const targetSince = expectedHostSince + skewMs
    const { calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: 'package:/data/app/base.apk\n', stderr: '' }
      if (args[1] === 'pm' && args.includes('--uid')) return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'pm' && args[2] === 'list') return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'date') return { code: 0, stdout: `${targetEpoch(HOST_NOW_MS + skewMs)}\n`, stderr: '' }
      if (args[0] === 'logcat') {
        return {
          code: 0,
          stdout: [
            `1999999999.999 I/${INSTALL_LOG_FENCE}`,
            `${targetEpoch(targetSince - 1)} old`,
            `${targetEpoch(targetSince)} kept`,
            ''
          ].join('\n'),
          stderr: ''
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    }, { now: () => HOST_NOW_MS })

    const result = await session.logcat({ applicationId: APP_ID, since })

    expect(result.since).toBe(new Date(expectedHostSince).toISOString())
    expect(result.lines).toEqual([`${targetEpoch(targetSince)} kept`])
    expect(calls.find((args) => args[1] === 'date')).toEqual(['shell', 'date', '+%s.%3N'])
    expect(calls.find((args) => args[0] === 'logcat')).not.toContain('-t')
  })

  it('fails closed when the target-clock round trip is too slow to bound safely', async () => {
    let now = HOST_NOW_MS
    const { calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: 'package:/data/app/base.apk\n', stderr: '' }
      if (args[1] === 'pm' && args.includes('--uid')) return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'pm' && args[2] === 'list') return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'date') {
        now += 2_001
        return { code: 0, stdout: `${targetEpoch(HOST_NOW_MS)}\n`, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    }, { now: () => now })

    await expect(session.logcat({
      applicationId: APP_ID,
      since: '2026-08-31T01:05:04.567Z'
    })).rejects.toMatchObject({
      code: 'ANDROID_TARGET_CLOCK_UNVERIFIED'
    })
    expect(calls.some((args) => args[0] === 'logcat')).toBe(false)
  })

  it.each([
    { label: 'malformed', clock: { code: 0, stdout: 'not-an-epoch\n', stderr: '' } },
    { label: 'nonzero', clock: { code: 1, stdout: `${targetEpoch(HOST_NOW_MS)}\n`, stderr: 'date failed' } }
  ])('fails closed on a $label target-clock result before reading logcat', async ({ clock }) => {
    const { calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: 'package:/data/app/base.apk\n', stderr: '' }
      if (args[1] === 'pm' && args.includes('--uid')) return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'pm' && args[2] === 'list') return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'date') return clock
      return { code: 0, stdout: '', stderr: '' }
    }, { now: () => HOST_NOW_MS })

    await expect(session.logcat({
      applicationId: APP_ID,
      since: '2026-08-31T01:05:04.567Z'
    })).rejects.toMatchObject({
      code: 'ANDROID_TARGET_CLOCK_UNVERIFIED'
    })
    expect(calls.some((args) => args[0] === 'logcat')).toBe(false)
  })

  it('fails closed with an actionable since hint when bounded logcat source overflows', async () => {
    const { session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: 'package:/data/app/base.apk\n', stderr: '' }
      if (args[1] === 'pm' && args.includes('--uid')) return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'pm' && args[2] === 'list') return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'date') return { code: 0, stdout: `${targetEpoch(HOST_NOW_MS)}\n`, stderr: '' }
      if (args[0] === 'logcat') {
        return {
          code: -1,
          stdout: 'bounded prefix',
          stderr: 'Android emulator command output exceeded its safety limit.'
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    }, { now: () => HOST_NOW_MS })

    await expect(session.logcat({
      applicationId: APP_ID,
      filter: 'MATCH',
      maxLines: 1
    })).rejects.toMatchObject({
      code: 'ANDROID_OUTPUT_LIMIT',
      recoveryHint: expect.stringMatching(/rerun android_run/i)
    })
  })

  it.each([
    { label: 'missing', source: '1690000000.000 unrelated\n' },
    {
      label: 'ambiguous',
      source: `1690000000.000 ${INSTALL_LOG_FENCE}\n1690000000.001 ${INSTALL_LOG_FENCE}\n`
    }
  ])('fails closed when the install log fence is $label in bounded UID evidence', async ({ source }) => {
    const { session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'pm' && args.includes('--uid')) return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'pm' && args[2] === 'list') return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[0] === 'logcat') return { code: 0, stdout: source, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.logcat({ applicationId: APP_ID })).rejects.toMatchObject({
      code: 'ANDROID_LOG_FENCE_UNSUPPORTED'
    })
  })

  it('rejects a declared legacy shared UID even while the app is its sole current owner', async () => {
    const sharedUserName = 'com.private.legacy.shared'
    const { calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'sh' && args[3]?.startsWith('dumpsys package "$1"')) {
        return {
          code: 0,
          stdout: [
            'Packages:',
            `  Package [${APP_ID}] (abc123):`,
            '    userId=10123',
            `    sharedUser=SharedUserSetting{def456 ${sharedUserName}/10123}`,
            `    pkg=Package{abc123 ${APP_ID}}`,
            `    codePath=${BASE_APK_PATH}`,
            '',
            args.at(-1),
            ''
          ].join('\n'),
          stderr: ''
        }
      }
      if (args[1] === 'pm' && args[2] === 'list') return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })

    await session.logcat({ applicationId: APP_ID }).catch((error: unknown) => {
      expect(error).toMatchObject({
        code: 'ANDROID_LOGCAT_SHARED_UID',
        evidence: { code: 0, stdout: '', stderr: '', truncated: true }
      })
      expect(JSON.stringify(error)).not.toContain(sharedUserName)
    })
    expect(calls.some((args) => args.includes('--uid'))).toBe(false)
    expect(calls.some((args) => args[0] === 'logcat')).toBe(false)
  })

  it('fails log authority closed when the package dump completion cannot be proven', async () => {
    const privateDiagnostic = 'sharedUser=com.private.legacy'
    const { calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'sh' && args[3]?.startsWith('dumpsys package "$1"')) {
        return {
          code: 0,
          // A syntactically valid prefix is not authoritative without the
          // random tail fence proving dumpsys and the wrapper both completed.
          stdout: `${EXCLUSIVE_PACKAGE_DUMP}\n`,
          stderr: privateDiagnostic
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.logcat({ applicationId: APP_ID })).rejects.toMatchObject({
      code: 'ANDROID_LOGCAT_UNSUPPORTED',
      evidence: { code: 0, stdout: '', stderr: '', truncated: true }
    })
    await session.logcat({ applicationId: APP_ID }).catch((error: unknown) => {
      expect(JSON.stringify(error)).not.toContain(privateDiagnostic)
    })
    expect(calls.some((args) => args.includes('--uid'))).toBe(false)
    expect(calls.some((args) => args[0] === 'logcat')).toBe(false)
  })

  it('withholds other package IDs when a current shared-UID owner probe fails', async () => {
    const otherPackage = 'com.private.other'
    const { calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'pm' && args.includes('--uid')) {
        return {
          code: 0,
          stdout: `package:${APP_ID} uid:10123\npackage:${otherPackage} uid:10123\n`,
          stderr: 'token=ghp_ABCDEFGHIJKLMNOPQRSTUVWX123456'
        }
      }
      if (args[1] === 'pm' && args[2] === 'list') return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })

    await session.logcat({ applicationId: APP_ID }).catch((error: unknown) => {
      expect(error).toMatchObject({
        code: 'ANDROID_LOGCAT_SHARED_UID',
        evidence: { code: 0, stdout: '', stderr: 'token=•••', truncated: true }
      })
      expect(JSON.stringify(error)).not.toContain(otherPackage)
    })
    expect(calls.some((args) => args[0] === 'logcat')).toBe(false)
  })

  it('fails log and crash closed before UID/logcat access when an install has no authority fence', async () => {
    const { installs, calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    installs.record({
      roomId: 'aaaa1111',
      target: { kind: 'emulator', targetId: 'aaaa1111', deviceId: null },
      applicationId: APP_ID,
      changeId: '11111111-2222-4333-8444-555555555555',
      apkSha256: 'a'.repeat(64),
      installedAt: INSTALLED_AT,
      packageIncarnation: PACKAGE_INCARNATION,
      logFence: null
    })

    await expect(session.logcat({ applicationId: APP_ID })).rejects.toMatchObject({
      code: 'ANDROID_LOG_FENCE_UNSUPPORTED'
    })
    await expect(session.crashScenario({
      applicationId: APP_ID,
      scenario: 'am-crash',
      runId: 'unsupported-fence'
    })).rejects.toMatchObject({ code: 'ANDROID_LOG_FENCE_UNSUPPORTED' })
    expect(calls.some((args) => args[0] === 'logcat' || args[1] === 'pidof' || args[1] === 'run-as')).toBe(false)
  })

  it('composes safe foreground metadata with its exact install receipt', async () => {
    const { session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: 'package:/data/app/base.apk\n', stderr: '' }
      if (args[1] === 'sh' && args.at(-1)?.includes('dumpsys window')) {
        return { code: 0, stdout: `mCurrentFocus=Window{1 u0 ${APP_ID}/.MainActivity}\n`, stderr: '' }
      }
      if (args[1] === 'getprop') return { code: 0, stdout: 'ko-KR\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })

    const context = await session.foregroundInstallContext()

    expect(context.status).toMatchObject({
      foregroundApplicationId: APP_ID,
      installedApplicationIds: [APP_ID],
      locale: 'ko-KR'
    })
    expect(context.receipt).toMatchObject({
      applicationId: APP_ID,
      changeId: '11111111-2222-4333-8444-555555555555',
      apkSha256: 'a'.repeat(64)
    })
    expect(context.receipt).not.toHaveProperty('leaseId')
    expect(context.receipt).not.toHaveProperty('packageIncarnation')
    expect(context.receipt).not.toHaveProperty('logFence')
  })

  it('invalidates a stale receipt when the package is gone', async () => {
    const { installs, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'list') return { code: 0, stdout: '', stderr: '' }
      return { code: 1, stdout: '', stderr: 'not installed' }
    })

    await expect(session.forceStop(APP_ID)).rejects.toMatchObject({ code: 'ANDROID_APP_NOT_INSTALLED' })
    expect(installs.get(
      'aaaa1111',
      { kind: 'emulator', targetId: 'aaaa1111', deviceId: null },
      APP_ID
    )).toBeNull()
  })

  it('preserves the receipt when package probes fail transiently', async () => {
    const { installs, calls, session } = setup(() => ({ code: 1, stdout: '', stderr: 'transport lost' }))

    await expect(session.forceStop(APP_ID)).rejects.toMatchObject({ code: 'ANDROID_APP_PROBE_FAILED' })
    expect(installs.get(
      'aaaa1111',
      { kind: 'emulator', targetId: 'aaaa1111', deviceId: null },
      APP_ID
    )).toMatchObject({ applicationId: APP_ID, apkSha256: 'a'.repeat(64) })
    expect(calls.some((args) => args[1] === 'pm' && args[2] === 'list')).toBe(true)
    expect(calls.some((args) => args[1] === 'am' && args[2] === 'force-stop')).toBe(false)
  })

  it('invalidates a receipt when the installed base APK bytes were replaced', async () => {
    const { installs, calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: 'package:/data/app/base.apk\n', stderr: '' }
      if (args[1] === 'sha256sum') return { code: 0, stdout: `${'b'.repeat(64)}  /data/app/base.apk\n`, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.forceStop(APP_ID)).rejects.toMatchObject({ code: 'ANDROID_APP_REPLACED' })
    expect(installs.get(
      'aaaa1111',
      { kind: 'emulator', targetId: 'aaaa1111', deviceId: null },
      APP_ID
    )).toBeNull()
    expect(calls.some((args) => args[1] === 'am' && args[2] === 'force-stop')).toBe(false)
  })

  it('invalidates a same-byte receipt when reinstall changes the base APK path', async () => {
    const { installs, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') {
        return { code: 0, stdout: 'package:/data/app/new-incarnation/base.apk\n', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.forceStop(APP_ID)).rejects.toMatchObject({ code: 'ANDROID_APP_REPLACED' })
    expect(installs.get(
      'aaaa1111',
      { kind: 'emulator', targetId: 'aaaa1111', deviceId: null },
      APP_ID
    )).toBeNull()
  })

  it('invalidates a same-byte receipt when reinstall changes inode at the same path', async () => {
    const replacementStat = '103:5252:123456:1788157200:1788157300'
    const { installs, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'stat') return { code: 0, stdout: `${replacementStat}\n`, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.forceStop(APP_ID)).rejects.toMatchObject({ code: 'ANDROID_APP_REPLACED' })
    expect(installs.get(
      'aaaa1111',
      { kind: 'emulator', targetId: 'aaaa1111', deviceId: null },
      APP_ID
    )).toBeNull()
  })

  it('preserves the receipt and refuses an unsealed split APK installation', async () => {
    const { installs, calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') {
        return {
          code: 0,
          stdout: 'package:/data/app/base.apk\npackage:/data/app/split_config.en.apk\n',
          stderr: ''
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.forceStop(APP_ID)).rejects.toMatchObject({ code: 'ANDROID_APP_IDENTITY_UNVERIFIED' })
    expect(installs.get(
      'aaaa1111',
      { kind: 'emulator', targetId: 'aaaa1111', deviceId: null },
      APP_ID
    )).toMatchObject({ applicationId: APP_ID, apkSha256: 'a'.repeat(64) })
    expect(calls.some((args) => args[1] === 'sha256sum')).toBe(false)
    expect(calls.some((args) => args[1] === 'am' && args[2] === 'force-stop')).toBe(false)
  })

  it('does not misreport a pre-crash PID probe failure as an app that is not running', async () => {
    const { calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: 'package:/data/app/base.apk\n', stderr: '' }
      if (args[1] === 'pidof') return { code: -1, stdout: '', stderr: 'transport lost' }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.crashScenario({
      applicationId: APP_ID,
      scenario: 'am-crash',
      runId: 'pre-probe-failure'
    })).rejects.toMatchObject({ code: 'ANDROID_PROCESS_PROBE_FAILED' })
    expect(calls.some((args) => args[1] === 'am' && args[2] === 'crash')).toBe(false)
  })

  it('reports not-running only for an authoritative empty pidof result', async () => {
    const { session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: 'package:/data/app/base.apk\n', stderr: '' }
      if (args[1] === 'pidof') return { code: 1, stdout: '', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.crashScenario({
      applicationId: APP_ID,
      scenario: 'am-crash',
      runId: 'not-running'
    })).rejects.toMatchObject({ code: 'ANDROID_APP_NOT_RUNNING' })
  })

  it('does not treat a post-crash PID probe failure as observed process death', async () => {
    let pidProbes = 0
    const { calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: 'package:/data/app/base.apk\n', stderr: '' }
      if (args[1] === 'pidof') {
        pidProbes += 1
        return pidProbes === 1
          ? { code: 0, stdout: '1234\n', stderr: '' }
          : { code: -1, stdout: '', stderr: 'transport lost' }
      }
      if (args[1] === 'sh' && args[3]?.includes('exec am crash')) {
        return { code: 0, stdout: `DEVHOTEL_TARGET_EPOCH=${targetEpoch(Date.now())}\n`, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.crashScenario({
      applicationId: APP_ID,
      scenario: 'am-crash',
      runId: 'post-probe-failure'
    })).rejects.toMatchObject({ code: 'ANDROID_PROCESS_PROBE_FAILED' })
    expect(calls.some((args) => args[1] === 'sh' && args[3]?.includes('exec am crash'))).toBe(true)
    expect(pidProbes).toBe(2)
  })

  it('emits the app-UID fence immediately before crash and reads from that exact fence without a clock probe', async () => {
    let pidProbes = 0
    let crashFence = ''
    const { calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: 'package:/data/app/base.apk\n', stderr: '' }
      if (args[1] === 'pidof') {
        pidProbes += 1
        return pidProbes === 1
          ? { code: 0, stdout: '1234\n', stderr: '' }
          : { code: 1, stdout: '', stderr: '' }
      }
      if (args[1] === 'sh' && args[3]?.includes('exec am crash')) {
        crashFence = args.at(-1)!
        return {
          code: 0,
          stdout: 'Crash requested\n',
          stderr: ''
        }
      }
      if (args[1] === 'pm' && args.includes('--uid')) return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'pm' && args[2] === 'list') return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[0] === 'logcat') {
        return {
          code: 0,
          stdout: `1999999999.999 I/${crashFence}\n1000000000.000 crash line\n`,
          stderr: ''
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    }, { now: () => HOST_NOW_MS, sleep: async () => {} })

    const result = await session.crashScenario({
      applicationId: APP_ID,
      scenario: 'am-crash',
      runId: 'target-clock-crash'
    })

    expect(result).toMatchObject({
      observed: true,
      pidsBefore: [1234],
      pidsAfter: [],
      evidence: { stdout: 'Crash requested\n' },
      logcat: {
        since: new Date(HOST_NOW_MS).toISOString(),
        lines: ['1000000000.000 crash line']
      }
    })
    const crash = calls.find((args) => args[1] === 'sh' && args[3]?.includes('exec am crash'))
    expect(crash).toEqual([
      'shell', 'sh', '-c',
      'run-as "$1" log -p i -t DEVHOTEL_CRASH_FENCE "$2" && exec am crash --user current "$1"',
      'devhotel-crash', APP_ID, crashFence
    ])
    expect(crashFence).toMatch(/^devhotel-crash-[0-9a-f-]{36}$/)
    expect(calls.find((args) => args[0] === 'logcat')).not.toContain('-t')
    expect(calls.some((args) => args[1] === 'date')).toBe(false)
  })

  it('transfers one exact target/package receipt to the last installing Room', () => {
    const { db, installs } = setup(() => ({ code: 0, stdout: '', stderr: '' }))
    roomsRepo(db).create(makeRoom({ id: 'bbbb2222', project: 'other', domain: 'other.localhost' }))
    const deviceId = `d${'b'.repeat(32)}`
    const firstLease = {
      kind: 'physical' as const,
      targetId: deviceId,
      deviceId,
      leaseId: '11111111-2222-4333-8444-555555555551'
    }
    const secondLease = {
      kind: 'physical' as const,
      targetId: deviceId,
      deviceId,
      leaseId: '11111111-2222-4333-8444-555555555552'
    }
    installs.record({
      roomId: 'aaaa1111', target: firstLease, applicationId: APP_ID,
      changeId: '21111111-2222-4333-8444-555555555555', apkSha256: 'b'.repeat(64), installedAt: INSTALLED_AT,
      packageIncarnation: 'b'.repeat(64), logFence: null
    })
    installs.record({
      roomId: 'bbbb2222', target: secondLease, applicationId: APP_ID,
      changeId: '31111111-2222-4333-8444-555555555555', apkSha256: 'c'.repeat(64), installedAt: INSTALLED_AT,
      packageIncarnation: 'c'.repeat(64), logFence: null
    })

    expect(installs.get('aaaa1111', firstLease, APP_ID)).toBeNull()
    expect(installs.get('bbbb2222', firstLease, APP_ID)).toBeNull()
    expect(installs.get('bbbb2222', secondLease, APP_ID)?.apkSha256).toBe('c'.repeat(64))
  })
})
