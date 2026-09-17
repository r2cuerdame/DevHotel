import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { RoomOrchestrator } from '../orchestrator'
import type { Db } from '../store/db'
import { FakeBackend, FakeGateway, FakeWindowsVm, listeningPort, makeRoom, tempDir, testDb } from './fakes'

type Internals = {
  syncRouteFor(roomId: string): Promise<void>
  revokeRouteFor(roomId: string, reason: string): void
  markWorkspaceAmbiguous(roomId: string): void
  activeRoomLocks: Set<string>
}

describe('gateway ingress invariant (#87)', () => {
  const dirs: string[] = []
  const dbs: Db[] = []

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function setup(opts: { windows?: boolean } = {}) {
    const userData = tempDir()
    dirs.push(userData)
    const db = testDb()
    dbs.push(db)
    const backend = new FakeBackend()
    const gateway = new FakeGateway()
    const windowsVm = opts.windows ? new FakeWindowsVm() : undefined
    const orch = new RoomOrchestrator({
      userData,
      backend,
      gateway: gateway.asGateway(),
      db,
      appVersion: 'test',
      ...(windowsVm ? { windowsVm } : {})
    })
    const internals = orch as unknown as Internals
    const seedRoute = (domain: string, roomId: string) =>
      gateway.routes.set(domain, { domain, roomId, targetPort: 45000, https: false, relayToken: 't' })
    return { orch, backend, gateway, windowsVm, internals, seedRoute }
  }

  it('T1 syncRouteFor revokes when hostPort is null and never calls the backend on that branch', async () => {
    const { orch, backend, gateway, internals, seedRoute } = setup()
    const room = makeRoom({ status: 'ready', hostPort: null })
    orch.rooms.create(room)
    seedRoute(room.domain, room.id)
    const callsBefore = backend.calls.length
    await internals.syncRouteFor(room.id)
    expect(gateway.routes.has(room.domain)).toBe(false)
    expect(backend.calls.length).toBe(callsBefore)
  })

  it('T2 syncRouteFor revokes when not awake (sleeping, preparing, deleting)', async () => {
    for (const status of ['sleeping', 'preparing', 'deleting'] as const) {
      const { orch, gateway, internals, seedRoute } = setup()
      const room = makeRoom({ id: `room-${status}`, domain: `${status}.localhost`, status, hostPort: 45000 })
      orch.rooms.create(room)
      seedRoute(room.domain, room.id)
      await internals.syncRouteFor(room.id)
      expect(gateway.routes.has(room.domain)).toBe(false)
    }
  })

  it('T3 syncRouteFor keeps/creates route for running, ready, attention, broken with valid hostPort', async () => {
    for (const status of ['running', 'ready', 'attention', 'broken'] as const) {
      const { orch, gateway, internals } = setup()
      const room = makeRoom({ id: `room-${status}`, domain: `${status}.localhost`, status, hostPort: 45000 })
      orch.rooms.create(room)
      await internals.syncRouteFor(room.id)
      expect(gateway.routes.get(room.domain)?.targetPort).toBe(45000)
    }
  })

  it('T3b relay-token failure fails closed (removeRoute called before rethrow)', async () => {
    const { orch, backend, gateway, internals, seedRoute } = setup()
    backend.relayToken = async () => {
      throw new Error('anchor down')
    }
    const room = makeRoom({ status: 'ready', hostPort: 45000 })
    orch.rooms.create(room)
    seedRoute(room.domain, room.id)
    await expect(internals.syncRouteFor(room.id)).rejects.toThrow('anchor down')
    expect(gateway.routes.has(room.domain)).toBe(false)
  })

  it('T4 Windows sleepRoom revokes pre-seeded route', async () => {
    const { orch, backend, gateway, seedRoute } = setup({ windows: true })
    backend.health = async () => ({ ok: false, detail: 'Docker intentionally unavailable' })
    const room = await orch.createRoom({
      sourceType: 'empty',
      sourceRef: '',
      project: 'win-app',
      nickname: 'dev',
      actor: 'user',
      provider: 'windows',
      windows: { baseVmxPath: 'C:\\VMs\\Windows 11.vmx', snapshot: 'devhotel-clean' }
    })
    seedRoute(room.domain, room.id)
    expect(gateway.routes.has(room.domain)).toBe(true)
    await orch.sleepRoom(room.id, 'user')
    expect(gateway.routes.has(room.domain)).toBe(false)
    expect(orch.rooms.get(room.id)?.status).toBe('sleeping')
  })

  it('T5 Windows deleteRoom revokes pre-seeded route', async () => {
    const { orch, backend, gateway, seedRoute } = setup({ windows: true })
    backend.health = async () => ({ ok: false, detail: 'Docker intentionally unavailable' })
    const room = await orch.createRoom({
      sourceType: 'empty',
      sourceRef: '',
      project: 'win-app',
      nickname: 'dev',
      actor: 'user',
      provider: 'windows',
      windows: { baseVmxPath: 'C:\\VMs\\Windows 11.vmx', snapshot: 'devhotel-clean' }
    })
    seedRoute(room.domain, room.id)
    expect(gateway.routes.has(room.domain)).toBe(true)
    await orch.deleteRoom(room.id, 'user')
    expect(gateway.routes.has(room.domain)).toBe(false)
    expect(orch.rooms.get(room.id)).toBeNull()
  })

  it('T6 markWorkspaceAmbiguous revokes route', () => {
    const { orch, gateway, internals, seedRoute } = setup()
    const room = makeRoom({ status: 'ready', hostPort: 45000 })
    orch.rooms.create(room)
    seedRoute(room.domain, room.id)
    internals.markWorkspaceAmbiguous(room.id)
    expect(gateway.routes.has(room.domain)).toBe(false)
    expect(orch.rooms.get(room.id)).toMatchObject({ status: 'broken', hostPort: null })
  })

  it('T7 Boot leaves no route for recorded-awake Rooms (init() preserves empty route table)', async () => {
    const { orch, gateway } = setup()
    const room = makeRoom({ status: 'ready', hostPort: 45000 })
    orch.rooms.create(room)
    await orch.init()
    expect(gateway.status().routes).toEqual([])
    expect(orch.rooms.get(room.id)).toMatchObject({ status: 'sleeping', hostPort: null })
  })

  it('T8 Runtime revalidation in hotelStatus, listRoomsRuntime, and inspectRoomRuntime revokes a dead route (the live case)', async () => {
    // hotelStatus
    const { orch, backend, gateway, seedRoute } = setup()
    const room = makeRoom({ status: 'attention', hostPort: 32845 })
    orch.rooms.create(room)
    seedRoute(room.domain, room.id)
    backend.webStateValue = 'exited'

    const status = await orch.hotelStatus()
    expect(status.gateway.routes).toEqual([])
    expect(status.rooms[0]).toMatchObject({ status: 'broken', runtimeStatus: { state: 'dead', main: 'exited' } })
    expect(orch.rooms.get(room.id)).toMatchObject({ status: 'attention', hostPort: 32845 })
    expect(gateway.routes.has(room.domain)).toBe(false)
    expect(backend.calls.some((call) => /start|create|recreate/i.test(call))).toBe(false)

    // listRoomsRuntime
    seedRoute(room.domain, room.id)
    const list = await orch.listRoomsRuntime()
    expect(list[0]).toMatchObject({ status: 'broken', runtimeStatus: { state: 'dead', main: 'exited' } })
    expect(gateway.routes.has(room.domain)).toBe(false)

    // inspectRoomRuntime
    seedRoute(room.domain, room.id)
    const inspection = await orch.inspectRoomRuntime(room.id)
    expect(inspection.urls.app).toBeNull()
    expect(inspection.runtimeStatus.state).toBe('dead')
    expect(gateway.routes.has(room.domain)).toBe(false)
  })

  it('T9 Revalidation never revokes on unknown or running', async () => {
    const { orch, backend, gateway, seedRoute } = setup()
    const room = makeRoom({ status: 'ready', hostPort: 45000 })
    orch.rooms.create(room)
    seedRoute(room.domain, room.id)

    // unknown
    backend.health = async () => ({ ok: false, detail: 'down' })
    await orch.hotelStatus()
    expect(gateway.routes.has(room.domain)).toBe(true)

    // running
    backend.health = async () => ({ ok: true, detail: 'up' })
    backend.webStateValue = 'running'
    await orch.hotelStatus()
    expect(gateway.routes.has(room.domain)).toBe(true)
  })

  it('T10 Revalidation defers to an in-flight lifecycle operation (activeRoomLocks.has(id))', async () => {
    const { orch, backend, gateway, internals, seedRoute } = setup()
    const room = makeRoom({ status: 'ready', hostPort: 45000 })
    orch.rooms.create(room)
    seedRoute(room.domain, room.id)
    backend.webStateValue = 'exited'

    internals.activeRoomLocks.add(room.id)
    await orch.hotelStatus()
    expect(gateway.routes.has(room.domain)).toBe(true)

    internals.activeRoomLocks.delete(room.id)
    await orch.hotelStatus()
    expect(gateway.routes.has(room.domain)).toBe(false)
  })

  it('T11 Wake failure revokes the stale route', async () => {
    const { orch, backend, gateway, seedRoute } = setup()
    const room = makeRoom({ status: 'ready', hostPort: 45123 })
    orch.rooms.create(room)
    seedRoute(room.domain, room.id)
    backend.webStateValue = 'missing'
    backend.recreateWeb = async () => {
      throw new Error('web boom')
    }

    await orch.startRoom(room.id, 'user').catch(() => undefined)
    expect(orch.rooms.get(room.id)?.status).toBe('broken')
    expect(gateway.routes.has(room.domain)).toBe(false)
  })

  it('T12 Check with exited process revokes; subsequent check with running process restores', async () => {
    const { orch, backend, gateway, seedRoute } = setup()
    backend.execInRoom = async (_roomId, cmd) => {
      if (cmd[0] === 'node') return { code: 0, stdout: 'v22.0.0\n', stderr: '' }
      return { code: 0, stdout: '10.0.0\n', stderr: '' }
    }
    const relay = await listeningPort()
    try {
      const room = makeRoom({
        sourceType: 'empty',
        sourceRef: '',
        workspaceMode: 'empty',
        syncStatus: 'empty',
        status: 'ready',
        hostPort: relay.port
      })
      orch.rooms.create(room)
      seedRoute(room.domain, room.id)
      backend.webStateValue = 'exited'

      const reportBroken = await orch.runChecks(room.id)
      expect(reportBroken.overall).toBe('broken')
      expect(orch.rooms.get(room.id)?.status).toBe('broken')
      expect(gateway.routes.has(room.domain)).toBe(false)

      backend.webStateValue = 'running'
      const reportReady = await orch.runChecks(room.id)
      expect(reportReady.overall).toBe('healthy')
      expect(gateway.routes.has(room.domain)).toBe(true)
      expect(orch.rooms.get(room.id)?.status).toBe('ready')
    } finally {
      relay.close()
    }
  })

  it('T13 Check with running process but dead port keeps the route', async () => {
    const { orch, backend, gateway, seedRoute } = setup()
    const room = makeRoom({ status: 'ready', hostPort: 1 })
    orch.rooms.create(room)
    seedRoute(room.domain, room.id)
    backend.webStateValue = 'running'

    const report = await orch.runChecks(room.id)
    const portStep = report.results.find((r) => r.step === 'port')!
    expect(portStep.status).toBe('broken')
    expect(orch.rooms.get(room.id)?.status).toBe('broken')
    expect(gateway.routes.has(room.domain)).toBe(true)
  })
})
