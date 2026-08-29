import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { RoomOrchestrator } from '../orchestrator'
import type { Db } from '../store/db'
import { FakeAdbHost, FakeBackend, FakeGateway, makeRoom, tempDir, testDb } from './fakes'

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
    expect(orch.inspectRoom('aaaa1111').device).toMatchObject({ roomId: 'aaaa1111', project: 'AppDied', purpose: 'acceptance' })
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
    expect(orch.inspectRoom('bbbb2222').device).toMatchObject({ roomId: 'bbbb2222' })
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
    expect(status.devices.devices.filter((device) => device.leaseOwner !== null)).toHaveLength(1)
    expect(status.devices.recentEvents.some((event) => event.kind === 'granted')).toBe(true)
  })
})

describe('Android automation targets the attached device without a hand-written serial', () => {
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
    return { orch, adb, backend }
  }

  it('resolves to the Room-owned emulator when no phone is attached', async () => {
    const { orch } = setup()
    await orch.refreshAndroidDevices()

    expect(await orch.resolveAdbTarget('aaaa1111')).toMatchObject({ kind: 'emulator', serial: 'emulator-5554' })
  })

  it('resolves to the leased phone once one is attached', async () => {
    const { orch } = setup()
    await orch.refreshAndroidDevices()
    await orch.attachAndroidDevice('aaaa1111', { purpose: 'acceptance', workerId: 'worker-a' })

    expect(await orch.resolveAdbTarget('aaaa1111')).toMatchObject({ kind: 'physical', serial: 'R5CT30ABCDE', nickname: expect.any(String) })
  })

  it('runs an authorized ADB command on the leased phone', async () => {
    const { orch, adb } = setup()
    await orch.refreshAndroidDevices()
    await orch.attachAndroidDevice('aaaa1111', { purpose: 'acceptance', workerId: 'worker-a' })
    adb.execs = []

    const result = await orch.adbOnDevice('aaaa1111', ['install', '-r', '/tmp/app.apk'])

    expect(result.code).toBe(0)
    expect(adb.execs).toEqual([{ serial: 'R5CT30ABCDE', args: ['install', '-r', '/tmp/app.apk'] }])
  })

  it('refuses an interfering ADB command from a Room with no lease, and never reaches the phone', async () => {
    const { orch, adb } = setup()
    await orch.refreshAndroidDevices()
    const deviceId = orch.androidDeviceStatus().devices[0]!.id
    adb.execs = []

    await expect(orch.adbOnDevice('aaaa1111', ['install', '-r', '/tmp/app.apk'], { deviceId })).rejects.toThrow(/needs a device lease/)
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

  it('screenshots the leased phone once one is attached, with no serial from the caller', async () => {
    const { orch, adb, backend } = setup()
    await orch.refreshAndroidDevices()
    await orch.attachAndroidDevice('aaaa1111', { purpose: 'acceptance', workerId: 'worker-a' })
    adb.execs = []
    backend.execResult = { code: 0, stdout: 'A'.repeat(200), stderr: '' }
    adb.screencapPng = 'B'.repeat(200)

    const shot = await orch.androidScreenshot('aaaa1111')

    expect(shot).toMatchObject({ source: 'adb', png: 'B'.repeat(200) })
    // The phone answered, not the Room's own emulator, whose stdout differs.
    expect(adb.execs[0]).toMatchObject({ serial: 'R5CT30ABCDE' })
  })
})
