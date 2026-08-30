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

function makeBroker(now = { value: Date.parse('2026-08-29T00:00:00.000Z') }) {
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
    now: () => now.value
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
