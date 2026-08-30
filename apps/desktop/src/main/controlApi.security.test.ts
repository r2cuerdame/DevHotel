import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DevHotelError, type RoomOrchestrator } from '@devhotel/core'
import { startControlApi } from './controlApi'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('agent control API host boundary', () => {
  it('redacts Host paths from list and inspect responses', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'devhotel-control-redaction-'))
    roots.push(userData)
    const room = { id: 'room1abc', sourceType: 'linked-folder', sourceRef: 'C:\\private\\project' }
    const listRoomsRuntime = vi.fn(async () => [room])
    const inspectRoomRuntime = vi.fn(async () => ({ room, dataDir: 'C:\\private\\devhotel' }))
    const control = await startControlApi({ listRoomsRuntime, inspectRoomRuntime } as unknown as RoomOrchestrator, userData, 'test')

    try {
      const headers = { authorization: `Bearer ${control.info.token}` }
      const list = (await (await fetch(`http://127.0.0.1:${control.info.port}/v1/rooms`, { headers })).json()) as {
        sourceRef: string
      }[]
      const inspection = (await (
        await fetch(`http://127.0.0.1:${control.info.port}/v1/rooms/room1abc`, { headers })
      ).json()) as { room: { sourceRef: string }; dataDir: string }

      expect(list[0]?.sourceRef).toBe('[Host folder hidden]')
      expect(inspection.room.sourceRef).toBe('[Host folder hidden]')
      expect(inspection.dataDir).toBe('[Hotel data hidden]')
    } finally {
      control.stop()
    }
  })

  it('returns stable DevHotel runtime errors without exposing engine text', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'devhotel-control-runtime-error-'))
    roots.push(userData)
    const execInRoom = vi.fn(async () => {
      throw new DevHotelError('ROOM_RUNTIME_NOT_RUNNING', 'Room room1abc cannot run commands because its runtime is exited.', {
        recoveryHint: 'Start or restart the Room, then retry.',
        httpStatus: 409,
        cause: new Error('container raw-engine-id is not running')
      })
    })
    const control = await startControlApi({ execInRoom } as unknown as RoomOrchestrator, userData, 'test')

    try {
      const response = await fetch(`http://127.0.0.1:${control.info.port}/v1/rooms/room1abc/exec`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${control.info.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ cmd: ['node', '--version'] })
      })
      const body = (await response.json()) as { error: string; code: string; recoveryHint: string }

      expect(response.status).toBe(409)
      expect(body).toEqual({
        error: 'Room room1abc cannot run commands because its runtime is exited.',
        code: 'ROOM_RUNTIME_NOT_RUNNING',
        recoveryHint: 'Start or restart the Room, then retry.'
      })
      expect(JSON.stringify(body)).not.toContain('raw-engine-id')
    } finally {
      control.stop()
    }
  })

  it('rejects linked-folder creation and arbitrary restore paths before the orchestrator is called', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'devhotel-control-security-'))
    roots.push(userData)
    mkdirSync(userData, { recursive: true })
    const createRoom = vi.fn(async (input: Record<string, unknown>) => ({ id: 'room9xyz', ...input }))
    const applyChange = vi.fn()
    const control = await startControlApi({ createRoom, applyChange } as unknown as RoomOrchestrator, userData, 'test')

    try {
      const response = await fetch(`http://127.0.0.1:${control.info.port}/v1/rooms`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${control.info.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          sourceType: 'linked-folder',
          sourceRef: 'C:\\Users\\me',
          project: 'stolen-host',
          nickname: 'agent'
        })
      })
      const body = (await response.json()) as { error?: string }
      expect(response.status).toBe(500)
      expect(body.error).toMatch(/Agents cannot create linked-folder Rooms/)
      expect(createRoom).not.toHaveBeenCalled()

      const windows = await fetch(`http://127.0.0.1:${control.info.port}/v1/rooms`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${control.info.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          sourceType: 'empty',
          sourceRef: '',
          project: 'windows-not-yet',
          nickname: 'agent',
          provider: 'windows'
        })
      })
      expect(windows.status).toBe(500)
      expect(createRoom).not.toHaveBeenCalled()

      const android = await fetch(`http://127.0.0.1:${control.info.port}/v1/rooms`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${control.info.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          sourceType: 'empty',
          sourceRef: '',
          project: 'android-ok',
          nickname: 'agent',
          provider: 'android'
        })
      })
      expect(android.status).toBe(200)
      expect(createRoom).toHaveBeenCalledWith(expect.objectContaining({ provider: 'android', actor: 'agent' }))

      const restore = await fetch(`http://127.0.0.1:${control.info.port}/v1/rooms/room1abc/changes`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${control.info.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          change: { kind: 'db-restore', service: 'postgres', file: 'C:\\Users\\me\\.ssh\\id_rsa' }
        })
      })
      const restoreBody = (await restore.json()) as { error?: string }
      expect(restore.status).toBe(500)
      expect(restoreBody.error).toMatch(/backupId|unrecognized key/i)
      expect(applyChange).not.toHaveBeenCalled()
    } finally {
      control.stop()
    }
  })

  it('runs agent Host sync under the Room grant, as the agent, and honours revocation', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'devhotel-control-sync-'))
    roots.push(userData)
    const room = { id: 'room1abc', sourceType: 'linked-folder', hostSyncEnabled: true, sourceRef: 'C:\\code\\demo' }
    const syncFromHost = vi.fn(async () => ({ ...room, syncStatus: 'synced' }))
    let granted = true
    const control = await startControlApi(
      {
        rooms: { get: () => room },
        agentHostSyncAllowed: () => granted,
        syncFromHost
      } as unknown as RoomOrchestrator,
      userData,
      'test'
    )
    try {
      const headers = { authorization: `Bearer ${control.info.token}` }
      const url = `http://127.0.0.1:${control.info.port}/v1/rooms/room1abc/sync-from-host`

      const allowed = await fetch(url, { method: 'POST', headers })
      expect(allowed.status).toBe(200)
      // journaled as the agent that ran it, never laundered as 'user'
      expect(syncFromHost).toHaveBeenCalledWith('room1abc', 'agent')
      const body = (await allowed.json()) as { sourceRef: string }
      expect(body.sourceRef).toBe('[Host folder hidden]')

      granted = false
      syncFromHost.mockClear()
      const revoked = await fetch(url, { method: 'POST', headers })
      expect(revoked.status).toBe(403)
      expect(syncFromHost).not.toHaveBeenCalled()
    } finally {
      control.stop()
    }
  })

  it('refuses agent deletion of Host-linked rooms but allows Hotel-owned ones', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'devhotel-control-delete-'))
    roots.push(userData)
    const rooms = new Map([
      ['room1abc', { id: 'room1abc', sourceType: 'linked-folder', workspaceMode: 'hotel' }],
      ['room2def', { id: 'room2def', sourceType: 'managed-git', workspaceMode: 'hotel' }]
    ])
    const deleteRoom = vi.fn(async () => ({ reclaimedBytes: 42 }))
    const control = await startControlApi(
      { rooms: { get: (id: string) => rooms.get(id) }, deleteRoom } as unknown as RoomOrchestrator,
      userData,
      'test'
    )
    try {
      const headers = { authorization: `Bearer ${control.info.token}` }
      const linked = await fetch(`http://127.0.0.1:${control.info.port}/v1/rooms/room1abc`, { method: 'DELETE', headers })
      expect(linked.status).toBe(403)
      expect(deleteRoom).not.toHaveBeenCalled()

      const hotel = await fetch(`http://127.0.0.1:${control.info.port}/v1/rooms/room2def`, { method: 'DELETE', headers })
      expect(hotel.status).toBe(200)
      expect(deleteRoom).toHaveBeenCalledWith('room2def', 'agent')
    } finally {
      control.stop()
    }
  })

  it('exposes no Host-input operation to Agents', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'devhotel-control-host-input-'))
    roots.push(userData)
    const openWindows = vi.fn()
    const control = await startControlApi({ openWindows } as unknown as RoomOrchestrator, userData, 'test')

    try {
      const headers = { authorization: `Bearer ${control.info.token}` }
      // The VMware console takes the Host cursor, keyboard and foreground
      // window; it is a user-only capability and must have no Agent route.
      for (const op of ['open-console', 'open-windows', 'console', 'input', 'focus']) {
        const response = await fetch(`http://127.0.0.1:${control.info.port}/v1/rooms/room1abc/${op}`, {
          method: 'POST',
          headers
        })
        expect(response.status, `POST /v1/rooms/:id/${op} must not exist`).toBe(404)
      }
      expect(openWindows).not.toHaveBeenCalled()
    } finally {
      control.stop()
    }
  })
})
