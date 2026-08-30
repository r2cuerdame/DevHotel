import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceLeaseError } from '@devhotel/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { AndroidDeviceBroker, androidDevicesRepo, openDb } from '../index'
import { FakeAdbHost } from './fakes'

const dirs: string[] = []
const dbs: { close(): void }[] = []
afterEach(() => {
  for (const db of dbs.splice(0)) {
    try {
      db.close()
    } catch {
      // already closed by the test
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeBroker(
  now = { value: Date.parse('2026-08-29T00:00:00.000Z') },
  roomEligible: (roomId: string) => boolean = () => true
) {
  const dir = mkdtempSync(join(tmpdir(), 'devhotel-devices-'))
  dirs.push(dir)
  const db = openDb(dir)
  dbs.push(db)
  const adb = new FakeAdbHost([
    { serial: 'R5CT30ABCDE', state: 'device', model: 'SM_G991N', release: '14', sdk: '34', usb: '1-4' }
  ])
  const broker = new AndroidDeviceBroker({
    repo: androidDevicesRepo(db),
    adb,
    now: () => now.value,
    roomEligible
  })
  return { broker, adb, db, now, dir }
}

describe('Android device broker — exclusive lease over a shared USB phone', () => {
  it('does not grant a cached-ready device while Host ADB is unavailable', async () => {
    const { broker, adb } = makeBroker()
    await broker.refreshInventory()
    const deviceId = broker.listDevices()[0]!.id
    adb.availability = { ok: false, detail: 'adb executable is unavailable' }
    await broker.refreshInventory()

    await expect(
      broker.requestDevice({ roomId: 'aaaa1111', project: 'AppDied', purpose: 'acceptance', workerId: 'worker-a' })
    ).rejects.toMatchObject({ code: 'device-unhealthy' })
    expect(() => broker.authorize('aaaa1111', deviceId, ['get-state'])).toThrow(DeviceLeaseError)
    expect(broker.leaseForRoom('aaaa1111')).toBeNull()
  })

  it('joins an in-flight inventory probe instead of leasing a cached-ready row', async () => {
    const { broker, adb } = makeBroker()
    await broker.refreshInventory()
    let finishDevices!: () => void
    const devicesGate = new Promise<void>((resolve) => {
      finishDevices = resolve
    })
    adb.devices = async () => {
      await devicesGate
      throw new Error('adb devices failed after availability passed')
    }

    const refresh = broker.refreshInventory()
    let requestSettled = false
    const request = broker.requestDevice({
      roomId: 'aaaa1111',
      project: 'AppDied',
      purpose: 'acceptance',
      workerId: 'worker-a'
    })
    void request.then(
      () => { requestSettled = true },
      () => { requestSettled = true }
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(requestSettled).toBe(false)

    finishDevices()
    await refresh
    await expect(request).rejects.toMatchObject({ code: 'device-unhealthy' })
    expect(broker.leaseForRoom('aaaa1111')).toBeNull()
  })

  it('does not promote a queued Room while Host ADB is unavailable', async () => {
    const { broker, adb } = makeBroker()
    await broker.refreshInventory()
    const first = await broker.requestDevice({ roomId: 'aaaa1111', project: 'AppDied', purpose: 'acceptance', workerId: 'worker-a' })
    await broker.requestDevice({ roomId: 'bbbb2222', project: 'MiracleKeyboard', purpose: 'keyboard', workerId: 'worker-b' })
    if (first.state !== 'granted') throw new Error('unreachable')

    adb.availability = { ok: false, detail: 'adb executable is unavailable' }
    await broker.refreshInventory()
    const released = await broker.release(first.lease.id, 'done while adb was unavailable')

    expect(released.promoted).toBeNull()
    expect(broker.leaseForRoom('bbbb2222')).toBeNull()
    expect(broker.listDevices()[0]!.queueDepth).toBe(1)

    adb.availability = { ok: true, detail: 'fake adb 35.0.0' }
    await broker.refreshInventory()
    expect(broker.leaseForRoom('bbbb2222')).toMatchObject({ roomId: 'bbbb2222' })
  })

  it('preserves but does not re-grant an existing lease while its phone is unhealthy', async () => {
    const { broker, adb } = makeBroker()
    await broker.refreshInventory()
    const first = await broker.requestDevice({ roomId: 'aaaa1111', project: 'AppDied', purpose: 'acceptance', workerId: 'worker-a' })
    if (first.state !== 'granted') throw new Error('unreachable')
    adb.phones = [{ serial: 'R5CT30ABCDE', state: 'offline', model: 'SM_G991N', release: '14', sdk: '34' }]
    await broker.refreshInventory()

    await expect(
      broker.requestDevice({ roomId: 'aaaa1111', project: 'AppDied', purpose: 'acceptance', workerId: 'worker-a' })
    ).rejects.toMatchObject({ code: 'device-unhealthy' })
    expect(broker.leaseForRoom('aaaa1111')).toMatchObject({ id: first.lease.id, state: 'active' })
  })

  it('grants the phone to the first Room and queues the second behind a visible owner', async () => {
    const { broker, db } = makeBroker()
    await broker.refreshInventory()

    const first = await broker.requestDevice({
      roomId: 'aaaa1111',
      project: 'AppDied',
      purpose: 'acceptance',
      workerId: 'worker-a'
    })
    const second = await broker.requestDevice({
      roomId: 'bbbb2222',
      project: 'MiracleKeyboard',
      purpose: 'keyboard',
      workerId: 'worker-b'
    })

    expect(first.state).toBe('granted')
    expect(second.state).toBe('queued')
    if (first.state !== 'granted' || second.state !== 'queued') throw new Error('unreachable')
    expect(first.lease.roomId).toBe('aaaa1111')
    expect(second.position).toBe(1)
    expect(second.owner).toMatchObject({ roomId: 'aaaa1111', project: 'AppDied', purpose: 'acceptance' })
    expect(second.reason).toMatch(/AppDied/)

    const device = broker.listDevices()[0]!
    expect(device.leaseOwner?.roomId).toBe('aaaa1111')
    expect(device.queueDepth).toBe(1)
    db.close()
  })

  it('keeps an unconstrained waiter eligible when a new matching phone appears', async () => {
    const { broker, adb } = makeBroker()
    await broker.refreshInventory()
    const first = await broker.requestDevice({
      roomId: 'aaaa1111',
      project: 'AppDied',
      purpose: 'acceptance',
      workerId: 'worker-a'
    })
    const waiting = await broker.requestDevice({
      roomId: 'bbbb2222',
      project: 'MiracleKeyboard',
      purpose: 'keyboard',
      workerId: 'worker-b'
    })
    if (first.state !== 'granted' || waiting.state !== 'queued') throw new Error('unreachable')
    expect(waiting.deviceId).toBeNull()

    adb.phones = [
      ...adb.phones,
      { serial: 'R5CT30NEW01', state: 'device', model: 'Pixel_8', release: '15', sdk: '35', usb: '1-5' }
    ]
    await broker.refreshInventory()

    expect(broker.leaseForRoom('aaaa1111')?.deviceId).toBe(first.device.id)
    expect(broker.leaseForRoom('bbbb2222')).toMatchObject({ roomId: 'bbbb2222', project: 'MiracleKeyboard' })
    expect(broker.leaseForRoom('bbbb2222')?.deviceId).not.toBe(first.device.id)
  })

  it('keeps an explicitly constrained waiter pinned when another phone appears', async () => {
    const { broker, adb } = makeBroker()
    await broker.refreshInventory()
    const first = await broker.requestDevice({
      roomId: 'aaaa1111',
      project: 'AppDied',
      purpose: 'acceptance',
      workerId: 'worker-a'
    })
    if (first.state !== 'granted') throw new Error('unreachable')
    const waiting = await broker.requestDevice({
      roomId: 'bbbb2222',
      project: 'MiracleKeyboard',
      purpose: 'keyboard',
      workerId: 'worker-b',
      constraints: { deviceId: first.device.id }
    })
    if (waiting.state !== 'queued') throw new Error('unreachable')
    expect(waiting.deviceId).toBe(first.device.id)

    adb.phones = [
      ...adb.phones,
      { serial: 'R5CT30NEW02', state: 'device', model: 'Pixel_8', release: '15', sdk: '35', usb: '1-6' }
    ]
    await broker.refreshInventory()

    expect(broker.leaseForRoom('bbbb2222')).toBeNull()
    expect(broker.listDevices().find((device) => device.id !== first.device.id)?.leaseOwner).toBeNull()
  })

  it('counts and ranks unpinned waiters only on devices matching their constraints', async () => {
    const { broker, adb } = makeBroker()
    adb.phones = [
      { serial: 'R5CT30USB01', state: 'device', model: 'Pixel_USB', release: '15', sdk: '35', usb: '1-4' },
      { serial: '192.0.2.20:5555', state: 'device', model: 'Pixel_WiFi', release: '15', sdk: '35' }
    ]
    await broker.refreshInventory()
    const usb = broker.listDevices().find((device) => device.connection === 'usb')!
    const wireless = broker.listDevices().find((device) => device.connection === 'wireless')!
    await broker.requestDevice({
      roomId: 'aaaa1111', project: 'UsbOwner', purpose: 'smoke', workerId: 'worker-a', constraints: { deviceId: usb.id }
    })
    await broker.requestDevice({
      roomId: 'bbbb2222', project: 'WifiOwner', purpose: 'smoke', workerId: 'worker-b', constraints: { deviceId: wireless.id }
    })

    const usbWaiter = await broker.requestDevice({
      roomId: 'cccc3333', project: 'UsbWaiter', purpose: 'acceptance', workerId: 'worker-c', constraints: { connection: 'usb' }
    })
    const wirelessWaiter = await broker.requestDevice({
      roomId: 'dddd4444', project: 'WifiWaiter', purpose: 'acceptance', workerId: 'worker-d', constraints: { connection: 'wireless' }
    })

    expect(usbWaiter).toMatchObject({ state: 'queued', deviceId: null, position: 1 })
    expect(wirelessWaiter).toMatchObject({ state: 'queued', deviceId: null, position: 1 })
    expect(broker.listDevices().find((device) => device.id === usb.id)).toMatchObject({
      queueDepth: 1,
      waiters: [{ roomId: 'cccc3333', project: 'UsbWaiter' }]
    })
    expect(broker.listDevices().find((device) => device.id === wireless.id)).toMatchObject({
      queueDepth: 1,
      waiters: [{ roomId: 'dddd4444', project: 'WifiWaiter' }]
    })
  })

  it('enforces wireless constraints for modern ADB TLS DNS-SD serials', async () => {
    const { broker, adb } = makeBroker()
    adb.phones = [{
      serial: 'adb-0W071F0A021046-xyZ._adb-tls-connect._tcp.local.',
      state: 'device',
      model: 'Pixel_Wireless',
      release: '15',
      sdk: '35'
    }]
    await broker.refreshInventory()
    const device = broker.listDevices()[0]!
    expect(device).toMatchObject({ connection: 'wireless', health: 'ready' })

    await expect(broker.requestDevice({
      roomId: 'aaaa1111',
      project: 'UsbOnly',
      purpose: 'smoke',
      workerId: 'worker-a',
      constraints: { connection: 'usb' }
    })).rejects.toMatchObject({ code: 'device-unknown' })
    expect(broker.leaseForRoom('aaaa1111')).toBeNull()

    const granted = await broker.requestDevice({
      roomId: 'bbbb2222',
      project: 'WirelessOnly',
      purpose: 'acceptance',
      workerId: 'worker-b',
      constraints: { connection: 'wireless' }
    })
    expect(granted).toMatchObject({ state: 'granted', device: { id: device.id, connection: 'wireless' } })
  })

  it('collapses simultaneous USB and wireless transports into one exclusive lease domain', async () => {
    const { broker, adb, db } = makeBroker()
    const hardwareSerial = 'PHYSICAL-SERIAL-001'
    const wirelessSerial = 'adb-PHYSICAL-SERIAL-001._adb-tls-connect._tcp.local.'
    adb.phones = [
      {
        serial: hardwareSerial,
        state: 'device',
        model: 'Pixel_Dual',
        release: '15',
        sdk: '35',
        usb: '1-4',
        hardwareSerial
      },
      {
        serial: wirelessSerial,
        state: 'device',
        model: 'Pixel_Dual',
        release: '15',
        sdk: '35',
        hardwareSerial
      }
    ]

    await broker.refreshInventory()

    const devices = broker.listDevices()
    expect(devices).toHaveLength(1)
    expect(devices[0]).toMatchObject({ connection: 'usb', health: 'ready' })
    expect(db.sqlite.prepare('SELECT count(*) AS count FROM android_devices').get()).toEqual({ count: 1 })
    const privateRow = db.sqlite.prepare('SELECT physical_identity FROM android_devices').get() as { physical_identity: string }
    expect(privateRow.physical_identity).toMatch(/^[a-f0-9]{64}$/)
    expect(privateRow.physical_identity).not.toContain(hardwareSerial)
    expect(JSON.stringify(broker.status())).not.toMatch(/PHYSICAL-SERIAL|adb-PHYSICAL/i)

    const otherInstall = makeBroker()
    otherInstall.adb.phones = [{
      serial: hardwareSerial,
      state: 'device',
      model: 'Pixel_Dual',
      release: '15',
      sdk: '35',
      usb: '1-4',
      hardwareSerial
    }]
    await otherInstall.broker.refreshInventory()
    const otherIdentity = otherInstall.db.sqlite
      .prepare('SELECT physical_identity FROM android_devices')
      .get() as { physical_identity: string }
    expect(otherIdentity.physical_identity).not.toBe(privateRow.physical_identity)

    const first = await broker.requestDevice({
      roomId: 'aaaa1111', project: 'UsbOwner', purpose: 'acceptance', workerId: 'worker-a'
    })
    const second = await broker.requestDevice({
      roomId: 'bbbb2222', project: 'WirelessContender', purpose: 'smoke', workerId: 'worker-b'
    })
    expect(first).toMatchObject({ state: 'granted', device: { id: devices[0]!.id } })
    expect(second).toMatchObject({ state: 'queued', owner: { roomId: 'aaaa1111' }, position: 1 })
    expect(db.sqlite.prepare("SELECT count(*) AS count FROM android_device_leases WHERE state = 'active'").get()).toEqual({ count: 1 })
  })

  it('keeps an active lease on its exact wireless transport until release, then prefers USB', async () => {
    const { broker, adb, db, now } = makeBroker()
    const hardwareSerial = 'PHYSICAL-SERIAL-002'
    const wirelessSerial = 'adb-PHYSICAL-SERIAL-002._adb-tls-connect._tcp'
    adb.phones = [{
      serial: wirelessSerial,
      state: 'device',
      model: 'Pixel_Dual',
      release: '15',
      sdk: '35',
      hardwareSerial
    }]
    await broker.refreshInventory()
    const device = broker.listDevices()[0]!
    const granted = await broker.requestDevice({
      roomId: 'aaaa1111', project: 'WirelessOwner', purpose: 'acceptance', workerId: 'worker-a'
    })
    if (granted.state !== 'granted') throw new Error('unreachable')
    expect(broker.authorizeInternalOperation('aaaa1111', device.id, 'test', granted.lease.id).serial).toBe(wirelessSerial)

    const physicalIdentity = (db.sqlite.prepare('SELECT physical_identity FROM android_devices WHERE id = ?').get(device.id) as {
      physical_identity: string
    }).physical_identity
    const racingRepo = androidDevicesRepo(db)
    expect(() => racingRepo.upsertDevice({
      id: `d${'f'.repeat(32)}`,
      serial: hardwareSerial,
      physicalIdentity,
      nickname: 'Racing-USB',
      model: 'Pixel Dual',
      androidVersion: '15',
      apiLevel: 35,
      connection: 'usb',
      health: 'ready',
      seenAt: new Date(now.value).toISOString()
    })).toThrow(/active Android device transport changed/)
    expect(broker.authorizeInternalOperation('aaaa1111', device.id, 'test', granted.lease.id).serial).toBe(wirelessSerial)

    adb.phones = [
      {
        serial: hardwareSerial,
        state: 'device',
        model: 'Pixel_Dual',
        release: '15',
        sdk: '35',
        usb: '1-4',
        hardwareSerial
      },
      {
        serial: wirelessSerial,
        state: 'device',
        model: 'Pixel_Dual',
        release: '15',
        sdk: '35',
        hardwareSerial
      }
    ]
    await broker.refreshInventory()

    expect(broker.listDevices()).toHaveLength(1)
    expect(broker.listDevices()[0]).toMatchObject({ id: device.id, connection: 'wireless' })
    expect(broker.authorizeInternalOperation('aaaa1111', device.id, 'test', granted.lease.id).serial).toBe(wirelessSerial)

    adb.phones[1]!.hardwareSerial = 'CHANGED-PHYSICAL-IDENTITY'
    await broker.refreshInventory()
    expect(broker.status()).toMatchObject({
      available: false,
      detail: 'Host ADB reported a changed identity for an actively leased transport; release the lease and retry.'
    })
    expect(broker.leaseForRoom('aaaa1111')?.id).toBe(granted.lease.id)
    expect(() => broker.authorizeInternalOperation('aaaa1111', device.id, 'test', granted.lease.id)).toThrow(DeviceLeaseError)

    adb.phones[1]!.hardwareSerial = hardwareSerial
    await broker.refreshInventory()
    expect(broker.status().available).toBe(true)

    await broker.release(granted.lease.id, 'wireless run finished')
    await broker.refreshInventory()
    expect(broker.listDevices()).toHaveLength(1)
    expect(broker.listDevices()[0]).toMatchObject({ id: device.id, connection: 'usb', health: 'ready' })
  })

  it('fails the whole inventory fence closed when a ready transport cannot prove identity', async () => {
    const { broker, adb } = makeBroker()
    const hardwareSerial = 'PHYSICAL-SERIAL-003'
    adb.phones = [{
      serial: hardwareSerial,
      state: 'device',
      model: 'Pixel_USB',
      release: '15',
      sdk: '35',
      usb: '1-4',
      hardwareSerial
    }]
    await broker.refreshInventory()
    const deviceId = broker.listDevices()[0]!.id

    adb.phones = [
      ...adb.phones,
      {
        serial: 'adb-unverified._adb-tls-connect._tcp',
        state: 'device',
        model: 'Pixel_Unknown',
        release: '15',
        sdk: '35',
        hardwareSerial: null
      }
    ]
    await broker.refreshInventory()

    expect(broker.status()).toMatchObject({
      available: false,
      detail: 'Host ADB could not verify a stable physical-device identity; reconnect the device and retry.'
    })
    expect(broker.listDevices()).toHaveLength(1)
    await expect(broker.requestDevice({
      roomId: 'aaaa1111', project: 'Blocked', purpose: 'smoke', workerId: 'worker-a', constraints: { deviceId }
    })).rejects.toMatchObject({ code: 'device-unhealthy' })
    expect(JSON.stringify(broker.status())).not.toContain('adb-unverified')

    adb.phones[1]!.hardwareSerial = hardwareSerial
    await broker.refreshInventory()
    expect(broker.status().available).toBe(true)
    expect(broker.listDevices()).toHaveLength(1)
  })

  it('atomically merges a provisional USB row and its pinned waiter after identity becomes available', async () => {
    const { broker, adb, db } = makeBroker()
    const usbSerial = 'USB-ALIAS-004'
    const hardwareSerial = 'PHYSICAL-SERIAL-004'
    const wirelessSerial = 'adb-PHYSICAL-SERIAL-004._adb-tls-connect._tcp'
    adb.phones = [
      {
        serial: usbSerial,
        state: 'offline',
        model: 'Pixel_Dual',
        usb: '1-4'
      },
      {
        serial: wirelessSerial,
        state: 'device',
        model: 'Pixel_Dual',
        release: '15',
        sdk: '35',
        hardwareSerial
      }
    ]
    await broker.refreshInventory()
    const provisional = broker.listDevices().find((device) => device.connection === 'usb')!
    const canonical = broker.listDevices().find((device) => device.connection === 'wireless')!
    expect(provisional.id).not.toBe(canonical.id)
    const queued = await broker.requestDevice({
      roomId: 'aaaa1111',
      project: 'PinnedWhileOffline',
      purpose: 'acceptance',
      workerId: 'worker-a',
      constraints: { deviceId: provisional.id }
    })
    expect(queued).toMatchObject({ state: 'queued', deviceId: provisional.id })

    adb.phones = [
      {
        serial: usbSerial,
        state: 'device',
        model: 'Pixel_Dual',
        release: '15',
        sdk: '35',
        usb: '1-4',
        hardwareSerial
      },
      {
        serial: wirelessSerial,
        state: 'device',
        model: 'Pixel_Dual',
        release: '15',
        sdk: '35',
        hardwareSerial
      }
    ]
    await broker.refreshInventory()

    expect(broker.listDevices()).toHaveLength(1)
    expect(broker.listDevices()[0]).toMatchObject({ id: canonical.id, connection: 'usb', leaseOwner: { roomId: 'aaaa1111' } })
    expect(broker.leaseForRoom('aaaa1111')).toMatchObject({ deviceId: canonical.id })
    expect(db.sqlite.prepare('SELECT count(*) AS count FROM android_devices').get()).toEqual({ count: 1 })
    expect(db.sqlite.prepare('SELECT count(*) AS count FROM android_devices WHERE id = ?').get(provisional.id)).toEqual({ count: 0 })
    const grantedQueue = db.sqlite
      .prepare('SELECT device_id, constraints_json, state FROM android_device_queue WHERE id = ?')
      .get(queued.state === 'queued' ? queued.requestId : '') as { device_id: string; constraints_json: string; state: string }
    expect(grantedQueue).toMatchObject({ device_id: canonical.id, state: 'granted' })
    expect(JSON.parse(grantedQueue.constraints_json)).toMatchObject({ deviceId: canonical.id })
  })

  it('hands the phone to the next queued Room when the owner releases it', async () => {
    const { broker, db } = makeBroker()
    await broker.refreshInventory()

    const first = await broker.requestDevice({ roomId: 'aaaa1111', project: 'AppDied', purpose: 'acceptance', workerId: 'worker-a' })
    await broker.requestDevice({ roomId: 'bbbb2222', project: 'MiracleKeyboard', purpose: 'keyboard', workerId: 'worker-b' })
    await broker.requestDevice({ roomId: 'cccc3333', project: 'Movit', purpose: 'smoke', workerId: 'worker-c' })
    if (first.state !== 'granted') throw new Error('unreachable')

    const released = await broker.release(first.lease.id, 'done')

    expect(released.promoted?.roomId).toBe('bbbb2222')
    expect(broker.listDevices()[0]).toMatchObject({ queueDepth: 1, leaseOwner: { roomId: 'bbbb2222' } })
    db.close()
  })

  it('keeps every durable waiter when an atomic queued grant cannot insert its lease', async () => {
    const { broker, db } = makeBroker()
    await broker.refreshInventory()
    const owner = await broker.requestDevice({
      roomId: 'aaaa1111', project: 'Owner', purpose: 'smoke', workerId: 'worker-a'
    })
    const queued = await broker.requestDevice({
      roomId: 'bbbb2222', project: 'Waiter', purpose: 'acceptance', workerId: 'worker-b'
    })
    if (owner.state !== 'granted' || queued.state !== 'queued') throw new Error('unreachable')

    // Model a pre-v6 duplicate row and make the lease write fail after the
    // promotion transaction has selected both the chosen and sibling waiters.
    db.sqlite.exec('DROP INDEX idx_android_queue_dedupe')
    const repo = androidDevicesRepo(db)
    const sibling = repo.enqueue({
      deviceId: owner.device.id,
      roomId: 'bbbb2222',
      project: 'HistoricalDuplicate',
      purpose: 'smoke',
      workerId: 'worker-old',
      issueRef: null,
      runId: null,
      constraints: { deviceId: owner.device.id },
      priority: -1,
      at: '2026-08-28T00:00:00.000Z',
      ttlMs: 60_000,
      maxDurationMs: 600_000
    })
    db.sqlite.exec(`
      CREATE TRIGGER fail_waiter_lease_insert
      BEFORE INSERT ON android_device_leases
      WHEN NEW.room_id = 'bbbb2222'
      BEGIN
        SELECT RAISE(ABORT, 'simulated queued lease insert failure');
      END;
    `)

    await expect(broker.release(owner.lease.id, 'owner finished')).rejects.toThrow(
      /simulated queued lease insert failure/
    )
    expect(repo.activeLease(owner.device.id)).toBeNull()
    expect(repo.getQueueEntry(queued.requestId)).toMatchObject({ state: 'waiting', resolvedAt: null })
    expect(repo.getQueueEntry(sibling.id)).toMatchObject({ state: 'waiting', resolvedAt: null })

    db.sqlite.exec('DROP TRIGGER fail_waiter_lease_insert')
    await broker.refreshInventory()
    const promoted = broker.leaseForRoom('bbbb2222')
    expect(promoted).toMatchObject({ project: 'Waiter' })
    expect(repo.getQueueEntry(queued.requestId)).toMatchObject({ state: 'granted' })
    expect(repo.getQueueEntry(sibling.id)).toMatchObject({ state: 'cancelled' })

    await broker.release(promoted!.id, 'waiter finished')
    expect(repo.activeLease(owner.device.id)).toBeNull()
    expect(repo.waiting(null).filter((entry) => entry.roomId === 'bbbb2222')).toHaveLength(0)
  })

  it('cancels an ineligible durable waiter and continues to the next live Room', async () => {
    const eligibleRooms = new Set(['aaaa1111', 'bbbb2222', 'cccc3333'])
    const now = { value: Date.parse('2026-08-29T00:00:00.000Z') }
    const { broker, db } = makeBroker(now, (roomId) => eligibleRooms.has(roomId))
    await broker.refreshInventory()
    const owner = await broker.requestDevice({
      roomId: 'aaaa1111', project: 'Owner', purpose: 'smoke', workerId: 'worker-a'
    })
    const stale = await broker.requestDevice({
      roomId: 'bbbb2222', project: 'Gone', purpose: 'acceptance', workerId: 'worker-b'
    })
    await broker.requestDevice({
      roomId: 'cccc3333', project: 'Live', purpose: 'acceptance', workerId: 'worker-c'
    })
    if (owner.state !== 'granted' || stale.state !== 'queued') throw new Error('unreachable')
    eligibleRooms.delete('bbbb2222')

    const released = await broker.release(owner.lease.id, 'owner finished')

    expect(released.promoted?.roomId).toBe('cccc3333')
    expect(broker.leaseForRoom('bbbb2222')).toBeNull()
    expect(androidDevicesRepo(db).getQueueEntry(stale.requestId)).toMatchObject({ state: 'cancelled' })
    expect(broker.status().recentEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'cancelled', roomId: 'bbbb2222' })
    ]))
  })

  it('replaces a Room pending request and never auto-promotes a stale duplicate after release', async () => {
    const { broker, db } = makeBroker()
    await broker.refreshInventory()
    const owner = await broker.requestDevice({
      roomId: 'aaaa1111', project: 'Owner', purpose: 'smoke', workerId: 'worker-a'
    })
    if (owner.state !== 'granted') throw new Error('unreachable')
    const first = await broker.requestDevice({
      roomId: 'bbbb2222', project: 'Waiter', purpose: 'smoke', workerId: 'worker-b'
    })
    const replacement = await broker.requestDevice({
      roomId: 'bbbb2222',
      project: 'Waiter',
      purpose: 'acceptance',
      workerId: 'worker-b',
      constraints: { deviceId: owner.device.id }
    })
    if (first.state !== 'queued' || replacement.state !== 'queued') throw new Error('unreachable')

    expect(replacement.requestId).not.toBe(first.requestId)
    expect(androidDevicesRepo(db).getQueueEntry(first.requestId)).toMatchObject({ state: 'cancelled' })
    expect(androidDevicesRepo(db).waiting(null).filter((entry) => entry.roomId === 'bbbb2222')).toHaveLength(1)

    const firstRelease = await broker.release(owner.lease.id, 'owner finished')
    expect(firstRelease.promoted?.roomId).toBe('bbbb2222')
    const secondRelease = await broker.release(firstRelease.promoted!.id, 'waiter finished')
    expect(secondRelease.promoted).toBeNull()
    expect(androidDevicesRepo(db).waiting(null).filter((entry) => entry.roomId === 'bbbb2222')).toHaveLength(0)
  })

  it('keeps one waiting entry per Room instead of stacking duplicate requests', async () => {
    const { broker, db } = makeBroker()
    await broker.refreshInventory()

    await broker.requestDevice({ roomId: 'aaaa1111', project: 'AppDied', purpose: 'acceptance', workerId: 'worker-a' })
    const queued = await broker.requestDevice({ roomId: 'bbbb2222', project: 'MiracleKeyboard', purpose: 'keyboard', workerId: 'worker-b' })
    const again = await broker.requestDevice({ roomId: 'bbbb2222', project: 'MiracleKeyboard', purpose: 'keyboard', workerId: 'worker-b' })
    if (queued.state !== 'queued' || again.state !== 'queued') throw new Error('unreachable')

    expect(again.requestId).toBe(queued.requestId)
    expect(broker.listDevices()[0]!.queueDepth).toBe(1)
    db.close()
  })

  it('lets a waiting Room cancel and skips it when the phone frees up', async () => {
    const { broker, db } = makeBroker()
    await broker.refreshInventory()

    const first = await broker.requestDevice({ roomId: 'aaaa1111', project: 'AppDied', purpose: 'acceptance', workerId: 'worker-a' })
    const waiting = await broker.requestDevice({ roomId: 'bbbb2222', project: 'MiracleKeyboard', purpose: 'keyboard', workerId: 'worker-b' })
    await broker.requestDevice({ roomId: 'cccc3333', project: 'Movit', purpose: 'smoke', workerId: 'worker-c' })
    if (first.state !== 'granted' || waiting.state !== 'queued') throw new Error('unreachable')

    broker.cancelRequest(waiting.requestId)
    const released = await broker.release(first.lease.id, 'done')

    expect(released.promoted?.roomId).toBe('cccc3333')
    db.close()
  })

  it('serves an urgent acceptance gate before older routine requests', async () => {
    const { broker, db, now } = makeBroker()
    await broker.refreshInventory()

    const first = await broker.requestDevice({ roomId: 'aaaa1111', project: 'AppDied', purpose: 'smoke', workerId: 'worker-a' })
    now.value += 1000
    await broker.requestDevice({ roomId: 'bbbb2222', project: 'MiracleKeyboard', purpose: 'smoke', workerId: 'worker-b' })
    now.value += 1000
    await broker.requestDevice({ roomId: 'cccc3333', project: 'Movit', purpose: 'acceptance', workerId: 'worker-c', priority: 10 })
    if (first.state !== 'granted') throw new Error('unreachable')

    const released = await broker.release(first.lease.id, 'done')

    expect(released.promoted?.roomId).toBe('cccc3333')
    db.close()
  })
})
