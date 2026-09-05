import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import type { AndroidAutomationTarget } from '@devhotel/shared'
import { DeviceLeaseError } from '@devhotel/shared'
import {
  AndroidAutomationSession,
  isPhysicalAcceptanceProofReadCommand,
  isPhysicalAutomationReadCommand,
  parseAndroidUiHierarchy,
  DEFAULT_SCREEN_WITNESS_ACTION_TIMEOUT_MS,
  SCREEN_WITNESS_BOOTSTRAP_ATTEMPTS,
  SCREEN_WITNESS_BOOTSTRAP_RETRY_MS,
  SCREEN_WITNESS_NON_ACTION_BUDGET_MS,
  SCREEN_WITNESS_READY_TIMEOUT_MS,
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
const INSTALL_LOG_FENCE = 'devhotel-install-u0-uid10123-11111111-2222-4333-8444-555555555555'
const SECONDARY_INSTALL_LOG_FENCE = 'devhotel-install-u10-uid1010123-11111111-2222-4333-8444-555555555555'
const INSTALL_USER_SERIAL = 0
const SECONDARY_INSTALL_USER_SERIAL = 42
const SYSTEM_USER_INCARNATION = 'devhotel-system-user-incarnation-v1 user=0 serial=0'
function exclusivePackageDump(
  idField: 'userId' | 'appId',
  userRows: string[] = ['    User 0: ceDataInode=1 installed=true hidden=false stopped=true enabled=0']
): string {
  return [
    'Packages:',
    `  Package [${APP_ID}] (abc123):`,
    `    ${idField}=10123`,
    `    pkg=Package{abc123 ${APP_ID}}`,
    `    codePath=${BASE_APK_PATH}`,
    ...userRows
  ].join('\n')
}

const EXCLUSIVE_PACKAGE_DUMP = exclusivePackageDump('appId')

function isGuardedTap(args: string[]): boolean {
  return args[0] === 'shell' && args[1] === 'sh' && args[2] === '-c' &&
    Boolean(args[3]?.includes('input tap "$x" "$y"'))
}

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
    handler: (
      args: string[],
      witness: {
        emitScreenEvent(tag: string, payload: string): void
        emitScreenMarker(payload: string): void
        emitRawScreenChunk(chunk: string): void
        emitRawScreenStderr(chunk: string): void
      }
    ) => { code: number; stdout: string; stderr: string } | Promise<{ code: number; stdout: string; stderr: string }>,
    timing: Pick<AndroidAutomationSessionOptions, 'now' | 'sleep'> = {},
    targetOverride: AndroidAutomationTarget = target,
    logFence: string | null = INSTALL_LOG_FENCE,
    witnessFixture: {
      splitInitialDivider?: boolean
      readerFailureAfterReadyMs?: number
      readerStartupDelayMs?: number
      dropPreStartBegin?: boolean
    } = {}
  ) {
    const installUserId = Number.parseInt(/^devhotel-install-u(\d+)-/.exec(logFence ?? '')?.[1] ?? '0', 10)
    const installUserSerial = installUserId === 0 ? INSTALL_USER_SERIAL : SECONDARY_INSTALL_USER_SERIAL
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
      logFence,
      installUserId,
      installUserSerial
    })
    const calls: string[][] = []
    const timeouts: Array<number | undefined> = []
    const signals: Array<AbortSignal | undefined> = []
    const stdoutLimits: Array<number | undefined> = []
    const operations: Array<string | undefined> = []
    let witnessBegin: string | null = null
    let witnessReader: {
      onStdout?: (chunk: string | Uint8Array) => void
      onStderr?: (chunk: string | Uint8Array) => void
      resolve(result: { code: number; stdout: string; stderr: string }): void
      reject(error: unknown): void
      signal?: AbortSignal
      abort(): void
    } | null = null
    let witnessBuffer: 'main' | 'events' = 'main'
    let witnessEventsStarted = false
    let witnessRecordCount = 0
    let witnessMaxRecords = 2
    const finishWitness = (): void => {
      if (!witnessReader || witnessRecordCount < witnessMaxRecords) return
      const reader = witnessReader
      witnessReader = null
      reader.signal?.removeEventListener('abort', reader.abort)
      reader.resolve({ code: 0, stdout: '', stderr: '' })
    }
    const emitScreenEvent = (tag: string, payload: string): void => {
      const reader = witnessReader
      if (!reader) return
      const divider = witnessEventsStarted
        ? witnessBuffer === 'events' ? '' : '--------- switch to events\n'
        : '--------- beginning of events\n'
      witnessEventsStarted = true
      witnessBuffer = 'events'
      reader.onStdout?.(`${divider}I/${tag}: ${payload}\n`)
      witnessRecordCount += 1
      finishWitness()
    }
    const emitScreenMarker = (payload: string): void => {
      const reader = witnessReader
      if (!reader) return
      const divider = witnessRecordCount === 0
        ? '--------- beginning of main\n'
        : witnessBuffer === 'events' ? '--------- switch to main\n' : ''
      reader.onStdout?.(`${divider}I/DEVHOTEL_USER_FENCE: ${payload}\n`)
      witnessBuffer = 'main'
      witnessRecordCount += 1
      finishWitness()
    }
    const emitRawScreenChunk = (chunk: string): void => {
      witnessReader?.onStdout?.(chunk)
    }
    const emitRawScreenStderr = (chunk: string): void => {
      witnessReader?.onStderr?.(chunk)
    }
    const session = new AndroidAutomationSession({
      roomId: 'aaaa1111',
      target: targetOverride,
      installTarget: { kind: 'emulator', targetId: 'aaaa1111', deviceId: null },
      installs,
      exec: async (args, opts) => {
        calls.push(args)
        operations.push(opts?.operation)
        timeouts.push(opts?.timeoutMs)
        signals.push(opts?.signal)
        stdoutLimits.push(opts?.maxStdoutBytes)
        if (opts?.signal?.aborted) throw opts.signal.reason
        if (
          witnessFixture.readerStartupDelayMs !== undefined &&
          args[1] === 'sh' &&
          args[3]?.includes('logcat -b main -b events')
        ) {
          await new Promise((resolve) => setTimeout(resolve, witnessFixture.readerStartupDelayMs))
        }
        const handled = handler(args, { emitScreenEvent, emitScreenMarker, emitRawScreenChunk, emitRawScreenStderr })
        // Keep synchronous fake transports synchronous so reader registration
        // faithfully precedes the first bootstrap marker. Individual command
        // fixtures can still return a Promise to model in-flight input.
        const result = handled instanceof Promise ? await handled : handled
        if (opts?.signal?.aborted) throw opts.signal.reason
        if (
          args[0] === 'shell' &&
          args[1] === 'log' &&
          args[5] === 'DEVHOTEL_USER_FENCE'
        ) {
          const marker = args[6] ?? ''
          if (marker.startsWith('devhotel-user-begin-')) {
            witnessBegin = marker
            emitScreenMarker(marker)
          }
          if (marker.startsWith('devhotel-user-end-') && witnessReader) {
            const reader = witnessReader
            if (result.code === 0 && result.stdout.length === 0 && result.stderr.length === 0) {
              const divider = witnessBuffer === 'events' ? '--------- switch to main\n' : ''
              reader.onStdout?.(`${divider}I/DEVHOTEL_USER_FENCE: ${marker}\n`)
              witnessBuffer = 'main'
              witnessRecordCount += 1
            }
            finishWitness()
          }
          return result
        }
        if (
          args[0] === 'shell' &&
          args[1] === 'sh' &&
          args[3]?.includes('for payload in "$@"')
        ) {
          const closeMarkers = args.slice(6)
          if (closeMarkers[0]?.startsWith('devhotel-user-end-') && witnessReader) {
            const reader = witnessReader
            if (result.code === 0 && result.stdout.length === 0 && result.stderr.length === 0) {
              for (const marker of closeMarkers) {
                if (!witnessReader || witnessRecordCount >= witnessMaxRecords) break
                const divider = witnessBuffer === 'events' ? '--------- switch to main\n' : ''
                reader.onStdout?.(`${divider}I/DEVHOTEL_USER_FENCE: ${marker}\n`)
                witnessBuffer = 'main'
                witnessRecordCount += 1
              }
            }
            finishWitness()
          }
          return result
        }
        if (
          args[0] === 'shell' &&
          args[1] === 'sh' &&
          args[3]?.includes('logcat -b main -b events')
        ) {
          if (result.stdout) opts?.onStdout?.(result.stdout)
          if (result.stderr) opts?.onStderr?.(result.stderr)
          if (result.code !== 0 || result.stdout.length > 0 || result.stderr.length > 0) {
            return result
          }
          witnessBuffer = 'main'
          witnessEventsStarted = false
          witnessRecordCount = 0
          witnessMaxRecords = Number.parseInt(args.at(-1) ?? '2', 10)
          return new Promise((resolve, reject) => {
            const reader = {
              onStdout: opts?.onStdout,
              onStderr: opts?.onStderr,
              resolve,
              reject,
              signal: opts?.signal,
              abort: () => undefined
            }
            reader.abort = () => {
              if (witnessReader !== reader) return
              witnessReader = null
              reader.signal?.removeEventListener('abort', reader.abort)
              reject(reader.signal?.reason ?? new Error('fake witness reader aborted'))
            }
            witnessReader = reader
            if (reader.signal?.aborted) reader.abort()
            else reader.signal?.addEventListener('abort', reader.abort, { once: true })
            if (witnessBegin && !witnessFixture.dropPreStartBegin) {
              if (witnessFixture.splitInitialDivider) {
                opts?.onStdout?.('--------- beginning of main\n')
                opts?.onStdout?.(`I/DEVHOTEL_USER_FENCE: ${witnessBegin}\n`)
                witnessRecordCount += 1
              } else {
                emitScreenMarker(witnessBegin)
              }
            }
            if (witnessFixture.readerFailureAfterReadyMs !== undefined) {
              const timer = setTimeout(() => {
                if (witnessReader !== reader) return
                witnessReader = null
                reader.signal?.removeEventListener('abort', reader.abort)
                reject(new Error('fake reader transport timed out'))
              }, witnessFixture.readerFailureAfterReadyMs)
              timer.unref?.()
            }
          })
        }
        if (
          args[1] === 'am' &&
          args[2] === 'get-current-user' &&
          result.code === 0 &&
          !result.stdout.trim()
        ) {
          return { code: 0, stdout: `${installUserId}\n`, stderr: '' }
        }
        if (
          args[1] === 'dumpsys' &&
          args[2] === 'user' &&
          args[3] === '--user' &&
          !result.stdout.startsWith(' UserInfo{')
        ) {
          const userId = args[4]!
          return {
            code: 0,
            stdout: ` UserInfo{${userId}:DevHotel:13} serialNo=${installUserSerial} isPrimary=${userId === '0'}\n Type: android.os.usertype.full.SECONDARY\n`,
            stderr: ''
          }
        }
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
        if (args[1] === 'pgrep' && result.code === 0 && result.stdout.length === 0 && result.stderr.length === 0) {
          return { code: 1, stdout: '', stderr: '' }
        }
        return result
      },
      ...timing
    })
    return { db, installs, calls, operations, session, signals, stdoutLimits, timeouts }
  }

  it.each([
    { apiLevel: 31, androidVersion: '12.0', idField: 'userId' as const, uid: 10123, userId: 0 },
    { apiLevel: 33, androidVersion: '13.0', idField: 'userId' as const, uid: 10123, userId: 0 },
    { apiLevel: 34, androidVersion: '14.0', idField: 'appId' as const, uid: 10123, userId: 0 },
    { apiLevel: 35, androidVersion: '15.0', idField: 'appId' as const, uid: 1_010_123, userId: 10 }
  ])('seals install identity and a unique app-UID log fence on API $apiLevel', async ({
    apiLevel,
    androidVersion,
    idField,
    uid,
    userId
  }) => {
    let emittedFence = ''
    const { calls, operations, session } = setup((args) => {
      if (args[1] === 'am' && args[2] === 'get-current-user') return { code: 0, stdout: `${userId}\n`, stderr: '' }
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'sh' && args[3]?.startsWith('dumpsys package "$1"')) {
        return {
          code: 0,
          stdout: `${exclusivePackageDump(idField)}\n\n${args.at(-1)}\n`,
          stderr: ''
        }
      }
      if (args[1] === 'pm' && args.includes('--uid')) return { code: 0, stdout: `package:${APP_ID} uid:${uid}\n`, stderr: '' }
      if (args[1] === 'pm' && args[2] === 'list') return { code: 0, stdout: `package:${APP_ID} uid:${uid}\n`, stderr: '' }
      if (args[1] === 'run-as') {
        emittedFence = args.at(-1)!
        return { code: 0, stdout: '', stderr: '' }
      }
      if (args[0] === 'logcat') return { code: 0, stdout: `${emittedFence}\n`, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }, {}, { ...target, apiLevel, androidVersion }, userId === 0 ? INSTALL_LOG_FENCE : SECONDARY_INSTALL_LOG_FENCE)

    const evidence = await session.establishInstallEvidence(APP_ID)
    expect(evidence).toEqual({
      apkSha256: 'a'.repeat(64),
      packageIncarnation: PACKAGE_INCARNATION,
      installUserId: userId,
      installUserSerial: userId === 0 ? INSTALL_USER_SERIAL : SECONDARY_INSTALL_USER_SERIAL,
      logFence: emittedFence
    })
    expect(calls.some((args) => args[1] === 'dumpsys' && args[2] === 'user')).toBe(userId !== 0)
    expect(isPhysicalAcceptanceProofReadCommand(
      ['shell', 'dumpsys', 'user', '--user', '0'],
      'Android user incarnation probe'
    )).toBe(false)
    if (userId !== 0) {
      expect(isPhysicalAcceptanceProofReadCommand(
        ['shell', 'dumpsys', 'user', '--user', String(userId)],
        'Android user incarnation probe'
      )).toBe(true)
    }
    expect(emittedFence).toMatch(new RegExp(`^devhotel-install-u${userId}-uid${uid}-[0-9a-f-]{36}$`))
    expect(calls.find((args) => args[1] === 'run-as')).toEqual([
      'shell', 'run-as', APP_ID, '--user', String(userId),
      'log', '-p', 'i', '-t', 'DEVHOTEL_INSTALL_FENCE', emittedFence
    ])
    expect(calls.find((args) => args[0] === 'logcat')).toEqual([
      'logcat', '-d', '-v', 'raw,printable', `--uid=${uid}`
    ])
    const proofIndex = operations.indexOf('Android install log fence proof')
    const proofArgs = calls[proofIndex]!
    expect(isPhysicalAutomationReadCommand(proofArgs, operations[proofIndex])).toBe(true)
    expect(isPhysicalAutomationReadCommand(
      [...proofArgs, '--unexpected'],
      operations[proofIndex]
    )).toBe(false)
  })

  it('rejects install evidence when the active Android user changes during proof', async () => {
    let markerRead = false
    let emittedFence = ''
    const { session } = setup((args) => {
      if (args[1] === 'am' && args[2] === 'get-current-user') {
        return { code: 0, stdout: `${markerRead ? 10 : 0}\n`, stderr: '' }
      }
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'pm' && args.includes('--uid')) return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'pm' && args[2] === 'list') return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'run-as') {
        emittedFence = args.at(-1)!
        return { code: 0, stdout: '', stderr: '' }
      }
      if (args[0] === 'logcat') {
        markerRead = true
        return { code: 0, stdout: `${emittedFence}\n`, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.establishInstallEvidence(APP_ID)).rejects.toMatchObject({
      code: 'ANDROID_APP_USER_CHANGED'
    })
  })

  it('rejects install evidence when the numeric user ID is recycled during proof', async () => {
    let markerRead = false
    let emittedFence = ''
    const { session } = setup((args) => {
      if (args[1] === 'dumpsys' && args[2] === 'user') {
        return {
          code: 0,
          stdout: ` UserInfo{10:Work:13} serialNo=${markerRead ? SECONDARY_INSTALL_USER_SERIAL + 1 : SECONDARY_INSTALL_USER_SERIAL} isPrimary=false\n`,
          stderr: ''
        }
      }
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'pm' && args.includes('--uid')) return { code: 0, stdout: `package:${APP_ID} uid:1010123\n`, stderr: '' }
      if (args[1] === 'pm' && args[2] === 'list') return { code: 0, stdout: `package:${APP_ID} uid:1010123\n`, stderr: '' }
      if (args[1] === 'run-as') {
        emittedFence = args.at(-1)!
        return { code: 0, stdout: '', stderr: '' }
      }
      if (args[0] === 'logcat') {
        markerRead = true
        return { code: 0, stdout: `${emittedFence}\n`, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    }, {}, target, SECONDARY_INSTALL_LOG_FENCE)

    await expect(session.establishInstallEvidence(APP_ID)).rejects.toMatchObject({
      code: 'ANDROID_APP_USER_CHANGED'
    })
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
      installUserId: 0,
      installUserSerial: INSTALL_USER_SERIAL,
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
      installUserId: 0,
      installUserSerial: INSTALL_USER_SERIAL,
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
    expect(calls.map((args) => args[1] === 'pm' && args.includes('--uid')).lastIndexOf(true)).toBeLessThan(
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
      installUserId: 0,
      installUserSerial: INSTALL_USER_SERIAL,
      logFence: null
    })
    expect(calls.some((args) => args[1] === 'run-as' || args[0] === 'logcat')).toBe(false)
  })

  it('launches with typed argv and never constructs a shell command from extras', async () => {
    const { calls, session } = setup((args) => {
      if (args[1] === 'am' && args[2] === 'get-current-user') return { code: 0, stdout: '0\n', stderr: '' }
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: 'package:/data/app/base.apk\n', stderr: '' }
      if (args[1] === 'stat') return { code: 0, stdout: `${BASE_APK_STAT}\n`, stderr: '' }
      if (args[1] === 'sha256sum') return { code: 0, stdout: `${'a'.repeat(64)}  /data/app/base.apk\n`, stderr: '' }
      if (args[1] === 'cmd') return { code: 0, stdout: `${APP_ID}/.MainActivity\n`, stderr: '' }
      if (args[1] === 'sh' && args[3]?.includes('dumpsys window')) {
        return { code: 0, stdout: `mCurrentFocus=Window{1 u0 ${APP_ID}/.MainActivity}\n`, stderr: '' }
      }
      return { code: 0, stdout: 'Status: ok\n', stderr: '' }
    })

    const result = await session.launch(APP_ID, undefined, { label: 'A $HOME; id', retries: 2, enabled: true })

    expect(result.component).toBe(`${APP_ID}/.MainActivity`)
    expect(calls.find((args) => args[1] === 'am' && args[2] === 'start')).toEqual([
      'shell', 'am', 'start', '-W', '--user', '0', '-n', `${APP_ID}/.MainActivity`,
      '--es', 'label', 'A $HOME; id', '--ei', 'retries', '2', '--ez', 'enabled', 'true'
    ])
    expect(calls.find((args) => args[1] === 'am' && args[2] === 'start')?.[2]).toBe('start')
  })

  it('rejects a NUL string extra before invoking an Android launch command', async () => {
    const { calls, session } = setup((args) => {
      if (args[1] === 'am' && args[2] === 'get-current-user') return { code: 0, stdout: '0\n', stderr: '' }
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
      if (args[1] === 'am' && args[2] === 'get-current-user') return { code: 0, stdout: '0\n', stderr: '' }
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: 'package:/data/app/base.apk\n', stderr: '' }
      if (args[1] === 'sha256sum') return { code: 0, stdout: `${'a'.repeat(64)}  /data/app/base.apk\n`, stderr: '' }
      if (args[1] === 'sh' && args[3]?.includes('dumpsys window')) {
        return { code: 0, stdout: `mCurrentFocus=Window{1 u0 ${APP_ID}/com.vendor.auth.LoginActivity}\n`, stderr: '' }
      }
      return { code: 0, stdout: 'Status: ok\n', stderr: '' }
    })

    const result = await session.launch(APP_ID, 'com.vendor.auth.LoginActivity')

    expect(result.component).toBe(`${APP_ID}/com.vendor.auth.LoginActivity`)
    expect(calls.find((args) => args[1] === 'am' && args[2] === 'start')).toEqual([
      'shell', 'am', 'start', '-W', '--user', '0', '-n',
      `${APP_ID}/com.vendor.auth.LoginActivity`
    ])
  })

  it('returns only bounded redacted evidence when a launch command fails', async () => {
    const secret = `ghp_${'A'.repeat(24)}`
    const { session } = setup((args) => {
      if (args[1] === 'am' && args[2] === 'get-current-user') return { code: 0, stdout: '0\n', stderr: '' }
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: 'package:/data/app/base.apk\n', stderr: '' }
      if (args[1] === 'stat') return { code: 0, stdout: `${BASE_APK_STAT}\n`, stderr: '' }
      if (args[1] === 'sha256sum') return { code: 0, stdout: `${'a'.repeat(64)}  /data/app/base.apk\n`, stderr: '' }
      if (args[1] === 'cmd') return { code: 0, stdout: `${APP_ID}/.MainActivity\n`, stderr: '' }
      if (args[1] === 'sh' && args[3]?.includes('dumpsys window')) {
        return { code: 0, stdout: `mCurrentFocus=Window{1 u0 ${APP_ID}/.MainActivity}\n`, stderr: '' }
      }
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

  it('rejects a dispatched launch that redirects away from the tracked package', async () => {
    const { session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'cmd') return { code: 0, stdout: `${APP_ID}/.MainActivity\n`, stderr: '' }
      if (args[1] === 'am' && args[2] === 'start') return { code: 0, stdout: 'Status: ok\n', stderr: '' }
      if (args[1] === 'sh' && args[3]?.includes('dumpsys window')) {
        return { code: 0, stdout: 'mCurrentFocus=Window{1 u0 com.other.app/.PrivateActivity}\n', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.launch(APP_ID)).rejects.toMatchObject({ code: 'ANDROID_APP_NOT_FOREGROUND' })
  })

  it.each([
    {
      state: 'tracked mFocusedApp behind a SystemUI current-focus window',
      stdout: `mFocusedApp=AppWindowToken{1 token=Token{2 ActivityRecord{3 u0 ${APP_ID}/.MainActivity}}}\n` +
        'mCurrentFocus=Window{4 u0 com.android.systemui/.SystemUI}\n',
      code: 'ANDROID_APP_NOT_FOREGROUND'
    },
    {
      state: 'mFocusedApp without any current-focus window',
      stdout: `mFocusedApp=AppWindowToken{1 token=Token{2 ActivityRecord{3 u0 ${APP_ID}/.MainActivity}}}\n`,
      code: 'ANDROID_FOREGROUND_UNKNOWN'
    }
  ])('never treats $state as launch foreground authority', async ({ stdout, code }) => {
    const { session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'cmd') return { code: 0, stdout: `${APP_ID}/.MainActivity\n`, stderr: '' }
      if (args[1] === 'am' && args[2] === 'start') return { code: 0, stdout: 'Status: ok\n', stderr: '' }
      if (args[1] === 'sh' && args[3]?.includes('dumpsys window')) return { code: 0, stdout, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.launch(APP_ID)).rejects.toMatchObject({ code })
  })

  it('prioritizes package replacement over launch failure evidence from the replacement', async () => {
    const replacementStat = '103:5252:123456:1788157200:1788157300'
    let replaced = false
    const { installs, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'stat') return { code: 0, stdout: `${replaced ? replacementStat : BASE_APK_STAT}\n`, stderr: '' }
      if (args[1] === 'cmd') return { code: 0, stdout: `${APP_ID}/.MainActivity\n`, stderr: '' }
      if (args[1] === 'am' && args[2] === 'start') {
        replaced = true
        return { code: 1, stdout: 'replacement-private-output\n', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await session.launch(APP_ID).catch((error: unknown) => {
      expect(error).toMatchObject({ code: 'ANDROID_APP_REPLACED' })
      expect(JSON.stringify(error)).not.toContain('replacement-private-output')
    })
    expect(installs.get(
      'aaaa1111',
      { kind: 'emulator', targetId: 'aaaa1111', deviceId: null },
      APP_ID
    )).toBeNull()
  })

  it('fails a successful force-stop closed when the package is replaced during the action', async () => {
    const replacementStat = '103:5252:123456:1788157200:1788157300'
    let replaced = false
    const { session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'pm' && args[2] === 'list') return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'stat') return { code: 0, stdout: `${replaced ? replacementStat : BASE_APK_STAT}\n`, stderr: '' }
      if (args[1] === 'am' && args[2] === 'force-stop') {
        replaced = true
        return { code: 0, stdout: 'Force stopped\n', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.forceStop(APP_ID)).rejects.toMatchObject({ code: 'ANDROID_APP_REPLACED' })
  })

  it('withholds force-stop success when the active user changes during the action', async () => {
    let switched = false
    const { installs, session } = setup((args) => {
      if (args[1] === 'am' && args[2] === 'get-current-user') {
        return { code: 0, stdout: `${switched ? 10 : 0}\n`, stderr: '' }
      }
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'pm' && args[2] === 'list') return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'am' && args[2] === 'force-stop') {
        switched = true
        return { code: 0, stdout: 'Force stopped\n', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.forceStop(APP_ID)).rejects.toMatchObject({ code: 'ANDROID_APP_USER_CHANGED' })
    expect(installs.get(
      'aaaa1111',
      { kind: 'emulator', targetId: 'aaaa1111', deviceId: null },
      APP_ID
    )).not.toBeNull()
  })

  it('returns force-stop success only after exact-user foreground absence and the package stopped bit are proven', async () => {
    const { calls, operations, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'sh' && args[3]?.includes('dumpsys window')) {
        return { code: 0, stdout: 'mCurrentFocus=Window{1 u0 com.android.launcher/.Launcher}\n', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.forceStop(APP_ID)).resolves.toMatchObject({ applicationId: APP_ID })
    const proofIndex = operations.indexOf('Android force-stop state proof')
    const proofArgs = calls[proofIndex]!
    expect(isPhysicalAutomationReadCommand(proofArgs, operations[proofIndex])).toBe(true)
    expect(isPhysicalAutomationReadCommand(
      [...proofArgs.slice(0, 6), proofArgs[6]!.replace('devhotel-force-stop-', 'devhotel-force-stop-0')],
      operations[proofIndex]
    )).toBe(false)
  })

  it('accepts a proven stopped package when the screen has no current-focus window', async () => {
    const { session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'sh' && args[3]?.includes('dumpsys window')) {
        return { code: 0, stdout: 'mCurrentFocus=null\n', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.forceStop(APP_ID)).resolves.toMatchObject({ applicationId: APP_ID })
  })

  it('rejects a background relaunch between foreground absence and the final stopped-state proof', async () => {
    let stoppedProofs = 0
    const { session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'sh' && args[3]?.startsWith('dumpsys package "$1"')) {
        stoppedProofs += 1
        const stopped = stoppedProofs === 1
        return {
          code: 0,
          stdout: `${exclusivePackageDump('appId', [
            `    User 0: installed=true hidden=false stopped=${stopped} enabled=0`
          ])}\n\n${args.at(-1)}\n`,
          stderr: ''
        }
      }
      if (args[1] === 'sh' && args[3] === 'exec dumpsys window displays') {
        return { code: 0, stdout: 'mCurrentFocus=Window{1 u0 com.android.launcher/.Launcher}\n', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.forceStop(APP_ID)).rejects.toMatchObject({ code: 'ANDROID_FORCE_STOP_FAILED' })
    expect(stoppedProofs).toBe(2)
  })

  it.each([
    { probe: 'nonzero', result: { code: 1, stdout: 'mCurrentFocus=null\n', stderr: '' } },
    { probe: 'stderr', result: { code: 0, stdout: 'mCurrentFocus=null\n', stderr: 'window probe warning' } },
    { probe: 'missing', result: { code: 0, stdout: '', stderr: '' } },
    { probe: 'duplicate', result: { code: 0, stdout: 'mCurrentFocus=null\nmCurrentFocus=null\n', stderr: '' } },
    { probe: 'malformed', result: { code: 0, stdout: 'mCurrentFocus=Window{broken}\n', stderr: '' } },
    {
      probe: 'output-limit',
      result: { code: 0, stdout: 'mCurrentFocus=null\n', stderr: '', outputLimitExceeded: true }
    }
  ])('rejects force-stop success when the foreground probe is $probe', async ({ result }) => {
    const { calls, session, stdoutLimits } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'sh' && args[3]?.includes('dumpsys window')) return result
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.forceStop(APP_ID)).rejects.toMatchObject({ code: 'ANDROID_FORCE_STOP_FAILED' })
    const foregroundProbeIndex = calls.findIndex((args) => args[1] === 'sh' && args[3]?.includes('dumpsys window'))
    expect(calls[foregroundProbeIndex]).toEqual(['shell', 'sh', '-c', 'exec dumpsys window displays'])
    expect(stdoutLimits[foregroundProbeIndex]).toBe(1024 * 1024)
  })

  it('asks the one dumpsys section that still carries the focus line on API 34', async () => {
    // Observed on a live Android 14 (API 34) managed emulator: `dumpsys window
    // windows` stops at 32000 bytes, before `mCurrentFocus=`, so a visibly
    // foreground app reported as "no window has focus" and every launch failed.
    // `dumpsys window displays` carries exactly one focus line at a quarter the size.
    const sections: string[] = []
    const { session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'sh' && args[3]?.includes('dumpsys window')) {
        sections.push(args[3])
        // What the truncated `windows` section actually returns on API 34.
        if (args[3].includes('window windows')) return { code: 0, stdout: 'x'.repeat(32_000), stderr: '' }
        return {
          code: 0,
          stdout: `  mCurrentFocus=Window{7cf796c u0 ${APP_ID}/com.purpleship.appdied.MainActivity}\n`,
          stderr: ''
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await session.forceStop(APP_ID).catch(() => undefined)

    expect(sections).not.toHaveLength(0)
    for (const section of sections) {
      expect(section).toBe('exec dumpsys window displays')
      expect(section).not.toContain('window windows')
    }
  })

  it('rejects a second focus record after a first record that filled the old guest-side cap', async () => {
    const suffix = ' u0 com.android.launcher/.Launcher}'
    const prefix = 'mCurrentFocus=Window{'
    const padding = 'x'.repeat(2048 - Buffer.byteLength(`${prefix}${suffix}\n`, 'utf8'))
    const first = `${prefix}${padding}${suffix}`
    expect(Buffer.byteLength(`${first}\n`, 'utf8')).toBe(2048)
    const { session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'sh' && args[3] === 'exec dumpsys window displays') {
        return { code: 0, stdout: `${first}\nmCurrentFocus=null\n`, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.forceStop(APP_ID)).rejects.toMatchObject({ code: 'ANDROID_FORCE_STOP_FAILED' })
  })

  it('maps an oversized full foreground dump to unknown without exposing partial output', async () => {
    const { session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'sh' && args[3] === 'exec dumpsys window displays') {
        return { code: 0, stdout: 'x'.repeat((1024 * 1024) + 1), stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.forceStop(APP_ID)).rejects.toMatchObject({
      code: 'ANDROID_FORCE_STOP_FAILED',
      evidence: { stdout: '' }
    })
  })

  it.each([
    { state: 'package stopped bit remains false', stopped: false, foregroundRemains: false },
    { state: 'foreground remains', stopped: true, foregroundRemains: true }
  ])('rejects code-zero force-stop when the $state', async ({ stopped, foregroundRemains }) => {
    const { session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'sh' && args[3]?.startsWith('dumpsys package "$1"')) {
        return {
          code: 0,
          stdout: `${exclusivePackageDump('appId', [
            `    User 0: installed=true hidden=false stopped=${stopped} enabled=0`
          ])}\n\n${args.at(-1)}\n`,
          stderr: ''
        }
      }
      if (args[1] === 'sh' && args[3]?.includes('dumpsys window')) {
        return {
          code: 0,
          stdout: foregroundRemains
            ? `mCurrentFocus=Window{1 u0 ${APP_ID}/.MainActivity}\n`
            : 'mCurrentFocus=Window{1 u0 com.android.launcher/.Launcher}\n',
          stderr: ''
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    }, { sleep: async () => undefined })

    await expect(session.forceStop(APP_ID)).rejects.toMatchObject({ code: 'ANDROID_FORCE_STOP_FAILED' })
  })

  it('supports API 30 and a declared shared UID without treating sibling processes as package state', async () => {
    const api30 = { ...target, androidVersion: '11.0', apiLevel: 30 }
    const { calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'sh' && args[3]?.startsWith('dumpsys package "$1"')) {
        const dump = exclusivePackageDump('userId').replace(
          '    pkg=',
          '    sharedUser=SharedUserSetting{legacy.shared/10123}\n    pkg='
        )
        return { code: 0, stdout: `${dump}\n\n${args.at(-1)}\n`, stderr: '' }
      }
      if (args[1] === 'pgrep') return { code: 0, stdout: '1234\n5678\n', stderr: '' }
      if (args[1] === 'sh' && args[3]?.includes('dumpsys window')) {
        return { code: 0, stdout: 'mCurrentFocus=Window{1 u0 com.android.launcher/.Launcher}\n', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    }, {}, api30)

    await expect(session.forceStop(APP_ID)).resolves.toMatchObject({ applicationId: APP_ID })
    expect(calls.some((args) => args[1] === 'pgrep' || args[1] === 'pm' && args.includes('--uid'))).toBe(false)
  })

  it.each([
    { label: 'missing', rows: [] as string[], code: 0, stderr: '', oversized: false },
    { label: 'duplicate', rows: ['    User 0: installed=true stopped=true', '    User 0: installed=true stopped=true'], code: 0, stderr: '', oversized: false },
    { label: 'wrong user', rows: ['    User 10: installed=true stopped=true'], code: 0, stderr: '', oversized: false },
    { label: 'nonzero', rows: ['    User 0: installed=true stopped=true'], code: 1, stderr: '', oversized: false },
    { label: 'stderr', rows: ['    User 0: installed=true stopped=true'], code: 0, stderr: 'private warning', oversized: false },
    { label: 'truncated', rows: ['    User 0: installed=true stopped=true'], code: 0, stderr: '', oversized: true }
  ])('fails force-stop closed on a $label package-state proof', async ({ rows, code, stderr, oversized }) => {
    const { session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'sh' && args[3]?.startsWith('dumpsys package "$1"')) {
        return {
          code,
          stdout: oversized
            ? 'x'.repeat(1024 * 1024 + 1)
            : `${exclusivePackageDump('appId', rows)}\n\n${args.at(-1)}\n`,
          stderr
        }
      }
      if (args[1] === 'sh' && args[3]?.includes('dumpsys window')) {
        return { code: 0, stdout: 'mCurrentFocus=Window{1 u0 com.android.launcher/.Launcher}\n', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.forceStop(APP_ID)).rejects.toMatchObject({ code: 'ANDROID_FORCE_STOP_FAILED' })
  })

  it('streams a screen witness into Host memory and reveals its end marker only after the action', async () => {
    const { calls, session } = setup(() => ({ code: 0, stdout: '', stderr: '' }))
    let actionAt = -1

    const value = await session.withActiveUserScreenWitness(async () => {
      actionAt = calls.length
      return 'captured'
    })

    expect(value).toBe('captured')
    const beginIndex = calls.findIndex((args) => args[1] === 'log' && args.at(-1)?.startsWith('devhotel-user-begin-'))
    const readerIndex = calls.findIndex((args) => args[1] === 'sh' && args[3]?.includes('DEVHOTEL_USER_FENCE:I'))
    const endIndex = calls.findIndex((args) =>
      args[1] === 'sh' && args.some((value) => value.startsWith('devhotel-user-end-'))
    )
    expect(beginIndex).toBeGreaterThanOrEqual(0)
    expect(readerIndex).toBeLessThan(beginIndex)
    expect(readerIndex).toBeLessThan(actionAt)
    expect(endIndex).toBeGreaterThanOrEqual(actionAt)
    expect(calls[readerIndex]?.[3]).toContain('-D -v tag,printable')
    expect(calls[readerIndex]?.[3]).toMatch(/^exec logcat /)
    expect(calls[readerIndex]?.[3]).not.toMatch(/mkfifo|\/data\/local\/tmp|\|/)
    expect(calls[readerIndex]?.[3]).toContain('am_switch_user:V')
    expect(calls[readerIndex]?.[3]).toContain('wm_resume_activity:V')
    const syntax = spawnSync('sh', ['-n', '-c', calls[readerIndex]?.[3] ?? ''], {
      encoding: 'utf8',
      windowsHide: true
    })
    expect({ status: syntax.status, stderr: syntax.stderr }).toEqual({ status: 0, stderr: '' })
    expect(Number(calls[readerIndex]?.at(-1))).toBeGreaterThan(2)
    expect(calls.some((args) => args.some((value) => value.includes('/data/local/tmp')))).toBe(false)
  })

  it('does not miss cancellation between a pause precheck and listener registration', async () => {
    const reason = new Error('screen witness was cancelled during pause setup')
    let abortedReads = 0
    const signal = {
      get aborted() {
        abortedReads += 1
        return abortedReads >= 2
      },
      reason,
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    } as unknown as AbortSignal
    const { calls, session } = setup(
      () => ({ code: 0, stdout: '', stderr: '' }),
      { sleep: () => new Promise(() => undefined) }
    )
    const pauseWithSignal = (session as unknown as {
      pauseWithSignal(ms: number, signal: AbortSignal): Promise<void>
    }).pauseWithSignal.bind(session)

    await expect(pauseWithSignal(60_000, signal)).rejects.toBe(reason)
    expect(abortedReads).toBeGreaterThanOrEqual(2)
    expect(calls).toEqual([])
  })

  it('preserves an exact lease error when its command deadline expires concurrently', async () => {
    const leaseError = new DeviceLeaseError('lease-expired', 'exact physical lease expired')
    let clockReads = 0
    const { session } = setup(
      () => { throw leaseError },
      { now: () => clockReads++ === 0 ? 0 : 100 }
    )
    const command = (session as unknown as {
      command(args: string[], opts: {
        deadline: { at: number; applicationId: string }
        operation: string
      }): Promise<unknown>
    }).command.bind(session)

    await expect(command(['shell', 'get-state'], {
      deadline: { at: 50, applicationId: APP_ID },
      operation: 'deadline and lease precedence probe'
    })).rejects.toBe(leaseError)
  })

  it('returns the original action error only after an exact screen witness closes', async () => {
    const { session } = setup(() => ({ code: 0, stdout: '', stderr: '' }))
    const original = new Error('bounded capture failed')

    let captured: unknown
    try {
      await session.withActiveUserScreenWitness(async () => { throw original })
    } catch (error) {
      captured = error
    }
    expect(captured).toBe(original)
  })

  it('accepts a divider/record chunk split while the live reader is becoming ready', async () => {
    const { session } = setup(
      () => ({ code: 0, stdout: '', stderr: '' }),
      {},
      target,
      INSTALL_LOG_FENCE,
      { splitInitialDivider: true }
    )

    await expect(session.withActiveUserScreenWitness(async () => 'split-ok')).resolves.toBe('split-ok')
  })

  it('never starts an action when one bootstrap chunk already contains a forbidden transition', async () => {
    let actions = 0
    const { session } = setup((args, witness) => {
      if (args[1] === 'log' && args.at(-1)?.startsWith('devhotel-user-begin-')) {
        witness.emitRawScreenChunk([
          '--------- beginning of main',
          `I/DEVHOTEL_USER_FENCE: ${args.at(-1)}`,
          '--------- beginning of events',
          'I/input_focus: Window{private-system-overlay},reason=UpdateInputWindows',
          ''
        ].join('\n'))
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.withActiveUserScreenWitness(async () => {
      actions += 1
      return 'must-not-run'
    })).rejects.toMatchObject({ code: 'ANDROID_SCREEN_WITNESS_FAILED' })
    expect(actions).toBe(0)
  })

  it('never starts an action when its observed begin marker is beyond the bootstrap record budget', async () => {
    let actions = 0
    const { session } = setup((args, witness) => {
      if (args[1] === 'log' && args.at(-1)?.startsWith('devhotel-user-begin-')) {
        witness.emitRawScreenChunk([
          '--------- beginning of main',
          ...Array.from({ length: 8 }, (_, index) => `I/DEVHOTEL_USER_FENCE: stale-${index}`),
          `I/DEVHOTEL_USER_FENCE: ${args.at(-1)}`,
          ''
        ].join('\n'))
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.withActiveUserScreenWitness(async () => {
      actions += 1
      return 'must-not-run'
    })).rejects.toMatchObject({ code: 'ANDROID_SCREEN_WITNESS_FAILED' })
    expect(actions).toBe(0)
  })

  it('observes a fresh marker on one live reader after slow startup displaced every pre-start marker', async () => {
    let actions = 0
    const { calls, session } = setup(
      () => ({ code: 0, stdout: '', stderr: '' }),
      {},
      target,
      INSTALL_LOG_FENCE,
      { readerStartupDelayMs: 1_100, dropPreStartBegin: true }
    )

    await expect(session.withActiveUserScreenWitness(async () => {
      actions += 1
      return 'retry-ok'
    })).resolves.toBe('retry-ok')
    expect(actions).toBe(1)
    expect(calls.filter((args) => args[1] === 'sh' && args[3]?.includes('logcat -b main -b events')))
      .toHaveLength(1)
    expect(calls.filter((args) => args[1] === 'log' && args.at(-1)?.startsWith('devhotel-user-begin-')).length)
      .toBeGreaterThan(1)
  })

  it('aborts and awaits the live reader when close markers fail before an end record exists', async () => {
    const started = Date.now()
    const { calls, session, signals } = setup((args) =>
      args[1] === 'sh' && args[3]?.includes('for payload in "$@"')
        ? { code: 1, stdout: '', stderr: 'marker unavailable' }
        : { code: 0, stdout: '', stderr: '' }
    )

    await expect(session.withActiveUserScreenWitness(async () => 'withheld')).rejects.toMatchObject({
      code: 'ANDROID_SCREEN_WITNESS_FAILED'
    })
    const readerIndex = calls.findIndex((args) => args[1] === 'sh' && args[3]?.includes('logcat -b main -b events'))
    expect(signals[readerIndex]?.aborted).toBe(true)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('derives the reader lifetime from the declared action window plus setup and close budgets', async () => {
    const { calls, session, timeouts } = setup(() => ({ code: 0, stdout: '', stderr: '' }))

    await session.withActiveUserScreenWitness(async () => 'slow-boundary', { actionTimeoutMs: 70_000 })

    const readerIndex = calls.findIndex((args) => args[1] === 'sh' && args[3]?.includes('logcat -b main -b events'))
    expect(timeouts[readerIndex]).toBe(160_000)
  })

  it('aborts an action-aware never-ending callback and awaits reader cleanup at its declared deadline', async () => {
    const started = Date.now()
    const { calls, session, signals } = setup(() => ({ code: 0, stdout: '', stderr: '' }))
    let actionAborted = false

    await expect(session.withActiveUserScreenWitness(
      (signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          actionAborted = true
          reject(signal.reason)
        }, { once: true })
      }),
      { actionTimeoutMs: 20 }
    )).rejects.toMatchObject({ code: 'ANDROID_SCREEN_WITNESS_FAILED' })

    const readerIndex = calls.findIndex((args) => args[1] === 'sh' && args[3]?.includes('logcat -b main -b events'))
    expect(actionAborted).toBe(true)
    expect(signals[readerIndex]?.aborted).toBe(true)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('aborts an action-aware callback when the live reader transport exits first', async () => {
    const { session } = setup(
      () => ({ code: 0, stdout: '', stderr: '' }),
      {},
      target,
      INSTALL_LOG_FENCE,
      { readerFailureAfterReadyMs: 20 }
    )
    let actionAborted = false

    await expect(session.withActiveUserScreenWitness((signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          actionAborted = true
          reject(signal.reason)
        }, { once: true })
      })
    )).rejects.toMatchObject({ code: 'ANDROID_SCREEN_WITNESS_FAILED' })
    expect(actionAborted).toBe(true)
  })

  it('allows a fenced emulator helper more than one second to start its live reader', async () => {
    const { session } = setup(
      () => ({ code: 0, stdout: '', stderr: '' }),
      {},
      target,
      INSTALL_LOG_FENCE,
      { readerStartupDelayMs: 1_100 }
    )

    await expect(session.withActiveUserScreenWitness(async () => 'ready')).resolves.toBe('ready')
  })

  it('prioritizes a foreground-transition witness failure over private action errors', async () => {
    let emitScreenEvent: (tag: string, payload: string) => void = () => undefined
    const { session } = setup((_args, witness) => {
      emitScreenEvent = witness.emitScreenEvent
      return { code: 0, stdout: '', stderr: '' }
    })

    let captured: unknown
    try {
      await session.withActiveUserScreenWitness(async () => {
        emitScreenEvent('wm_set_resumed_activity', '[0,com.other.app/.PrivateActivity,topResumed]')
        throw new Error('private-cross-app-capture-error')
      })
    } catch (error) {
      captured = error
    }
    expect(captured).toMatchObject({ code: 'ANDROID_SCREEN_WITNESS_FAILED' })
    expect(JSON.stringify(captured)).not.toContain('private-cross-app-capture-error')
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
    expect(calls.some(isGuardedTap)).toBe(false)
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
    expect(calls.some(isGuardedTap)).toBe(false)
  })

  it('refuses coordinates that move while the tap witness is bootstrapping', async () => {
    let screenReaders = 0
    const { calls, session } = setup((args) => {
      if (args[1] === 'sh' && args[3]?.includes('logcat -b main -b events')) screenReaders += 1
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'sh' && args[3]?.includes('dumpsys window')) {
        return { code: 0, stdout: `mCurrentFocus=Window{1 u0 ${APP_ID}/.MainActivity}\n`, stderr: '' }
      }
      if (args[0] === 'exec-out') {
        const left = screenReaders >= 2 ? 20 : 0
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
    expect(calls.some(isGuardedTap)).toBe(false)
  })

  it('withholds a UI dump captured from a concurrently replaced package', async () => {
    const replacementStat = '103:5252:123456:1788157200:1788157300'
    let replaced = false
    const { session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'stat') return { code: 0, stdout: `${replaced ? replacementStat : BASE_APK_STAT}\n`, stderr: '' }
      if (args[1] === 'sh' && args[3]?.includes('dumpsys window')) {
        return { code: 0, stdout: `mCurrentFocus=Window{1 u0 ${APP_ID}/.MainActivity}\n`, stderr: '' }
      }
      if (args[0] === 'exec-out') {
        replaced = true
        return {
          code: 0,
          stdout: `<hierarchy><node package="${APP_ID}" text="replacement-private-ui" bounds="[0,0][20,20]" /></hierarchy>`,
          stderr: ''
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    let capturedError: unknown
    try {
      await session.dumpUi({ applicationId: APP_ID })
    } catch (error) {
      capturedError = error
    }
    expect(capturedError).toMatchObject({ code: 'ANDROID_APP_REPLACED' })
    expect(JSON.stringify(capturedError)).not.toContain('replacement-private-ui')
  })

  it('withholds a UI dump when cleanup races a package replacement', async () => {
    const replacementStat = '103:5252:123456:1788157200:1788157300'
    let replaced = false
    const { session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'stat') return { code: 0, stdout: `${replaced ? replacementStat : BASE_APK_STAT}\n`, stderr: '' }
      if (args[1] === 'sh' && args[3]?.includes('dumpsys window')) {
        return { code: 0, stdout: `mCurrentFocus=Window{1 u0 ${APP_ID}/.MainActivity}\n`, stderr: '' }
      }
      if (args[0] === 'exec-out') {
        return {
          code: 0,
          stdout: `<hierarchy><node package="${APP_ID}" text="private-ui" bounds="[0,0][20,20]" /></hierarchy>`,
          stderr: ''
        }
      }
      if (args[1] === 'rm') replaced = true
      return { code: 0, stdout: '', stderr: '' }
    })

    let capturedError: unknown
    try {
      await session.dumpUi({ applicationId: APP_ID })
    } catch (error) {
      capturedError = error
    }
    expect(capturedError).toMatchObject({ code: 'ANDROID_APP_REPLACED' })
    expect(JSON.stringify(capturedError)).not.toContain('private-ui')
  })

  it('withholds partial cross-app XML from a failed UI hierarchy read', async () => {
    const privateXml = '<hierarchy><node package="com.android.systemui" text="private-overlay" /></hierarchy>'
    const { session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'sh' && args[3]?.includes('dumpsys window')) {
        return { code: 0, stdout: `mCurrentFocus=Window{1 u0 ${APP_ID}/.MainActivity}\n`, stderr: '' }
      }
      if (args[0] === 'exec-out') {
        return { code: 1, stdout: privateXml, stderr: 'bounded UI transport failure' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    let captured: unknown
    try {
      await session.dumpUi({ applicationId: APP_ID })
    } catch (error) {
      captured = error
    }
    expect(captured).toMatchObject({
      code: 'ANDROID_UI_DUMP_FAILED',
      evidence: { code: 1, stdout: '', stderr: 'bounded UI transport failure', truncated: true }
    })
    expect(JSON.stringify(captured)).not.toContain('private-overlay')
    expect(JSON.stringify(captured)).not.toContain('com.android.systemui')
  })

  it('withholds UI captured across an active-user A-B-A switch witness', async () => {
    const { calls, session } = setup((args, witness) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'sh' && args[3]?.includes('dumpsys window')) {
        return { code: 0, stdout: `mCurrentFocus=Window{1 u0 ${APP_ID}/.MainActivity}\n`, stderr: '' }
      }
      if (args[0] === 'exec-out') {
        witness.emitScreenEvent('am_switch_user', '10')
        return {
          code: 0,
          stdout: `<hierarchy><node package="${APP_ID}" text="cross-user-private-ui" bounds="[0,0][20,20]" /></hierarchy>`,
          stderr: ''
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    let capturedError: unknown
    try {
      await session.dumpUi({ applicationId: APP_ID })
    } catch (error) {
      capturedError = error
    }
    expect(capturedError).toMatchObject({ code: 'ANDROID_SCREEN_WITNESS_FAILED' })
    const wire = calls.find((args) => args[0] === 'shell' && args[1] === 'sh' && args[3]?.includes('logcat'))
    expect(wire?.[3]).toContain('-b main -b events -T 1 -m "$1" -D')
    expect(wire?.[3]).toContain('DEVHOTEL_USER_FENCE:I')
    expect(wire?.[3]).toContain('am_switch_user:V')
    expect(wire?.[3]).toContain('wm_resume_activity:V')
    expect(calls.some((args) => args.some((value) => value.includes('.user-switch')))).toBe(false)
    expect(JSON.stringify(capturedError)).not.toContain('cross-user-private-ui')
  })

  it('returns committed when the package is replaced during input postflight', async () => {
    const replacementStat = '103:5252:123456:1788157200:1788157300'
    let replaced = false
    const { session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'stat') return { code: 0, stdout: `${replaced ? replacementStat : BASE_APK_STAT}\n`, stderr: '' }
      if (args[1] === 'sh' && args[3]?.includes('dumpsys window')) {
        return { code: 0, stdout: `mCurrentFocus=Window{1 u0 ${APP_ID}/.MainActivity}\n`, stderr: '' }
      }
      if (args[0] === 'exec-out') {
        return {
          code: 0,
          stdout: `<hierarchy><node package="${APP_ID}" text="Crash" resource-id="${APP_ID}:id/crash" class="android.widget.Button" bounds="[0,0][20,20]" /></hierarchy>`,
          stderr: ''
        }
      }
      if (isGuardedTap(args)) {
        replaced = true
        return { code: 0, stdout: 'Tapped\n', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.tapText({ applicationId: APP_ID, text: 'Crash' })).resolves.toMatchObject({
      outcome: 'committed',
      retrySafe: false,
      evidence: null
    })
  })

  it('confirms same-app navigation observed after the guarded input witness closes', async () => {
    let tapped = false
    const { session } = setup((args, witness) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'sh' && args[3]?.includes('dumpsys window')) {
        const activity = tapped ? '.DetailsActivity' : '.MainActivity'
        return { code: 0, stdout: `mCurrentFocus=Window{1 u0 ${APP_ID}/${activity}}\n`, stderr: '' }
      }
      if (args[0] === 'exec-out') {
        return {
          code: 0,
          stdout: `<hierarchy><node package="${APP_ID}" text="Next" resource-id="${APP_ID}:id/next" class="android.widget.Button" bounds="[0,0][20,20]" /></hierarchy>`,
          stderr: ''
        }
      }
      if (isGuardedTap(args)) {
        tapped = true
        setTimeout(() => {
          witness.emitScreenEvent(
            'wm_resume_activity',
            `[0,12345,44,${APP_ID}/.DetailsActivity]`
          )
          witness.emitScreenEvent('input_focus', 'Window{same-app-details},reason=UpdateInputWindows')
        }, 10)
        return { code: 0, stdout: '', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.tapText({ applicationId: APP_ID, text: 'Next' })).resolves.toMatchObject({
      applicationId: APP_ID,
      tapped: { text: 'Next' },
      outcome: 'confirmed',
      retrySafe: false
    })
  })

  it('returns an explicit non-retry-safe indeterminate outcome when focus changes while input is pending', async () => {
    const { calls, session } = setup(async (args, witness) => {
      if (args[1] === 'pm' && args[2] === 'path') {
        return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      }
      if (args[1] === 'sh' && args[3]?.includes('dumpsys window')) {
        return { code: 0, stdout: `mCurrentFocus=Window{1 u0 ${APP_ID}/.MainActivity}\n`, stderr: '' }
      }
      if (args[0] === 'exec-out') {
        return {
          code: 0,
          stdout: `<hierarchy><node package="${APP_ID}" text="Next" bounds="[0,0][20,20]" /></hierarchy>`,
          stderr: ''
        }
      }
      if (isGuardedTap(args)) {
        // AOSP logs Activity focus changes while `input tap` can still be
        // returning. DevHotel cannot distinguish input-caused navigation from
        // an overlay race at this boundary, so it must forbid auto-retry.
        witness.emitScreenEvent(
          'input_focus',
          `Focus entering 123 ${APP_ID}/.DetailsActivity (server),reason=setFocusedWindow`
        )
        await Promise.resolve()
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.tapText({ applicationId: APP_ID, text: 'Next' })).resolves.toMatchObject({
      applicationId: APP_ID,
      tapped: { text: 'Next' },
      outcome: 'indeterminate',
      retrySafe: false,
      evidence: null
    })
    expect(calls.filter(isGuardedTap)).toHaveLength(1)
  })

  it('returns indeterminate when the guarded input transport rejects after invocation', async () => {
    const transportError = new Error('private adb transport disconnected after input dispatch')
    const { calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') {
        return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      }
      if (args[1] === 'sh' && args[3]?.includes('dumpsys window')) {
        return { code: 0, stdout: `mCurrentFocus=Window{1 u0 ${APP_ID}/.MainActivity}\n`, stderr: '' }
      }
      if (args[0] === 'exec-out') {
        return {
          code: 0,
          stdout: `<hierarchy><node package="${APP_ID}" text="Next" bounds="[0,0][20,20]" /></hierarchy>`,
          stderr: ''
        }
      }
      if (isGuardedTap(args)) throw transportError
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.tapText({ applicationId: APP_ID, text: 'Next' })).resolves.toMatchObject({
      applicationId: APP_ID,
      tapped: { text: 'Next' },
      outcome: 'indeterminate',
      retrySafe: false,
      evidence: null
    })
    expect(calls.filter(isGuardedTap)).toHaveLength(1)
  })

  it.each([
    { transitions: 0, outcome: 'success' as const },
    { transitions: 14, outcome: 'success' as const },
    { transitions: 15, outcome: 'failure' as const }
  ])('handles exactly $transitions allowed tap transitions with deterministic record padding', async ({
    transitions,
    outcome
  }) => {
    const { session } = setup((args, witness) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'sh' && args[3]?.includes('dumpsys window')) {
        return { code: 0, stdout: `mCurrentFocus=Window{1 u0 ${APP_ID}/.MainActivity}\n`, stderr: '' }
      }
      if (args[0] === 'exec-out') {
        return {
          code: 0,
          stdout: `<hierarchy><node package="${APP_ID}" text="Next" resource-id="${APP_ID}:id/next" class="android.widget.Button" bounds="[0,0][20,20]" /></hierarchy>`,
          stderr: ''
        }
      }
      if (isGuardedTap(args)) {
        for (let index = 0; index < transitions; index += 1) {
          witness.emitScreenEvent(
            'wm_resume_activity',
            `[0,${10_000 + index},44,${APP_ID}/.DetailsActivity]`
          )
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    const result = session.tapText({ applicationId: APP_ID, text: 'Next' })
    if (outcome === 'success') {
      await expect(result).resolves.toMatchObject({ applicationId: APP_ID, outcome: 'confirmed' })
    } else {
      await expect(result).resolves.toMatchObject({
        applicationId: APP_ID,
        outcome: 'indeterminate',
        retrySafe: false,
        evidence: null
      })
    }
  })

  it('returns committed without inviting retry when the observed follow-up belongs to another app', async () => {
    let tapped = false
    const { session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'sh' && args[3]?.includes('dumpsys window')) {
        return {
          code: 0,
          stdout: tapped
            ? 'mCurrentFocus=Window{1 u0 com.other.app/.PrivateActivity}\n'
            : `mCurrentFocus=Window{1 u0 ${APP_ID}/.MainActivity}\n`,
          stderr: ''
        }
      }
      if (args[0] === 'exec-out') {
        return {
          code: 0,
          stdout: `<hierarchy><node package="${APP_ID}" text="Next" bounds="[0,0][20,20]" /></hierarchy>`,
          stderr: ''
        }
      }
      if (isGuardedTap(args)) tapped = true
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.tapText({ applicationId: APP_ID, text: 'Next' })).resolves.toMatchObject({
      outcome: 'committed',
      retrySafe: false,
      evidence: null
    })
  })

  it.each([
    { mode: 'forbidden input focus', flood: false },
    { mode: 'record-cap flood', flood: true }
  ])('aborts before input when the live witness observes a $mode during preflight', async ({ flood }) => {
    let readerStarted = false
    let emitted = false
    const { calls, session } = setup((args, witness) => {
      if (args[1] === 'sh' && args[3]?.includes('logcat -b main -b events')) readerStarted = true
      if (readerStarted && !emitted && args[1] === 'am' && args[2] === 'get-current-user') {
        emitted = true
        if (flood) {
          for (let index = 0; index < 15; index += 1) {
            witness.emitScreenEvent(
              'wm_resume_activity',
              `[0,${20_000 + index},44,${APP_ID}/.DetailsActivity]`
            )
          }
        } else {
          witness.emitScreenEvent('input_focus', 'Window{private-system-overlay},reason=UpdateInputWindows')
        }
      }
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'sh' && args[3]?.includes('dumpsys window')) {
        return { code: 0, stdout: `mCurrentFocus=Window{1 u0 ${APP_ID}/.MainActivity}\n`, stderr: '' }
      }
      if (args[0] === 'exec-out') {
        return {
          code: 0,
          stdout: `<hierarchy><node package="${APP_ID}" text="Next" bounds="[0,0][20,20]" /></hierarchy>`,
          stderr: ''
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.tapText({ applicationId: APP_ID, text: 'Next' })).rejects.toMatchObject({
      code: 'ANDROID_SCREEN_WITNESS_FAILED'
    })
    expect(calls.some(isGuardedTap)).toBe(false)
  }, 20_000)

  it('aborts before input when the live reader writes diagnostics during preflight', async () => {
    let screenReaders = 0
    let emitted = false
    const { calls, session } = setup((args, witness) => {
      if (args[1] === 'sh' && args[3]?.includes('logcat -b main -b events')) screenReaders += 1
      if (screenReaders >= 2 && !emitted && args[0] === 'exec-out') {
        emitted = true
        witness.emitRawScreenStderr('private logcat warning')
      }
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'sh' && args[3]?.includes('dumpsys window')) {
        return { code: 0, stdout: `mCurrentFocus=Window{1 u0 ${APP_ID}/.MainActivity}\n`, stderr: '' }
      }
      if (args[0] === 'exec-out') {
        return {
          code: 0,
          stdout: `<hierarchy><node package="${APP_ID}" text="Next" bounds="[0,0][20,20]" /></hierarchy>`,
          stderr: ''
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.tapText({ applicationId: APP_ID, text: 'Next' })).rejects.toMatchObject({
      code: 'ANDROID_SCREEN_WITNESS_FAILED'
    })
    expect(calls.some(isGuardedTap)).toBe(false)
  })

  it('withholds strict screen evidence across an input-focus-only transient overlay', async () => {
    const { session } = setup((_args, witness) => {
      witness.emitScreenEvent('input_focus', 'Window{private-system-overlay},reason=UpdateInputWindows')
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.withActiveUserScreenWitness(async () => 'private-screen')).rejects.toMatchObject({
      code: 'ANDROID_SCREEN_WITNESS_FAILED'
    })
  })

  it('returns committed when close framing is corrupted after Android accepted input', async () => {
    let tapped = false
    const { session } = setup((args, witness) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'sh' && args[3]?.includes('dumpsys window')) {
        return { code: 0, stdout: `mCurrentFocus=Window{1 u0 ${APP_ID}/.MainActivity}\n`, stderr: '' }
      }
      if (args[0] === 'exec-out') {
        return {
          code: 0,
          stdout: `<hierarchy><node package="${APP_ID}" text="Next" bounds="[0,0][20,20]" /></hierarchy>`,
          stderr: ''
        }
      }
      if (isGuardedTap(args)) tapped = true
      if (tapped && args[1] === 'sh' && args[3]?.includes('for payload in "$@"')) {
        witness.emitScreenMarker(args[6]!)
        witness.emitScreenEvent('wm_resume_activity', '[0,12345,44,com.other.app/.PrivateActivity]')
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.tapText({ applicationId: APP_ID, text: 'Next' })).resolves.toMatchObject({
      outcome: 'committed',
      retrySafe: false,
      evidence: null
    })
  })

  it('rejects an ambiguous tagged activity transition instead of treating it as same-app', async () => {
    let emitScreenEvent: (tag: string, payload: string) => void = () => undefined
    const { session } = setup((_args, witness) => {
      emitScreenEvent = witness.emitScreenEvent
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.withActiveUserScreenWitness(async () => {
      emitScreenEvent('wm_resume_activity', `[0,not-a-complete-record,${APP_ID}/.DetailsActivity]`)
    })).rejects.toMatchObject({ code: 'ANDROID_SCREEN_WITNESS_FAILED' })
  })

  it('guards input with the sealed active user inside the same guest command', async () => {
    let switched = false
    const { calls, session } = setup((args) => {
      if (args[1] === 'am' && args[2] === 'get-current-user') {
        return { code: 0, stdout: `${switched ? 10 : 0}\n`, stderr: '' }
      }
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'sh' && args[3]?.includes('dumpsys window')) {
        return { code: 0, stdout: `mCurrentFocus=Window{1 u0 ${APP_ID}/.MainActivity}\n`, stderr: '' }
      }
      if (args[0] === 'exec-out') {
        return {
          code: 0,
          stdout: `<hierarchy><node package="${APP_ID}" text="Crash" resource-id="${APP_ID}:id/crash" class="android.widget.Button" bounds="[0,0][20,20]" /></hierarchy>`,
          stderr: ''
        }
      }
      if (isGuardedTap(args)) {
        switched = true
        return { code: 71, stdout: '', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.tapText({ applicationId: APP_ID, text: 'Crash' })).resolves.toMatchObject({
      outcome: 'indeterminate',
      retrySafe: false,
      evidence: null
    })
    const tap = calls.find(isGuardedTap)
    expect(tap?.slice(0, 5)).toEqual([
      'shell', 'sh', '-c',
      expect.stringContaining('input tap "$x" "$y"'),
      'devhotel-tap'
    ])
    expect(tap?.slice(5, 8)).toEqual(['0', '10', '10'])
    expect(tap?.[3]).toContain('[ "$current" = "$expected_user" ] || exit 71')
    expect(tap).toHaveLength(8)
    const tapIndex = calls.indexOf(tap!)
    const endIndex = calls.findIndex((args, index) =>
      index > tapIndex && (
        args[1] === 'log' && args.at(-1)?.startsWith('devhotel-user-end-') ||
        args[1] === 'sh' && args.some((value) => value.startsWith('devhotel-user-end-'))
      )
    )
    expect(endIndex).toBeGreaterThan(tapIndex)
  })

  it('returns indeterminate when the live witness observes an A-B-A user switch during input', async () => {
    const { calls, session } = setup((args, witness) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'sh' && args[3]?.includes('dumpsys window')) {
        return { code: 0, stdout: `mCurrentFocus=Window{1 u0 ${APP_ID}/.MainActivity}\n`, stderr: '' }
      }
      if (args[0] === 'exec-out') {
        return {
          code: 0,
          stdout: `<hierarchy><node package="${APP_ID}" text="Crash" resource-id="${APP_ID}:id/crash" class="android.widget.Button" bounds="[0,0][20,20]" /></hierarchy>`,
          stderr: ''
        }
      }
      if (isGuardedTap(args)) {
        witness.emitScreenEvent('wm_set_resumed_activity', '[0,com.other.app/.PrivateActivity,topResumed]')
        return { code: 0, stdout: 'private-tap-evidence\n', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.tapText({ applicationId: APP_ID, text: 'Crash' })).resolves.toMatchObject({
      outcome: 'indeterminate',
      retrySafe: false,
      evidence: null
    })
    expect(calls.some((args) => args[0] === 'shell' && args[1] === 'sh' && args[3]?.includes('logcat'))).toBe(true)
    expect(calls.some((args) => args.some((value) => value.includes('/data/local/tmp/devhotel-tap-')))).toBe(false)
  })

  it('returns committed when the package is replaced during the final foreground probe', async () => {
    const replacementStat = '103:5252:123456:1788157200:1788157300'
    let tapRan = false
    let replaced = false
    const { session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'stat') return { code: 0, stdout: `${replaced ? replacementStat : BASE_APK_STAT}\n`, stderr: '' }
      if (args[1] === 'sh' && args[3]?.includes('dumpsys window')) {
        if (tapRan) replaced = true
        return { code: 0, stdout: `mCurrentFocus=Window{1 u0 ${APP_ID}/.MainActivity}\n`, stderr: '' }
      }
      if (args[0] === 'exec-out') {
        return {
          code: 0,
          stdout: `<hierarchy><node package="${APP_ID}" text="Crash" resource-id="${APP_ID}:id/crash" class="android.widget.Button" bounds="[0,0][20,20]" /></hierarchy>`,
          stderr: ''
        }
      }
      if (isGuardedTap(args)) {
        tapRan = true
        return { code: 0, stdout: 'private-tap-evidence\n', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.tapText({ applicationId: APP_ID, text: 'Crash' })).resolves.toMatchObject({
      outcome: 'committed',
      retrySafe: false,
      evidence: null
    })
  })

  it('returns committed when exact lease authorization is lost during tap postflight', async () => {
    const leaseError = new DeviceLeaseError('lease-expired', 'exact physical lease expired')
    let tapRan = false
    const { session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') {
        if (tapRan) throw leaseError
        return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      }
      if (args[1] === 'sh' && args[3]?.includes('dumpsys window')) {
        return { code: 0, stdout: `mCurrentFocus=Window{1 u0 ${APP_ID}/.MainActivity}\n`, stderr: '' }
      }
      if (args[0] === 'exec-out') {
        return {
          code: 0,
          stdout: `<hierarchy><node package="${APP_ID}" text="Crash" resource-id="${APP_ID}:id/crash" class="android.widget.Button" bounds="[0,0][20,20]" /></hierarchy>`,
          stderr: ''
        }
      }
      if (isGuardedTap(args)) {
        tapRan = true
        return { code: 0, stdout: '', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.tapText({ applicationId: APP_ID, text: 'Crash' })).resolves.toMatchObject({
      outcome: 'committed',
      retrySafe: false,
      evidence: null
    })
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
    expect(calls.some(isGuardedTap)).toBe(false)
  })

  it('clamps every wait-for-text command to the remaining request deadline', async () => {
    let now = 1_000
    const { calls, session, timeouts } = setup((args) => {
      if (args[1] !== 'stat') now += 30
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
      timeoutMs: 1_000,
      pollIntervalMs: 250
    })).rejects.toMatchObject({ code: 'ANDROID_WAIT_TIMEOUT' })

    expect(timeouts[0]).toBe(1_000)
    expect(timeouts.every((timeout, index) =>
      timeout !== undefined && timeout > 0 && (index === 0 || timeout <= timeouts[index - 1]!)
    )).toBe(true)
    expect(timeouts.at(-1)).toBeLessThan(1_000)
    const trappedDump = calls.find((args) => args[0] === 'exec-out')
    expect(trappedDump?.[3]).toContain('trap cleanup 0 1 2 15')
    expect(trappedDump?.[3]).toContain('kill "$child"')
    expect(trappedDump?.[3]).not.toContain('logcat')
    expect(trappedDump?.[5]).toMatch(/^\/data\/local\/tmp\/devhotel-ui-[a-f0-9-]+\.xml$/)
    expect(calls.find((args) => args[1] === 'sh' && args[3]?.includes('logcat'))?.[3]).toContain(
      'logcat -b main -b events -T 1 -m "$1" -D'
    )
    expect(calls.some((args) => args.some((value) => value.includes('.user-switch')))).toBe(false)
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
    const packageLists = calls.filter((args) => args[1] === 'pm' && args[2] === 'list')
    expect(packageLists.length).toBeGreaterThanOrEqual(4)
    expect(packageLists.every((args) => args[6] === '0')).toBe(true)
    expect(packageLists.flat()).not.toContain('current')
  })

  it('withholds partial pre-fence stdout when package-scoped logcat fails', async () => {
    const privateRow = '1690000000.001 com.other.app private-before-fence-row'
    const { session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'pm' && args.includes('--uid')) return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'pm' && args[2] === 'list') return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[0] === 'logcat') {
        return { code: 1, stdout: `${privateRow}\n`, stderr: 'bounded logcat transport failure' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    let captured: unknown
    try {
      await session.logcat({ applicationId: APP_ID })
    } catch (error) {
      captured = error
    }
    expect(captured).toMatchObject({
      code: 'ANDROID_LOGCAT_UNSUPPORTED',
      evidence: { code: 1, stdout: '', stderr: 'bounded logcat transport failure', truncated: true }
    })
    expect(JSON.stringify(captured)).not.toContain('private-before-fence-row')
    expect(JSON.stringify(captured)).not.toContain('com.other.app')
  })

  it('preserves the full package UID for a secondary Android user', async () => {
    const secondaryUid = 1_010_123
    const { calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'pm' && args.includes('--uid')) {
        return { code: 0, stdout: `package:${APP_ID} uid:${secondaryUid}\n`, stderr: '' }
      }
      if (args[1] === 'pm' && args[2] === 'list') {
        return { code: 0, stdout: `package:${APP_ID} uid:${secondaryUid}\n`, stderr: '' }
      }
      if (args[0] === 'logcat') {
        return {
          code: 0,
          stdout: `1690000000.000 ${SECONDARY_INSTALL_LOG_FENCE}\n1690000000.001 secondary-user row\n`,
          stderr: ''
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    }, {}, target, SECONDARY_INSTALL_LOG_FENCE)

    await expect(session.logcat({ applicationId: APP_ID })).resolves.toMatchObject({
      lines: ['1690000000.001 secondary-user row']
    })
    expect(calls.find((args) => args[0] === 'logcat')).toContain(`--uid=${secondaryUid}`)
    expect(calls).toContainEqual([
      'shell', 'pm', 'list', 'packages', '-U', '--user', '10', '--uid', String(secondaryUid)
    ])
  })

  it('rejects a different active user before reading even if the APK identity is globally identical', async () => {
    const { calls, installs, session } = setup((args) => {
      if (args[1] === 'am' && args[2] === 'get-current-user') return { code: 0, stdout: '10\n', stderr: '' }
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.logcat({ applicationId: APP_ID })).rejects.toMatchObject({
      code: 'ANDROID_APP_USER_CHANGED'
    })
    expect(installs.get(
      'aaaa1111',
      { kind: 'emulator', targetId: 'aaaa1111', deviceId: null },
      APP_ID
    )).not.toBeNull()
    expect(calls.some((args) => args[0] === 'logcat')).toBe(false)
  })

  it('fails closed when the active Android user changes during a log capture', async () => {
    let logRead = false
    const { calls, session } = setup((args) => {
      if (args[1] === 'am' && args[2] === 'get-current-user') {
        return { code: 0, stdout: `${logRead ? 10 : 0}\n`, stderr: '' }
      }
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'pm' && args.includes('--uid')) return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'pm' && args[2] === 'list') return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[0] === 'logcat') {
        logRead = true
        return {
          code: 0,
          stdout: `1690000000.000 ${INSTALL_LOG_FENCE}\n1690000000.001 old-user row\n`,
          stderr: ''
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.logcat({ applicationId: APP_ID })).rejects.toMatchObject({
      code: 'ANDROID_APP_USER_CHANGED'
    })
    expect(calls.some((args) => args[0] === 'logcat')).toBe(true)
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
          code: 1,
          stdout: `1690000000.000 ${INSTALL_LOG_FENCE}\n1690000000.001 replacement row\n`,
          stderr: 'replacement-private-log-error'
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    let capturedError: unknown
    try {
      await session.logcat({ applicationId: APP_ID })
    } catch (error) {
      capturedError = error
    }
    expect(capturedError).toMatchObject({ code: 'ANDROID_APP_REPLACED' })
    expect(JSON.stringify(capturedError)).not.toContain('replacement-private-log-error')
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

  it('withholds log rows when replacement races the final UID authority probe', async () => {
    const replacementStat = '103:5252:123456:1788157200:1788157300'
    let packageDumpProbes = 0
    let replaced = false
    const { session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'stat') return { code: 0, stdout: `${replaced ? replacementStat : BASE_APK_STAT}\n`, stderr: '' }
      if (args[1] === 'sh' && args[3]?.startsWith('dumpsys package "$1"')) {
        packageDumpProbes += 1
        if (packageDumpProbes === 3) replaced = true
        return {
          code: 0,
          stdout: `${EXCLUSIVE_PACKAGE_DUMP}\n\n${args.at(-1)}\n`,
          stderr: ''
        }
      }
      if (args[1] === 'pm' && args.includes('--uid')) return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'pm' && args[2] === 'list') return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[0] === 'logcat') {
        return {
          code: 0,
          stdout: `1690000000.000 ${INSTALL_LOG_FENCE}\n1690000000.001 replacement-private-row\n`,
          stderr: ''
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    let capturedError: unknown
    try {
      await session.logcat({ applicationId: APP_ID })
    } catch (error) {
      capturedError = error
    }
    expect(capturedError).toMatchObject({ code: 'ANDROID_APP_REPLACED' })
    expect(JSON.stringify(capturedError)).not.toContain('replacement-private-row')
    expect(packageDumpProbes).toBe(3)
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
            '    appId=10123',
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
      logFence: null,
      installUserId: 0,
      installUserSerial: INSTALL_USER_SERIAL
    })

    await expect(session.logcat({ applicationId: APP_ID })).rejects.toMatchObject({
      code: 'ANDROID_LOG_FENCE_UNSUPPORTED'
    })
    await expect(session.crashScenario({
      applicationId: APP_ID,
      scenario: 'am-crash',
      runId: 'unsupported-fence'
    })).rejects.toMatchObject({ code: 'ANDROID_LOG_FENCE_UNSUPPORTED' })
    expect(calls.some((args) => args[0] === 'logcat' || args[1] === 'pgrep' || args[1] === 'run-as')).toBe(false)
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

    const evidence = await session.foregroundInstallEvidence()
    expect(evidence.context).toEqual(context)
    expect(evidence.seal).toMatchObject({
      targetKind: 'emulator',
      targetId: 'aaaa1111',
      deviceId: null,
      leaseId: null,
      roomId: 'aaaa1111',
      applicationId: APP_ID,
      changeId: '11111111-2222-4333-8444-555555555555',
      apkSha256: 'a'.repeat(64),
      installedAt: INSTALLED_AT,
      packageIncarnation: PACKAGE_INCARNATION,
      logFence: INSTALL_LOG_FENCE,
      installUserId: 0,
      installUserSerial: INSTALL_USER_SERIAL
    })
  })

  it('does not collapse an ambiguous foreground probe into durable no-app evidence', async () => {
    const { session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: 'package:/data/app/base.apk\n', stderr: '' }
      if (args[1] === 'sh' && args.at(-1)?.includes('dumpsys window')) {
        return { code: 0, stdout: 'mFocusedApp=ActivityRecord{private stale value}\n', stderr: '' }
      }
      if (args[1] === 'getprop') return { code: 0, stdout: 'ko-KR\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.foregroundInstallEvidence()).rejects.toMatchObject({
      code: 'ANDROID_FOREGROUND_UNKNOWN'
    })
  })

  it('fails legacy receipts without user authority closed while preserving them for rerun', async () => {
    const { db, installs, calls, session } = setup(() => ({ code: 0, stdout: '', stderr: '' }))
    db.sqlite.prepare('UPDATE android_app_installs SET install_user_id = NULL').run()

    await expect(session.forceStop(APP_ID)).rejects.toMatchObject({
      code: 'ANDROID_APP_USER_UNVERIFIED'
    })
    expect(installs.get(
      'aaaa1111',
      { kind: 'emulator', targetId: 'aaaa1111', deviceId: null },
      APP_ID
    )).not.toBeNull()
    expect(calls.some((args) => args[1] === 'pm' || (args[1] === 'am' && args[2] === 'force-stop'))).toBe(false)
  })

  it.each(['install_user_id', 'install_user_serial'] as const)(
    'fails a legacy receipt with null %s closed without deleting it',
    async (column) => {
      const { db, installs, calls, session } = setup(() => ({ code: 0, stdout: '', stderr: '' }))
      db.sqlite.prepare(`UPDATE android_app_installs SET ${column} = NULL`).run()

      await expect(session.forceStop(APP_ID)).rejects.toMatchObject({
        code: 'ANDROID_APP_USER_UNVERIFIED'
      })
      expect(installs.get(
        'aaaa1111',
        { kind: 'emulator', targetId: 'aaaa1111', deviceId: null },
        APP_ID
      )).not.toBeNull()
      expect(calls).toEqual([])
    }
  )

  it('rejects a recycled numeric user ID with a new serial without deleting the old receipt', async () => {
    const recycledSerial = SECONDARY_INSTALL_USER_SERIAL + 1
    const { installs, calls, session } = setup((args) => {
      if (args[1] === 'dumpsys' && args[2] === 'user') {
        return {
          code: 0,
          stdout: ` UserInfo{10:Replacement user:13} serialNo=${recycledSerial} isPrimary=false\n Type: android.os.usertype.full.SECONDARY\n`,
          stderr: ''
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    }, {}, target, SECONDARY_INSTALL_LOG_FENCE)

    await expect(session.launch(APP_ID, '.MainActivity')).rejects.toMatchObject({
      code: 'ANDROID_APP_USER_CHANGED'
    })
    expect(installs.get(
      'aaaa1111',
      { kind: 'emulator', targetId: 'aaaa1111', deviceId: null },
      APP_ID
    )).not.toBeNull()
    expect(calls.some((args) => args[1] === 'pm' || (args[1] === 'am' && args[2] === 'start'))).toBe(false)
  })

  it.each([
    {
      label: 'malformed',
      stdout: ' UserInfo{10:Private user name:13} serialNo=not-a-number isPrimary=false\n'
    },
    {
      label: 'duplicate',
      stdout: [
        ` UserInfo{10:Private user name:13} serialNo=${SECONDARY_INSTALL_USER_SERIAL} isPrimary=false`,
        ` UserInfo{10:Injected:13} serialNo=${SECONDARY_INSTALL_USER_SERIAL} isPrimary=false`,
        ''
      ].join('\n')
    },
    {
      label: 'overflow',
      stdout: ' UserInfo{10:Private user name:13} serialNo=2147483648 isPrimary=false\n'
    }
  ])('fails a $label user-serial probe closed without exposing its dump', async ({ stdout }) => {
    const { calls, session } = setup((args) => args[1] === 'dumpsys' && args[2] === 'user'
      ? { code: 0, stdout, stderr: 'private-user-diagnostic' }
      : { code: 0, stdout: '', stderr: '' }, {}, target, SECONDARY_INSTALL_LOG_FENCE)

    await session.forceStop(APP_ID).catch((error: unknown) => {
      expect(error).toMatchObject({
        code: 'ANDROID_APP_USER_UNVERIFIED',
        evidence: { code: 0, stdout: '', stderr: '', truncated: true }
      })
      expect(JSON.stringify(error)).not.toContain('Private user name')
      expect(JSON.stringify(error)).not.toContain('private-user-diagnostic')
    })
    expect(calls.some((args) => args[1] === 'pm' || (args[1] === 'am' && args[2] === 'force-stop'))).toBe(false)
  })

  it('keeps other-user receipts durable while status returns only the active user context', async () => {
    const otherApplicationId = 'com.example.other'
    const { installs, calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'sh' && args.at(-1)?.includes('dumpsys window')) {
        return { code: 0, stdout: `mCurrentFocus=Window{1 u0 ${APP_ID}/.MainActivity}\n`, stderr: '' }
      }
      if (args[1] === 'getprop') return { code: 0, stdout: 'en-US\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    installs.record({
      roomId: 'aaaa1111',
      target: { kind: 'emulator', targetId: 'aaaa1111', deviceId: null },
      applicationId: otherApplicationId,
      changeId: '21111111-2222-4333-8444-555555555555',
      apkSha256: 'a'.repeat(64),
      installedAt: INSTALLED_AT,
      packageIncarnation: PACKAGE_INCARNATION,
      logFence: null,
      installUserId: 10,
      installUserSerial: SECONDARY_INSTALL_USER_SERIAL
    })

    await expect(session.status()).resolves.toMatchObject({
      installedApplicationIds: [APP_ID],
      foregroundApplicationId: APP_ID
    })
    expect(installs.get(
      'aaaa1111',
      { kind: 'emulator', targetId: 'aaaa1111', deviceId: null },
      otherApplicationId
    )).not.toBeNull()
    expect(calls.some((args) => args[1] === 'pm' && args.at(-1) === otherApplicationId)).toBe(false)
  })

  it('withholds foreground install context when the package is replaced after metadata capture', async () => {
    let foregroundCaptured = false
    const replacementStat = '103:5252:123456:1788157200:1788157300'
    const { installs, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'stat') {
        return { code: 0, stdout: `${foregroundCaptured ? replacementStat : BASE_APK_STAT}\n`, stderr: '' }
      }
      if (args[1] === 'sh' && args.at(-1)?.includes('dumpsys window')) {
        foregroundCaptured = true
        return { code: 0, stdout: `mCurrentFocus=Window{1 u0 ${APP_ID}/.MainActivity}\n`, stderr: '' }
      }
      if (args[1] === 'getprop') return { code: 0, stdout: 'en-US\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.foregroundInstallContext()).rejects.toMatchObject({ code: 'ANDROID_APP_REPLACED' })
    expect(installs.get(
      'aaaa1111',
      { kind: 'emulator', targetId: 'aaaa1111', deviceId: null },
      APP_ID
    )).toBeNull()
  })

  it('rejects direct primitives on another active user without deleting the original receipt', async () => {
    const { installs, calls, session } = setup((args) => {
      if (args[1] === 'am' && args[2] === 'get-current-user') return { code: 0, stdout: '10\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.launch(APP_ID, '.MainActivity')).rejects.toMatchObject({ code: 'ANDROID_APP_USER_CHANGED' })
    expect(installs.get(
      'aaaa1111',
      { kind: 'emulator', targetId: 'aaaa1111', deviceId: null },
      APP_ID
    )).not.toBeNull()
    expect(calls.some((args) => args[1] === 'pm' || (args[1] === 'am' && args[2] === 'start'))).toBe(false)
  })

  it('invalidates a stale receipt when the package is gone', async () => {
    const { installs, session } = setup((args) => {
      if (args[1] === 'am' && args[2] === 'get-current-user') return { code: 0, stdout: '0\n', stderr: '' }
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
    const { installs, calls, session } = setup((args) => args[1] === 'am' && args[2] === 'get-current-user'
      ? { code: 0, stdout: '0\n', stderr: '' }
      : { code: 1, stdout: '', stderr: 'transport lost' })

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

  it.each([
    {
      shape: 'stderr warning',
      stdout: `package:${BASE_APK_PATH}\n`,
      stderr: 'private package-manager warning'
    },
    {
      shape: 'mixed stdout record',
      stdout: `private warning\npackage:${BASE_APK_PATH}\n`,
      stderr: ''
    },
    {
      shape: 'extra blank line',
      stdout: `package:${BASE_APK_PATH}\n\n`,
      stderr: ''
    }
  ])('preserves the receipt when pm path has a non-exact $shape', async ({ stdout, stderr }) => {
    const { installs, calls, session } = setup((args) => args[1] === 'pm' && args[2] === 'path'
      ? { code: 0, stdout, stderr }
      : { code: 0, stdout: '', stderr: '' })

    await session.forceStop(APP_ID).catch((error: unknown) => {
      expect(error).toMatchObject({
        code: 'ANDROID_APP_IDENTITY_UNVERIFIED',
        evidence: { stdout: '', stderr: '', truncated: true }
      })
      expect(JSON.stringify(error)).not.toMatch(/private package-manager warning|private warning/)
    })
    expect(installs.get(
      'aaaa1111',
      { kind: 'emulator', targetId: 'aaaa1111', deviceId: null },
      APP_ID
    )).not.toBeNull()
    expect(calls.some((args) => args[1] === 'stat' || args[1] === 'sha256sum')).toBe(false)
  })

  it('does not misreport a pre-crash PID probe failure as an app that is not running', async () => {
    const { calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: 'package:/data/app/base.apk\n', stderr: '' }
      if (args[1] === 'pm' && args.includes('--uid')) return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'pm' && args[2] === 'list') return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'pgrep') return { code: -1, stdout: '', stderr: 'transport lost' }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.crashScenario({
      applicationId: APP_ID,
      scenario: 'am-crash',
      runId: 'pre-probe-failure'
    })).rejects.toMatchObject({ code: 'ANDROID_PROCESS_PROBE_FAILED' })
    expect(calls.some((args) => args[1] === 'am' && args[2] === 'crash')).toBe(false)
  })

  it('reports not-running only for an authoritative empty exact-UID pgrep result', async () => {
    const { session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: 'package:/data/app/base.apk\n', stderr: '' }
      if (args[1] === 'pm' && args.includes('--uid')) return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'pm' && args[2] === 'list') return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'pgrep') return { code: 1, stdout: '', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.crashScenario({
      applicationId: APP_ID,
      scenario: 'am-crash',
      runId: 'not-running'
    })).rejects.toMatchObject({ code: 'ANDROID_APP_NOT_RUNNING' })
  })

  it('does not misclassify a replacement during an empty PID probe as not-running', async () => {
    const replacementStat = '103:5252:123456:1788157200:1788157300'
    let replaced = false
    const { installs, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'stat') return { code: 0, stdout: `${replaced ? replacementStat : BASE_APK_STAT}\n`, stderr: '' }
      if (args[1] === 'pm' && args.includes('--uid')) return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'pm' && args[2] === 'list') return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'pgrep') {
        replaced = true
        return { code: 1, stdout: '', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.crashScenario({
      applicationId: APP_ID,
      scenario: 'am-crash',
      runId: 'replacement-before-empty'
    })).rejects.toMatchObject({ code: 'ANDROID_APP_REPLACED' })
    expect(installs.get(
      'aaaa1111',
      { kind: 'emulator', targetId: 'aaaa1111', deviceId: null },
      APP_ID
    )).toBeNull()
  })

  it.each(['unreadable', 'malformed', 'duplicate', 'noisy-empty'] as const)(
    'fails closed when the exact-UID process probe is %s',
    async (failure) => {
      const { calls, session } = setup((args) => {
        if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
        if (args[1] === 'pm' && args.includes('--uid')) return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
        if (args[1] === 'pm' && args[2] === 'list') return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
        if (args[1] === 'pgrep') {
          return failure === 'unreadable'
            ? { code: 2, stdout: '', stderr: 'permission denied' }
            : failure === 'noisy-empty'
              ? { code: 1, stdout: '', stderr: '\n' }
            : failure === 'duplicate'
              ? { code: 0, stdout: '1234\n1234\n', stderr: '' }
              : { code: 0, stdout: 'not-a-pid\n', stderr: '' }
        }
        return { code: 0, stdout: '', stderr: '' }
      })

      await session.crashScenario({
        applicationId: APP_ID,
        scenario: 'am-crash',
        runId: `pid-${failure}`
      }).catch((error: unknown) => {
        expect(error).toMatchObject({
          code: 'ANDROID_PROCESS_PROBE_FAILED',
          evidence: { stdout: '', stderr: '', truncated: true }
        })
        expect(JSON.stringify(error)).not.toMatch(/permission denied|not-a-pid|1234/)
      })
      expect(calls.some((args) => args[1] === 'sh' && args[3]?.includes('exec am crash'))).toBe(false)
    }
  )

  it('does not treat a post-crash PID probe failure as observed process death', async () => {
    let pidProbes = 0
    const { calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: 'package:/data/app/base.apk\n', stderr: '' }
      if (args[1] === 'pgrep') {
        pidProbes += 1
        return pidProbes === 1
          ? { code: 0, stdout: '1234\n', stderr: '' }
          : { code: -1, stdout: '', stderr: 'transport lost' }
      }
      if (args[1] === 'pm' && args.includes('--uid')) return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'pm' && args[2] === 'list') return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
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
    const secondaryUid = 1_010_123
    let pidProbes = 0
    let crashFence = ''
    const { calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: 'package:/data/app/base.apk\n', stderr: '' }
      if (args[1] === 'pgrep') {
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
      if (args[1] === 'pm' && args.includes('--uid')) return { code: 0, stdout: `package:${APP_ID} uid:${secondaryUid}\n`, stderr: '' }
      if (args[1] === 'pm' && args[2] === 'list') return { code: 0, stdout: `package:${APP_ID} uid:${secondaryUid}\n`, stderr: '' }
      if (args[0] === 'logcat') {
        return {
          code: 0,
          stdout: `1999999999.999 I/${crashFence}\n1000000000.000 crash line\n`,
          stderr: ''
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    }, { now: () => HOST_NOW_MS, sleep: async () => {} }, target, SECONDARY_INSTALL_LOG_FENCE)

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
      'run-as "$1" --user "$2" log -p i -t DEVHOTEL_CRASH_FENCE "$3" && exec am crash --user "$2" "$1"',
      'devhotel-crash', APP_ID, '10', crashFence
    ])
    expect(crashFence).toMatch(/^devhotel-crash-[0-9a-f-]{36}$/)
    expect(calls.find((args) => args[0] === 'logcat')).toEqual([
      'logcat', '-d', '-v', 'epoch,UTC,printable', `--uid=${secondaryUid}`
    ])
    expect(calls.some((args) => args[1] === 'date')).toBe(false)
  })

  it('scopes crash PID evidence to the exact Android user when the app runs for two users', async () => {
    const secondaryUid = 1_010_123
    let pidProbes = 0
    let crashFence = ''
    const { calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'pm' && args.includes('--uid')) {
        return { code: 0, stdout: `package:${APP_ID} uid:${secondaryUid}\n`, stderr: '' }
      }
      if (args[1] === 'pm' && args[2] === 'list') {
        return { code: 0, stdout: `package:${APP_ID} uid:${secondaryUid}\n`, stderr: '' }
      }
      if (args[1] === 'pgrep') {
        pidProbes += 1
        return pidProbes === 1
          ? { code: 0, stdout: '5678\n6789\n', stderr: '' }
          : { code: 1, stdout: '', stderr: '' }
      }
      if (args[1] === 'sh' && args[3]?.includes('exec am crash')) {
        crashFence = args.at(-1)!
        return { code: 0, stdout: 'Crash requested\n', stderr: '' }
      }
      if (args[0] === 'logcat') {
        return { code: 0, stdout: `${crashFence}\nsecondary crash row\n`, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    }, { sleep: async () => {} }, target, SECONDARY_INSTALL_LOG_FENCE)

    const result = await session.crashScenario({
      applicationId: APP_ID,
      scenario: 'am-crash',
      runId: 'two-users'
    })

    expect(result).toMatchObject({ observed: true, pidsBefore: [5678, 6789], pidsAfter: [] })
    expect(JSON.stringify(result)).not.toContain('1234')
    expect(calls.filter((args) => args[1] === 'pgrep')).toEqual([
      ['shell', 'pgrep', '-u', String(secondaryUid)],
      ['shell', 'pgrep', '-u', String(secondaryUid)]
    ])
    expect(calls.some((args) => args[1] === 'pidof')).toBe(false)
  })

  it('reads and mutates app locales only for the tracked numeric Android user', async () => {
    let applied = ['en-US']
    let pgrepCalls = 0
    let dispatchCallbackRan = false
    let setterRanBeforeDispatchCallback = false
    let setterAcknowledged = false
    let acceptedCallbackRan = false
    let postAckProbeRanBeforeCallback = false
    const { calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') {
        if (setterAcknowledged && !acceptedCallbackRan) postAckProbeRanBeforeCallback = true
        return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      }
      if (args[1] === 'getprop' && args[2] === 'ro.build.version.sdk') {
        return { code: 0, stdout: '34\n', stderr: '' }
      }
      if (args[1] === 'pm' && args[2] === 'list') {
        return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      }
      if (args[1] === 'cmd' && args[2] === 'locale' && args[3] === 'get-app-locales') {
        return { code: 0, stdout: `Locales for ${APP_ID} for user 0 are [${applied.join(',')}]\n`, stderr: '' }
      }
      if (args[1] === 'cmd' && args[2] === 'locale' && args[3] === 'set-app-locales') {
        if (!dispatchCallbackRan) setterRanBeforeDispatchCallback = true
        const index = args.indexOf('--locales')
        applied = index < 0 ? [] : [args[index + 1]!]
        setterAcknowledged = true
        return { code: 0, stdout: '', stderr: '' }
      }
      if (args[0] === 'get-state') return { code: 0, stdout: 'device\n', stderr: '' }
      if (args[1] === 'pgrep') {
        pgrepCalls += 1
        const pid = pgrepCalls === 1 ? 100 : pgrepCalls === 2 ? 101 : 102
        return { code: 0, stdout: `${pid}\n`, stderr: '' }
      }
      if (args[1] === 'sh' && args[3] === 'exec dumpsys window displays') {
        return { code: 0, stdout: `mCurrentFocus=Window{1 u0 ${APP_ID}/.MainActivity}\n`, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    }, { now: () => HOST_NOW_MS, sleep: async () => {} })

    const result = await session.applyAppLocalesAndWait(APP_ID, ['ko-KR'], {
      onBeforeMutation: () => {
        dispatchCallbackRan = true
      },
      onMutationAccepted: () => {
        acceptedCallbackRan = true
      }
    })

    expect(result).toMatchObject({
      apiLevel: 34,
      localeTags: ['ko-KR'],
      previousLocaleTags: ['en-US'],
      process: { beforePids: [100], afterPids: [102], restarted: true },
      readiness: { attempts: 3, consecutiveReadyChecks: 2, pids: [102] }
    })
    expect(calls).toContainEqual([
      'shell', 'cmd', 'locale', 'get-app-locales', APP_ID, '--user', '0'
    ])
    expect(calls).toContainEqual([
      'shell', 'cmd', 'locale', 'set-app-locales', APP_ID, '--user', '0', '--locales', 'ko-KR'
    ])
    expect(calls.filter((args) => args[1] === 'pgrep').every((args) => args.at(-1) === '10123')).toBe(true)
    expect(calls.some((args) => args.includes('current'))).toBe(false)
    expect(dispatchCallbackRan).toBe(true)
    expect(setterRanBeforeDispatchCallback).toBe(false)
    expect(acceptedCallbackRan).toBe(true)
    expect(postAckProbeRanBeforeCallback).toBe(false)
  })

  it('creates no locale command when an async pre-dispatch callback violates the synchronous contract', async () => {
    const { calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') {
        return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      }
      if (args[1] === 'getprop' && args[2] === 'ro.build.version.sdk') {
        return { code: 0, stdout: '34\n', stderr: '' }
      }
      if (args[1] === 'pm' && args[2] === 'list') {
        return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      }
      if (args[1] === 'cmd' && args[2] === 'locale' && args[3] === 'get-app-locales') {
        return { code: 0, stdout: `Locales for ${APP_ID} for user 0 are [en-US]\n`, stderr: '' }
      }
      if (args[1] === 'pgrep') return { code: 0, stdout: '100\n', stderr: '' }
      if (args[1] === 'sh' && args[3] === 'exec dumpsys window displays') {
        return { code: 0, stdout: `mCurrentFocus=Window{1 u0 ${APP_ID}/.MainActivity}\n`, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    const typeContract: Parameters<AndroidAutomationSession['applyAppLocalesAndWait']>[2] = {
      // @ts-expect-error async callbacks cannot satisfy the durable synchronous CAS contract
      onBeforeMutation: async () => undefined
    }
    expect(typeContract).toBeDefined()
    await expect(session.applyAppLocalesAndWait(APP_ID, ['ko-KR'], {
      onBeforeMutation: (async () => {
        throw new Error('late async dispatch rejection')
      }) as unknown as () => undefined
    })).rejects.toThrow('must complete synchronously')

    expect(calls.some((args) => args[1] === 'cmd' && args[3] === 'set-app-locales')).toBe(false)
  })

  it('runs no postflight probe when an async accepted hook violates the synchronous contract', async () => {
    let setterAcknowledged = false
    let postAcknowledgementProbes = 0
    const { calls, session } = setup((args) => {
      if (setterAcknowledged && args[1] === 'pm') postAcknowledgementProbes += 1
      if (args[1] === 'pm' && args[2] === 'path') {
        return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      }
      if (args[1] === 'getprop' && args[2] === 'ro.build.version.sdk') {
        return { code: 0, stdout: '34\n', stderr: '' }
      }
      if (args[1] === 'pm' && args[2] === 'list') {
        return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      }
      if (args[1] === 'cmd' && args[2] === 'locale' && args[3] === 'get-app-locales') {
        return { code: 0, stdout: `Locales for ${APP_ID} for user 0 are [en-US]\n`, stderr: '' }
      }
      if (args[1] === 'cmd' && args[2] === 'locale' && args[3] === 'set-app-locales') {
        setterAcknowledged = true
        return { code: 0, stdout: '', stderr: '' }
      }
      if (args[1] === 'pgrep') return { code: 0, stdout: '100\n', stderr: '' }
      if (args[1] === 'sh' && args[3] === 'exec dumpsys window displays') {
        return { code: 0, stdout: `mCurrentFocus=Window{1 u0 ${APP_ID}/.MainActivity}\n`, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.applyAppLocalesAndWait(APP_ID, ['ko-KR'], {
      onMutationAccepted: (async () => {
        throw new Error('late async acknowledgement rejection')
      }) as unknown as () => undefined
    })).rejects.toThrow('must complete synchronously')

    expect(calls.filter((args) => args[1] === 'cmd' && args[3] === 'set-app-locales')).toHaveLength(1)
    expect(postAcknowledgementProbes).toBe(0)
  })

  it('rejects an original locale that changes while the restorable snapshot is being sealed', async () => {
    let localeReads = 0
    const { calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'getprop' && args[2] === 'ro.build.version.sdk') return { code: 0, stdout: '34\n', stderr: '' }
      if (args[1] === 'pm' && args[2] === 'list') return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'cmd' && args[2] === 'locale' && args[3] === 'get-app-locales') {
        localeReads += 1
        return {
          code: 0,
          stdout: `Locales for ${APP_ID} for user 0 are [${localeReads === 1 ? 'en-US' : 'ko-KR'}]\n`,
          stderr: ''
        }
      }
      if (args[1] === 'pgrep') return { code: 0, stdout: '100\n', stderr: '' }
      if (args[1] === 'sh' && args[3] === 'exec dumpsys window displays') {
        return { code: 0, stdout: `mCurrentFocus=Window{1 u0 ${APP_ID}/.MainActivity}\n`, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.appLocaleSnapshot(APP_ID)).rejects.toMatchObject({
      code: 'ANDROID_LOCALE_TARGET_CHANGED'
    })
    expect(calls.some((args) => args[1] === 'cmd' && args[3] === 'set-app-locales')).toBe(false)
  })

  it('uses two complete release pulses and rejects a late foreground/PID drift', async () => {
    let pulseCalls = 0
    const releasePulse = (foregroundApplicationId: string, pids: string) => {
      const values = {
        api: '34',
        activeUser: '0',
        userDump: SYSTEM_USER_INCARNATION,
        paths: `package:${BASE_APK_PATH}`,
        stat: BASE_APK_STAT,
        sha: `${'a'.repeat(64)}  ${BASE_APK_PATH}`,
        uidRecord: `package:${APP_ID} uid:10123`,
        uidOwners: `package:${APP_ID} uid:10123`,
        locale: `Locales for ${APP_ID} for user 0 are [en-US]`,
        focus: `mCurrentFocus=Window{1 u0 ${foregroundApplicationId}/.MainActivity}`,
        pids,
        pgrepStatus: pids.length > 0 ? '0' : '1'
      }
      return Object.entries(values)
        .map(([key, value]) => `${key}=${Buffer.from(value).toString('base64')}`)
        .join('\n') + '\n'
    }
    const { session } = setup((args) => {
      if (args[1] === 'sh' && args[3]?.includes('emit pgrepStatus')) {
        pulseCalls += 1
        return {
          code: 0,
          stdout: pulseCalls === 1
            ? releasePulse(APP_ID, '101')
            : releasePulse('com.android.launcher', ''),
          stderr: ''
        }
      }
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'getprop' && args[2] === 'ro.build.version.sdk') return { code: 0, stdout: '34\n', stderr: '' }
      if (args[1] === 'pm' && args[2] === 'list') return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'cmd' && args[2] === 'locale' && args[3] === 'get-app-locales') {
        return { code: 0, stdout: `Locales for ${APP_ID} for user 0 are [en-US]\n`, stderr: '' }
      }
      if (args[1] === 'pgrep') return { code: 0, stdout: '100\n', stderr: '' }
      if (args[1] === 'sh' && args[3] === 'exec dumpsys window displays') {
        return { code: 0, stdout: `mCurrentFocus=Window{1 u0 ${APP_ID}/.MainActivity}\n`, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const initial = await session.appLocaleSnapshot(APP_ID)

    await expect(session.proveAppLocaleFinalState(APP_ID, initial.restoreFence))
      .rejects.toMatchObject({ code: 'ANDROID_LOCALE_TARGET_CHANGED' })
    expect(pulseCalls).toBe(2)
  })

  it('returns the stable PID set when the package filter also returns a prefixed sibling app', async () => {
    let pulseCalls = 0
    const values = {
      api: '34',
      activeUser: '0',
      userDump: SYSTEM_USER_INCARNATION,
      paths: `package:${BASE_APK_PATH}`,
      stat: BASE_APK_STAT,
      sha: `${'a'.repeat(64)}  ${BASE_APK_PATH}`,
      uidRecord: `package:${APP_ID} uid:10123\npackage:${APP_ID}.crashsample uid:10124`,
      uidOwners: `package:${APP_ID} uid:10123`,
      locale: `Locales for ${APP_ID} for user 0 are [en-US]`,
      focus: `mCurrentFocus=Window{1 u0 ${APP_ID}/.MainActivity}`,
      pids: '101\n102',
      pgrepStatus: '0'
    }
    const output = Object.entries(values)
      .map(([key, value]) => `${key}=${Buffer.from(value).toString('base64')}`)
      .join('\n') + '\n'
    const { calls, operations, session } = setup((args) => {
      if (args[1] === 'sh' && args[3]?.includes('emit pgrepStatus')) {
        pulseCalls += 1
        return { code: 0, stdout: output, stderr: '' }
      }
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'getprop' && args[2] === 'ro.build.version.sdk') return { code: 0, stdout: '34\n', stderr: '' }
      if (args[1] === 'pm' && args[2] === 'list') {
        return {
          code: 0,
          stdout: args.includes('--uid')
            ? `package:${APP_ID} uid:10123\n`
            : `package:${APP_ID} uid:10123\npackage:${APP_ID}.crashsample uid:10124\n`,
          stderr: ''
        }
      }
      if (args[1] === 'cmd' && args[2] === 'locale' && args[3] === 'get-app-locales') {
        return { code: 0, stdout: `Locales for ${APP_ID} for user 0 are [en-US]\n`, stderr: '' }
      }
      if (args[1] === 'pgrep') return { code: 0, stdout: '100\n', stderr: '' }
      if (args[1] === 'sh' && args[3] === 'exec dumpsys window displays') {
        return { code: 0, stdout: `mCurrentFocus=Window{1 u0 ${APP_ID}/.MainActivity}\n`, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const initial = await session.appLocaleSnapshot(APP_ID)

    await expect(session.proveAppLocaleFinalState(APP_ID, initial.restoreFence))
      .resolves.toMatchObject({ localeTags: ['en-US'], pids: [101, 102] })
    expect(pulseCalls).toBe(2)
    expect(calls.flatMap((args, index) =>
      isPhysicalAcceptanceProofReadCommand(args, operations[index])
        ? []
        : [{ args, operation: operations[index] }]
    )).toEqual([])
    const packageDumpIndex = operations.indexOf('Android package shared-UID declaration probe')
    const packageDump = calls[packageDumpIndex]!
    expect(packageDump[6]).toMatch(/^devhotel-package-dump-/)
    expect(isPhysicalAcceptanceProofReadCommand(
      [...packageDump.slice(0, 6), packageDump[6]!.slice('devhotel-package-dump-'.length)],
      operations[packageDumpIndex]
    )).toBe(false)
    expect(isPhysicalAcceptanceProofReadCommand(
      [...packageDump.slice(0, 6), `devhotel-package-dump-${'0'.repeat(36)}`],
      operations[packageDumpIndex]
    )).toBe(false)
    expect(isPhysicalAcceptanceProofReadCommand(
      ['shell', 'cmd', 'locale', 'set-app-locales', APP_ID, '--user', '0', '--locales', 'ko-KR'],
      'Android app locale mutation'
    )).toBe(false)
    expect(isPhysicalAcceptanceProofReadCommand(
      ['shell', 'am', 'start', '-W', '--user', '0', '-n', `${APP_ID}/.MainActivity`],
      'Android app launch'
    )).toBe(false)
    expect(isPhysicalAutomationReadCommand(
      ['shell', 'getprop', 'persist.sys.locale'],
      'Android locale probe'
    )).toBe(true)
    expect(isPhysicalAutomationReadCommand(['get-state'], 'ADB locale readiness probe')).toBe(true)
    expect(isPhysicalAutomationReadCommand(['get-state', 'unexpected'], 'ADB locale readiness probe')).toBe(false)
    expect(isPhysicalAutomationReadCommand(
      ['shell', 'some-new-oem-tool', '--wipe'],
      'new helper without an audited read contract'
    )).toBe(false)
  })

  it('rejects a reinstall that lands during the final locale snapshot read', async () => {
    let localeReads = 0
    let reinstalled = false
    const { session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'getprop' && args[2] === 'ro.build.version.sdk') return { code: 0, stdout: '34\n', stderr: '' }
      if (args[1] === 'pm' && args[2] === 'list') return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'cmd' && args[2] === 'locale' && args[3] === 'get-app-locales') {
        localeReads += 1
        if (localeReads === 2) reinstalled = true
        return { code: 0, stdout: `Locales for ${APP_ID} for user 0 are [en-US]\n`, stderr: '' }
      }
      if (args[1] === 'stat') {
        return { code: 0, stdout: `${reinstalled ? '103:4242:123456:1788157200:1788157202' : BASE_APK_STAT}\n`, stderr: '' }
      }
      if (args[1] === 'pgrep') return { code: 0, stdout: '100\n', stderr: '' }
      if (args[1] === 'sh' && args[3] === 'exec dumpsys window displays') {
        return { code: 0, stdout: `mCurrentFocus=Window{1 u0 ${APP_ID}/.MainActivity}\n`, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.appLocaleSnapshot(APP_ID)).rejects.toMatchObject({ code: 'ANDROID_APP_REPLACED' })
  })

  it('checks the expected previous locale immediately before mutation and normalizes PID order', async () => {
    let localeReads = 0
    let pgrepCalls = 0
    const { calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'getprop' && args[2] === 'ro.build.version.sdk') return { code: 0, stdout: '34\n', stderr: '' }
      if (args[1] === 'pm' && args[2] === 'list') return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'cmd' && args[2] === 'locale' && args[3] === 'get-app-locales') {
        localeReads += 1
        return {
          code: 0,
          stdout: `Locales for ${APP_ID} for user 0 are [${localeReads === 1 ? 'en-US' : 'fr-FR'}]\n`,
          stderr: ''
        }
      }
      if (args[1] === 'pgrep') {
        pgrepCalls += 1
        return { code: 0, stdout: pgrepCalls === 1 ? '200\n100\n' : '100\n200\n', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.applyAppLocalesAndWait(APP_ID, ['ko-KR'], {
      expectedPreviousLocaleTags: ['en-US']
    })).rejects.toMatchObject({ code: 'ANDROID_LOCALE_PRECONDITION_CHANGED' })
    expect(calls.some((args) => args[1] === 'cmd' && args[3] === 'set-app-locales')).toBe(false)

    localeReads = 0
    pgrepCalls = 0
    let applied = false
    const stable = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      if (args[1] === 'getprop' && args[2] === 'ro.build.version.sdk') return { code: 0, stdout: '34\n', stderr: '' }
      if (args[1] === 'pm' && args[2] === 'list') return { code: 0, stdout: `package:${APP_ID} uid:10123\n`, stderr: '' }
      if (args[1] === 'cmd' && args[2] === 'locale' && args[3] === 'get-app-locales') {
        return { code: 0, stdout: `Locales for ${APP_ID} for user 0 are [${applied ? 'ko-KR' : 'en-US'}]\n`, stderr: '' }
      }
      if (args[1] === 'cmd' && args[2] === 'locale' && args[3] === 'set-app-locales') {
        applied = true
        return { code: 0, stdout: '', stderr: '' }
      }
      if (args[0] === 'get-state') return { code: 0, stdout: 'device\n', stderr: '' }
      if (args[1] === 'pgrep') {
        pgrepCalls += 1
        return { code: 0, stdout: pgrepCalls === 1 ? '200\n100\n' : '100\n200\n', stderr: '' }
      }
      if (args[1] === 'sh' && args[3] === 'exec dumpsys window displays') {
        return { code: 0, stdout: `mCurrentFocus=Window{1 u0 ${APP_ID}/.MainActivity}\n`, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    }, { now: () => HOST_NOW_MS, sleep: async () => {} })
    const result = await stable.session.applyAppLocalesAndWait(APP_ID, ['ko-KR'], {
      expectedPreviousLocaleTags: ['en-US']
    })
    expect(result.process).toEqual({ beforePids: [100, 200], afterPids: [100, 200], restarted: false })
  })

  it('fails before locale mutation when the live API is unsupported', async () => {
    const { calls, session } = setup((args) => {
      if (args[1] === 'pm' && args[2] === 'path') {
        return { code: 0, stdout: `package:${BASE_APK_PATH}\n`, stderr: '' }
      }
      if (args[1] === 'getprop' && args[2] === 'ro.build.version.sdk') {
        return { code: 0, stdout: '32\n', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    await expect(session.appLocaleSnapshot(APP_ID)).rejects.toMatchObject({
      code: 'ANDROID_LOCALE_UNSUPPORTED'
    })
    expect(calls.some((args) => args[1] === 'cmd' && args[3] === 'set-app-locales')).toBe(false)
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
      packageIncarnation: 'b'.repeat(64), logFence: null, installUserId: 0, installUserSerial: INSTALL_USER_SERIAL
    })
    installs.record({
      roomId: 'bbbb2222', target: secondLease, applicationId: APP_ID,
      changeId: '31111111-2222-4333-8444-555555555555', apkSha256: 'c'.repeat(64), installedAt: INSTALLED_AT,
      packageIncarnation: 'c'.repeat(64), logFence: null, installUserId: 0, installUserSerial: INSTALL_USER_SERIAL
    })

    expect(installs.get('aaaa1111', firstLease, APP_ID)).toBeNull()
    expect(installs.get('bbbb2222', firstLease, APP_ID)).toBeNull()
    expect(installs.get('bbbb2222', secondLease, APP_ID)?.apkSha256).toBe('c'.repeat(64))
  })
})

describe('screen witness budgets', () => {
  /** Measured against a managed emulator on Docker Desktop: one marker is a whole helper. */
  const MEASURED_MARKER_ROUND_TRIP_MS = 4_500

  it('gives the bootstrap enough room for every attempt it is allowed to make', () => {
    // Each bootstrap marker is a whole fenced helper container round trip —
    // measured at ~4.5s against a managed emulator on Docker Desktop. A budget
    // that cannot cover the retries it permits aborts the witness before it has
    // tried, which is how every screen-sensitive action started failing with
    // ANDROID_SCREEN_WITNESS_FAILED on a healthy emulator.
    expect(SCREEN_WITNESS_READY_TIMEOUT_MS).toBeGreaterThanOrEqual(
      SCREEN_WITNESS_BOOTSTRAP_ATTEMPTS * (MEASURED_MARKER_ROUND_TRIP_MS + SCREEN_WITNESS_BOOTSTRAP_RETRY_MS)
    )
    // …and still fit inside the window that surrounds the caller's action.
    expect(SCREEN_WITNESS_READY_TIMEOUT_MS).toBeLessThan(SCREEN_WITNESS_NON_ACTION_BUDGET_MS)
  })

  it('gives a witnessed action room for the round trips it is made of', () => {
    // `android_dump_ui` alone spends an active-user proof, the dump, a
    // tracked-install proof and a foreground proof — each one a fenced helper
    // container. A budget sized for a single adb call expires mid-action and is
    // then reported as if the active user had changed underneath.
    expect(DEFAULT_SCREEN_WITNESS_ACTION_TIMEOUT_MS).toBeGreaterThanOrEqual(
      8 * MEASURED_MARKER_ROUND_TRIP_MS
    )
    // The validator refuses anything above two minutes.
    expect(DEFAULT_SCREEN_WITNESS_ACTION_TIMEOUT_MS).toBeLessThanOrEqual(120_000)
  })
})
