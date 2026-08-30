import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoomOrchestrator } from '../orchestrator'
import type { Db } from '../store/db'
import { FakeAdbHost, FakeBackend, FakeGateway, makeRoom, tempDir, testDb } from './fakes'

const TEST_BASE_APK = '/data/app/base.apk'
const TEST_BASE_STAT = '103:4242:123456:1788157200:1788157201'
const TEST_APK_SHA = createHash('sha256').update('fake-room-file').digest('hex')
const TEST_PACKAGE_INCARNATION = createHash('sha256')
  .update('devhotel-android-package-incarnation\0')
  .update(TEST_BASE_APK)
  .update('\0')
  .update(TEST_BASE_STAT)
  .digest('hex')

function logicalAdbArgs(args: string[]): string[] {
  if (args[0] !== 'shell' || args.length !== 2 || !args[1]?.startsWith("'") || !args[1].endsWith("'")) return args
  return [
    'shell',
    ...args[1]
      .slice(1, -1)
      .split("' '")
      .map((value) => value.replaceAll("'\\''", "'"))
  ]
}

function roomAndroidArgs(command: string[]): string[] | null {
  if (command[0] !== 'adb' || command[1] !== '-s' || command.length < 4) return null
  return logicalAdbArgs(command.slice(3))
}

function installEvidenceResult(args: string[], state: { fence: string; apkSha256?: string }): { code: number; stdout: string; stderr: string } | null {
  const logical = logicalAdbArgs(args)
  if (logical[1] === 'pm' && logical[2] === 'path') {
    return { code: 0, stdout: `package:${TEST_BASE_APK}\n`, stderr: '' }
  }
  if (logical[1] === 'sh' && logical[3]?.startsWith('dumpsys package "$1"')) {
    return {
      code: 0,
      stdout: [
        'Packages:',
        '  Package [com.example.app] (abc123):',
        '    userId=10123',
        '    pkg=Package{abc123 com.example.app}',
        `    codePath=${TEST_BASE_APK}`,
        '',
        logical.at(-1),
        ''
      ].join('\n'),
      stderr: ''
    }
  }
  if (logical[1] === 'stat') return { code: 0, stdout: `${TEST_BASE_STAT}\n`, stderr: '' }
  if (logical[1] === 'sha256sum') {
    return { code: 0, stdout: `${state.apkSha256 ?? TEST_APK_SHA}  ${TEST_BASE_APK}\n`, stderr: '' }
  }
  if (logical[1] === 'pm' && logical[2] === 'list') {
    return { code: 0, stdout: 'package:com.example.app uid:10123\n', stderr: '' }
  }
  if (logical[1] === 'run-as') {
    state.fence = logical.at(-1) ?? ''
    return { code: 0, stdout: '', stderr: '' }
  }
  if (logical[0] === 'logcat' && logical.includes('raw,printable')) {
    return { code: 0, stdout: `${state.fence}\n`, stderr: '' }
  }
  return null
}

describe('Rooms attach and release the shared phone', () => {
  const dirs: string[] = []
  const dbs: Db[] = []

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function setup() {
    const userData = tempDir()
    dirs.push(userData)
    const db = testDb()
    dbs.push(db)
    const backend = new FakeBackend()
    const gateway = new FakeGateway()
    const adb = new FakeAdbHost([
      { serial: 'R5CT30ABCDE', state: 'device', model: 'SM_G991N', release: '14', sdk: '34' },
      { serial: 'R5CT30ZZZZZ', state: 'device', model: 'Pixel_7', release: '15', sdk: '35' }
    ])
    const orch = new RoomOrchestrator({ userData, backend, gateway: gateway.asGateway(), db, appVersion: 'test', adb })
    return { backend, gateway, orch, adb }
  }

  function androidRoom(id: string, project: string) {
    return makeRoom({
      id,
      project,
      nickname: 'dev',
      domain: `${project.toLowerCase()}-dev.localhost`,
      provider: 'android',
      sourceType: 'empty',
      sourceRef: '',
      workspaceMode: 'empty',
      syncStatus: 'empty',
      runtime: { kind: 'jdk', version: '17' },
      packageManager: { kind: 'gradle' },
      startCommand: 'gradle assembleDebug --no-daemon',
      internalPort: 6080,
      status: 'ready',
      hostPort: 45000
    })
  }

  it('attaches a phone to a Room and reports the lease on the Room', async () => {
    const { orch } = setup()
    orch.rooms.create(androidRoom('aaaa1111', 'AppDied'))
    await orch.refreshAndroidDevices()

    const result = await orch.attachAndroidDevice('aaaa1111', { purpose: 'acceptance', workerId: 'worker-a' })

    expect(result.state).toBe('granted')
    if (result.state !== 'granted') throw new Error('unreachable')
    expect(result.device).not.toHaveProperty('serial')
    const inspection = orch.inspectRoom('aaaa1111')
    expect(inspection.device).toMatchObject({ deviceId: result.device.id, project: 'AppDied', purpose: 'acceptance' })
    expect(JSON.stringify(inspection)).not.toContain(result.lease.id)
    expect(JSON.stringify(inspection)).not.toContain('worker-a')
  })

  it('queues the second Room and tells it who is holding the phone', async () => {
    const { orch } = setup()
    orch.rooms.create(androidRoom('aaaa1111', 'AppDied'))
    orch.rooms.create(androidRoom('bbbb2222', 'MiracleKeyboard'))
    await orch.refreshAndroidDevices()
    const first = await orch.attachAndroidDevice('aaaa1111', { purpose: 'acceptance', workerId: 'worker-a' })
    if (first.state !== 'granted') throw new Error('unreachable')

    // Both Rooms ask for the SAME phone, so the second one has to wait.
    const second = await orch.attachAndroidDevice('bbbb2222', {
      purpose: 'keyboard',
      workerId: 'worker-b',
      constraints: { deviceId: first.lease.deviceId }
    })

    expect(second.state).toBe('queued')
    if (second.state !== 'queued') throw new Error('unreachable')
    expect(second.owner?.project).toBe('AppDied')
    expect(second.position).toBe(1)
    const publicStatus = JSON.stringify(orch.androidDeviceStatus())
    expect(publicStatus).not.toContain(first.lease.id)
    expect(publicStatus).not.toContain(second.requestId)
  })

  it('gives the phone up when the Room goes to sleep', async () => {
    const { orch } = setup()
    orch.rooms.create(androidRoom('aaaa1111', 'AppDied'))
    orch.rooms.create(androidRoom('bbbb2222', 'MiracleKeyboard'))
    await orch.refreshAndroidDevices()
    const first = await orch.attachAndroidDevice('aaaa1111', { purpose: 'acceptance', workerId: 'worker-a' })
    if (first.state !== 'granted') throw new Error('unreachable')
    await orch.attachAndroidDevice('bbbb2222', {
      purpose: 'keyboard',
      workerId: 'worker-b',
      constraints: { deviceId: first.lease.deviceId }
    })

    await orch.sleepRoom('aaaa1111', 'user')

    expect(orch.inspectRoom('aaaa1111').device).toBeNull()
    expect(orch.inspectRoom('bbbb2222').device).toMatchObject({ project: 'MiracleKeyboard', purpose: 'keyboard' })
  })

  it('cancels a crash-left waiter for a broken Room and promotes the next eligible Room', async () => {
    const { orch } = setup()
    orch.rooms.create(androidRoom('aaaa1111', 'Owner'))
    orch.rooms.create(androidRoom('bbbb2222', 'BrokenWaiter'))
    orch.rooms.create(androidRoom('cccc3333', 'LiveWaiter'))
    await orch.refreshAndroidDevices()
    const owner = await orch.attachAndroidDevice('aaaa1111', { purpose: 'smoke', workerId: 'worker-a' })
    if (owner.state !== 'granted') throw new Error('unreachable')
    await orch.attachAndroidDevice('bbbb2222', {
      purpose: 'acceptance', workerId: 'worker-b', constraints: { deviceId: owner.device.id }
    })
    await orch.attachAndroidDevice('cccc3333', {
      purpose: 'acceptance', workerId: 'worker-c', constraints: { deviceId: owner.device.id }
    })
    // Simulate a crash persisting the Room lifecycle before its queue cleanup.
    orch.rooms.update('bbbb2222', { status: 'broken' })

    await orch.releaseAndroidDevice('aaaa1111', 'owner finished')

    expect(orch.devices.leaseForRoom('bbbb2222')).toBeNull()
    expect(orch.devices.leaseForRoom('cccc3333')).toMatchObject({ project: 'LiveWaiter' })
    expect(orch.androidDeviceStatus().recentEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'cancelled', roomId: 'bbbb2222' })
    ]))
  })

  it('gives the phone up when the Room is deleted', async () => {
    const { orch } = setup()
    orch.rooms.create(androidRoom('aaaa1111', 'AppDied'))
    await orch.refreshAndroidDevices()
    const attached = await orch.attachAndroidDevice('aaaa1111', { purpose: 'acceptance', workerId: 'worker-a' })
    if (attached.state !== 'granted') throw new Error('unreachable')

    await orch.deleteRoom('aaaa1111', 'user')

    const device = orch.androidDeviceStatus().devices.find((entry) => entry.id === attached.lease.deviceId)
    expect(device?.leaseOwner).toBeNull()
  })

  it('shows connected phones, owners and queue in the Hotel status', async () => {
    const { orch } = setup()
    orch.rooms.create(androidRoom('aaaa1111', 'AppDied'))
    await orch.refreshAndroidDevices()
    await orch.attachAndroidDevice('aaaa1111', { purpose: 'acceptance', workerId: 'worker-a' })

    const status = await orch.hotelStatus()

    expect(status.devices.devices).toHaveLength(2)
    expect(status.devices.devices[0]).not.toHaveProperty('serial')
    expect(status.devices.devices.filter((device) => device.leaseOwner !== null)).toHaveLength(1)
    expect(status.devices.recentEvents.some((event) => event.kind === 'granted')).toBe(true)
  })
})

describe('Android automation targets the attached device without a hand-written serial', () => {
  const dirs: string[] = []
  const dbs: Db[] = []

  afterEach(() => {
    vi.useRealTimers()
    for (const db of dbs.splice(0)) db.close()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function setup() {
    const userData = tempDir()
    dirs.push(userData)
    const db = testDb()
    dbs.push(db)
    const backend = new FakeBackend()
    const gateway = new FakeGateway()
    const adb = new FakeAdbHost([{ serial: 'R5CT30ABCDE', state: 'device', model: 'SM_G991N', release: '14', sdk: '34' }])
    const orch = new RoomOrchestrator({ userData, backend, gateway: gateway.asGateway(), db, appVersion: 'test', adb })
    const room = makeRoom({
      id: 'aaaa1111',
      project: 'AppDied',
      provider: 'android',
      sourceType: 'empty',
      sourceRef: '',
      workspaceMode: 'empty',
      syncStatus: 'empty',
      runtime: { kind: 'jdk', version: '17' },
      packageManager: { kind: 'gradle' },
      startCommand: 'gradle assembleDebug --no-daemon',
      internalPort: 6080,
      status: 'ready',
      hostPort: 45000
    })
    orch.rooms.create(room)
    return { orch, adb, backend, userData }
  }

  it('resolves to the Room-owned emulator when no phone is attached', async () => {
    const { orch } = setup()
    await orch.refreshAndroidDevices()

    const target = await orch.resolveAdbTarget('aaaa1111')
    expect(target).toMatchObject({ kind: 'emulator', deviceId: null })
    expect(target).not.toHaveProperty('serial')
  })

  it('resolves to the leased phone once one is attached', async () => {
    const { orch } = setup()
    await orch.refreshAndroidDevices()
    await orch.attachAndroidDevice('aaaa1111', { purpose: 'acceptance', workerId: 'worker-a' })

    const target = await orch.resolveAdbTarget('aaaa1111')
    expect(target).toMatchObject({ kind: 'physical', deviceId: expect.any(String), nickname: expect.any(String) })
    expect(target).not.toHaveProperty('serial')
  })

  it('quotes every physical adb-shell argument as one remote command without interpreting caller text', async () => {
    const { orch, adb } = setup()
    await orch.refreshAndroidDevices()
    const attached = await orch.attachAndroidDevice('aaaa1111', { purpose: 'acceptance', workerId: 'worker-a' })
    if (attached.state !== 'granted') throw new Error('unreachable')
    orch.androidInstalls.record({
      roomId: 'aaaa1111',
      target: {
        kind: 'physical', targetId: attached.device.id, deviceId: attached.device.id, leaseId: attached.lease.id
      },
      applicationId: 'com.example.app',
      changeId: '11111111-2222-4333-8444-555555555555',
      apkSha256: 'a'.repeat(64),
      installedAt: '2026-08-31T00:00:00.000Z',
      packageIncarnation: TEST_PACKAGE_INCARNATION,
      logFence: null
    })
    adb.execs = []
    adb.execResultFor = (_serial, args) =>
      installEvidenceResult(args, { fence: '', apkSha256: 'a'.repeat(64) })
    const hostile = "quote' $HOME; $(id)\nnext"

    await orch.androidLaunchApp('aaaa1111', {
      applicationId: 'com.example.app',
      activity: '.MainActivity',
      extras: { label: hostile },
      target: { kind: 'physical', deviceId: attached.device.id }
    })

    const launch = adb.execs.find((call) => call.args[0] === 'shell' && call.args[1]?.includes("'am' 'start'"))
    expect(launch?.args).toEqual([
      'shell',
      "'am' 'start' '-W' '--user' 'current' '-n' 'com.example.app/.MainActivity' '--es' 'label' 'quote'\\'' $HOME; $(id)\nnext'"
    ])
    expect(launch?.args).toHaveLength(2)
  })

  it('uses the same one-string shell quoting for the Room emulator executor', async () => {
    const { orch, backend } = setup()
    backend.emulatorStateValue = 'running'
    orch.androidInstalls.record({
      roomId: 'aaaa1111',
      target: { kind: 'emulator', targetId: 'aaaa1111', deviceId: null },
      applicationId: 'com.example.app',
      changeId: '11111111-2222-4333-8444-555555555555',
      apkSha256: 'a'.repeat(64),
      installedAt: '2026-08-31T00:00:00.000Z',
      packageIncarnation: TEST_PACKAGE_INCARNATION,
      logFence: null
    })
    backend.execInRoomCalls = []
    backend.execInRoomHandler = (_roomId, command) => {
      const androidArgs = roomAndroidArgs(command)
      if (!androidArgs) return { code: 0, stdout: '', stderr: '' }
      return installEvidenceResult(androidArgs, { fence: '', apkSha256: 'a'.repeat(64) }) ??
        { code: 0, stdout: 'Status: ok\n', stderr: '' }
    }
    const hostile = "quote' $HOME; $(id)\nnext"

    await orch.androidLaunchApp('aaaa1111', {
      applicationId: 'com.example.app',
      activity: '.MainActivity',
      extras: { label: hostile },
      target: { kind: 'emulator' }
    })

    const launch = backend.execInRoomCalls.find((call) =>
      call.cmd[0] === 'adb' && call.cmd[4]?.includes("'am' 'start'")
    )
    expect(launch?.cmd).toEqual([
      'adb', '-s', 'emulator-5554', 'shell',
      "'am' 'start' '-W' '--user' 'current' '-n' 'com.example.app/.MainActivity' '--es' 'label' 'quote'\\'' $HOME; $(id)\nnext'"
    ])
  })

  it('fails an attached physical run when that phone becomes unhealthy instead of using the emulator', async () => {
    const { orch, adb, backend } = setup()
    await orch.refreshAndroidDevices()
    await orch.attachAndroidDevice('aaaa1111', { purpose: 'acceptance', workerId: 'worker-a' })
    adb.execs = []
    adb.phones = [{ serial: 'R5CT30ABCDE', state: 'offline', model: 'SM_G991N', release: '14', sdk: '34' }]
    await orch.refreshAndroidDevices()
    backend.execInRoomCalls = []

    await expect(orch.resolveAdbTarget('aaaa1111')).rejects.toMatchObject({ code: 'device-unhealthy' })
    await expect(orch.applyChange('aaaa1111', { kind: 'android-run' }, 'user')).rejects.toMatchObject({
      code: 'device-unhealthy'
    })
    expect(adb.execs).toEqual([])
    expect(backend.execInRoomCalls.some((call) => call.cmd.join(' ').includes('gradle assembleDebug'))).toBe(false)
  })

  it('keeps a disconnected physical proof target sticky until explicit release', async () => {
    const { orch, adb, backend } = setup()
    await orch.refreshAndroidDevices()
    await orch.attachAndroidDevice('aaaa1111', { purpose: 'acceptance', workerId: 'worker-a' })
    adb.phones = []
    await orch.refreshAndroidDevices()
    backend.execInRoomCalls = []

    expect(orch.inspectRoom('aaaa1111').device).toBeNull()
    await expect(orch.resolveAdbTarget('aaaa1111')).rejects.toMatchObject({ code: 'device-unhealthy' })
    await expect(orch.applyChange('aaaa1111', { kind: 'android-run' }, 'user')).rejects.toMatchObject({
      code: 'device-unhealthy'
    })
    expect(backend.execInRoomCalls.some((call) => call.cmd.join(' ').includes('gradle assembleDebug'))).toBe(false)

    await orch.releaseAndroidDevice('aaaa1111', 'switch back to emulator explicitly')
    await expect(orch.resolveAdbTarget('aaaa1111')).resolves.toMatchObject({ kind: 'emulator', deviceId: null })
  })

  it('stages Room APK bytes in a private Host temp before installing, then removes them', async () => {
    const { orch, adb, backend, userData } = setup()
    await orch.refreshAndroidDevices()
    await orch.attachAndroidDevice('aaaa1111', { purpose: 'acceptance', workerId: 'worker-a' })
    adb.execs = []
    let stagedPath = ''
    adb.execHook = (_serial, args) => {
      if (args[0] !== 'install') return
      stagedPath = args[2]!
      expect(stagedPath).not.toContain('/workspace/')
      expect(stagedPath.startsWith(join(userData, 'tmp', 'device-adb-'))).toBe(true)
      expect(existsSync(stagedPath)).toBe(true)
      expect(readFileSync(stagedPath, 'utf8')).toBe('fake-room-file')
    }

    const result = await orch.adbOnDevice('aaaa1111', ['install', '-r', '/workspace/app/build/outputs/apk/debug/app-debug.apk'])

    expect(result.code).toBe(0)
    expect(backend.calls).toContain('copyFromRoom:/workspace/app/build/outputs/apk/debug/app-debug.apk')
    expect(adb.execs).toEqual([{ serial: 'R5CT30ABCDE', args: ['install', '-r', stagedPath] }])
    expect(stagedPath).not.toBe('')
    expect(existsSync(stagedPath)).toBe(false)
  })

  it.each([
    { label: 'succeeds', code: 0 },
    { label: 'fails', code: 1 }
  ])('revokes every exact-target receipt before a raw physical install $label', async ({ code }) => {
    const { orch, adb } = setup()
    await orch.refreshAndroidDevices()
    const attached = await orch.attachAndroidDevice('aaaa1111', { purpose: 'acceptance', workerId: 'worker-a' })
    if (attached.state !== 'granted') throw new Error('unreachable')
    const target = {
      kind: 'physical' as const,
      targetId: attached.device.id,
      deviceId: attached.device.id,
      leaseId: attached.lease.id
    }
    for (const [index, applicationId] of ['com.example.app', 'com.example.companion'].entries()) {
      orch.androidInstalls.record({
        roomId: 'aaaa1111',
        target,
        applicationId,
        changeId: `11111111-2222-4333-8444-55555555555${index}`,
        apkSha256: 'a'.repeat(64),
        installedAt: '2026-08-31T00:00:00.000Z',
        packageIncarnation: TEST_PACKAGE_INCARNATION,
        logFence: null
      })
    }
    adb.execResultFor = (_serial, args) => args[0] === 'install'
      ? { code, stdout: code === 0 ? 'Success\n' : '', stderr: code === 0 ? '' : 'Failure\n' }
      : null

    const result = await orch.adbOnDevice(
      'aaaa1111',
      ['install', '-r', '/workspace/app/build/outputs/apk/debug/app-debug.apk']
    )

    expect(result.code).toBe(code)
    expect(orch.androidInstalls.list('aaaa1111', target)).toEqual([])
  })

  it('maps private staging paths back to Room paths in every adb result', async () => {
    const { orch, adb, userData } = setup()
    await orch.refreshAndroidDevices()
    await orch.attachAndroidDevice('aaaa1111', { purpose: 'acceptance', workerId: 'worker-a' })
    adb.execResultFor = (_serial, args) => {
      const privatePath = args.at(-1)!
      return {
        code: 1,
        stdout: `failed to inspect ${privatePath.replaceAll('\\', '/')}\n`,
        stderr: `adb: failed to stat ${privatePath}\n`
      }
    }

    const roomPath = '/workspace/app/build/outputs/apk/debug/broken.apk'
    const result = await orch.adbOnDevice('aaaa1111', ['install', '-r', roomPath])

    expect(result.stdout).toContain(roomPath)
    expect(result.stderr).toContain(roomPath)
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(userData)
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/device-adb-/)
  })

  it('rejects a staged APK link before Host adb can dereference it', async () => {
    const { orch, adb, backend, userData } = setup()
    await orch.refreshAndroidDevices()
    await orch.attachAndroidDevice('aaaa1111', { purpose: 'acceptance', workerId: 'worker-a' })
    adb.execs = []
    const outside = join(userData, 'outside-staging-target')
    mkdirSync(outside)
    backend.copyFromRoomHook = (_roomId, _roomPath, hostPath) => {
      symlinkSync(outside, hostPath, process.platform === 'win32' ? 'junction' : 'dir')
    }

    await expect(
      orch.adbOnDevice('aaaa1111', ['install', '-r', '/workspace/app/build/outputs/apk/debug/app-debug.apk'])
    ).rejects.toThrow(/non-regular|escaped/)

    expect(adb.execs).toEqual([])
    expect(existsSync(outside)).toBe(true)
  })

  it('fences a staged install to the exact lease captured before copying bytes', async () => {
    const { orch, adb, backend, userData } = setup()
    await orch.refreshAndroidDevices()
    const first = await orch.attachAndroidDevice('aaaa1111', { purpose: 'acceptance', workerId: 'worker-a' })
    if (first.state !== 'granted') throw new Error('unreachable')
    adb.execs = []
    backend.copyFromRoomHook = async () => {
      backend.copyFromRoomHook = null
      await orch.devices.release(first.lease.id, 'replace lease during staging')
      const replacement = await orch.devices.requestDevice({
        roomId: 'aaaa1111',
        project: 'AppDied',
        purpose: 'acceptance',
        workerId: 'worker-b',
        constraints: { deviceId: first.lease.deviceId }
      })
      expect(replacement.state).toBe('granted')
      if (replacement.state === 'granted') expect(replacement.lease.id).not.toBe(first.lease.id)
    }

    await expect(
      orch.adbOnDevice('aaaa1111', ['install', '-r', '/workspace/app/build/outputs/apk/debug/app-debug.apk'])
    ).rejects.toMatchObject({ code: 'lease-expired' })

    expect(adb.execs).toEqual([])
    const tmpEntries = existsSync(join(userData, 'tmp')) ? readdirSync(join(userData, 'tmp')) : []
    expect(tmpEntries).toEqual([])
  })

  it('rejects Host APK paths and every leading ADB target-selector form', async () => {
    const { orch, adb } = setup()
    await orch.refreshAndroidDevices()
    await orch.attachAndroidDevice('aaaa1111', { purpose: 'acceptance', workerId: 'worker-a' })
    adb.execs = []

    await expect(orch.adbOnDevice('aaaa1111', ['install', '-r', 'C:\\tmp\\app.apk'])).rejects.toThrow(/only from \/workspace|Host/)
    await expect(
      orch.adbOnDevice('aaaa1111', ['install-multiple', '/workspace/app.apk', '/tmp/secret-without-extension'])
    ).rejects.toThrow(/Host/)
    await expect(
      orch.adbOnDevice('aaaa1111', ['install-multiple', '/workspace/app.apk', '..\\payload.bin'])
    ).rejects.toThrow(/relative|Host/)
    await expect(
      orch.adbOnDevice('aaaa1111', ['install-multiple', '/workspace/app.apk', 'payload.bin'])
    ).rejects.toThrow(/relative|Host/)
    await expect(
      orch.adbOnDevice('aaaa1111', ['install', '-r', '--local-agent', 'payload.bin', '/workspace/app.apk'])
    ).rejects.toThrow(/approved flags|Host/)
    await expect(orch.adbOnDevice('aaaa1111', ['-s', 'OTHER', 'get-state'])).rejects.toThrow(/target-selector/)
    await expect(orch.adbOnDevice('aaaa1111', ['-sOTHER', 'get-state'])).rejects.toThrow(/target-selector/)
    await expect(orch.adbOnDevice('aaaa1111', ['--one-device=OTHER', 'get-state'])).rejects.toThrow(/target-selector/)
    await expect(orch.adbOnDevice('aaaa1111', ['-d', 'get-state'])).rejects.toThrow(/target-selector/)
    await expect(orch.adbOnDevice('aaaa1111', ['-e', 'get-state'])).rejects.toThrow(/target-selector/)
    await expect(orch.adbOnDevice('aaaa1111', ['-t', '1', 'get-state'])).rejects.toThrow(/target-selector/)
    await expect(orch.adbOnDevice('aaaa1111', ['-Hlocalhost', 'get-state'])).rejects.toThrow(/target-selector/)
    await expect(orch.adbOnDevice('aaaa1111', ['--exit-on-write-error', 'get-state'])).rejects.toThrow(/target-selector/)
    expect(adb.execs).toEqual([])
  })

  it('hard-denies Host-wide and serial queries for the lease holder, and redacts serial text from allowed output', async () => {
    const { orch, adb } = setup()
    await orch.refreshAndroidDevices()
    await orch.attachAndroidDevice('aaaa1111', { purpose: 'acceptance', workerId: 'worker-a' })
    adb.execs = []

    for (const args of [
      ['kill-server'],
      ['devices', '-l'],
      ['forward', '--list'],
      ['get-serialno'],
      ['shell', 'getprop'],
      ['shell', 'getprop', 'ro.serialno'],
      ['exec-out', 'getprop', 'ro.boot.serialno'],
      ['shell', '/system/bin/getprop', 'ro.serialno'],
      ['shell', 'sh', '-c', 'getprop ro.serialno | base64'],
      ['shell', 'dumpsys'],
      ['shell', 'dumpsys', 'package', 'com.example.app'],
      ['shell', 'pm', 'list', 'packages'],
      ['shell', 'ps', '-A'],
      ['shell', 'pidof', 'com.example.app'],
      ['logcat'],
      ['logcat', '-d'],
      ['exec-out', 'screencap', '-p'],
      ['jdwp'],
      ['tcpip', '5555'],
      ['shell', 'settings', 'put', 'global', 'adb_enabled', '0'],
      ['shell', 'settings', '--user', '0', 'delete', 'secure', 'adb_enabled'],
      ['shell', 'content', 'insert', '--uri', 'content://settings/global', '--bind', 'name:s:adb_enabled'],
      ['shell', 'content', 'call', '--uri', 'content://settings/global', '--method', 'PUT_global'],
      ['shell', 'device_config', 'put', 'adb', 'mdns_enabled', 'false'],
      ['shell', 'device_config', 'set_sync_disabled_for_tests', 'persistent'],
      ['shell', 'cmd', 'settings', 'put', 'global', 'adb_enabled', '0'],
      ['shell', 'setprop', 'persist.sys.usb.config', 'none'],
      ['shell', 'am', 'hang'],
      ['shell', 'am', 'restart']
    ]) {
      await expect(orch.adbOnDevice('aaaa1111', args)).rejects.toMatchObject({ code: 'adb-command-forbidden' })
    }
    expect(adb.execs).toEqual([])

    adb.execResultFor = () => ({
      code: 1,
      stdout: 'device R5CT30ABCDE reported a value\n',
      stderr: 'transport r5ct30abcde failed\n'
    })
    const result = await orch.adbOnDevice('aaaa1111', ['get-state'])
    expect(result.stdout).toContain('[device-serial-redacted]')
    expect(result.stderr).toContain('[device-serial-redacted]')
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/R5CT30ABCDE/i)
  })

  it('refuses an interfering ADB command from a Room with no lease, and never reaches the phone', async () => {
    const { orch, adb } = setup()
    await orch.refreshAndroidDevices()
    const deviceId = orch.androidDeviceStatus().devices[0]!.id
    adb.execs = []

    await expect(
      orch.adbOnDevice('aaaa1111', ['install', '-r', '/workspace/app/build/outputs/apk/debug/app-debug.apk'], { deviceId })
    ).rejects.toThrow(/needs a device lease/)
    expect(adb.execs).toEqual([])
  })

  it('automatically installs and launches android-run on the attached phone', async () => {
    const { orch, adb, backend } = setup()
    await orch.refreshAndroidDevices()
    const attached = await orch.attachAndroidDevice('aaaa1111', { purpose: 'acceptance', workerId: 'worker-a' })
    if (attached.state !== 'granted') throw new Error('unreachable')
    adb.execs = []
    backend.execInRoomCalls = []
    backend.execInRoomHandler = (_roomId, cmd) => {
      const command = cmd.at(-1) ?? ''
      if (command.includes('find /workspace')) {
        return { code: 0, stdout: '/workspace/app/build/outputs/apk/debug/output-metadata.json\n', stderr: '' }
      }
      if (command.startsWith("cat '/workspace/")) {
        return {
          code: 0,
          stdout: JSON.stringify({ applicationId: 'com.example.app', elements: [{ outputFile: 'My 앱-$&-debug.APK' }] }),
          stderr: ''
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    const installEvidence = { fence: '' }
    adb.execResultFor = (_serial, args) => {
      const evidence = installEvidenceResult(args, installEvidence)
      if (evidence) return evidence
      const logical = logicalAdbArgs(args)
      if (logical[0] === 'shell' && logical[1] === 'cmd') {
        return { code: 0, stdout: 'com.example.app/.MainActivity\n', stderr: '' }
      }
      return logical[0] === 'shell' && logical[1] === 'pidof' ? { code: 0, stdout: '1234\n', stderr: '' } : null
    }

    const entry = await orch.applyChange('aaaa1111', { kind: 'android-run' }, 'user')

    expect(entry.status).toBe('verified')
    expect(entry.verify?.detail).toMatch(/running on SM-G991N-01/)
    expect(orch.androidInstalls.list('aaaa1111', {
      kind: 'physical', targetId: attached.device.id, deviceId: attached.device.id, leaseId: attached.lease.id
    })).toEqual([
      expect.objectContaining({
        roomId: 'aaaa1111',
        applicationId: 'com.example.app',
        changeId: entry.id,
        apkSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
    ])
    expect(installEvidence.fence).toMatch(/^devhotel-install-[0-9a-f-]{36}$/)
    expect(backend.calls).toContain('copyFromRoom:/workspace/app/build/outputs/apk/debug/My 앱-$&-debug.APK')
    expect(adb.execs.find((call) => call.args[0] === 'install')?.args[2]).not.toContain('/workspace/')
    expect(adb.execs.find((call) => logicalAdbArgs(call.args)[1] === 'am')?.serial).toBe('R5CT30ABCDE')
    expect(backend.execInRoomCalls.some((call) => call.cmd.at(-1)?.includes('emulator-5554'))).toBe(false)
  })

  it('refuses to launch a component resolved for a different package', async () => {
    const { orch, adb, backend } = setup()
    await orch.refreshAndroidDevices()
    await orch.attachAndroidDevice('aaaa1111', { purpose: 'acceptance', workerId: 'worker-a' })
    adb.execs = []
    backend.execInRoomHandler = (_roomId, cmd) => {
      const command = cmd.at(-1) ?? ''
      if (command.includes('find /workspace')) {
        return { code: 0, stdout: '/workspace/app/build/outputs/apk/debug/output-metadata.json\n', stderr: '' }
      }
      if (command.startsWith("cat '/workspace/")) {
        return {
          code: 0,
          stdout: JSON.stringify({ applicationId: 'com.example.app', elements: [{ outputFile: 'app-debug.apk' }] }),
          stderr: ''
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    const installEvidence = { fence: '' }
    adb.execResultFor = (_serial, args) => {
      const evidence = installEvidenceResult(args, installEvidence)
      if (evidence) return evidence
      const logical = logicalAdbArgs(args)
      return logical[0] === 'shell' && logical[1] === 'cmd'
        ? { code: 0, stdout: 'com.other.app/.MainActivity\n', stderr: '' }
        : null
    }

    const entry = await orch.applyChange('aaaa1111', { kind: 'android-run' }, 'user')

    expect(entry).toMatchObject({ status: 'failed', verify: { ok: false } })
    expect(entry.verify?.detail).toMatch(/could not resolve launcher/)
    expect(adb.execs.some((call) => {
      const logical = logicalAdbArgs(call.args)
      return logical[0] === 'shell' && logical[1] === 'am'
    })).toBe(false)
  })

  it('durably records a safe failed verify when the physical PID probe loses its lease', async () => {
    const { orch, adb, backend } = setup()
    await orch.refreshAndroidDevices()
    const attached = await orch.attachAndroidDevice('aaaa1111', { purpose: 'acceptance', workerId: 'worker-a' })
    if (attached.state !== 'granted') throw new Error('unreachable')
    adb.execs = []
    backend.execInRoomHandler = (_roomId, cmd) => {
      const command = cmd.at(-1) ?? ''
      if (command.includes('find /workspace')) {
        return { code: 0, stdout: '/workspace/app/build/outputs/apk/debug/output-metadata.json\n', stderr: '' }
      }
      if (command.startsWith("cat '/workspace/")) {
        return {
          code: 0,
          stdout: JSON.stringify({ applicationId: 'com.example.app', elements: [{ outputFile: 'app-debug.apk' }] }),
          stderr: ''
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    const installEvidence = { fence: '' }
    adb.execResultFor = async (_serial, args) => {
      const evidence = installEvidenceResult(args, installEvidence)
      if (evidence) return evidence
      const logical = logicalAdbArgs(args)
      if (logical[0] === 'shell' && logical[1] === 'cmd') {
        return { code: 0, stdout: 'com.example.app/.MainActivity\n', stderr: '' }
      }
      if (logical[0] === 'shell' && logical[1] === 'pidof') {
        await orch.devices.release(attached.lease.id, 'simulated disconnect during physical verification')
        throw new Error('R5CT30ABCDE C:\\Users\\private\\adb.exe token=ghp_12345678901234567890')
      }
      return null
    }

    const entry = await orch.applyChange('aaaa1111', { kind: 'android-run' }, 'user')

    expect(entry).toMatchObject({
      status: 'applied',
      verify: {
        ok: false,
        detail: expect.stringMatching(/could not be verified on the attached physical device/)
      }
    })
    expect(entry.verify!.detail.length).toBeLessThanOrEqual(300)
    expect(entry.verify!.detail).not.toMatch(/R5CT30ABCDE|Users|adb\.exe|ghp_/i)
    expect(orch.listChanges('aaaa1111').find((change) => change.id === entry.id)).toMatchObject({
      status: 'applied',
      verify: { ok: false }
    })
  })

  it.each([
    {
      name: 'applicationId shell metacharacters',
      findOutput: '/workspace/app/build/outputs/apk/debug/output-metadata.json\n',
      metadata: { applicationId: 'com.example.app;getprop.ro.serialno', elements: [{ outputFile: 'app-debug.apk' }] },
      expected: /Invalid Android applicationId/
    },
    {
      name: 'POSIX APK filename traversal',
      findOutput: '/workspace/app/build/outputs/apk/debug/output-metadata.json\n',
      metadata: { applicationId: 'com.example.app', elements: [{ outputFile: '../../secret.apk' }] },
      expected: /unsafe APK filename/
    },
    {
      name: 'Windows APK filename traversal',
      findOutput: '/workspace/app/build/outputs/apk/debug/output-metadata.json\n',
      metadata: { applicationId: 'com.example.app', elements: [{ outputFile: '..\\secret.apk' }] },
      expected: /unsafe APK filename/
    },
    {
      name: 'absolute POSIX APK filename',
      findOutput: '/workspace/app/build/outputs/apk/debug/output-metadata.json\n',
      metadata: { applicationId: 'com.example.app', elements: [{ outputFile: '/tmp/secret.apk' }] },
      expected: /unsafe APK filename/
    },
    {
      name: 'drive-relative APK filename',
      findOutput: '/workspace/app/build/outputs/apk/debug/output-metadata.json\n',
      metadata: { applicationId: 'com.example.app', elements: [{ outputFile: 'C:secret.apk' }] },
      expected: /unsafe APK filename/
    },
    {
      name: 'UNC APK filename',
      findOutput: '/workspace/app/build/outputs/apk/debug/output-metadata.json\n',
      metadata: { applicationId: 'com.example.app', elements: [{ outputFile: '\\\\server\\share\\secret.apk' }] },
      expected: /unsafe APK filename/
    },
    {
      name: 'dot-segment APK filename',
      findOutput: '/workspace/app/build/outputs/apk/debug/output-metadata.json\n',
      metadata: { applicationId: 'com.example.app', elements: [{ outputFile: '..apk' }] },
      expected: /unsafe APK filename/
    },
    {
      name: 'parent-dot-segment APK filename',
      findOutput: '/workspace/app/build/outputs/apk/debug/output-metadata.json\n',
      metadata: { applicationId: 'com.example.app', elements: [{ outputFile: '...apk' }] },
      expected: /unsafe APK filename/
    },
    {
      name: 'control character in APK filename',
      findOutput: '/workspace/app/build/outputs/apk/debug/output-metadata.json\n',
      metadata: { applicationId: 'com.example.app', elements: [{ outputFile: 'My\u0000App.apk' }] },
      expected: /unsafe APK filename/
    },
    {
      name: 'APK filename over the UTF-8 byte limit',
      findOutput: '/workspace/app/build/outputs/apk/debug/output-metadata.json\n',
      metadata: { applicationId: 'com.example.app', elements: [{ outputFile: `${'앱'.repeat(90)}.apk` }] },
      expected: /unsafe APK filename/
    },
    {
      name: 'metadata path shell injection',
      findOutput: "/workspace/app/build/outputs/apk/debug/output-metadata.json';getprop ro.serialno;'\n",
      metadata: { applicationId: 'com.example.app', elements: [{ outputFile: 'app-debug.apk' }] },
      expected: /unsafe output-metadata path/
    }
  ])('fails closed on $name before a physical adb install', async ({ findOutput, metadata, expected }) => {
    const { orch, adb, backend } = setup()
    await orch.refreshAndroidDevices()
    await orch.attachAndroidDevice('aaaa1111', { purpose: 'acceptance', workerId: 'worker-a' })
    adb.execs = []
    backend.execInRoomHandler = (_roomId, cmd) => {
      const command = cmd.at(-1) ?? ''
      if (command.includes('find /workspace')) return { code: 0, stdout: findOutput, stderr: '' }
      if (command.startsWith('cat ')) return { code: 0, stdout: JSON.stringify(metadata), stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }

    const entry = await orch.applyChange('aaaa1111', { kind: 'android-run' }, 'user')

    expect(entry.status).toBe('failed')
    expect(entry.verify?.detail).toMatch(expected)
    expect(adb.execs.map((call) => call.args[0])).toEqual(['get-state'])
  })

  it('rejects an invalid requested applicationId before inserting it into physical adb argv', async () => {
    const { orch, adb, backend } = setup()
    await orch.refreshAndroidDevices()
    await orch.attachAndroidDevice('aaaa1111', { purpose: 'acceptance', workerId: 'worker-a' })
    adb.execs = []
    backend.execInRoomHandler = (_roomId, cmd) => {
      const command = cmd.at(-1) ?? ''
      if (command.includes('find /workspace')) {
        return { code: 0, stdout: '/workspace/app/build/outputs/apk/debug/output-metadata.json\n', stderr: '' }
      }
      if (command.startsWith('cat ')) {
        return {
          code: 0,
          stdout: JSON.stringify({ applicationId: 'com.example.app', elements: [{ outputFile: 'app-debug.apk' }] }),
          stderr: ''
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    }

    const entry = await orch.applyChange(
      'aaaa1111',
      { kind: 'android-run', applicationId: 'com.example.app;getprop.ro.serialno' },
      'user'
    )

    expect(entry.status).toBe('failed')
    expect(entry.verify?.detail).toMatch(/Invalid Android applicationId/)
    expect(adb.execs.map((call) => call.args[0])).toEqual(['get-state'])
  })

  it('keeps android-run fenced to its preflight lease across a long build', async () => {
    const { orch, adb, backend } = setup()
    await orch.refreshAndroidDevices()
    const first = await orch.attachAndroidDevice('aaaa1111', { purpose: 'acceptance', workerId: 'worker-a' })
    if (first.state !== 'granted') throw new Error('unreachable')
    adb.execs = []
    let replaced = false
    backend.execInRoomHandler = async (_roomId, cmd) => {
      const command = cmd.at(-1) ?? ''
      if (command.includes('cd /workspace') && !replaced) {
        replaced = true
        await orch.devices.release(first.lease.id, 'replace lease during build')
        const next = await orch.devices.requestDevice({
          roomId: 'aaaa1111',
          project: 'AppDied',
          purpose: 'acceptance',
          workerId: 'worker-b',
          constraints: { deviceId: first.lease.deviceId }
        })
        expect(next.state).toBe('granted')
        return { code: 0, stdout: '', stderr: '' }
      }
      if (command.includes('find /workspace')) {
        return { code: 0, stdout: '/workspace/app/build/outputs/apk/debug/output-metadata.json\n', stderr: '' }
      }
      if (command.startsWith("cat '/workspace/")) {
        return {
          code: 0,
          stdout: JSON.stringify({ applicationId: 'com.example.app', elements: [{ outputFile: 'app-debug.apk' }] }),
          stderr: ''
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    }

    const entry = await orch.applyChange('aaaa1111', { kind: 'android-run' }, 'user')

    expect(replaced).toBe(true)
    expect(entry.status).toBe('failed')
    expect(entry.verify?.detail).toMatch(/lease changed/)
    expect(adb.execs.some((call) => ['install', 'install-multiple', 'install-multi-package'].includes(call.args[0] ?? ''))).toBe(false)
  })

  it('keeps android-run on the Room emulator by default', async () => {
    const { orch, adb, backend } = setup()
    const installedAtBeforeFence = '2026-08-31T01:00:00.000Z'
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(installedAtBeforeFence)
    await orch.refreshAndroidDevices()
    adb.execs = []
    backend.emulatorStateValue = 'running'
    backend.execInRoomCalls = []
    const installEvidence = { fence: '' }
    backend.execInRoomHandler = (_roomId, cmd) => {
      const androidArgs = roomAndroidArgs(cmd)
      if (androidArgs) {
        if (logicalAdbArgs(androidArgs)[1] === 'run-as') {
          vi.setSystemTime('2026-08-31T01:00:01.000Z')
        }
        const evidence = installEvidenceResult(androidArgs, installEvidence)
        if (evidence) return evidence
      }
      const command = cmd.at(-1) ?? ''
      if (command.includes('find /workspace')) {
        return { code: 0, stdout: '/workspace/app/build/outputs/apk/debug/output-metadata.json\n', stderr: '' }
      }
      if (command.startsWith("cat '/workspace/")) {
        return {
          code: 0,
          stdout: JSON.stringify({ applicationId: 'com.example.app', elements: [{ outputFile: "My App's $&-debug.APK" }] }),
          stderr: ''
        }
      }
      if (command.includes('resolve-activity')) return { code: 0, stdout: 'com.example.app/.MainActivity\n', stderr: '' }
      if (command.includes('sys.boot_completed')) return { code: 0, stdout: '1\n', stderr: '' }
      if (command.includes('pidof')) return { code: 0, stdout: '1234\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }

    const entry = await orch.applyChange('aaaa1111', { kind: 'android-run' }, 'user')

    expect(entry.status).toBe('verified')
    expect(installEvidence.fence).toMatch(/^devhotel-install-[0-9a-f-]{36}$/)
    expect(entry.verify?.detail).toMatch(/Room emulator/)
    expect(orch.androidInstalls.list('aaaa1111', {
      kind: 'emulator', targetId: 'aaaa1111', deviceId: null
    })).toEqual([
      expect.objectContaining({
        applicationId: 'com.example.app',
        changeId: entry.id,
        installedAt: installedAtBeforeFence
      })
    ])
    expect(adb.execs).toEqual([])
    expect(backend.execInRoomCalls.some((call) => call.cmd.at(-1)?.includes('adb -s emulator-5554'))).toBe(true)
    expect(
      backend.execInRoomCalls.some((call) =>
        call.cmd
          .at(-1)
          ?.includes("'install' '-r' '/workspace/app/build/outputs/apk/debug/My App'\\''s $&-debug.APK'")
      )
    ).toBe(true)
  })

  it('removes an old emulator receipt before tracked reinstall proof can fail', async () => {
    const { orch, backend } = setup()
    backend.emulatorStateValue = 'running'
    const target = { kind: 'emulator' as const, targetId: 'aaaa1111', deviceId: null }
    orch.androidInstalls.record({
      roomId: 'aaaa1111',
      target,
      applicationId: 'com.example.app',
      changeId: '11111111-2222-4333-8444-555555555555',
      apkSha256: TEST_APK_SHA,
      installedAt: '2026-08-31T00:00:00.000Z',
      packageIncarnation: TEST_PACKAGE_INCARNATION,
      logFence: null
    })
    backend.execInRoomHandler = (_roomId, cmd) => {
      const androidArgs = roomAndroidArgs(cmd)
      if (androidArgs) {
        const logical = logicalAdbArgs(androidArgs)
        if (logical[1] === 'pm' && logical[2] === 'path') return { code: 0, stdout: `package:${TEST_BASE_APK}\n`, stderr: '' }
        if (logical[1] === 'stat') return { code: 0, stdout: `${TEST_BASE_STAT}\n`, stderr: '' }
        if (logical[1] === 'sha256sum') return { code: 0, stdout: `${'b'.repeat(64)}  ${TEST_BASE_APK}\n`, stderr: '' }
        if (logical[1] === 'pm' && logical[2] === 'list') {
          return { code: 0, stdout: 'package:com.example.app uid:10123\n', stderr: '' }
        }
        if (logical[1] === 'run-as') return { code: 1, stdout: '', stderr: 'not debuggable' }
      }
      const command = cmd.at(-1) ?? ''
      if (command.includes('find /workspace')) {
        return { code: 0, stdout: '/workspace/app/build/outputs/apk/debug/output-metadata.json\n', stderr: '' }
      }
      if (command.startsWith("cat '/workspace/")) {
        return {
          code: 0,
          stdout: JSON.stringify({ applicationId: 'com.example.app', elements: [{ outputFile: 'app-debug.apk' }] }),
          stderr: ''
        }
      }
      if (command.includes('sys.boot_completed')) return { code: 0, stdout: '1\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }

    const entry = await orch.applyChange('aaaa1111', { kind: 'android-run' }, 'user')

    expect(entry).toMatchObject({ status: 'failed', verify: { ok: false } })
    expect(entry.verify?.detail).toMatch(/bytes differ/)
    expect(orch.androidInstalls.list('aaaa1111', target)).toEqual([])
  })

  it('does not commit an emulator receipt when the package changes after log-fence proof', async () => {
    const { orch, backend } = setup()
    backend.emulatorStateValue = 'running'
    const target = { kind: 'emulator' as const, targetId: 'aaaa1111', deviceId: null }
    const installEvidence = { fence: '' }
    let pathProbes = 0
    backend.execInRoomHandler = (_roomId, cmd) => {
      const androidArgs = roomAndroidArgs(cmd)
      if (androidArgs) {
        const logical = logicalAdbArgs(androidArgs)
        if (logical[1] === 'pm' && logical[2] === 'path') {
          pathProbes += 1
          const path = pathProbes === 1 ? TEST_BASE_APK : '/data/app/replaced/base.apk'
          return { code: 0, stdout: `package:${path}\n`, stderr: '' }
        }
        const evidence = installEvidenceResult(androidArgs, installEvidence)
        if (evidence) return evidence
      }
      const command = cmd.at(-1) ?? ''
      if (command.includes('find /workspace')) {
        return { code: 0, stdout: '/workspace/app/build/outputs/apk/debug/output-metadata.json\n', stderr: '' }
      }
      if (command.startsWith("cat '/workspace/")) {
        return {
          code: 0,
          stdout: JSON.stringify({ applicationId: 'com.example.app', elements: [{ outputFile: 'app-debug.apk' }] }),
          stderr: ''
        }
      }
      if (command.includes('sys.boot_completed')) return { code: 0, stdout: '1\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }

    const entry = await orch.applyChange('aaaa1111', { kind: 'android-run' }, 'user')

    expect(entry).toMatchObject({ status: 'failed', verify: { ok: false } })
    expect(entry.verify?.detail).toMatch(/package incarnation/)
    expect(pathProbes).toBe(2)
    expect(orch.androidInstalls.list('aaaa1111', target)).toEqual([])
  })

  it('records non-log automation authority when install fence proof output overflows', async () => {
    const { orch, backend } = setup()
    backend.emulatorStateValue = 'running'
    const target = { kind: 'emulator' as const, targetId: 'aaaa1111', deviceId: null }
    const installEvidence = { fence: '' }
    backend.execInRoomHandler = (_roomId, cmd) => {
      const androidArgs = roomAndroidArgs(cmd)
      if (androidArgs) {
        const evidence = installEvidenceResult(androidArgs, installEvidence)
        if (evidence) {
          return androidArgs[0] === 'logcat'
            ? { code: 0, stdout: 'x'.repeat((1024 * 1024) + 1), stderr: '' }
            : evidence
        }
      }
      const command = cmd.at(-1) ?? ''
      if (command.includes('find /workspace')) {
        return { code: 0, stdout: '/workspace/app/build/outputs/apk/debug/output-metadata.json\n', stderr: '' }
      }
      if (command.startsWith("cat '/workspace/")) {
        return {
          code: 0,
          stdout: JSON.stringify({ applicationId: 'com.example.app', elements: [{ outputFile: 'app-debug.apk' }] }),
          stderr: ''
        }
      }
      if (command.includes('resolve-activity')) return { code: 0, stdout: 'com.example.app/.MainActivity\n', stderr: '' }
      if (command.includes('sys.boot_completed')) return { code: 0, stdout: '1\n', stderr: '' }
      if (command.includes('pidof')) return { code: 0, stdout: '1234\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }

    const entry = await orch.applyChange('aaaa1111', { kind: 'android-run' }, 'user')

    expect(entry.status).toBe('verified')
    expect(orch.androidInstalls.list('aaaa1111', target)).toHaveLength(1)
    expect(orch.androidInstalls.logFence('aaaa1111', target, 'com.example.app')).toBeNull()
  })

  it('uses an explicitly selected Room emulator even while a physical lease is attached', async () => {
    const { orch, adb, backend } = setup()
    await orch.refreshAndroidDevices()
    await orch.attachAndroidDevice('aaaa1111', { purpose: 'acceptance', workerId: 'worker-a' })
    adb.execs = []
    backend.emulatorStateValue = 'running'
    orch.androidInstalls.record({
      roomId: 'aaaa1111',
      target: { kind: 'emulator', targetId: 'aaaa1111', deviceId: null },
      applicationId: 'com.example.app',
      changeId: '11111111-2222-4333-8444-555555555555',
      apkSha256: 'a'.repeat(64),
      installedAt: '2026-08-31T00:00:00.000Z',
      packageIncarnation: TEST_PACKAGE_INCARNATION,
      logFence: null
    })
    backend.execInRoomHandler = (_roomId, cmd) => {
      const logical = roomAndroidArgs(cmd)
      if (!logical) return { code: 0, stdout: '', stderr: '' }
      const identity = installEvidenceResult(logical, { fence: '', apkSha256: 'a'.repeat(64) })
      if (identity) return identity
      if (logical[1] === 'sh' && logical.at(-1)?.includes('dumpsys window')) {
        return { code: 0, stdout: 'mCurrentFocus=Window{1 u0 com.example.app/.MainActivity}\n', stderr: '' }
      }
      if (logical[1] === 'getprop') return { code: 0, stdout: 'ko-KR\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }

    const status = await orch.androidAutomationStatus('aaaa1111', { kind: 'emulator' })

    expect(status).toMatchObject({
      target: { kind: 'emulator', deviceId: null },
      installedApplicationIds: ['com.example.app'],
      foregroundApplicationId: 'com.example.app',
      locale: 'ko-KR'
    })
    expect(adb.execs).toEqual([])
  })

  it('fails closed when streamed emulator evidence exceeds the operation limit', async () => {
    const { orch, backend } = setup()
    backend.emulatorStateValue = 'running'
    orch.androidInstalls.record({
      roomId: 'aaaa1111',
      target: { kind: 'emulator', targetId: 'aaaa1111', deviceId: null },
      applicationId: 'com.example.app',
      changeId: '11111111-2222-4333-8444-555555555555',
      apkSha256: 'a'.repeat(64),
      installedAt: '2026-08-31T00:00:00.000Z',
      packageIncarnation: TEST_PACKAGE_INCARNATION,
      logFence: null
    })
    backend.execInRoomHandler = (_roomId, cmd, opts) => {
      const logical = roomAndroidArgs(cmd)
      if (!logical) return { code: 0, stdout: '', stderr: '' }
      const identity = installEvidenceResult(logical, { fence: '', apkSha256: 'a'.repeat(64) })
      if (identity) return identity
      if (logical[1] === 'sh' && logical.at(-1)?.includes('dumpsys window')) {
        opts?.onStdout?.(`mCurrentFocus=Window{1 u0 com.example.app/.MainActivity}\n${'x'.repeat(3_000)}`)
        return { code: 0, stdout: '', stderr: '' }
      }
      if (logical[1] === 'getprop') return { code: 0, stdout: 'ko-KR\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }

    const status = await orch.androidAutomationStatus('aaaa1111', { kind: 'emulator' })

    expect(status.installedApplicationIds).toEqual(['com.example.app'])
    expect(status.foregroundApplicationId).toBeNull()
    expect(status.locale).toBe('ko-KR')
  })

  it('rechecks the exact physical lease between UI evidence and input', async () => {
    const { orch, adb } = setup()
    await orch.refreshAndroidDevices()
    const attached = await orch.attachAndroidDevice('aaaa1111', { purpose: 'acceptance', workerId: 'worker-a' })
    if (attached.state !== 'granted') throw new Error('unreachable')
    orch.androidInstalls.record({
      roomId: 'aaaa1111',
      target: {
        kind: 'physical',
        targetId: attached.device.id,
        deviceId: attached.device.id,
        leaseId: attached.lease.id
      },
      applicationId: 'com.example.app',
      changeId: '11111111-2222-4333-8444-555555555555',
      apkSha256: 'a'.repeat(64),
      installedAt: '2026-08-31T00:00:00.000Z',
      packageIncarnation: TEST_PACKAGE_INCARNATION,
      logFence: null
    })
    let replaced = false
    adb.execResultFor = async (_serial, args) => {
      const logical = logicalAdbArgs(args)
      const identity = installEvidenceResult(logical, { fence: '', apkSha256: 'a'.repeat(64) })
      if (identity) return identity
      if (logical[1] === 'sh' && logical.at(-1)?.includes('dumpsys window')) {
        return { code: 0, stdout: 'mCurrentFocus=Window{1 u0 com.example.app/.MainActivity}\n', stderr: '' }
      }
      if (logical[1] === 'uiautomator') return { code: 0, stdout: 'UI hierarchy dumped\n', stderr: '' }
      if (logical[0] === 'exec-out') {
        await orch.devices.release(attached.lease.id, 'replace after evidence')
        const next = await orch.devices.requestDevice({
          roomId: 'aaaa1111', project: 'AppDied', purpose: 'acceptance', workerId: 'worker-b',
          constraints: { deviceId: attached.device.id }
        })
        expect(next.state).toBe('granted')
        replaced = true
        return {
          code: 0,
          stdout: '<hierarchy><node package="com.example.app" text="Crash" bounds="[0,0][20,20]" /></hierarchy>',
          stderr: ''
        }
      }
      return null
    }

    await expect(orch.androidTapText('aaaa1111', {
      applicationId: 'com.example.app', text: 'Crash'
    })).rejects.toMatchObject({ code: 'lease-expired' })
    expect(replaced).toBe(true)
    const execOut = adb.execs.find((call) => call.args[0] === 'exec-out')
    expect(execOut?.args.slice(0, 3)).toEqual(['exec-out', 'sh', '-c'])
    expect(execOut?.args.length).toBeGreaterThan(5)
    expect(adb.execs.some((call) => call.args[1] === 'input')).toBe(false)
  })

  it('does not reuse a physical install receipt after the phone is leased again', async () => {
    const { orch, adb } = setup()
    await orch.refreshAndroidDevices()
    const first = await orch.attachAndroidDevice('aaaa1111', { purpose: 'acceptance', workerId: 'worker-a' })
    if (first.state !== 'granted') throw new Error('unreachable')
    orch.androidInstalls.record({
      roomId: 'aaaa1111',
      target: {
        kind: 'physical',
        targetId: first.device.id,
        deviceId: first.device.id,
        leaseId: first.lease.id
      },
      applicationId: 'com.example.app',
      changeId: '11111111-2222-4333-8444-555555555555',
      apkSha256: 'a'.repeat(64),
      installedAt: '2026-08-31T00:00:00.000Z',
      packageIncarnation: TEST_PACKAGE_INCARNATION,
      logFence: null
    })
    await orch.releaseAndroidDevice('aaaa1111', 'rotate lease')
    const second = await orch.attachAndroidDevice('aaaa1111', { purpose: 'acceptance', workerId: 'worker-b' })
    if (second.state !== 'granted') throw new Error('unreachable')
    expect(second.lease.id).not.toBe(first.lease.id)
    adb.execs = []

    await expect(orch.androidForceStop('aaaa1111', {
      applicationId: 'com.example.app',
      target: { kind: 'physical', deviceId: second.device.id }
    })).rejects.toMatchObject({ code: 'ANDROID_APP_NOT_TRACKED' })
    expect(adb.execs).toEqual([])
  })
})

describe('Screenshots follow the attached device', () => {
  const dirs: string[] = []
  const dbs: Db[] = []

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function setup() {
    const userData = tempDir()
    dirs.push(userData)
    const db = testDb()
    dbs.push(db)
    const backend = new FakeBackend()
    const gateway = new FakeGateway()
    const adb = new FakeAdbHost([{ serial: 'R5CT30ABCDE', state: 'device', model: 'SM_G991N', release: '14', sdk: '34' }])
    const orch = new RoomOrchestrator({ userData, backend, gateway: gateway.asGateway(), db, appVersion: 'test', adb })
    orch.rooms.create(
      makeRoom({
        id: 'aaaa1111',
        project: 'AppDied',
        provider: 'android',
        sourceType: 'empty',
        sourceRef: '',
        workspaceMode: 'empty',
        syncStatus: 'empty',
        runtime: { kind: 'jdk', version: '17' },
        packageManager: { kind: 'gradle' },
        startCommand: 'gradle assembleDebug --no-daemon',
        internalPort: 6080,
        status: 'ready',
        hostPort: 45000
      })
    )
    return { orch, adb, backend }
  }

  it('screenshots the Room emulator when no phone is attached', async () => {
    const { orch, adb, backend } = setup()
    await orch.refreshAndroidDevices()
    backend.execResult = { code: 0, stdout: 'A'.repeat(200), stderr: '' }
    adb.execs = []

    const shot = await orch.androidScreenshot('aaaa1111')

    // The picture came from inside the Room, and the Host adb was never touched.
    expect(shot).toMatchObject({ source: 'adb', png: 'A'.repeat(200) })
    expect(adb.execs).toEqual([])
  })

  it('blocks every Android screenshot while a trusted pairing-code capture is active', async () => {
    const { orch, adb, backend } = setup()
    adb.pairingServices = [
      { serviceName: 'adb-private._adb-tls-pairing._tcp', endpoint: '192.0.2.60:37660' }
    ]
    const discovery = await orch.devices.discoverPairingCandidates()
    if (!discovery.ok) throw new Error('unreachable')
    const candidate = discovery.candidates[0]!
    orch.devices.beginPairingCodeCapture(candidate.id, discovery.generation)

    await expect(orch.androidScreenshot('aaaa1111')).rejects.toThrow(
      'Capture is temporarily disabled while an ADB pairing code is visible.'
    )
    expect(adb.execs).toEqual([])
    expect(backend.calls).not.toContain('captureEmulatorScreen:aaaa1111')

    orch.devices.cancelPairingCodeCapture(candidate.id, discovery.generation)
    backend.execResult = { code: 0, stdout: 'A'.repeat(200), stderr: '' }
    await expect(orch.androidScreenshot('aaaa1111')).resolves.toMatchObject({ source: 'adb' })
  })

  it('screenshots the leased phone once one is attached, with no serial from the caller', async () => {
    const { orch, adb, backend } = setup()
    await orch.refreshAndroidDevices()
    await orch.attachAndroidDevice('aaaa1111', { purpose: 'acceptance', workerId: 'worker-a' })
    adb.execs = []
    backend.execResult = { code: 0, stdout: 'A'.repeat(200), stderr: '' }
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x80, 0x42])
    adb.screencapPng = png

    const shot = await orch.androidScreenshot('aaaa1111')

    expect(shot).toMatchObject({ source: 'adb', png: png.toString('base64') })
    // The phone answered, not the Room's own emulator, whose stdout differs.
    expect(adb.execs[0]).toMatchObject({ serial: 'R5CT30ABCDE' })
  })

  it('honors explicit screen mode through the Room display even when a phone is attached', async () => {
    const { orch, adb, backend } = setup()
    await orch.refreshAndroidDevices()
    await orch.attachAndroidDevice('aaaa1111', { purpose: 'acceptance', workerId: 'worker-a' })
    adb.execs = []
    const displayPng = 'ZmFrZS1lbXVsYXRvci1zY3JlZW4tcG5nLWJ5dGVzLWZvci10ZXN0cw=='

    const shot = await orch.androidScreenshot('aaaa1111', 'screen')

    expect(shot).toEqual({ source: 'screen', png: displayPng })
    expect(backend.calls).toContain('captureEmulatorScreen:aaaa1111')
    expect(adb.execs).toEqual([])
  })

  it('redacts the private serial from a physical screenshot failure', async () => {
    const { orch, adb } = setup()
    await orch.refreshAndroidDevices()
    await orch.attachAndroidDevice('aaaa1111', { purpose: 'acceptance', workerId: 'worker-a' })
    adb.execBinaryResultFor = () => ({
      code: 1,
      stdout: Buffer.alloc(0),
      stderr: "error: device 'R5CT30ABCDE' not found",
      outputLimitExceeded: false
    })

    let message = ''
    try {
      await orch.androidScreenshot('aaaa1111')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('[device-serial-redacted]')
    expect(message).not.toContain('R5CT30ABCDE')
  })
})
