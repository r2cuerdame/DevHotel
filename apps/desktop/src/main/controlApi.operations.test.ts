import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OperationRecord } from '@devhotel/shared'
import type { RoomOrchestrator } from '@devhotel/core'
import { startControlApi } from './controlApi'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const OPERATION_ID = '9d2a2c30-9c9a-4a2e-9b8b-0f6a2f1d5f01'

function operation(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    id: OPERATION_ID,
    kind: 'room-start',
    roomId: 'room1abc',
    actor: 'agent',
    status: 'running',
    stage: 'container-start',
    stages: [
      {
        key: 'container-start',
        label: 'Start the Room containers',
        status: 'running',
        detail: null,
        startedAt: '2026-08-25T00:00:00.000Z',
        endedAt: null
      }
    ],
    error: null,
    startedAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:00:01.000Z',
    finishedAt: null,
    ...overrides
  }
}

function userDataDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), name))
  roots.push(dir)
  return dir
}

describe('agent control API long operations', () => {
  it('answers a start with the wake operation, and never with a bare success', async () => {
    const startRoomOperation = vi.fn(() => operation())
    const waitForOperation = vi.fn(async () => operation())
    const control = await startControlApi(
      { startRoomOperation, waitForOperation } as unknown as RoomOrchestrator,
      userDataDir('devhotel-control-start-'),
      'test'
    )
    try {
      const response = await fetch(`http://127.0.0.1:${control.info.port}/v1/rooms/room1abc/start`, {
        method: 'POST',
        headers: { authorization: `Bearer ${control.info.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ waitMs: 250 })
      })
      const body = (await response.json()) as { operation: OperationRecord }

      expect(response.status).toBe(200)
      expect(startRoomOperation).toHaveBeenCalledWith('room1abc', 'agent')
      expect(waitForOperation).toHaveBeenCalledWith(OPERATION_ID, 250)
      // A wake that has not finished is reported as running — not as an error,
      // and not as a success the caller would read as "the Room is up".
      expect(body.operation).toMatchObject({ id: OPERATION_ID, status: 'running', stage: 'container-start' })
    } finally {
      control.stop()
    }
  })

  it('returns the operation without waiting when the caller asks for waitMs 0', async () => {
    const startRoomOperation = vi.fn(() => operation())
    const waitForOperation = vi.fn(async () => operation())
    const control = await startControlApi(
      { startRoomOperation, waitForOperation } as unknown as RoomOrchestrator,
      userDataDir('devhotel-control-start-nowait-'),
      'test'
    )
    try {
      const response = await fetch(`http://127.0.0.1:${control.info.port}/v1/rooms/room1abc/start`, {
        method: 'POST',
        headers: { authorization: `Bearer ${control.info.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ waitMs: 0 })
      })
      expect(response.status).toBe(200)
      expect(waitForOperation).not.toHaveBeenCalled()
    } finally {
      control.stop()
    }
  })

  it('returns the durable operation id immediately when waitMs is omitted', async () => {
    const startRoomOperation = vi.fn(() => operation())
    const waitForOperation = vi.fn(async () => operation({ status: 'succeeded' }))
    const control = await startControlApi(
      { startRoomOperation, waitForOperation } as unknown as RoomOrchestrator,
      userDataDir('devhotel-control-start-default-nowait-'),
      'test'
    )
    try {
      const response = await fetch(`http://127.0.0.1:${control.info.port}/v1/rooms/room1abc/start`, {
        method: 'POST',
        headers: { authorization: `Bearer ${control.info.token}`, 'content-type': 'application/json' },
        body: '{}'
      })
      const body = (await response.json()) as { operation: OperationRecord }

      expect(response.status).toBe(200)
      expect(body.operation).toMatchObject({ id: OPERATION_ID, status: 'running' })
      expect(waitForOperation).not.toHaveBeenCalled()
    } finally {
      control.stop()
    }
  })

  it('repeated starts join one wake instead of asking for another', async () => {
    // The orchestrator dedupes; the API must not defeat that by, say, waking
    // the Room itself before asking for an operation.
    const startRoomOperation = vi.fn(() => operation())
    const startRoom = vi.fn(async () => undefined)
    const control = await startControlApi(
      { startRoomOperation, startRoom, waitForOperation: async () => operation() } as unknown as RoomOrchestrator,
      userDataDir('devhotel-control-start-join-'),
      'test'
    )
    try {
      const headers = { authorization: `Bearer ${control.info.token}`, 'content-type': 'application/json' }
      const url = `http://127.0.0.1:${control.info.port}/v1/rooms/room1abc/start`
      const first = (await (await fetch(url, { method: 'POST', headers, body: '{"waitMs":0}' })).json()) as {
        operation: OperationRecord
      }
      const second = (await (await fetch(url, { method: 'POST', headers, body: '{"waitMs":0}' })).json()) as {
        operation: OperationRecord
      }

      expect(first.operation.id).toBe(second.operation.id)
      expect(startRoom).not.toHaveBeenCalled()
      expect(startRoomOperation).toHaveBeenCalledTimes(2)
    } finally {
      control.stop()
    }
  })

  it('serves a finished operation by id, with its stages and terminal error', async () => {
    const failed = operation({
      status: 'failed',
      stage: 'verify',
      error: { stage: 'verify', message: 'web process exited' },
      finishedAt: '2026-08-25T00:01:00.000Z'
    })
    const getOperation = vi.fn(() => failed)
    const control = await startControlApi(
      { getOperation, waitForOperation: async () => failed } as unknown as RoomOrchestrator,
      userDataDir('devhotel-control-op-get-'),
      'test'
    )
    try {
      const headers = { authorization: `Bearer ${control.info.token}` }
      const response = await fetch(`http://127.0.0.1:${control.info.port}/v1/operations/${OPERATION_ID}`, { headers })
      const body = (await response.json()) as { operation: OperationRecord }

      expect(response.status).toBe(200)
      expect(getOperation).toHaveBeenCalledWith(OPERATION_ID)
      expect(body.operation.status).toBe('failed')
      expect(body.operation.error).toEqual({ stage: 'verify', message: 'web process exited' })
      expect(body.operation.stages[0]?.key).toBe('container-start')
    } finally {
      control.stop()
    }
  })

  it('holds the operation call open only for the requested wait', async () => {
    const waitForOperation = vi.fn(async () => operation({ status: 'succeeded', stage: 'complete' }))
    const control = await startControlApi(
      { getOperation: () => operation(), waitForOperation } as unknown as RoomOrchestrator,
      userDataDir('devhotel-control-op-wait-'),
      'test'
    )
    try {
      const headers = { authorization: `Bearer ${control.info.token}` }
      const response = await fetch(
        `http://127.0.0.1:${control.info.port}/v1/operations/${OPERATION_ID}?waitMs=1500`,
        { headers }
      )
      const body = (await response.json()) as { operation: OperationRecord }

      expect(waitForOperation).toHaveBeenCalledWith(OPERATION_ID, 1500)
      expect(body.operation.status).toBe('succeeded')
    } finally {
      control.stop()
    }
  })

  it('rejects a malformed operation id and reports an unknown one as 404', async () => {
    const control = await startControlApi(
      { getOperation: () => null } as unknown as RoomOrchestrator,
      userDataDir('devhotel-control-op-404-'),
      'test'
    )
    try {
      const headers = { authorization: `Bearer ${control.info.token}` }
      const malformed = await fetch(`http://127.0.0.1:${control.info.port}/v1/operations/not-a-uuid`, { headers })
      expect(malformed.status).toBe(500)

      const unknown = await fetch(`http://127.0.0.1:${control.info.port}/v1/operations/${OPERATION_ID}`, { headers })
      expect(unknown.status).toBe(404)
    } finally {
      control.stop()
    }
  })

  it('lists a Room’s recent operations', async () => {
    const listOperations = vi.fn(() => [operation()])
    const control = await startControlApi(
      { listOperations } as unknown as RoomOrchestrator,
      userDataDir('devhotel-control-op-list-'),
      'test'
    )
    try {
      const headers = { authorization: `Bearer ${control.info.token}` }
      const response = await fetch(`http://127.0.0.1:${control.info.port}/v1/rooms/room1abc/operations?limit=5`, {
        headers
      })
      const body = (await response.json()) as { operations: OperationRecord[] }

      expect(response.status).toBe(200)
      expect(listOperations).toHaveBeenCalledWith('room1abc', 5)
      expect(body.operations).toHaveLength(1)
    } finally {
      control.stop()
    }
  })

  it('forwards operationId and waitMs to applyChange when provided', async () => {
    const applyChange = vi.fn(async () => ({ operation: operation({ kind: 'android-run' }) }))
    const control = await startControlApi(
      { applyChange } as unknown as RoomOrchestrator,
      userDataDir('devhotel-control-apply-op-'),
      'test'
    )
    try {
      const response = await fetch(`http://127.0.0.1:${control.info.port}/v1/rooms/room1abc/changes`, {
        method: 'POST',
        headers: { authorization: `Bearer ${control.info.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          change: { kind: 'android-run' },
          operationId: OPERATION_ID,
          waitMs: 500
        })
      })
      const body = (await response.json()) as { operation: OperationRecord }

      expect(response.status).toBe(200)
      expect(applyChange).toHaveBeenCalledWith('room1abc', { kind: 'android-run' }, 'agent', OPERATION_ID, 500)
      expect(body.operation.kind).toBe('android-run')
    } finally {
      control.stop()
    }
  })

  it('reuses previous port from control.json across restarts when available', async () => {
    const dir = userDataDir('devhotel-control-port-reuse-')
    const firstControl = await startControlApi({} as unknown as RoomOrchestrator, dir, 'test')
    const assignedPort = firstControl.info.port
    expect(assignedPort).toBeGreaterThan(0)
    firstControl.server.close() // Close server while leaving control.json in place

    const secondControl = await startControlApi({} as unknown as RoomOrchestrator, dir, 'test')
    try {
      expect(secondControl.info.port).toBe(assignedPort)
    } finally {
      secondControl.stop()
    }
  })

  it('reuses the preferred port across a graceful stop without retaining the live token file', async () => {
    const dir = userDataDir('devhotel-control-port-graceful-reuse-')
    const firstControl = await startControlApi({} as unknown as RoomOrchestrator, dir, 'test')
    const assignedPort = firstControl.info.port
    const closed = once(firstControl.server, 'close')
    firstControl.stop()
    await closed

    expect(() => readFileSync(join(dir, 'control.json'), 'utf8')).toThrow()
    expect(JSON.parse(readFileSync(join(dir, 'control-port.json'), 'utf8'))).toEqual({ port: assignedPort })

    const secondControl = await startControlApi({} as unknown as RoomOrchestrator, dir, 'test')
    try {
      expect(secondControl.info.port).toBe(assignedPort)
      expect(secondControl.info.token).not.toBe(firstControl.info.token)
    } finally {
      secondControl.stop()
    }
  })
})
