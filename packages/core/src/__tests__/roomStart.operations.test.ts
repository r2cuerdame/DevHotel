import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { OperationRecord, OperationStageKey } from '@devhotel/shared'
import { RoomOrchestrator } from '../orchestrator'
import type { Db } from '../store/db'
import { FakeBackend, FakeGateway, FakeWindowsVm, listeningPort, makeRoom, tempDir, testDb } from './fakes'

/** A promise a test resolves by hand, standing in for a slow docker call. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

function stageKeys(record: OperationRecord): OperationStageKey[] {
  return record.stages.map((stage) => stage.key)
}

function stage(record: OperationRecord, key: OperationStageKey) {
  return record.stages.find((entry) => entry.key === key)
}

function interruptedOperation(roomId: string): OperationRecord {
  const startedAt = '2026-08-25T00:00:00.000Z'
  return {
    id: '9d2a2c30-9c9a-4a2e-9b8b-0f6a2f1d5f01',
    kind: 'room-start',
    roomId,
    actor: 'agent',
    status: 'running',
    stage: 'container-start',
    stages: [{
      key: 'container-start',
      label: 'Start the Room containers',
      status: 'running',
      detail: null,
      startedAt,
      endedAt: null
    }],
    error: null,
    startedAt,
    updatedAt: startedAt,
    finishedAt: null
  }
}

describe('Room start as a trackable operation', () => {
  const dirs: string[] = []
  const dbs: Db[] = []
  const closers: (() => void)[] = []

  afterEach(() => {
    for (const close of closers.splice(0)) close()
    for (const db of dbs.splice(0)) db.close()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  async function setup(overrides: Partial<Parameters<typeof makeRoom>[0]> = {}) {
    const userData = tempDir()
    dirs.push(userData)
    const db = testDb()
    dbs.push(db)
    const backend = new FakeBackend()
    const gateway = new FakeGateway()
    const windowsVm = new FakeWindowsVm()
    const listener = await listeningPort()
    closers.push(listener.close)
    backend.hostPort = listener.port
    const orch = new RoomOrchestrator({
      userData,
      backend,
      windowsVm,
      gateway: gateway.asGateway(),
      db,
      appVersion: 'test'
    })
    const record = makeRoom({
      sourceType: 'managed-git',
      sourceRef: 'https://example.test/demo.git',
      workspaceMode: 'hotel',
      syncStatus: 'synced',
      status: 'sleeping',
      hostPort: null,
      ...overrides
    })
    orch.rooms.create(record)
    return { backend, gateway, windowsVm, orch, room: record, db, userData }
  }

  it('does not queue a second wake behind a wake that is still running', async () => {
    const { backend, orch, room } = await setup()
    const slow = gate()
    const inner = backend.recreateAnchor.bind(backend)
    backend.recreateAnchor = async (spec) => {
      await slow.promise
      return inner(spec)
    }

    const first = orch.startRoom(room.id, 'agent')
    const second = orch.startRoom(room.id, 'agent')
    slow.open()
    await Promise.all([first, second])

    expect(backend.calls.filter((call) => call.startsWith('recreateAnchor:'))).toHaveLength(1)
  })

  it('joins a retry while Android emulator startup is still running', async () => {
    const { backend, orch, room } = await setup({
      provider: 'android',
      sourceType: 'empty',
      sourceRef: '',
      workspaceMode: 'empty',
      syncStatus: 'empty',
      runtime: { kind: 'jdk', version: '17' },
      packageManager: { kind: 'gradle' },
      startCommand: 'gradle assembleDebug --no-daemon',
      internalPort: 6080,
      android: { device: 'Pixel 6', version: '15.0' }
    })
    const slow = gate()
    const createEmulator = backend.createEmulator.bind(backend)
    backend.createEmulator = async (roomId, config) => {
      await slow.promise
      return createEmulator(roomId, config)
    }

    const first = orch.startRoomOperation(room.id, 'agent')
    const retry = orch.startRoomOperation(room.id, 'agent')
    expect(retry.id).toBe(first.id)
    slow.open()
    await orch.waitForOperation(first.id, 30_000)

    expect(backend.calls.filter((call) => call.startsWith('createEmulator:'))).toHaveLength(1)
  })

  it('keeps one wake running when a caller gives up and asks again', async () => {
    const { backend, orch, room } = await setup()
    const slow = gate()
    const inner = backend.recreateAnchor.bind(backend)
    backend.recreateAnchor = async (spec) => {
      await slow.promise
      return inner(spec)
    }

    // The caller starts the Room and gives up waiting — exactly what an MCP or
    // HTTP client timeout looks like from the outside.
    const operation = orch.startRoomOperation(room.id, 'agent')
    expect(operation.status).toBe('running')

    // Asking again must join the running wake instead of queueing a second one.
    const retry = orch.startRoomOperation(room.id, 'agent')
    expect(retry.id).toBe(operation.id)
    expect(retry.status).toBe('running')

    slow.open()
    const finished = await orch.waitForOperation(operation.id, 10_000)
    expect(finished?.status).toBe('succeeded')
    expect(backend.calls.filter((call) => call.startsWith('recreateAnchor:'))).toHaveLength(1)
  })

  it('does not publish or schedule an operation whose initial durable save fails', async () => {
    const { backend, orch, room } = await setup()
    const save = orch.operationRecords.save.bind(orch.operationRecords)
    let rejectInitialSave = true
    orch.operationRecords.save = (record) => {
      if (rejectInitialSave) {
        rejectInitialSave = false
        throw new Error('SQLITE_IOERR: operation record could not be saved')
      }
      save(record)
    }

    expect(() => orch.startRoomOperation(room.id, 'agent')).toThrow(/SQLITE_IOERR/)
    expect(backend.calls.filter((call) => call.startsWith('recreateAnchor:'))).toHaveLength(0)
    expect(orch.listOperations(room.id)).toHaveLength(0)

    const retry = orch.startRoomOperation(room.id, 'agent')
    const finished = await orch.waitForOperation(retry.id, 30_000)
    expect(finished?.status).toBe('succeeded')
    expect(backend.calls.filter((call) => call.startsWith('recreateAnchor:'))).toHaveLength(1)
  })

  it('records a terminal save failure and does not leave the dedupe key stale', async () => {
    const { orch, room } = await setup()
    const save = orch.operationRecords.save.bind(orch.operationRecords)
    let rejectTerminalSave = true
    orch.operationRecords.save = (record) => {
      if (rejectTerminalSave && record.status !== 'running') {
        rejectTerminalSave = false
        throw new Error('SQLITE_FULL: terminal operation record could not be saved')
      }
      save(record)
    }

    const started = orch.startRoomOperation(room.id, 'agent')
    const failed = await orch.waitForOperation(started.id, 30_000)
    expect(failed).toMatchObject({
      status: 'failed',
      error: { message: expect.stringContaining('SQLITE_FULL') }
    })

    const retry = orch.startRoomOperation(room.id, 'agent')
    expect(retry.id).not.toBe(started.id)
    await expect(orch.waitForOperation(retry.id, 30_000)).resolves.toMatchObject({ status: 'succeeded' })
  })

  it('reports an unfinished wake as running, never as failed, when the wait runs out', async () => {
    const { backend, orch, room } = await setup()
    const slow = gate()
    const inner = backend.recreateAnchor.bind(backend)
    backend.recreateAnchor = async (spec) => {
      await slow.promise
      return inner(spec)
    }

    const started = orch.startRoomOperation(room.id, 'agent')
    const timedOut = await orch.waitForOperation(started.id, 30)
    expect(timedOut?.status).toBe('running')
    expect(timedOut?.error).toBeNull()
    expect(timedOut?.finishedAt).toBeNull()
    expect(timedOut?.stage).toBe('container-start')

    slow.open()
    const finished = await orch.waitForOperation(started.id, 10_000)
    expect(finished?.status).toBe('succeeded')
    expect(finished?.finishedAt).not.toBeNull()
  })

  it('polling the operation neither starts nor repeats any Room work', async () => {
    const { backend, orch, room } = await setup()
    const started = orch.startRoomOperation(room.id, 'agent')
    await orch.waitForOperation(started.id, 10_000)
    const callsAfterWake = [...backend.calls]

    for (let i = 0; i < 5; i++) {
      const polled = orch.getOperation(started.id)
      expect(polled?.status).toBe('succeeded')
    }
    expect(orch.listOperations(room.id)).toHaveLength(1)
    expect(backend.calls).toEqual(callsAfterWake)
  })

  it('walks a Web Room through its wake stages to complete', async () => {
    const { orch, room } = await setup({ services: { postgres: { version: '16' } } })

    const started = orch.startRoomOperation(room.id, 'user')
    const finished = await orch.waitForOperation(started.id, 30_000)

    expect(finished?.status).toBe('succeeded')
    expect(stageKeys(finished!)).toEqual([
      'preparing',
      'container-start',
      'services-start',
      'web-start',
      'verify',
      'complete'
    ])
    expect(finished?.stage).toBe('complete')
    expect(finished!.stages.every((entry) => entry.status !== 'running')).toBe(true)
    expect(stage(finished!, 'verify')?.detail).toContain('web process running')
  })

  it('walks a Windows Room through VM startup without touching OCI', async () => {
    const { backend, windowsVm, orch, room } = await setup({
      provider: 'windows',
      runtime: { kind: 'windows', version: '11' },
      packageManager: { kind: 'none' },
      startCommand: '',
      internalPort: 0,
      windows: { backend: 'vmware', templateId: 'd'.repeat(64), snapshot: 'devhotel-clean' }
    })

    const started = orch.startRoomOperation(room.id, 'user')
    const finished = await orch.waitForOperation(started.id, 30_000)

    expect(finished?.status).toBe('succeeded')
    expect(stageKeys(finished!)).toEqual(['preparing', 'vm-start', 'complete'])
    expect(windowsVm.calls).toEqual([`start:${room.id}`, `state:${room.id}`])
    expect(backend.calls).toEqual([])
  })

  it('walks an Android Room through emulator boot and the adb readiness answer', async () => {
    const { backend, orch, room } = await setup({
      provider: 'android',
      sourceType: 'empty',
      sourceRef: '',
      workspaceMode: 'empty',
      syncStatus: 'empty',
      runtime: { kind: 'jdk', version: '17' },
      packageManager: { kind: 'gradle' },
      startCommand: 'gradle assembleDebug --no-daemon',
      internalPort: 6080,
      android: { device: 'Pixel 6', version: '15.0' }
    })
    backend.execResult = { code: 0, stdout: '1', stderr: '' }

    const started = orch.startRoomOperation(room.id, 'agent')
    const finished = await orch.waitForOperation(started.id, 30_000)

    expect(finished?.status).toBe('succeeded')
    expect(stageKeys(finished!)).toEqual([
      'preparing',
      'container-start',
      'emulator-boot',
      'web-start',
      'verify',
      'adb-ready',
      'complete'
    ])
    expect(stage(finished!, 'adb-ready')?.status).toBe('done')
    expect(stage(finished!, 'adb-ready')?.detail).toContain('finished booting')
  })

  it('says the phone is still booting instead of pretending the Room is usable', async () => {
    const { backend, orch, room } = await setup({
      provider: 'android',
      sourceType: 'empty',
      sourceRef: '',
      workspaceMode: 'empty',
      syncStatus: 'empty',
      runtime: { kind: 'jdk', version: '17' },
      packageManager: { kind: 'gradle' },
      startCommand: 'gradle assembleDebug --no-daemon',
      internalPort: 6080,
      android: { device: 'Pixel 6', version: '15.0' }
    })
    backend.execResult = { code: 1, stdout: '', stderr: 'device offline' }

    const started = orch.startRoomOperation(room.id, 'agent')
    const finished = await orch.waitForOperation(started.id, 30_000)

    // A phone that has not booted is not a failed wake: the Room builds fine.
    expect(finished?.status).toBe('succeeded')
    expect(stage(finished!, 'adb-ready')?.status).toBe('skipped')
    expect(stage(finished!, 'adb-ready')?.detail).toContain('still booting')
    expect(orch.rooms.get(room.id)?.status).toBe('ready')
  })

  it('keeps an Android Room build-only when the emulator cannot start, and says so', async () => {
    const { backend, orch, room } = await setup({
      provider: 'android',
      sourceType: 'empty',
      sourceRef: '',
      workspaceMode: 'empty',
      syncStatus: 'empty',
      runtime: { kind: 'jdk', version: '17' },
      packageManager: { kind: 'gradle' },
      startCommand: 'gradle assembleDebug --no-daemon',
      internalPort: 6080,
      android: { device: 'Pixel 6', version: '15.0' }
    })
    backend.createEmulator = async () => {
      throw new Error('NO_KVM: /dev/kvm cannot be found')
    }

    const started = orch.startRoomOperation(room.id, 'agent')
    const finished = await orch.waitForOperation(started.id, 30_000)

    expect(finished?.status).toBe('succeeded')
    expect(stage(finished!, 'emulator-boot')?.status).toBe('skipped')
    expect(stage(finished!, 'emulator-boot')?.detail).toContain('NO_KVM')
    expect(stageKeys(finished!)).not.toContain('adb-ready')
    expect(orch.rooms.get(room.id)?.status).toBe('ready')
  })

  it('reports a wake that threw as failed, with the stage and the error', async () => {
    const { backend, orch, room } = await setup()
    backend.recreateWeb = async () => {
      throw new Error('docker: no space left on device')
    }

    const started = orch.startRoomOperation(room.id, 'agent')
    const finished = await orch.waitForOperation(started.id, 30_000)

    expect(finished?.status).toBe('failed')
    expect(finished?.stage).toBe('web-start')
    expect(finished?.error?.stage).toBe('web-start')
    expect(finished?.error?.message).toContain('no space left on device')
    expect(stage(finished!, 'web-start')?.status).toBe('failed')
    expect(orch.rooms.get(room.id)?.status).toBe('broken')
  })

  it('reports a wake whose Room never answered as failed, not as a bare success', async () => {
    const { backend, orch, room } = await setup()
    backend.webStateValue = 'exited'

    // Today this call resolves either way — the Room status carries the outcome.
    await expect(orch.startRoom(room.id, 'agent')).resolves.toBeUndefined()

    const [operation] = orch.listOperations(room.id)
    expect(orch.rooms.get(room.id)?.status).toBe('attention')
    expect(operation?.status).toBe('failed')
    expect(operation?.error?.stage).toBe('verify')
    expect(operation?.error?.message).toContain('web process exited')
  })

  it('records an already-awake Room as a skipped, successful no-op', async () => {
    const { backend, orch, room } = await setup()
    const first = orch.startRoomOperation(room.id, 'user')
    await orch.waitForOperation(first.id, 30_000)
    const callsAfterWake = [...backend.calls]

    const second = orch.startRoomOperation(room.id, 'user')
    expect(second.id).not.toBe(first.id)
    const finished = await orch.waitForOperation(second.id, 30_000)

    expect(finished?.status).toBe('succeeded')
    expect(stage(finished!, 'preparing')?.status).toBe('skipped')
    expect(stage(finished!, 'preparing')?.detail).toContain('already awake')
    expect(backend.calls).toEqual(callsAfterWake)
  })

  it('answers a poll for an operation the app restart interrupted', async () => {
    const { orch, room, db, userData } = await setup()
    const started = interruptedOperation(room.id)
    orch.operationRecords.save(started)
    expect(orch.getOperation(started.id)?.status).toBe('running')

    // A new orchestrator over the same database is what an app restart looks
    // like: the work is gone, so the record must not stay 'running' forever.
    const restarted = new RoomOrchestrator({
      userData,
      backend: new FakeBackend(),
      gateway: new FakeGateway().asGateway(),
      db,
      appVersion: 'test'
    })
    await restarted.init()

    const recovered = restarted.getOperation(started.id)
    expect(recovered?.status).toBe('failed')
    expect(recovered?.error?.message).toContain('restarted')
  })

  it('recovers an interrupted operation before a fallible gateway startup', async () => {
    const { orch, room, db, userData } = await setup()
    const started = interruptedOperation(room.id)
    orch.operationRecords.save(started)
    expect(orch.getOperation(started.id)?.status).toBe('running')

    const gateway = new FakeGateway()
    gateway.start = async () => {
      throw new Error('gateway port is unavailable')
    }
    const restarted = new RoomOrchestrator({
      userData,
      backend: new FakeBackend(),
      gateway: gateway.asGateway(),
      db,
      appVersion: 'test'
    })

    await expect(restarted.init()).rejects.toThrow(/gateway port is unavailable/)
    expect(restarted.getOperation(started.id)).toMatchObject({
      status: 'failed',
      error: { message: expect.stringContaining('restarted') }
    })
  })

  it('refuses to open an operation for a Room that does not exist', async () => {
    const { orch } = await setup()
    expect(() => orch.startRoomOperation('nosuchrm', 'agent')).toThrow(/not found/i)
    await expect(orch.startRoom('nosuchrm', 'agent')).rejects.toThrow(/not found/i)
  })

  it('forgets the operations of a deleted Room', async () => {
    const { orch, room } = await setup()
    const started = orch.startRoomOperation(room.id, 'agent')
    await orch.waitForOperation(started.id, 30_000)
    expect(orch.listOperations(room.id)).toHaveLength(1)

    await orch.deleteRoom(room.id, 'user')

    expect(orch.listOperations(room.id)).toHaveLength(0)
    expect(orch.getOperation(started.id)).toBeNull()
  })
})
