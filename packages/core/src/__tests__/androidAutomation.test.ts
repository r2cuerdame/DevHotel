import { afterEach, describe, expect, it } from 'vitest'
import type { AndroidAutomationTarget } from '@devhotel/shared'
import { AndroidAutomationSession, parseAndroidUiHierarchy } from '../devices/androidAutomation'
import { androidAppInstallsRepo } from '../store/androidAppInstallsRepo'
import { roomsRepo } from '../store/roomsRepo'
import type { Db } from '../store/db'
import { makeRoom, testDb } from './fakes'

const APP_ID = 'com.example.app'
const INSTALLED_AT = '2026-08-31T01:02:03.000Z'
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

  function setup(handler: (args: string[]) => { code: number; stdout: string; stderr: string }) {
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
      installedAt: INSTALLED_AT
    })
    const calls: string[][] = []
    const session = new AndroidAutomationSession({
      roomId: 'aaaa1111',
      target,
      installTarget: { kind: 'emulator', targetId: 'aaaa1111', deviceId: null },
      installs,
      exec: async (args) => {
        calls.push(args)
        const result = handler(args)
        if (args[1] === 'sha256sum' && result.code === 0 && !result.stdout && !result.stderr) {
          return { code: 0, stdout: `${'a'.repeat(64)}  ${args[2]}\n`, stderr: '' }
        }
        return result
      }
    })
    return { db, installs, calls, session }
  }

  it('launches with typed argv and never constructs a shell command from extras', async () => {
    const { calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: 'package:/data/app/base.apk\n', stderr: '' }
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

  it('returns only bounded redacted evidence when a launch command fails', async () => {
    const secret = `ghp_${'A'.repeat(24)}`
    const { session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: 'package:/data/app/base.apk\n', stderr: '' }
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

  it('uses an exact unshared UID, clamps time to install, and redacts log secrets', async () => {
    const { calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: 'package:/data/app/base.apk\n', stderr: '' }
      if (args[1] === 'pm' && args.includes('--uid')) return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'pm' && args[2] === 'list') return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[0] === 'logcat') {
        return { code: 0, stdout: '1690000000.000 token=ghp_ABCDEFGHIJKLMNOPQRSTUVWX123456\nnormal line\n', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    const result = await session.logcat({
      applicationId: APP_ID,
      since: '2020-01-01T00:00:00.000Z',
      maxLines: 20
    })

    expect(result.since).toBe(INSTALLED_AT)
    expect(result.lines.join('\n')).not.toContain('ghp_')
    expect(calls.find((args) => args[0] === 'logcat')).toEqual(expect.arrayContaining([
      '--uid=10123', '-t', `${Math.floor(Date.parse(INSTALLED_AT) / 1000)}.000`, '-m', '20'
    ]))
    expect(calls.filter((args) => args[1] === 'pm' && args[2] === 'list')).toEqual([
      ['shell', 'pm', 'list', 'packages', '-U', '--user', 'current', APP_ID],
      ['shell', 'pm', 'list', 'packages', '-U', '--user', 'current', '--uid', '10123']
    ])
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
  })

  it('invalidates a stale receipt when the package is gone', async () => {
    const { installs, session } = setup(() => ({ code: 1, stdout: '', stderr: 'not installed' }))

    await expect(session.forceStop(APP_ID)).rejects.toMatchObject({ code: 'ANDROID_APP_NOT_INSTALLED' })
    expect(installs.get(
      'aaaa1111',
      { kind: 'emulator', targetId: 'aaaa1111', deviceId: null },
      APP_ID
    )).toBeNull()
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
      changeId: '21111111-2222-4333-8444-555555555555', apkSha256: 'b'.repeat(64), installedAt: INSTALLED_AT
    })
    installs.record({
      roomId: 'bbbb2222', target: secondLease, applicationId: APP_ID,
      changeId: '31111111-2222-4333-8444-555555555555', apkSha256: 'c'.repeat(64), installedAt: INSTALLED_AT
    })

    expect(installs.get('aaaa1111', firstLease, APP_ID)).toBeNull()
    expect(installs.get('bbbb2222', firstLease, APP_ID)).toBeNull()
    expect(installs.get('bbbb2222', secondLease, APP_ID)?.apkSha256).toBe('c'.repeat(64))
  })
})
