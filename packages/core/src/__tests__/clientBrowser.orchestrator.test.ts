import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RoomOrchestrator } from '../orchestrator'
import { openDb, type Db } from '../store/db'
import type { ClientBrowserLaunchRequest, ClientBrowserRuntime, LaunchedClientBrowser } from '../browser/runtime'
import { FakeAdbHost, FakeBackend, FakeGateway, listeningPort, makeRoom, tempDir } from './fakes'

interface DeferredGate {
  promise: Promise<void>
  entered: Promise<void>
  markEntered: () => void
  release: () => void
}

function makeGate(): DeferredGate {
  let markEntered!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve
  })
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, entered, markEntered, release }
}

/**
 * A runtime that launches nothing: it records what the orchestrator asked
 * for, so Room lifecycle can be proven to own the browser without a Chromium.
 */
class FakeClientBrowserRuntime implements ClientBrowserRuntime {
  readonly kind = 'fake'
  readonly launches: ClientBrowserLaunchRequest[] = []
  readonly stopped: string[] = []
  readonly orphansStopped: string[] = []
  availabilityGate: DeferredGate | null = null
  launchGate: DeferredGate | null = null
  onBeforeLaunchResolve: ((request: ClientBrowserLaunchRequest) => void) | null = null
  readonly unverifiedOrphanDirs = new Set<string>()
  private readonly sessionByPid = new Map<number, string>()
  private nextPid = 5000

  async availability(): Promise<{ available: boolean; detail: string }> {
    const gate = this.availabilityGate
    if (gate) {
      this.availabilityGate = null
      gate.markEntered()
      await gate.promise
    }
    return { available: true, detail: 'fake' }
  }

  async launch(request: ClientBrowserLaunchRequest): Promise<LaunchedClientBrowser> {
    this.launches.push(request)
    const gate = this.launchGate
    if (gate) {
      this.launchGate = null
      gate.markEntered()
      await gate.promise
    }
    this.onBeforeLaunchResolve?.(request)
    const pid = this.nextPid++
    this.sessionByPid.set(pid, request.sessionId)
    return {
      pid,
      browserKind: 'chromium',
      devtoolsHost: '127.0.0.1',
      devtoolsPort: 40_000 + pid,
      cdpWsUrl: `ws://127.0.0.1:${40_000 + pid}/devtools/browser/fake-${request.sessionId}`,
      stop: async () => {
        this.stopped.push(request.sessionId)
      }
    }
  }

  async probe(record: { pid: number | null }) {
    const sessionId = record.pid !== null ? this.sessionByPid.get(record.pid) : undefined
    const alive = sessionId !== undefined && !this.stopped.includes(sessionId)
    return { processAlive: alive, cdpReachable: false, cdpWsUrl: null, browserVersion: null }
  }

  async stopOrphan(record: { profileDir: string }): Promise<boolean> {
    if (this.unverifiedOrphanDirs.has(record.profileDir)) return false
    this.orphansStopped.push(record.profileDir)
    return true
  }
}

describe('Room lifecycle owns the Room’s Client Browsers', () => {
  let db: Db
  let userData: string
  let backend: FakeBackend
  let runtime: FakeClientBrowserRuntime
  let orch: RoomOrchestrator
  let closePort: () => void

  beforeEach(async () => {
    userData = tempDir()
    db = openDb(userData)
    backend = new FakeBackend()
    const listener = await listeningPort()
    backend.hostPort = listener.port
    closePort = listener.close
    runtime = new FakeClientBrowserRuntime()
    orch = new RoomOrchestrator({
      userData,
      backend,
      gateway: new FakeGateway().asGateway(),
      db,
      appVersion: 'test',
      adb: new FakeAdbHost([]),
      clientBrowserRuntime: runtime
    })
    await orch.init()
  })

  afterEach(async () => {
    await orch.shutdown().catch(() => undefined)
    closePort()
    db.close()
    rmSync(userData, { recursive: true, force: true })
  })

  it('refuses a sleeping Room, allocates for an awake one, and releases on sleep and delete', async () => {
    orch.rooms.create(makeRoom({ id: 'awake001', status: 'ready', hostPort: backend.hostPort }))
    orch.rooms.create(makeRoom({ id: 'asleep01', nickname: 'z', domain: 'z.localhost', status: 'sleeping' }))

    await expect(orch.clientBrowsers.allocate('asleep01')).rejects.toMatchObject({ code: 'CLIENT_BROWSER_ROOM_NOT_AWAKE' })
    await expect(orch.clientBrowsers.allocate('nosuch01')).rejects.toMatchObject({ code: 'ROOM_NOT_FOUND' })

    const first = await orch.clientBrowsers.allocate('awake001')
    const second = await orch.clientBrowsers.allocate('awake001', { headless: false })
    expect(runtime.launches.map((l) => l.headless)).toEqual([true, false])
    expect(runtime.launches[0]!.profileDir).toBe(join(userData, 'client-browsers', first.session.id))
    expect(existsSync(runtime.launches[0]!.profileDir)).toBe(true)
    expect(orch.clientBrowsers.listForRoom('awake001').map((s) => s.id)).toEqual([first.session.id, second.session.id])

    const inspected = await orch.clientBrowsers.inspect(first.session.id, first.token)
    expect(inspected.owner).toEqual({ roomId: 'awake001', project: 'demo', nickname: 'dev' })
    expect(inspected.liveness.processAlive).toBe(true)
    expect(inspected.connection.endpoint).toEqual(first.endpoint)
    expect(inspected.connection.activeClients).toBe(0)

    await orch.sleepRoom('awake001', 'user')
    expect(runtime.stopped.sort()).toEqual([first.session.id, second.session.id].sort())
    expect(orch.clientBrowsers.listForRoom('awake001')).toEqual([])
    expect(existsSync(runtime.launches[0]!.profileDir)).toBe(false)
    await expect(orch.clientBrowsers.inspect(first.session.id, first.token)).rejects.toMatchObject({ code: 'CLIENT_BROWSER_NOT_FOUND' })

    // Wake it again, allocate, and let delete take the browser with the Room.
    orch.rooms.update('awake001', { status: 'ready', hostPort: backend.hostPort })
    const third = await orch.clientBrowsers.allocate('awake001')
    await orch.deleteRoom('awake001', 'user')
    expect(runtime.stopped).toContain(third.session.id)
    expect(orch.clientBrowsers.listAll()).toEqual([])
  })

  it('reconciles sessions of an earlier process at startup before serving new ones', async () => {
    orch.rooms.create(makeRoom({ id: 'awake002', status: 'ready', hostPort: backend.hostPort }))
    const stale = await orch.clientBrowsers.allocate('awake002')
    await orch.shutdown()

    // A new process over the same database: the row is there, the browser is not ours.
    const runtime2 = new FakeClientBrowserRuntime()
    const db2 = openDb(userData)
    const orch2 = new RoomOrchestrator({
      userData,
      backend,
      gateway: new FakeGateway().asGateway(),
      db: db2,
      appVersion: 'test',
      adb: new FakeAdbHost([]),
      clientBrowserRuntime: runtime2
    })
    try {
      // shutdown already released the live session; simulate a crash by reinserting its row
      db2.sqlite
        .prepare(
          `INSERT INTO client_browser_sessions (id, room_id, token_hash, status, pid, devtools_port, browser_kind, headless, profile_mode, profile_path, runtime_generation, created_at, last_active_at)
           VALUES (?, ?, 'x', 'ready', 999999, 1, 'chromium', 1, 'ephemeral', ?, 'dead-gen', ?, ?)`
        )
        .run(stale.session.id, 'awake002', join(userData, 'client-browsers', stale.session.id), stale.session.createdAt, stale.session.createdAt)
      await orch2.init()
      // shutdown slept the Room; the new process wakes it before allocating
      orch2.rooms.update('awake002', { status: 'ready', hostPort: backend.hostPort })
      expect(runtime2.orphansStopped).toEqual([join(userData, 'client-browsers', stale.session.id)])
      expect(orch2.clientBrowsers.listAll()).toEqual([])
      const fresh = await orch2.clientBrowsers.allocate('awake002')
      expect(fresh.session.status).toBe('ready')
    } finally {
      await orch2.shutdown().catch(() => undefined)
      db2.close()
    }
  })

  it('stops in-flight browser allocations and cleans empty profiles when the Room sleeps, is deleted, or DevHotel shuts down', async () => {
    orch.rooms.create(makeRoom({ id: 'other001', nickname: 'other', domain: 'other.localhost', status: 'ready', hostPort: backend.hostPort }))
    const otherPersistent = await orch.clientBrowsers.allocate('other001', { profileMode: 'persistent' })
    const otherPersistentFile = join(userData, 'client-browsers', 'persistent', 'other001', 'keep.txt')
    writeFileSync(otherPersistentFile, 'keep-other')

    // 1. Race during runtime.availability(): sleep, delete, and shutdown before mkdir/insert.
    orch.rooms.create(makeRoom({ id: 'avail001', nickname: 'a1', domain: 'a1.localhost', status: 'ready', hostPort: backend.hostPort }))
    const availSleepGate = makeGate()
    runtime.availabilityGate = availSleepGate
    const availSleepAssert = expect(orch.clientBrowsers.allocate('avail001', { profileMode: 'persistent' })).rejects.toMatchObject({
      code: 'CLIENT_BROWSER_ROOM_NOT_AWAKE'
    })
    await availSleepGate.entered
    await orch.sleepRoom('avail001', 'user')
    availSleepGate.release()
    await availSleepAssert
    expect(existsSync(join(userData, 'client-browsers', 'persistent', 'avail001'))).toBe(false)

    orch.rooms.update('avail001', { status: 'ready', hostPort: backend.hostPort })
    const availDeleteGate = makeGate()
    runtime.availabilityGate = availDeleteGate
    const availDeleteAssert = expect(orch.clientBrowsers.allocate('avail001', { profileMode: 'persistent' })).rejects.toMatchObject({
      code: 'ROOM_NOT_FOUND'
    })
    await availDeleteGate.entered
    await orch.deleteRoom('avail001', 'user')
    availDeleteGate.release()
    await availDeleteAssert
    expect(existsSync(join(userData, 'client-browsers', 'persistent', 'avail001'))).toBe(false)

    // 2. Race during runtime.launch() + sleepRoom: belated browser stops immediately and leaves no empty folder.
    orch.rooms.create(makeRoom({ id: 'sleep001', nickname: 's1', domain: 's1.localhost', status: 'ready', hostPort: backend.hostPort }))
    const launchSleepGate = makeGate()
    runtime.launchGate = launchSleepGate
    const launchSleepAssert = expect(orch.clientBrowsers.allocate('sleep001', { profileMode: 'persistent' })).rejects.toMatchObject({
      code: 'CLIENT_BROWSER_ROOM_NOT_AWAKE'
    })
    await launchSleepGate.entered
    const sleepLaunchReq = runtime.launches.at(-1)!
    await orch.sleepRoom('sleep001', 'user')
    expect(orch.clientBrowsers.listForRoom('sleep001')).toEqual([])
    launchSleepGate.release()
    await launchSleepAssert
    expect(runtime.stopped).toContain(sleepLaunchReq.sessionId)
    expect(orch.clientBrowsers.listForRoom('sleep001')).toEqual([])
    expect(existsSync(sleepLaunchReq.profileDir)).toBe(false)

    // 3. Race during runtime.launch() + deleteRoom: belated browser stops and persistent folder is gone even if launch wrote into it.
    orch.rooms.create(makeRoom({ id: 'del00001', nickname: 'd1', domain: 'd1.localhost', status: 'ready', hostPort: backend.hostPort }))
    const preExistingDelDir = join(userData, 'client-browsers', 'persistent', 'del00001')
    mkdirSync(preExistingDelDir, { recursive: true })
    writeFileSync(join(preExistingDelDir, 'cookie.txt'), 'old')
    const launchDeleteGate = makeGate()
    runtime.launchGate = launchDeleteGate
    runtime.onBeforeLaunchResolve = (req) => {
      mkdirSync(req.profileDir, { recursive: true })
      writeFileSync(join(req.profileDir, 'late.txt'), 'late')
    }
    const launchDeleteAssert = expect(orch.clientBrowsers.allocate('del00001', { profileMode: 'persistent' })).rejects.toMatchObject({
      code: 'ROOM_NOT_FOUND'
    })
    await launchDeleteGate.entered
    const deleteLaunchReq = runtime.launches.at(-1)!
    await orch.deleteRoom('del00001', 'user')
    launchDeleteGate.release()
    await launchDeleteAssert
    runtime.onBeforeLaunchResolve = null
    expect(runtime.stopped).toContain(deleteLaunchReq.sessionId)
    expect(existsSync(preExistingDelDir)).toBe(false)

    // Other Room remained completely unaffected through all races on avail001, sleep001, and del00001.
    expect(runtime.stopped).not.toContain(otherPersistent.session.id)
    expect(existsSync(otherPersistentFile)).toBe(true)
    const otherInspected = await orch.clientBrowsers.inspect(otherPersistent.session.id, otherPersistent.token)
    expect(otherInspected.liveness.processAlive).toBe(true)

    // 4. Race during runtime.launch() + clientBrowsers.shutdown() / orch.shutdown(): belated browser stops and rejects with 503.
    orch.rooms.create(makeRoom({ id: 'shut0001', nickname: 'sh1', domain: 'sh1.localhost', status: 'ready', hostPort: backend.hostPort }))
    const launchShutdownGate = makeGate()
    runtime.launchGate = launchShutdownGate
    const launchShutdownAssert = expect(orch.clientBrowsers.allocate('shut0001')).rejects.toMatchObject({
      code: 'CLIENT_BROWSER_UNAVAILABLE'
    })
    await launchShutdownGate.entered
    const shutdownLaunchReq = runtime.launches.at(-1)!
    await orch.clientBrowsers.shutdown()
    launchShutdownGate.release()
    await launchShutdownAssert
    expect(runtime.stopped).toContain(shutdownLaunchReq.sessionId)
    expect(orch.clientBrowsers.listAll()).toEqual([])
    expect(existsSync(shutdownLaunchReq.profileDir)).toBe(false)
  })

  it('keeps a Room’s persistent browser profile across sleep, removes it on Room deletion, and preserves unverified processes', async () => {
    orch.rooms.create(makeRoom({ id: 'pers0001', nickname: 'p1', domain: 'p1.localhost', status: 'ready', hostPort: backend.hostPort }))
    orch.rooms.create(makeRoom({ id: 'pers0002', nickname: 'p2', domain: 'p2.localhost', status: 'ready', hostPort: backend.hostPort }))

    const p1 = await orch.clientBrowsers.allocate('pers0001', { profileMode: 'persistent' })
    const p2 = await orch.clientBrowsers.allocate('pers0002', { profileMode: 'persistent' })
    const p1Dir = join(userData, 'client-browsers', 'persistent', 'pers0001')
    const p2Dir = join(userData, 'client-browsers', 'persistent', 'pers0002')
    writeFileSync(join(p1Dir, 'state.json'), '{"loggedIn":true}')
    writeFileSync(join(p2Dir, 'state.json'), '{"otherRoom":true}')

    // Temporary sleep closes the browser process, but keeps the Room's persistent profile intact.
    await orch.sleepRoom('pers0001', 'user')
    expect(runtime.stopped).toContain(p1.session.id)
    expect(orch.clientBrowsers.listForRoom('pers0001')).toEqual([])
    expect(existsSync(join(p1Dir, 'state.json'))).toBe(true)

    // Waking and sleeping mid-launch also preserves an already-populated persistent profile.
    orch.rooms.update('pers0001', { status: 'ready', hostPort: backend.hostPort })
    const midWakeGate = makeGate()
    runtime.launchGate = midWakeGate
    const midWakeAssert = expect(orch.clientBrowsers.allocate('pers0001', { profileMode: 'persistent' })).rejects.toMatchObject({
      code: 'CLIENT_BROWSER_ROOM_NOT_AWAKE'
    })
    await midWakeGate.entered
    await orch.sleepRoom('pers0001', 'user')
    midWakeGate.release()
    await midWakeAssert
    expect(existsSync(join(p1Dir, 'state.json'))).toBe(true)

    // Deleting the Room removes its persistent profile while leaving pers0002's running browser and profile untouched.
    orch.rooms.update('pers0001', { status: 'ready', hostPort: backend.hostPort })
    const p1Again = await orch.clientBrowsers.allocate('pers0001', { profileMode: 'persistent' })
    await orch.deleteRoom('pers0001', 'user')
    expect(runtime.stopped).toContain(p1Again.session.id)
    expect(existsSync(p1Dir)).toBe(false)
    expect(runtime.stopped).not.toContain(p2.session.id)
    expect(existsSync(join(p2Dir, 'state.json'))).toBe(true)

    // If stopOrphan cannot verify a process on a sleeping Room's persistent folder, deleteRoom leaves the folder for startup reconcile.
    orch.rooms.create(makeRoom({ id: 'unver001', nickname: 'u1', domain: 'u1.localhost', status: 'ready', hostPort: backend.hostPort }))
    await orch.clientBrowsers.allocate('unver001', { profileMode: 'persistent' })
    const unverifiedDir = join(userData, 'client-browsers', 'persistent', 'unver001')
    writeFileSync(join(unverifiedDir, 'locked.bin'), 'busy')
    await orch.sleepRoom('unver001', 'user')
    runtime.unverifiedOrphanDirs.add(unverifiedDir)
    await orch.deleteRoom('unver001', 'user')
    expect(existsSync(unverifiedDir)).toBe(true)
  })

  it('reconciles leftover persistent profiles of deleted Rooms at startup without touching living or sleeping Rooms', async () => {
    orch.rooms.create(makeRoom({ id: 'keep0001', nickname: 'k1', domain: 'k1.localhost', status: 'sleeping' }))
    orch.rooms.create(makeRoom({ id: 'keep0002', nickname: 'k2', domain: 'k2.localhost', status: 'ready', hostPort: backend.hostPort }))
    await orch.shutdown()

    const keep1Dir = join(userData, 'client-browsers', 'persistent', 'keep0001')
    const keep2Dir = join(userData, 'client-browsers', 'persistent', 'keep0002')
    const gone1Dir = join(userData, 'client-browsers', 'persistent', 'gone0001')
    const gone2Dir = join(userData, 'client-browsers', 'persistent', 'gone0002')
    const delCrashDir = join(userData, 'client-browsers', 'persistent', 'delcrash')
    for (const dir of [keep1Dir, keep2Dir, gone1Dir, gone2Dir, delCrashDir]) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'profile.json'), '{"saved":true}')
    }

    const runtime2 = new FakeClientBrowserRuntime()
    runtime2.unverifiedOrphanDirs.add(gone2Dir)
    const db2 = openDb(userData)
    const orch2 = new RoomOrchestrator({
      userData,
      backend,
      gateway: new FakeGateway().asGateway(),
      db: db2,
      appVersion: 'test',
      adb: new FakeAdbHost([]),
      clientBrowserRuntime: runtime2
    })
    try {
      // Simulate a previous process that crashed mid-deletion before removing the Room row.
      orch2.rooms.create(makeRoom({ id: 'delcrash', nickname: 'dc', domain: 'dc.localhost', status: 'deleting' }))
      await orch2.init()
      expect(existsSync(join(keep1Dir, 'profile.json'))).toBe(true)
      expect(existsSync(join(keep2Dir, 'profile.json'))).toBe(true)
      expect(existsSync(gone1Dir)).toBe(false)
      expect(existsSync(delCrashDir)).toBe(false)
      expect(runtime2.orphansStopped).toContain(gone1Dir)
      expect(runtime2.orphansStopped).toContain(delCrashDir)
      expect(runtime2.orphansStopped).not.toContain(keep1Dir)
      expect(runtime2.orphansStopped).not.toContain(keep2Dir)
      // Unverified deleted-Room profile was left untouched on the first pass and reported as unverified.
      expect(existsSync(gone2Dir)).toBe(true)
      const unverifiedPass = await orch2.clientBrowsers.reconcile()
      expect(unverifiedPass.unverified).toEqual(['persistent/gone0002'])

      runtime2.unverifiedOrphanDirs.clear()
      const secondPass = await orch2.clientBrowsers.reconcile()
      expect(secondPass).toEqual({ orphanedSessions: 0, stoppedProcesses: 0, removedProfiles: 1, unverified: [] })
      expect(existsSync(gone2Dir)).toBe(false)
      expect(existsSync(join(keep1Dir, 'profile.json'))).toBe(true)
      expect(existsSync(join(keep2Dir, 'profile.json'))).toBe(true)
    } finally {
      await orch2.shutdown().catch(() => undefined)
      db2.close()
    }
  })
})
