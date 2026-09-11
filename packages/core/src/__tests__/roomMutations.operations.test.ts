import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { OperationRecord, RoomRecord } from '@devhotel/shared'
import { RoomOrchestrator } from '../orchestrator'
import type { Db } from '../store/db'
import { FakeBackend, FakeGateway, FakeWindowsVm, listeningPort, makeRoom, tempDir, testDb } from './fakes'

const CALLER_ID = '2f0f6f52-1c0a-4f5f-9ba0-7c1a4a2b1f01'
const OTHER_ID = '2f0f6f52-1c0a-4f5f-9ba0-7c1a4a2b1f02'

/** A promise a test resolves by hand, standing in for a slow backend call. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

describe('long Room mutations as pollable operations', () => {
  const dirs: string[] = []
  const dbs: Db[] = []
  const closers: (() => void)[] = []

  afterEach(() => {
    for (const close of closers.splice(0)) close()
    for (const db of dbs.splice(0)) db.close()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  async function setup(overrides: Partial<RoomRecord> = {}) {
    const userData = tempDir()
    dirs.push(userData)
    const db = testDb()
    dbs.push(db)
    const backend = new FakeBackend()
    const gateway = new FakeGateway()
    const listener = await listeningPort()
    closers.push(listener.close)
    backend.hostPort = listener.port
    const orch = new RoomOrchestrator({
      userData,
      backend,
      windowsVm: new FakeWindowsVm(),
      gateway: gateway.asGateway(),
      db,
      appVersion: 'test'
    })
    const room = makeRoom({
      sourceType: 'managed-git',
      sourceRef: 'https://example.test/demo.git',
      workspaceMode: 'hotel',
      syncStatus: 'synced',
      status: 'ready',
      ...overrides
    })
    orch.rooms.create(room)
    return { backend, orch, room, db }
  }

  it('persists the operation before the first side effect, so a lost response is pollable', async () => {
    const { backend, orch, room } = await setup()
    const slow = gate()
    const stop = backend.stopRoomPod.bind(backend)
    backend.stopRoomPod = async (roomId: string) => {
      await slow.promise
      return stop(roomId)
    }

    // waitMs 0 is the honest model of a caller whose own deadline is shorter
    // than the work: it takes the durable ID and stops waiting.
    const accepted = await orch.sleepRoomOperation(room.id, 'agent', { waitMs: 0 })
    expect(accepted.result).toBeUndefined()
    expect(accepted.operation.status).toBe('running')
    // Durable before the pod was ever touched — that is the whole point.
    expect(backend.calls.filter((call) => call.startsWith('stopRoomPod:'))).toHaveLength(0)
    expect(orch.getOperation(accepted.operation.id)?.status).toBe('running')

    slow.open()
    const finished = await orch.waitForOperation(accepted.operation.id, 10_000)
    expect(finished?.status).toBe('succeeded')
    expect(orch.rooms.get(room.id)?.status).toBe('sleeping')
    expect(backend.calls.filter((call) => call.startsWith('stopRoomPod:'))).toHaveLength(1)
  })

  it('replays a repeated operation ID instead of sleeping the Room twice', async () => {
    const { backend, orch, room } = await setup()

    const first = await orch.sleepRoomOperation(room.id, 'agent', { operationId: CALLER_ID })
    // The retry a client sends after it never saw the first answer.
    const retry = await orch.sleepRoomOperation(room.id, 'agent', { operationId: CALLER_ID })

    expect(first.operation.id).toBe(CALLER_ID)
    expect(retry.operation.id).toBe(CALLER_ID)
    expect(retry.operation.status).toBe('succeeded')
    expect(backend.calls.filter((call) => call.startsWith('stopRoomPod:'))).toHaveLength(1)
    expect(orch.listOperations(room.id).filter((op) => op.kind === 'room-sleep')).toHaveLength(1)
  })

  it('refuses to reuse one operation ID for a different request', async () => {
    const { orch, room } = await setup()
    await orch.runChecksOperation(room.id, 'agent', { operationId: CALLER_ID })

    await expect(
      orch.sleepRoomOperation(room.id, 'agent', { operationId: CALLER_ID })
    ).rejects.toThrow(/different request/)
  })

  it('carries the answer the lost response would have had', async () => {
    const { orch, room } = await setup()

    const applied = await orch.applyChange(room.id, { kind: 'domain', domain: 'moved.localhost' }, 'agent', CALLER_ID)
    expect(applied).toMatchObject({ id: CALLER_ID })

    // The client never saw that entry. Polling the ID it chose returns it.
    const polled = orch.getOperation(CALLER_ID)
    expect(polled?.kind).toBe('room-change')
    expect(polled?.status).toBe('succeeded')
    expect(polled?.result).toMatchObject({ id: CALLER_ID, kind: 'domain' })
  })

  it('applies a change once when the same request is retried', async () => {
    const { orch, room } = await setup()
    const change = { kind: 'domain', domain: 'retried.localhost' } as const

    await orch.applyChange(room.id, change, 'agent', CALLER_ID)
    await orch.applyChange(room.id, change, 'agent', CALLER_ID)

    expect(orch.listChanges(room.id).filter((entry) => entry.kind === 'domain')).toHaveLength(1)
    expect(orch.listOperations(room.id).filter((op) => op.kind === 'room-change')).toHaveLength(1)
  })

  it('keeps a failed mutation terminal and answers the retry with the same failure', async () => {
    const { backend, orch, room } = await setup()
    backend.stopRoomPod = async () => {
      throw new Error('the isolation backend refused to stop the pod')
    }

    await expect(orch.sleepRoomOperation(room.id, 'agent', { operationId: CALLER_ID })).rejects.toThrow(
      /refused to stop the pod/
    )
    const record = orch.getOperation(CALLER_ID)
    expect(record?.status).toBe('failed')
    expect(record?.result).toBeUndefined()

    await expect(orch.sleepRoomOperation(room.id, 'agent', { operationId: CALLER_ID })).rejects.toThrow(
      /refused to stop the pod/
    )
  })

  it('leaves the delete receipt pollable after the Room it removed is gone', async () => {
    const { orch, room } = await setup()

    const outcome = await orch.deleteRoomOperation(room.id, 'agent', { operationId: CALLER_ID })

    expect(outcome.result).toEqual({ reclaimedBytes: expect.any(Number) })
    expect(orch.rooms.get(room.id)).toBeNull()
    // The Room's cascade must not take the record of its own deletion with it.
    const receipt = orch.getOperation(CALLER_ID)
    expect(receipt?.kind).toBe('room-delete')
    expect(receipt?.status).toBe('succeeded')
    expect(receipt?.result).toEqual({ reclaimedBytes: expect.any(Number) })
  })

  it('never loses the delete receipt to its own cascade, not even for an instant', async () => {
    const { orch, room } = await setup()
    const cascade = orch.rooms.delete.bind(orch.rooms)
    let survivedCascade: OperationRecord | null = null
    orch.rooms.delete = (id, keepOperationId) => {
      cascade(id, keepOperationId)
      // Read straight from storage, in the window between the Room going away
      // and the terminal record being written.
      survivedCascade = orch.operationRecords.get(CALLER_ID)
    }

    // waitMs 0 returns before the cascade runs, so nothing about this call is
    // still on the stack when the Room — and its operation rows — go away.
    const accepted = await orch.deleteRoomOperation(room.id, 'agent', { operationId: CALLER_ID, waitMs: 0 })
    expect(accepted.operation.status).toBe('running')
    expect(await orch.waitForOperation(CALLER_ID, 10_000)).toMatchObject({ status: 'succeeded' })

    // A poll landing in that window has to get an answer, not a 404.
    expect(survivedCascade).toMatchObject({ id: CALLER_ID, kind: 'room-delete', status: 'running' })
    expect(orch.rooms.get(room.id)).toBeNull()
    expect(orch.getOperation(CALLER_ID)?.result).toEqual({ reclaimedBytes: expect.any(Number) })
  })

  it('deletes the Room once when the delete request is retried', async () => {
    const { backend, orch, room } = await setup()

    await orch.deleteRoomOperation(room.id, 'agent', { operationId: CALLER_ID })
    const retry = await orch.deleteRoomOperation(room.id, 'agent', { operationId: CALLER_ID })

    expect(retry.operation.status).toBe('succeeded')
    expect(backend.calls.filter((call) => call.startsWith('deleteRoomPod:'))).toHaveLength(1)
  })

  it('answers a bounded wait that ran out with the running operation, not an error', async () => {
    const { backend, orch, room } = await setup()
    const slow = gate()
    const stop = backend.stopRoomPod.bind(backend)
    backend.stopRoomPod = async (roomId: string) => {
      await slow.promise
      return stop(roomId)
    }

    const outcome = await orch.sleepRoomOperation(room.id, 'agent', { operationId: OTHER_ID, waitMs: 25 })
    expect(outcome.result).toBeUndefined()
    expect(outcome.operation.status).toBe('running')

    slow.open()
    expect((await orch.waitForOperation(OTHER_ID, 10_000))?.status).toBe('succeeded')
  })

  it('records health checks and web restarts as their own operations', async () => {
    const { orch, room } = await setup({ status: 'sleeping', hostPort: null })
    await orch.startRoom(room.id, 'agent')

    await orch.runChecksOperation(room.id, 'agent', {})
    await orch.restartWebOperation(room.id, 'agent', {})

    const kinds = orch.listOperations(room.id).map((op) => op.kind)
    expect(kinds).toContain('room-checks')
    expect(kinds).toContain('room-restart-web')
    expect(orch.listOperations(room.id).every((op) => op.status !== 'running')).toBe(true)
  })

  it('survives a restart by failing the mutation nobody is driving any more', async () => {
    const { backend, orch, room } = await setup()
    const slow = gate()
    const stop = backend.stopRoomPod.bind(backend)
    backend.stopRoomPod = async (roomId: string) => {
      await slow.promise
      return stop(roomId)
    }

    const accepted = await orch.sleepRoomOperation(room.id, 'agent', { operationId: CALLER_ID, waitMs: 0 })
    expect(accepted.operation.status).toBe('running')

    // What the next process sees in the durable store: a row still marked
    // running with no work behind it.
    const recovered = orch.operationRecords.failInterrupted('DevHotel restarted', new Date().toISOString())
    expect(recovered.map((op) => op.id)).toContain(CALLER_ID)
    expect(orch.operationRecords.get(CALLER_ID)?.status).toBe('failed')

    slow.open()
    await orch.waitForOperation(CALLER_ID, 10_000)
  })
})
