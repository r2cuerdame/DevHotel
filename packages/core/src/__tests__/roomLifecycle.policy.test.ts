import { rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RoomOrchestrator } from '../orchestrator'
import { openDb, type Db } from '../store/db'
import { FakeBackend, FakeGateway, listeningPort, makeRoom, tempDir } from './fakes'

const hour = 60 * 60 * 1000
const day = 24 * hour

describe('Room lifecycle policy', () => {
  let db: Db
  let userData: string
  let backend: FakeBackend
  let orch: RoomOrchestrator
  let closePort: () => void

  beforeEach(async () => {
    userData = tempDir()
    db = openDb(userData)
    backend = new FakeBackend()
    const listener = await listeningPort()
    backend.hostPort = listener.port
    closePort = listener.close
    orch = new RoomOrchestrator({
      userData,
      backend,
      gateway: new FakeGateway().asGateway(),
      db,
      appVersion: 'test'
    })
  })

  afterEach(() => {
    closePort()
    db.close()
    rmSync(userData, { recursive: true, force: true })
  })

  function cleanRoom(id: string, activity: string) {
    return makeRoom({
      id,
      project: id,
      domain: `${id}.localhost`,
      sourceType: 'managed-git',
      sourceRef: `https://example.test/${id}.git`,
      workspaceMode: 'hotel',
      stateRevision: 1,
      syncStatus: 'synced',
      lastActivityAt: activity,
      lifecycle: { state: 'active', expiredAt: null }
    })
  }

  it('sleeps an idle Room and journals the lifecycle action', async () => {
    const now = new Date('2026-09-14T12:00:00.000Z')
    const room = cleanRoom('idle-room', new Date(now.getTime() - 2 * hour).toISOString())
    orch.rooms.create(room)

    const result = await orch.sweepRoomLifecycle(now)

    expect(result.slept).toEqual([room.id])
    expect(orch.rooms.get(room.id)?.status).toBe('sleeping')
    expect(orch.listChanges(room.id)[0]).toMatchObject({ kind: 'auto-sleep-room', actor: 'devhotel' })
  })

  it('moves a safe Room into grace and deletes it only after grace elapses', async () => {
    const now = new Date('2026-09-14T12:00:00.000Z')
    const room = cleanRoom('grace-room', new Date(now.getTime() - 8 * day).toISOString())
    room.status = 'sleeping'
    orch.rooms.create(room)

    const expired = await orch.sweepRoomLifecycle(now)
    expect(expired.expired).toEqual([room.id])
    expect(orch.rooms.get(room.id)?.lifecycle).toEqual({ state: 'expired', expiredAt: now.toISOString() })
    expect(orch.listChanges(room.id)[0]).toMatchObject({ kind: 'expire-room', actor: 'devhotel' })

    await orch.sweepRoomLifecycle(new Date(now.getTime() + day - 1))
    expect(orch.rooms.get(room.id)).not.toBeNull()

    const deleted = await orch.sweepRoomLifecycle(new Date(now.getTime() + day))
    expect(deleted.deleted).toEqual([room.id])
    expect(orch.rooms.get(room.id)).toBeNull()
  })

  it('never automatically deletes pinned, modified, DB-bearing, or uncertain Rooms', async () => {
    const now = new Date('2026-09-14T12:00:00.000Z')
    const expiredAt = new Date(now.getTime() - 2 * day).toISOString()
    const pinned = cleanRoom('pinned-room', new Date(now.getTime() - 10 * day).toISOString())
    const modified = cleanRoom('modified-room', pinned.lastActivityAt!)
    const database = cleanRoom('database-room', pinned.lastActivityAt!)
    const uncertain = cleanRoom('uncertain-room', pinned.lastActivityAt!)
    for (const room of [pinned, modified, database, uncertain]) {
      room.status = 'sleeping'
      room.lifecycle = { state: 'expired', expiredAt }
    }
    pinned.pinned = true
    modified.syncStatus = 'modified'
    database.services = { postgres: { version: '17' } }
    uncertain.stateRevision = 2
    for (const room of [pinned, modified, database, uncertain]) orch.rooms.create(room)

    const result = await orch.sweepRoomLifecycle(now)

    expect(result.deleted).toEqual([])
    for (const room of [pinned, modified, database, uncertain]) expect(orch.rooms.get(room.id)).not.toBeNull()
    expect(result.retained.map((entry) => entry.roomId)).toEqual(
      expect.arrayContaining([pinned.id, modified.id, database.id, uncertain.id])
    )
  })

  it('persists pin state and activity cancels expiry grace', async () => {
    const room = cleanRoom('pin-state', '2026-09-01T00:00:00.000Z')
    room.status = 'sleeping'
    room.lifecycle = { state: 'expired', expiredAt: '2026-09-10T00:00:00.000Z' }
    orch.rooms.create(room)

    const updated = await orch.setRoomPinned(room.id, true, 'user')

    expect(updated.pinned).toBe(true)
    expect(updated.lifecycle).toEqual({ state: 'active', expiredAt: null })
    expect(Date.parse(updated.lastActivityAt!)).toBeGreaterThan(Date.parse(room.lastActivityAt!))
    expect(orch.listChanges(room.id)[0]).toMatchObject({ kind: 'pin-room', actor: 'user' })
  })

  it('wakes a sleeping Room when a command is validly used and resets activity', async () => {
    const room = cleanRoom('wake-use', '2026-09-01T00:00:00.000Z')
    room.status = 'sleeping'
    room.hostPort = null
    room.lifecycle = {
      state: 'expired',
      expiredAt: '2026-09-10T00:00:00.000Z',
      autoSleptAt: '2026-09-08T00:00:00.000Z'
    }
    orch.rooms.create(room)

    const result = await orch.execInRoom(room.id, ['true'])

    expect(result.code).toBe(0)
    expect(orch.rooms.get(room.id)).toMatchObject({
      status: 'ready',
      lifecycle: { state: 'active', expiredAt: null }
    })
    expect(Date.parse(orch.rooms.get(room.id)!.lastActivityAt!)).toBeGreaterThan(Date.parse(room.lastActivityAt!))
    expect(orch.listChanges(room.id).some((entry) => entry.kind === 'reactivate-room')).toBe(true)
  })
})
