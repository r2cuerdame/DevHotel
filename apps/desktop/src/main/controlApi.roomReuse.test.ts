import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DevHotelError, type RoomOrchestrator } from '@devhotel/core'
import { startControlApi } from './controlApi'

describe('Room acquisition API', () => {
  it('routes acquisition as agent, rejects unsafe inputs and preserves duplicate error evidence', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'dh-reuse-api-'))
    const result = { room: { id: 'room1abc', sourceType: 'empty', sourceRef: '', workspaceMode: 'empty' }, disposition: 'reused', reason: 'compatible', modified: true }
    const acquireRoom = vi.fn(async () => result)
    const createRoom = vi.fn(async () => { throw new DevHotelError('ROOM_REUSE_REQUIRED', 'Reuse existing Room', { evidence: { roomId: 'room1abc' } }) })
    const control = await startControlApi({ acquireRoom, createRoom } as unknown as RoomOrchestrator, userData, 'test')
    const base = { sourceType: 'empty', sourceRef: '', project: 'demo', nickname: 'new', taskId: 'task-97' }
    const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${control.info.port}/v1/rooms${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${control.info.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body)
    })
    try {
      const response = await post('/acquire', base)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(result)
      expect(acquireRoom).toHaveBeenCalledWith({ ...base, actor: 'agent' })
      for (const extra of [{ actor: 'user' }, { force: true }, { provider: 'windows' }, { sourceType: 'linked-folder' }]) {
        expect((await post('/acquire', { ...base, ...extra })).status).not.toBe(200)
      }
      expect(acquireRoom).toHaveBeenCalledTimes(1)
      const duplicate = await post('', base)
      expect(duplicate.status).toBe(409)
      expect(await duplicate.json()).toMatchObject({ code: 'ROOM_REUSE_REQUIRED', evidence: { roomId: 'room1abc' } })
    } finally {
      control.stop()
      rmSync(userData, { recursive: true, force: true })
    }
  })
})
