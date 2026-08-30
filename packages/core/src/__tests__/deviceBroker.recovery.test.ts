import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DeviceLease } from '@devhotel/shared'
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
      // already closed
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeBroker(
  opts: {
    alive?: boolean | 'unknown'
    graceMs?: number
    ownerLiveness?: (lease: DeviceLease) => Promise<boolean | 'unknown'> | boolean | 'unknown'
  } = {}
) {
  const dir = mkdtempSync(join(tmpdir(), 'devhotel-recovery-'))
  dirs.push(dir)
  const db = openDb(dir)
  dbs.push(db)
  const now = { value: Date.parse('2026-08-29T00:00:00.000Z') }
  const liveness: { alive: boolean | 'unknown' } = { alive: opts.alive ?? false }
  const adb = new FakeAdbHost([{ serial: 'R5CT30ABCDE', state: 'device', model: 'SM_G991N', release: '14', sdk: '34' }])
  const broker = new AndroidDeviceBroker({
    repo: androidDevicesRepo(db),
    adb,
    now: () => now.value,
    ownerLiveness: opts.ownerLiveness ?? (() => liveness.alive),
    graceMs: opts.graceMs ?? 30_000
  })
  return { broker, adb, db, now, liveness }
}

describe('Android device broker — stale lease recovery', () => {
  it('reclaims the phone from a killed worker and hands it to the waiting Room', async () => {
    const { broker, now } = makeBroker({ alive: false })
    await broker.refreshInventory()
    await broker.requestDevice({ roomId: 'aaaa1111', project: 'AppDied', purpose: 'acceptance', workerId: 'worker-a', ttlMs: 30_000 })
    await broker.requestDevice({ roomId: 'bbbb2222', project: 'Movit', purpose: 'smoke', workerId: 'worker-b' })

    // The worker dies: no more heartbeats, and liveness says the process is gone.
    now.value += 31_000
    const firstSweep = await broker.reap()
    now.value += 31_000
    const secondSweep = await broker.reap()

    expect(firstSweep.recovered).toHaveLength(0) // still inside the grace period
    expect(secondSweep.recovered).toHaveLength(1)
    expect(secondSweep.recovered[0]!.reason).toMatch(/not running/)
    expect(secondSweep.recovered[0]!.promoted?.roomId).toBe('bbbb2222')
  })

  it('keeps the phone with a Room that is alive but quiet', async () => {
    const { broker, now } = makeBroker({ alive: true })
    await broker.refreshInventory()
    const granted = await broker.requestDevice({ roomId: 'aaaa1111', project: 'AppDied', purpose: 'acceptance', workerId: 'worker-a', ttlMs: 30_000 })
    if (granted.state !== 'granted') throw new Error('unreachable')

    // Sweep repeatedly, far past both the TTL and any grace period: a live
    // owner must survive every one of them on liveness alone.
    for (let sweep = 0; sweep < 5; sweep++) {
      now.value += 2 * 60_000
      expect((await broker.reap()).recovered).toHaveLength(0)
    }

    expect(broker.leaseForRoom('aaaa1111')?.id).toBe(granted.lease.id)
  })

  it('reclaims a silent opaque worker after TTL and grace instead of parking the phone forever', async () => {
    const { broker, now } = makeBroker({ alive: 'unknown' })
    await broker.refreshInventory()
    await broker.requestDevice({
      roomId: 'aaaa1111',
      project: 'AppDied',
      purpose: 'acceptance',
      workerId: 'opaque-agent-session',
      ttlMs: 30_000
    })

    now.value += 31_000
    expect((await broker.reap()).recovered).toHaveLength(0)
    now.value += 31_000
    const recovered = await broker.reap()

    expect(recovered.recovered).toHaveLength(1)
    expect(recovered.recovered[0]!.reason).toMatch(/worker liveness is unavailable/)
    expect(broker.leaseForRoom('aaaa1111')).toBeNull()
  })

  it('does not reclaim over a heartbeat that arrives while liveness is being checked', async () => {
    let finishProbe!: (alive: boolean) => void
    let probeStarted!: () => void
    const started = new Promise<void>((resolve) => {
      probeStarted = resolve
    })
    const probe = new Promise<boolean>((resolve) => {
      finishProbe = resolve
    })
    const { broker, now } = makeBroker({
      graceMs: 0,
      ownerLiveness: () => {
        probeStarted()
        return probe
      }
    })
    await broker.refreshInventory()
    const granted = await broker.requestDevice({
      roomId: 'aaaa1111',
      project: 'AppDied',
      purpose: 'acceptance',
      workerId: 'worker-a',
      ttlMs: 30_000
    })
    if (granted.state !== 'granted') throw new Error('unreachable')
    now.value += 31_000

    const sweeping = broker.reap()
    await started
    broker.heartbeat(granted.lease.id)
    finishProbe(false)

    expect((await sweeping).recovered).toHaveLength(0)
    expect(broker.leaseForRoom('aaaa1111')?.id).toBe(granted.lease.id)
  })

  it('does not double-close a lease released while liveness is being checked', async () => {
    let finishProbe!: (alive: boolean) => void
    let probeStarted!: () => void
    const started = new Promise<void>((resolve) => {
      probeStarted = resolve
    })
    const probe = new Promise<boolean>((resolve) => {
      finishProbe = resolve
    })
    const { broker, now } = makeBroker({
      graceMs: 0,
      ownerLiveness: () => {
        probeStarted()
        return probe
      }
    })
    await broker.refreshInventory()
    const granted = await broker.requestDevice({
      roomId: 'aaaa1111',
      project: 'AppDied',
      purpose: 'acceptance',
      workerId: 'worker-a',
      ttlMs: 30_000
    })
    if (granted.state !== 'granted') throw new Error('unreachable')
    now.value += 31_000

    const sweeping = broker.reap()
    await started
    await broker.release(granted.lease.id, 'finished during liveness probe')
    finishProbe(false)

    expect((await sweeping).recovered).toHaveLength(0)
    expect(broker.leaseForRoom('aaaa1111')).toBeNull()
  })

  it('re-reads a later lease before max-duration reclaim after another owner probe awaits', async () => {
    let finishProbe!: (alive: boolean) => void
    let probeStarted!: () => void
    const started = new Promise<void>((resolve) => {
      probeStarted = resolve
    })
    const probe = new Promise<boolean>((resolve) => {
      finishProbe = resolve
    })
    const { broker, adb, now } = makeBroker({
      ownerLiveness: (lease) => {
        if (lease.roomId !== 'aaaa1111') return true
        probeStarted()
        return probe
      }
    })
    adb.phones = [
      { serial: 'R5CT30FIRST1', state: 'device', model: 'First_Probe', release: '14', sdk: '34', usb: '1-4' },
      { serial: 'R5CT30SECOND', state: 'device', model: 'Second_Busy', release: '14', sdk: '34', usb: '1-5' }
    ]
    await broker.refreshInventory()
    const firstDevice = broker.listDevices().find((device) => device.model === 'First Probe')!
    const secondDevice = broker.listDevices().find((device) => device.model === 'Second Busy')!
    const first = await broker.requestDevice({
      roomId: 'aaaa1111',
      project: 'FirstOwner',
      purpose: 'smoke',
      workerId: 'worker-a',
      constraints: { deviceId: firstDevice.id },
      ttlMs: 5_000,
      maxDurationMs: 600_000
    })
    now.value += 1
    const second = await broker.requestDevice({
      roomId: 'bbbb2222',
      project: 'SecondOwner',
      purpose: 'acceptance',
      workerId: 'worker-b',
      constraints: { deviceId: secondDevice.id },
      ttlMs: 5_000,
      maxDurationMs: 60_000
    })
    if (first.state !== 'granted' || second.state !== 'granted') throw new Error('unreachable')

    now.value += 60_001
    // Keep its heartbeat fresh but leave activity old enough that the snapshot
    // taken at sweep start would be eligible for max-duration reclaim.
    broker.heartbeat(second.lease.id)
    const sweeping = broker.reap()
    await started
    // This must fence the stale activity snapshot while the first Room's
    // liveness probe is still pending.
    broker.heartbeat(second.lease.id, { busy: true })
    finishProbe(true)

    const swept = await sweeping
    expect(swept.recovered.find((entry) => entry.lease.id === second.lease.id)).toBeUndefined()
    expect(swept.warnings.find((event) => event.deviceId === secondDevice.id)?.kind).toBe('max-duration-warning')
    expect(broker.leaseForRoom('bbbb2222')?.id).toBe(second.lease.id)
  })

  it('skips a later lease explicitly released while another owner probe awaits', async () => {
    let finishProbe!: (alive: boolean) => void
    let probeStarted!: () => void
    const started = new Promise<void>((resolve) => {
      probeStarted = resolve
    })
    const probe = new Promise<boolean>((resolve) => {
      finishProbe = resolve
    })
    const { broker, adb, now } = makeBroker({
      ownerLiveness: (lease) => {
        if (lease.roomId !== 'aaaa1111') return true
        probeStarted()
        return probe
      }
    })
    adb.phones = [
      { serial: 'R5CT30FIRST2', state: 'device', model: 'First_Probe', release: '14', sdk: '34', usb: '1-4' },
      { serial: 'R5CT30THIRD1', state: 'device', model: 'Second_Released', release: '14', sdk: '34', usb: '1-5' }
    ]
    await broker.refreshInventory()
    const firstDevice = broker.listDevices().find((device) => device.model === 'First Probe')!
    const secondDevice = broker.listDevices().find((device) => device.model === 'Second Released')!
    const first = await broker.requestDevice({
      roomId: 'aaaa1111',
      project: 'FirstOwner',
      purpose: 'smoke',
      workerId: 'worker-a',
      constraints: { deviceId: firstDevice.id },
      ttlMs: 5_000,
      maxDurationMs: 600_000
    })
    now.value += 1
    const second = await broker.requestDevice({
      roomId: 'bbbb2222',
      project: 'SecondOwner',
      purpose: 'acceptance',
      workerId: 'worker-b',
      constraints: { deviceId: secondDevice.id },
      ttlMs: 5_000,
      maxDurationMs: 60_000
    })
    if (first.state !== 'granted' || second.state !== 'granted') throw new Error('unreachable')

    now.value += 60_001
    broker.heartbeat(second.lease.id)
    const sweeping = broker.reap()
    await started
    await broker.release(second.lease.id, 'finished while another Room was probed')
    finishProbe(true)

    await expect(sweeping).resolves.toMatchObject({ recovered: [] })
    expect(broker.leaseForRoom('bbbb2222')).toBeNull()
  })

  it('does not cut off a long instrumentation run that is still reporting activity', async () => {
    const { broker, now } = makeBroker({ alive: true })
    await broker.refreshInventory()
    const granted = await broker.requestDevice({
      roomId: 'aaaa1111',
      project: 'AppDied',
      purpose: 'acceptance',
      workerId: 'worker-a',
      ttlMs: 60_000,
      maxDurationMs: 60_000
    })
    if (granted.state !== 'granted') throw new Error('unreachable')

    // Past the maximum, but the owner keeps reporting real device work.
    for (let elapsed = 0; elapsed < 3; elapsed++) {
      now.value += 30_000
      broker.heartbeat(granted.lease.id, { busy: true })
    }
    const sweep = await broker.reap()

    expect(sweep.recovered).toHaveLength(0)
    expect(sweep.warnings.map((event) => event.kind)).toContain('max-duration-warning')
    expect(broker.leaseForRoom('aaaa1111')).not.toBeNull()
  })

  it('reclaims an overrun lease whose owner stopped touching the device', async () => {
    const { broker, now } = makeBroker({ alive: true })
    await broker.refreshInventory()
    const granted = await broker.requestDevice({
      roomId: 'aaaa1111',
      project: 'AppDied',
      purpose: 'acceptance',
      workerId: 'worker-a',
      ttlMs: 60_000,
      maxDurationMs: 60_000
    })
    if (granted.state !== 'granted') throw new Error('unreachable')

    // Heartbeats keep coming, but nothing has touched the phone since it was taken.
    for (let tick = 0; tick < 4; tick++) {
      now.value += 30_000
      broker.heartbeat(granted.lease.id)
    }
    const sweep = await broker.reap()

    expect(sweep.recovered).toHaveLength(1)
    expect(sweep.recovered[0]!.reason).toMatch(/maximum lease time/)
    expect(broker.leaseForRoom('aaaa1111')).toBeNull()
  })

  it('does not restore a stale owner when the phone unplugs and comes back', async () => {
    const { broker, adb, now } = makeBroker({ alive: true })
    await broker.refreshInventory()
    await broker.requestDevice({ roomId: 'aaaa1111', project: 'AppDied', purpose: 'acceptance', workerId: 'worker-a' })

    adb.phones = []
    now.value += 5_000
    await broker.refreshInventory()
    expect(broker.listDevices()[0]).toMatchObject({ health: 'disconnected', leaseOwner: null })

    adb.phones = [{ serial: 'R5CT30ABCDE', state: 'device', model: 'SM_G991N', release: '14', sdk: '34' }]
    now.value += 5_000
    await broker.refreshInventory()

    expect(broker.listDevices()[0]).toMatchObject({ health: 'ready', leaseOwner: null })
    expect(broker.leaseForRoom('aaaa1111')).toBeNull()
  })

  it('finishes lease revocation after a crash persisted disconnect health first', async () => {
    const { broker, adb, db, now } = makeBroker({ alive: true })
    await broker.refreshInventory()
    const granted = await broker.requestDevice({
      roomId: 'aaaa1111',
      project: 'AppDied',
      purpose: 'acceptance',
      workerId: 'worker-a'
    })
    if (granted.state !== 'granted') throw new Error('unreachable')

    // Simulate process death in the narrow window after markHealth() committed
    // but before the active lease was revoked.
    const repo = androidDevicesRepo(db)
    repo.markHealth(granted.device.id, 'disconnected', new Date(now.value).toISOString())
    expect(repo.activeLease(granted.device.id)?.id).toBe(granted.lease.id)
    adb.phones = []

    await broker.refreshInventory()

    expect(repo.activeLease(granted.device.id)).toBeNull()
    expect(repo.latestLeaseForRoom('aaaa1111')).toMatchObject({
      id: granted.lease.id,
      state: 'revoked',
      releaseReason: 'device disconnected'
    })
    expect(broker.deviceForRoom('aaaa1111')).toMatchObject({ id: granted.device.id, health: 'disconnected' })
  })

  it('promotes queued work when an offline device becomes ready', async () => {
    const { broker, adb } = makeBroker({ alive: true })
    adb.phones = [{ serial: 'R5CT30ABCDE', state: 'offline', model: 'SM_G991N', release: '14', sdk: '34' }]
    await broker.refreshInventory()
    const deviceId = broker.listDevices()[0]!.id
    const queued = await broker.requestDevice({
      roomId: 'bbbb2222',
      project: 'Movit',
      purpose: 'smoke',
      workerId: 'worker-b',
      constraints: { deviceId }
    })
    expect(queued.state).toBe('queued')

    adb.phones = [{ serial: 'R5CT30ABCDE', state: 'device', model: 'SM_G991N', release: '14', sdk: '34' }]
    await broker.refreshInventory()

    expect(broker.leaseForRoom('bbbb2222')).toMatchObject({ deviceId, project: 'Movit' })
    expect(broker.listDevices()[0]).toMatchObject({ health: 'ready', queueDepth: 0, leaseOwner: { roomId: 'bbbb2222' } })
    expect(broker.status().recentEvents.map((event) => event.kind)).toEqual(expect.arrayContaining(['reconnected', 'granted']))
  })

  it('keeps the nickname a human gave the phone across a reconnect', async () => {
    const { broker, adb, now } = makeBroker({ alive: true })
    await broker.refreshInventory()
    const deviceId = broker.listDevices()[0]!.id
    broker.setNickname(deviceId, 'Pixel-USB-01')

    adb.phones = []
    now.value += 1_000
    await broker.refreshInventory()
    adb.phones = [{ serial: 'R5CT30ABCDE', state: 'device', model: 'SM_G991N', release: '14', sdk: '34' }]
    now.value += 1_000
    await broker.refreshInventory()

    expect(broker.listDevices()[0]).toMatchObject({ id: deviceId, nickname: 'Pixel-USB-01' })
  })
})

describe('Android device broker — the phone is handed on as it was left', () => {
  it('runs no uninstall, clear or data wipe when a lease is released or reclaimed', async () => {
    const { broker, adb, now } = makeBroker({ alive: false })
    await broker.refreshInventory()
    const granted = await broker.requestDevice({ roomId: 'aaaa1111', project: 'AppDied', purpose: 'acceptance', workerId: 'worker-a', ttlMs: 30_000 })
    await broker.requestDevice({ roomId: 'bbbb2222', project: 'Movit', purpose: 'smoke', workerId: 'worker-b' })
    if (granted.state !== 'granted') throw new Error('unreachable')
    adb.execs = []

    await broker.release(granted.lease.id, 'acceptance finished')
    now.value += 10 * 60_000
    await broker.reap()

    const issued = adb.execs.map((call) => call.args.join(' '))
    expect(issued.filter((command) => /uninstall|pm clear|cmd package clear|rm -rf/.test(command))).toEqual([])
  })

  it('records the release history a project can read back', async () => {
    const { broker } = makeBroker({ alive: true })
    await broker.refreshInventory()
    const granted = await broker.requestDevice({ roomId: 'aaaa1111', project: 'AppDied', purpose: 'acceptance', workerId: 'worker-a' })
    if (granted.state !== 'granted') throw new Error('unreachable')

    await broker.release(granted.lease.id, 'acceptance finished')
    const status = broker.status()

    expect(status.recentEvents.map((event) => event.kind)).toEqual(expect.arrayContaining(['discovered', 'granted', 'released']))
    expect(status.recentEvents.find((event) => event.kind === 'released')?.detail).toBe('acceptance finished')
  })
})
