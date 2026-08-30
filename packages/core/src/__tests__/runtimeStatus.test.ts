import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoomOrchestrator } from '../orchestrator'
import type { Db } from '../store/db'
import { FakeBackend, FakeGateway, listeningPort, makeRoom, tempDir, testDb } from './fakes'

describe('Room runtime status', () => {
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
    const orch = new RoomOrchestrator({
      userData,
      backend,
      gateway: new FakeGateway().asGateway(),
      db,
      appVersion: 'test'
    })
    return { backend, orch }
  }

  it('does not report a recorded-ready Room as ready when its runtime stopped', async () => {
    const { backend, orch } = setup()
    const room = makeRoom({
      workspaceMode: 'hotel',
      syncStatus: 'synced',
      workspaceFingerprint: 'baseline',
      status: 'ready'
    })
    orch.rooms.create(room)
    backend.webStateValue = 'exited'

    const listed = await orch.listRoomsRuntime()
    const hotel = await orch.hotelStatus()
    const inspection = await orch.inspectRoomRuntime(room.id)

    expect(listed[0]).toMatchObject({
      status: 'broken',
      runtimeStatus: { state: 'dead', recordedStatus: 'ready', main: 'exited' }
    })
    expect(hotel.rooms[0]).toMatchObject({
      status: 'broken',
      runtimeStatus: { state: 'dead', recordedStatus: 'ready', main: 'exited' }
    })
    expect(inspection.room.status).toBe('broken')
    expect(inspection.runtimeStatus).toMatchObject({ state: 'dead', recordedStatus: 'ready', main: 'exited' })
    expect(inspection.urls.app).toBeNull()
    expect(orch.rooms.get(room.id)?.status).toBe('ready')
    expect(orch.rooms.get(room.id)?.syncStatus).toBe('synced')
    expect(backend.calls.some((call) => /start|create|recreate/i.test(call))).toBe(false)
  })

  it('keeps a live Room ready and status reads never start it', async () => {
    const { backend, orch } = setup()
    const room = makeRoom({ status: 'ready' })
    orch.rooms.create(room)
    backend.webStateValue = 'running'

    const first = await orch.inspectRoomRuntime(room.id)
    const second = await orch.inspectRoomRuntime(room.id)

    expect(first.room.status).toBe('ready')
    expect(first.runtimeStatus).toMatchObject({ state: 'running', recordedStatus: 'ready', main: 'running' })
    expect(second.runtimeStatus.state).toBe('running')
    expect(backend.calls.some((call) => /start|create|recreate/i.test(call))).toBe(false)
  })

  it('recreates a recorded-ready Room when Start is used to recover a dead runtime', async () => {
    const { backend, orch } = setup()
    const relay = await listeningPort()
    backend.hostPort = relay.port
    const room = makeRoom({ status: 'ready', hostPort: 45123 })
    orch.rooms.create(room)
    backend.webStateValue = 'missing'
    const recreateAnchor = backend.recreateAnchor.bind(backend)
    backend.recreateAnchor = async (spec) => {
      const result = await recreateAnchor(spec)
      backend.webStateValue = 'running'
      return result
    }

    try {
      await orch.startRoom(room.id, 'user')

      expect(backend.calls).toContain(`recreateAnchor:${room.id}:${room.internalPort}`)
      expect(backend.calls.some((call) => call.startsWith(`recreateWeb:${room.id}:`))).toBe(true)
      expect(orch.rooms.get(room.id)).toMatchObject({ status: 'ready', hostPort: relay.port })
    } finally {
      relay.close()
    }
  })

  it('reports an Android Room with one dead runtime component as degraded', async () => {
    const { backend, orch } = setup()
    const room = makeRoom({
      provider: 'android',
      runtime: { kind: 'jdk', version: '17' },
      packageManager: { kind: 'gradle' },
      internalPort: 6080,
      android: { device: 'Pixel 6', version: '11.0' },
      status: 'ready'
    })
    orch.rooms.create(room)
    backend.webStateValue = 'running'
    backend.emulatorStateValue = 'exited'

    const inspection = await orch.inspectRoomRuntime(room.id)

    expect(inspection.room.status).toBe('attention')
    expect(inspection.runtimeStatus).toMatchObject({
      state: 'degraded',
      recordedStatus: 'ready',
      main: 'running',
      emulator: 'exited'
    })
    expect(inspection.urls.app).toBeNull()

    backend.webStateValue = 'exited'
    backend.emulatorStateValue = 'running'
    const mainDead = await orch.inspectRoomRuntime(room.id)
    expect(mainDead.room.status).toBe('attention')
    expect(mainDead.runtimeStatus).toMatchObject({ state: 'degraded', main: 'exited', emulator: 'running' })
  })

  it('rejects commands before Docker exec when the runtime is dead', async () => {
    const { backend, orch } = setup()
    const room = makeRoom({
      workspaceMode: 'hotel',
      syncStatus: 'synced',
      workspaceFingerprint: 'baseline',
      status: 'ready'
    })
    orch.rooms.create(room)
    backend.webStateValue = 'missing'
    const exec = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'container room is not running' }))
    backend.execInRoom = exec

    await expect(orch.execInRoom(room.id, ['node', '--version'], undefined, 'agent')).rejects.toMatchObject({
      code: 'ROOM_RUNTIME_NOT_RUNNING',
      recoveryHint: expect.stringMatching(/start|restart/i)
    })
    expect(exec).not.toHaveBeenCalled()
    expect(orch.rooms.get(room.id)?.syncStatus).toBe('synced')
  })

  it('normalizes a runtime that dies between the preflight and Docker exec', async () => {
    const { backend, orch } = setup()
    const room = makeRoom({ workspaceMode: 'hotel', syncStatus: 'synced', status: 'ready' })
    orch.rooms.create(room)
    let probes = 0
    backend.webState = async () => (probes++ === 0 ? 'running' : 'exited')
    backend.execInRoom = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'container raw-engine-id is not running' }))

    let error: unknown
    try {
      await orch.execInRoom(room.id, ['node', '--version'], undefined, 'agent')
    } catch (caught) {
      error = caught
    }

    expect(error).toMatchObject({
      code: 'ROOM_RUNTIME_NOT_RUNNING',
      message: expect.not.stringContaining('raw-engine-id')
    })
    expect(backend.execInRoom).toHaveBeenCalledOnce()
  })

  it('does not run commands in a recorded-sleeping Room even if a stray container is alive', async () => {
    const { backend, orch } = setup()
    const room = makeRoom({ workspaceMode: 'hotel', syncStatus: 'synced', status: 'sleeping', hostPort: null })
    orch.rooms.create(room)
    backend.webStateValue = 'running'
    backend.execInRoom = vi.fn(async () => ({ code: 0, stdout: 'unexpected', stderr: '' }))

    await expect(orch.execInRoom(room.id, ['node', '--version'], undefined, 'agent')).rejects.toMatchObject({
      code: 'ROOM_RUNTIME_NOT_RUNNING'
    })
    expect(backend.execInRoom).not.toHaveBeenCalled()
  })
})
