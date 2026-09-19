import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { OperationRecord } from '@devhotel/shared'
import type { RoomMutationOutcome, RoomOrchestrator } from '@devhotel/core'
import { startControlApi } from './controlApi'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function userDataDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), name))
  roots.push(dir)
  return dir
}

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

interface OperationRequest {
  operationId?: string
  waitMs?: number
}

/**
 * The smallest orchestrator that still tells the truth about the property under
 * test: a mutation publishes its durable record before it does its work, the
 * record reaches a terminal state whether or not anyone is still listening, and
 * a repeated operation ID replays instead of mutating again.
 */
class TrackedMutations {
  readonly records = new Map<string, OperationRecord>()
  readonly effects: string[] = []
  /** Resolves the first time a mutation actually reaches the orchestrator. */
  readonly entered = deferred()
  private gate: Deferred | null = null

  /** Hold every mutation open until {@link release} is called. */
  hold(): void {
    this.gate = deferred()
  }

  release(): void {
    this.gate?.resolve()
    this.gate = null
  }

  async run<T>(
    kind: OperationRecord['kind'],
    roomId: string,
    request: OperationRequest,
    effect: string,
    value: T
  ): Promise<RoomMutationOutcome<T>> {
    const id = request.operationId ?? `00000000-0000-4000-8000-${String(this.records.size).padStart(12, '0')}`
    const existing = this.records.get(id)
    if (existing) {
      return existing.status === 'running'
        ? { operation: existing }
        : { operation: existing, result: existing.result as T }
    }
    const startedAt = new Date().toISOString()
    // Durable before the effect, always.
    this.records.set(id, {
      id,
      kind,
      roomId,
      actor: 'agent',
      status: 'running',
      stage: 'mutate',
      stages: [],
      error: null,
      startedAt,
      updatedAt: startedAt,
      finishedAt: null
    })
    this.entered.resolve()
    const work = (this.gate?.promise ?? Promise.resolve()).then(() => this.settle(id, effect, value))
    if (request.waitMs === 0) {
      void work
      return { operation: this.records.get(id)! }
    }
    await work
    return { operation: this.records.get(id)!, result: value }
  }

  private settle<T>(id: string, effect: string, value: T): void {
    this.effects.push(effect)
    const finishedAt = new Date().toISOString()
    this.records.set(id, {
      ...this.records.get(id)!,
      status: 'succeeded',
      stage: 'complete',
      updatedAt: finishedAt,
      finishedAt,
      result: value
    })
  }
}

interface MutationCase {
  name: string
  method: string
  path: (operationId: string) => string
  body: (operationId: string) => string | undefined
  wire: (state: TrackedMutations) => Record<string, unknown>
}

/** Every mutating agent route, with the request that exercises it. */
const MUTATIONS: MutationCase[] = [
  {
    name: 'sleep',
    method: 'POST',
    path: () => '/v1/rooms/room1abc/sleep',
    body: (operationId) => JSON.stringify({ operationId }),
    wire: (state) => ({
      sleepRoomOperation: (roomId: string, _actor: string, request: OperationRequest) =>
        state.run('room-sleep', roomId, request, 'sleep', null)
    })
  },
  {
    name: 'restart-web',
    method: 'POST',
    path: () => '/v1/rooms/room1abc/restart-web',
    body: (operationId) => JSON.stringify({ operationId }),
    wire: (state) => ({
      restartWebOperation: (roomId: string, _actor: string, request: OperationRequest) =>
        state.run('room-restart-web', roomId, request, 'restart-web', { id: 'change1' })
    })
  },
  {
    name: 'checks',
    method: 'POST',
    path: () => '/v1/rooms/room1abc/checks',
    body: (operationId) => JSON.stringify({ operationId }),
    wire: (state) => ({
      runChecksOperation: (roomId: string, _actor: string, request: OperationRequest) =>
        state.run('room-checks', roomId, request, 'checks', { results: [] })
    })
  },
  {
    name: 'undo',
    method: 'POST',
    path: () => '/v1/rooms/room1abc/undo',
    body: (operationId) => JSON.stringify({ changeId: '7a1d1f10-0a2b-4c3d-8e4f-5a6b7c8d9e0f', operationId }),
    wire: (state) => ({
      undoChangeOperation: (roomId: string, _changeId: string, _actor: string, request: OperationRequest) =>
        state.run('room-undo', roomId, request, 'undo', { id: 'change1' })
    })
  },
  {
    name: 'clone',
    method: 'POST',
    path: () => '/v1/rooms/room1abc/clone',
    body: (operationId) =>
      JSON.stringify({ nickname: 'copy', copyDependencies: false, services: 'empty', operationId }),
    wire: (state) => ({
      cloneRoomOperation: (input: { sourceRoomId: string }, request: OperationRequest) =>
        state.run('room-clone', input.sourceRoomId, request, 'clone', { id: 'room2def', nickname: 'copy' })
    })
  },
  {
    name: 'create',
    method: 'POST',
    path: () => '/v1/rooms',
    body: (operationId) =>
      JSON.stringify({ project: 'demo', nickname: 'main', sourceType: 'empty', sourceRef: '', operationId }),
    wire: (state) => ({
      createRoomOperation: (_input: unknown, request: OperationRequest) =>
        state.run('room-create', 'room1abc', request, 'create', { id: 'room1abc' })
    })
  },
  {
    name: 'delete',
    method: 'DELETE',
    path: (operationId) => `/v1/rooms/room1abc?operationId=${operationId}`,
    body: () => undefined,
    wire: (state) => ({
      rooms: { get: () => ({ sourceType: 'managed-git', workspaceMode: 'hotel' }) },
      deleteRoomOperation: (roomId: string, _actor: string, request: OperationRequest) =>
        state.run('room-delete', roomId, request, 'delete', { reclaimedBytes: 4 })
    })
  }
]

const OPERATION_ID = 'b1c2d3e4-f506-4718-8920-a1b2c3d4e5f6'

function orchestratorFor(state: TrackedMutations, mutation: MutationCase): RoomOrchestrator {
  return {
    ...mutation.wire(state),
    getOperation: (id: string) => state.records.get(id) ?? null,
    waitForOperation: async (id: string) => state.records.get(id) ?? null
  } as unknown as RoomOrchestrator
}

describe('agent control API mutations that lose their response', () => {
  for (const mutation of MUTATIONS) {
    it(`leaves ${mutation.name} with one terminal operation and one effect after a disconnect`, async () => {
      const state = new TrackedMutations()
      const control = await startControlApi(
        orchestratorFor(state, mutation),
        userDataDir(`devhotel-lost-${mutation.name}-`),
        'test'
      )
      const base = `http://127.0.0.1:${control.info.port}`
      const path = mutation.path(OPERATION_ID)
      const headers = { authorization: `Bearer ${control.info.token}`, 'content-type': 'application/json' }
      try {
        state.hold()
        const abort = new AbortController()
        const inflight = fetch(`${base}${path}`, {
          method: mutation.method,
          headers,
          body: mutation.body(OPERATION_ID),
          signal: abort.signal
        })
        // The client gives up while the server is still working — the exact
        // case where "did that happen?" used to be unanswerable.
        await state.entered.promise
        abort.abort()
        await expect(inflight).rejects.toThrow()
        state.release()
        await new Promise((resolve) => setTimeout(resolve, 50))

        // The answer the caller never received is still there, and terminal.
        const polled = await fetch(`${base}/v1/operations/${OPERATION_ID}`, {
          headers: { authorization: `Bearer ${control.info.token}` }
        })
        expect(polled.status).toBe(200)
        const body = (await polled.json()) as { operation: OperationRecord }
        expect(body.operation.status).toBe('succeeded')

        // And the retry a client sends when it cannot tell replays instead of
        // mutating a second time.
        const retry = await fetch(`${base}${path}`, {
          method: mutation.method,
          headers,
          body: mutation.body(OPERATION_ID)
        })
        expect(retry.status).toBeLessThan(400)
        expect(state.effects).toEqual([mutation.name])
        expect([...state.records.keys()]).toEqual([OPERATION_ID])
      } finally {
        control.stop()
      }
    })
  }

  it('answers a bounded wait that ran out with the operation, not with a failure', async () => {
    const state = new TrackedMutations()
    const control = await startControlApi(
      orchestratorFor(state, MUTATIONS[0]!),
      userDataDir('devhotel-lost-waitms-'),
      'test'
    )
    try {
      state.hold()
      const response = await fetch(`http://127.0.0.1:${control.info.port}/v1/rooms/room1abc/sleep`, {
        method: 'POST',
        headers: { authorization: `Bearer ${control.info.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ operationId: OPERATION_ID, waitMs: 0 })
      })
      const body = (await response.json()) as { operation: OperationRecord }

      expect(response.status).toBe(202)
      expect(body.operation).toMatchObject({ id: OPERATION_ID, status: 'running', kind: 'room-sleep' })
      expect(state.effects).toEqual([])
      state.release()
    } finally {
      control.stop()
    }
  })

  it('keeps the legacy answer when the caller does not ask for a bounded wait', async () => {
    const state = new TrackedMutations()
    const control = await startControlApi(
      orchestratorFor(state, MUTATIONS[0]!),
      userDataDir('devhotel-lost-legacy-'),
      'test'
    )
    try {
      const response = await fetch(`http://127.0.0.1:${control.info.port}/v1/rooms/room1abc/sleep`, {
        method: 'POST',
        headers: { authorization: `Bearer ${control.info.token}` }
      })

      expect(response.status).toBe(204)
      expect(state.effects).toEqual(['sleep'])
    } finally {
      control.stop()
    }
  })

  it('rejects an operation identity the schema cannot accept', async () => {
    const control = await startControlApi(
      {} as unknown as RoomOrchestrator,
      userDataDir('devhotel-lost-bad-id-'),
      'test'
    )
    try {
      const response = await fetch(`http://127.0.0.1:${control.info.port}/v1/rooms/room1abc/checks`, {
        method: 'POST',
        headers: { authorization: `Bearer ${control.info.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ operationId: 'not-a-uuid' })
      })
      expect(response.status).toBe(400)
    } finally {
      control.stop()
    }
  })

  it('retains a command whose response was never delivered, so its run id still means something', async () => {
    const entered = deferred()
    const finish = deferred()
    let retainAll: boolean | undefined
    const orch = {
      execInRoom: async (_roomId: string, _cmd: string[], opts: { responseLost?: () => boolean }) => {
        entered.resolve()
        await finish.promise
        // Asked at completion, when the connection's fate is already decided.
        retainAll = opts.responseLost?.()
        return { code: 0, stdout: 'ok', stderr: '', output: { runId: 'run-1', retained: false } }
      }
    } as unknown as RoomOrchestrator
    const control = await startControlApi(orch, userDataDir('devhotel-lost-exec-'), 'test')
    try {
      const abort = new AbortController()
      const inflight = fetch(`http://127.0.0.1:${control.info.port}/v1/rooms/room1abc/exec`, {
        method: 'POST',
        headers: { authorization: `Bearer ${control.info.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ cmd: ['echo', 'hi'] }),
        signal: abort.signal
      })
      await entered.promise
      abort.abort()
      await expect(inflight).rejects.toThrow()
      // The client rejects the moment it aborts; the server learns a beat
      // later. A real command runs far longer than this gap.
      await new Promise((resolve) => setTimeout(resolve, 50))
      finish.resolve()
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Nothing was withheld from a response nobody received, so the complete
      // raw output has to survive for the run id to be worth anything.
      expect(retainAll).toBe(true)
    } finally {
      control.stop()
    }
  })

  it('does not retain a command whose response was delivered', async () => {
    let retainAll: boolean | undefined
    const orch = {
      execInRoom: async (_roomId: string, _cmd: string[], opts: { responseLost?: () => boolean }) => {
        retainAll = opts.responseLost?.()
        return { code: 0, stdout: 'ok', stderr: '', output: { runId: 'run-1', retained: false } }
      }
    } as unknown as RoomOrchestrator
    const control = await startControlApi(orch, userDataDir('devhotel-kept-exec-'), 'test')
    try {
      const response = await fetch(`http://127.0.0.1:${control.info.port}/v1/rooms/room1abc/exec`, {
        method: 'POST',
        headers: { authorization: `Bearer ${control.info.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ cmd: ['echo', 'hi'] })
      })
      expect(response.status).toBe(200)
      expect(retainAll).toBe(false)
    } finally {
      control.stop()
    }
  })
})
