import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceLeaseError } from '@devhotel/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { AndroidDeviceBroker, androidDevicesRepo, classifyAdbCommand, openDb } from '../index'
import { FakeAdbHost, type FakePhone } from './fakes'

const dirs: string[] = []
const dbs: { close(): void }[] = []
afterEach(() => {
  for (const db of dbs.splice(0)) {
    try {
      db.close()
    } catch {
      // already closed
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeBroker(phones: FakePhone[] = [{ serial: 'R5CT30ABCDE', state: 'device', model: 'SM_G991N', release: '14', sdk: '34' }]) {
  const dir = mkdtempSync(join(tmpdir(), 'devhotel-isolation-'))
  dirs.push(dir)
  const db = openDb(dir)
  dbs.push(db)
  const now = { value: Date.parse('2026-08-29T00:00:00.000Z') }
  const adb = new FakeAdbHost(phones)
  const broker = new AndroidDeviceBroker({ repo: androidDevicesRepo(db), adb, now: () => now.value, ownerLiveness: () => true })
  return { broker, adb, db, now }
}

describe('classifying ADB commands by whether another project would notice', () => {
  it.each([
    [['install', '-r', '/tmp/app.apk']],
    [['uninstall', 'com.example.app']],
    [['shell', 'pm', 'clear', 'com.example.app']],
    [['shell', 'am', 'start', '-n', 'com.example.app/.Main']],
    [['shell', 'input', 'tap', '100', '200']],
    [['shell', 'monkey', '-p', 'com.example.app', '1']],
    [['reboot']],
    [['push', 'local', '/sdcard/remote']],
    [['shell', 'settings', 'put', 'global', 'airplane_mode_on', '1']],
    [['logcat', '-c']],
    [['logcat', '-G', '16M']],
    [['shell', 'setprop', 'debug.foo', '1']],
    [['shell', 'uiautomator', 'runtest']],
    [['shell', 'wm', 'size', '1080x2400']],
    [['shell', 'wm', 'density', 'reset']],
    [['shell', 'wm', 'size', '--display=0']],
    [['shell', 'dumpsys', 'battery', 'set', 'level', '5']],
    [['shell', 'screencap', '-p', '/sdcard/stolen.png']],
    [['shell', 'screenrecord', '/sdcard/run.mp4']],
    [['shell', 'logcat', '-f', '/sdcard/log.txt']],
    [['shell', 'date', '-s', '20300101.000000']]
  ])('treats %j as interfering', (argv: string[]) => {
    expect(classifyAdbCommand(argv).interfering).toBe(true)
  })

  it.each([
    [['get-state']],
    [['shell', 'getprop', 'ro.build.version.sdk']],
    [['shell', 'dumpsys', 'battery']],
    [['shell', 'dumpsys', 'package', 'com.example.app']],
    [['shell', 'wm', 'size']],
    [['shell', 'wm', 'density']],
    [['exec-out', 'screencap', '-p']],
    [['logcat', '-d']],
    [['shell', 'pm', 'list', 'packages']]
  ])('treats %j as safe to share', (argv: string[]) => {
    expect(classifyAdbCommand(argv).interfering).toBe(false)
  })

  it.each([
    [['kill-server']],
    [['start-server']],
    [['devices', '-l']],
    [['track-devices-l']],
    [['connect', '192.0.2.1:5555']],
    [['forward', '--list']],
    [['forward', '--remove-all']],
    [['reverse', '--remove-all']],
    [['get-serialno']],
    [['get-devpath']],
    [['shell', 'getprop']],
    [['shell', 'getprop', 'ro.serialno']],
    [['exec-out', 'getprop', 'ro.boot.serialno']],
    [['shell', '/system/bin/getprop', 'ro.serialno']],
    [['shell', 'toybox', 'getprop', 'ro.serialno']],
    [['shell', 'sh', '-c', 'getprop ro.serialno | base64']],
    [['shell', 'dumpsys']],
    [['shell', 'dumpsys', 'iphonesubinfo']],
    [['shell', 'cmd', 'device_identifiers', 'get-serial-for-package']],
    [['shell']],
    [['shell', 'dd', 'if=/proc/bootconfig', 'bs=1', 'skip=0', 'count=1']],
    [['bugreport']],
    [['keygen', 'C:\\tmp\\adbkey']],
    [['server', 'nodaemon']],
    [['reconnect', 'offline']],
    [['host-features']]
  ])('forbids Host-wide, Host-file, and identity-revealing command %j even with a lease', (argv: string[]) => {
    expect(classifyAdbCommand(argv)).toMatchObject({ interfering: true, forbidden: true })
  })

  it('fails closed on a command it has never seen', () => {
    expect(classifyAdbCommand(['shell', 'some-new-oem-tool', '--wipe'])).toMatchObject({ interfering: true, forbidden: true })
    expect(classifyAdbCommand(['brand-new-verb'])).toMatchObject({ interfering: true, forbidden: true })
  })

  it('fails closed when a safe program smuggles a second command after it', () => {
    expect(classifyAdbCommand(['shell', 'getprop; pm clear com.example.app']).interfering).toBe(true)
    expect(classifyAdbCommand(['shell', 'dumpsys', '&&', 'reboot']).interfering).toBe(true)
    expect(classifyAdbCommand(['shell', 'echo', '$(pm clear com.example.app)']).interfering).toBe(true)
    expect(classifyAdbCommand(['shell', 'cat', '/proc/version', '>', '/sdcard/changed']).interfering).toBe(true)
    expect(classifyAdbCommand(['shell', 'getprop\rpm clear com.example.app']).interfering).toBe(true)
  })

  it('looks past the serial selector so `-s` cannot hide the verb', () => {
    expect(classifyAdbCommand(['-s', 'R5CT30ABCDE', 'install', 'app.apk']).interfering).toBe(true)
    expect(classifyAdbCommand(['-s', 'R5CT30ABCDE', 'get-state']).interfering).toBe(false)
  })
})

describe('Android device broker — no lease, no writes', () => {
  it('refuses an install from a Room that never took the phone', async () => {
    const { broker } = makeBroker()
    await broker.refreshInventory()
    const deviceId = broker.listDevices()[0]!.id

    expect(() => broker.authorize('aaaa1111', deviceId, ['install', '-r', '/workspace/app.apk'])).toThrow(DeviceLeaseError)
    try {
      broker.authorize('aaaa1111', deviceId, ['install', '-r', '/workspace/app.apk'])
    } catch (err) {
      expect((err as DeviceLeaseError).code).toBe('no-lease')
    }
  })

  it('refuses a second Room while the first holds the lease, and names the owner', async () => {
    const { broker } = makeBroker()
    await broker.refreshInventory()
    const deviceId = broker.listDevices()[0]!.id
    await broker.requestDevice({ roomId: 'aaaa1111', project: 'AppDied', purpose: 'acceptance', workerId: 'worker-a' })

    let caught: DeviceLeaseError | null = null
    try {
      broker.authorize('bbbb2222', deviceId, ['shell', 'input', 'tap', '10', '10'])
    } catch (err) {
      caught = err as DeviceLeaseError
    }

    expect(caught?.code).toBe('lease-held-by-another-room')
    expect(caught?.message).toMatch(/AppDied/)
    expect(caught?.message).toMatch(/aaaa1111/)
  })

  it('lets the lease holder install, and lets anyone read the inventory', async () => {
    const { broker } = makeBroker()
    await broker.refreshInventory()
    const deviceId = broker.listDevices()[0]!.id
    await broker.requestDevice({ roomId: 'aaaa1111', project: 'AppDied', purpose: 'acceptance', workerId: 'worker-a' })

    expect(broker.authorize('aaaa1111', deviceId, ['install', '-r', '/workspace/app.apk']).serial).toBe('R5CT30ABCDE')
    expect(broker.authorize('bbbb2222', deviceId, ['shell', 'getprop', 'ro.product.model']).serial).toBe('R5CT30ABCDE')
  })

  it.each([
    ['kill-server'],
    ['devices', '-l'],
    ['forward', '--list'],
    ['get-serialno'],
      ['shell', 'getprop'],
      ['shell', 'getprop', 'ro.serialno'],
      ['shell', '/system/bin/getprop', 'ro.serialno'],
      ['shell', 'sh', '-c', 'getprop ro.serialno | base64'],
      ['shell', 'dumpsys']
  ])('refuses %j even when the requesting Room holds the lease', async (...argv: string[]) => {
    const { broker } = makeBroker()
    await broker.refreshInventory()
    const deviceId = broker.listDevices()[0]!.id
    await broker.requestDevice({ roomId: 'aaaa1111', project: 'AppDied', purpose: 'acceptance', workerId: 'worker-a' })

    expect(() => broker.authorize('aaaa1111', deviceId, argv)).toThrow(DeviceLeaseError)
    try {
      broker.authorize('aaaa1111', deviceId, argv)
    } catch (err) {
      expect((err as DeviceLeaseError).code).toBe('adb-command-forbidden')
    }
  })

  it('refuses the holder too once its own lease has gone stale', async () => {
    const { broker, now } = makeBroker()
    await broker.refreshInventory()
    const deviceId = broker.listDevices()[0]!.id
    await broker.requestDevice({ roomId: 'aaaa1111', project: 'AppDied', purpose: 'acceptance', workerId: 'worker-a', ttlMs: 30_000 })

    now.value += 31_000

    let caught: DeviceLeaseError | null = null
    try {
      broker.authorize('aaaa1111', deviceId, ['install', '-r', '/workspace/app.apk'])
    } catch (err) {
      caught = err as DeviceLeaseError
    }
    expect(caught?.code).toBe('lease-expired')
  })

  it('refuses to drive a phone that is attached but unauthorized', async () => {
    const { broker } = makeBroker([{ serial: 'R5CT30ABCDE', state: 'unauthorized' }])
    await broker.refreshInventory()
    const deviceId = broker.listDevices()[0]!.id

    let caught: DeviceLeaseError | null = null
    try {
      broker.authorize('aaaa1111', deviceId, ['install', '-r', '/workspace/app.apk'])
    } catch (err) {
      caught = err as DeviceLeaseError
    }
    expect(caught?.code).toBe('device-unhealthy')
  })
})

describe('Android device broker — a Room-owned emulator is not a shared phone', () => {
  it('never puts an emulator in the brokered pool', async () => {
    const { broker } = makeBroker([
      { serial: 'emulator-5554', state: 'device', model: 'sdk_gphone64', release: '14', sdk: '34' },
      { serial: 'R5CT30ABCDE', state: 'device', model: 'SM_G991N', release: '14', sdk: '34' }
    ])
    await broker.refreshInventory()

    const emulator = broker.listDevices().find((device) => device.connection === 'emulator')!
    const phone = broker.listDevices().find((device) => device.connection === 'usb')!
    expect(emulator.brokered).toBe(false)
    expect(phone.brokered).toBe(true)
  })

  it('lets emulator work run without a lease and without touching the phone queue', async () => {
    const { broker } = makeBroker([
      { serial: 'emulator-5554', state: 'device', model: 'sdk_gphone64', release: '14', sdk: '34' },
      { serial: 'R5CT30ABCDE', state: 'device', model: 'SM_G991N', release: '14', sdk: '34' }
    ])
    await broker.refreshInventory()
    const emulator = broker.listDevices().find((device) => device.connection === 'emulator')!

    // The Room holding the USB phone is a different Room entirely.
    await broker.requestDevice({ roomId: 'aaaa1111', project: 'AppDied', purpose: 'acceptance', workerId: 'worker-a' })

    expect(broker.authorize('cccc3333', emulator.id, ['install', '-r', '/workspace/app.apk']).serial).toBe('emulator-5554')
    expect(broker.listDevices().find((device) => device.connection === 'usb')!.queueDepth).toBe(0)
  })

  it('will not lease an emulator even when a Room asks for it by ID', async () => {
    const { broker } = makeBroker([{ serial: 'emulator-5554', state: 'device', model: 'sdk_gphone64', release: '14', sdk: '34' }])
    await broker.refreshInventory()
    const emulator = broker.listDevices()[0]!

    await expect(
      broker.requestDevice({
        roomId: 'aaaa1111',
        project: 'AppDied',
        purpose: 'smoke',
        workerId: 'worker-a',
        constraints: { deviceId: emulator.id }
      })
    ).rejects.toThrow(/No connected Android device matches/)
  })
})
