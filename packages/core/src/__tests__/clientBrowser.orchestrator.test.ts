import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RoomOrchestrator } from '../orchestrator'
import { openDb, type Db } from '../store/db'
import type { ClientBrowserLaunchRequest, ClientBrowserRuntime, LaunchedClientBrowser } from '../browser/runtime'
import { FakeAdbHost, FakeBackend, FakeGateway, listeningPort, makeRoom, tempDir } from './fakes'

/**
 * A runtime that launches nothing: it records what the orchestrator asked
 * for, so Room lifecycle can be proven to own the browser without a Chromium.
 */
class FakeClientBrowserRuntime implements ClientBrowserRuntime {
  readonly kind = 'fake'
  readonly launches: ClientBrowserLaunchRequest[] = []
  readonly stopped: string[] = []
  readonly orphansStopped: string[] = []
  private nextPid = 5000

  async availability(): Promise<{ available: boolean; detail: string }> {
    return { available: true, detail: 'fake' }
  }

  async launch(request: ClientBrowserLaunchRequest): Promise<LaunchedClientBrowser> {
    this.launches.push(request)
    const pid = this.nextPid++
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
    const alive = record.pid !== null && !this.stopped.some((id) => this.launches.find((l) => l.sessionId === id))
    return { processAlive: alive, cdpReachable: false, cdpWsUrl: null, browserVersion: null }
  }

  async stopOrphan(record: { profileDir: string }): Promise<boolean> {
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
})
