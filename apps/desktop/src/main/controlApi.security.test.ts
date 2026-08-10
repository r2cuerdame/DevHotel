import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RoomOrchestrator } from '@devhotel/core'
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
    const listRooms = vi.fn(() => [room])
    const inspectRoom = vi.fn(() => ({ room, dataDir: 'C:\\private\\devhotel' }))
    const control = await startControlApi({ listRooms, inspectRoom } as unknown as RoomOrchestrator, userData, 'test')

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

  it('rejects linked-folder creation and arbitrary restore paths before the orchestrator is called', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'devhotel-control-security-'))
    roots.push(userData)
    mkdirSync(userData, { recursive: true })
    const createRoom = vi.fn()
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

      const android = await fetch(`http://127.0.0.1:${control.info.port}/v1/rooms`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${control.info.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          sourceType: 'empty',
          sourceRef: '',
          project: 'android-not-yet',
          nickname: 'agent',
          provider: 'android'
        })
      })
      expect(android.status).toBe(500)
      expect(createRoom).not.toHaveBeenCalled()

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
})
