import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { RoomOrchestrator } from '../orchestrator'
import type { Db } from '../store/db'
import { FakeBackend, FakeGateway, makeRoom, tempDir, testDb } from './fakes'

describe('orchestrator interrupted changes', () => {
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
    return { backend, orch, db }
  }

  it('interrupted ordinary change marks change record as failed while keeping room status as sleeping', async () => {
    const { orch } = setup()
    const room = makeRoom({ id: 'sleeproom1', domain: 'sleeproom1.localhost', status: 'sleeping' })
    orch.rooms.create(room)
    const entry = orch.changes.append({
      id: 'change-sleep-1',
      roomId: room.id,
      kind: 'node-version',
      title: 'Bump node version',
      actor: 'agent',
      component: 'Node',
      before: null,
      after: { version: '20' },
      captured: null,
      steps: ['Install node 20'],
      verify: null,
      undoable: true,
      undoStrategy: 'service-recreate',
      status: 'pending',
      rawLogPath: null,
      createdAt: new Date().toISOString(),
      undoneAt: null
    })
    expect(entry.status).toBe('pending')

    await orch.init()

    const updatedEntry = orch.changes.get(entry.id)
    expect(updatedEntry?.status).toBe('failed')
    expect(updatedEntry?.verify?.ok).toBe(false)
    expect(orch.rooms.get(room.id)?.status).toBe('sleeping')
  })

  it('marks interrupted change failed and moves awake room to attention', async () => {
    const { orch } = setup()
    const room = makeRoom({ id: 'readyroom1', domain: 'readyroom1.localhost', status: 'ready' })
    orch.rooms.create(room)
    const entry = orch.changes.append({
      id: 'change-ready-1',
      roomId: room.id,
      kind: 'node-version',
      title: 'Bump node version',
      actor: 'agent',
      component: 'Node',
      before: null,
      after: { version: '20' },
      captured: null,
      steps: ['Install node 20'],
      verify: null,
      undoable: true,
      undoStrategy: 'service-recreate',
      status: 'pending',
      rawLogPath: null,
      createdAt: new Date().toISOString(),
      undoneAt: null
    })
    expect(entry.status).toBe('pending')

    await orch.init()

    const updatedEntry = orch.changes.get(entry.id)
    expect(updatedEntry?.status).toBe('failed')
    expect(orch.rooms.get(room.id)?.status).toBe('attention')
  })
})
