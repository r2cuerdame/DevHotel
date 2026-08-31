import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { reconcile } from '../reconcile'
import { jobName } from '../backend/naming'
import { openDb } from '../store/db'
import { roomsRepo } from '../store/roomsRepo'
import { FakeBackend, makeRoom, tempDir } from './fakes'

describe('reconcile interrupted preparation', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('marks preparing rooms broken instead of making partial storage wakeable', async () => {
    const dir = tempDir()
    dirs.push(dir)
    const db = openDb(dir)
    const rooms = roomsRepo(db)
    rooms.create(makeRoom({ id: 'preparing1', domain: 'preparing.localhost', status: 'preparing', hostPort: 41001 }))
    rooms.create(makeRoom({ id: 'ready0001', domain: 'ready.localhost', status: 'ready', hostPort: 41002 }))
    const backend = new FakeBackend()
    const logs: string[] = []

    const result = await reconcile(backend, rooms, (line) => logs.push(line))

    expect(rooms.get('preparing1')?.status).toBe('broken')
    expect(rooms.get('preparing1')?.hostPort).toBeNull()
    expect(rooms.get('ready0001')?.status).toBe('sleeping')
    expect(result.roomsSlept).toEqual(['ready0001'])
    expect(backend.calls).toContain('stopRoomPod:preparing1')
    expect(logs.some((line) => line.includes('interrupted while preparing'))).toBe(true)
    db.close()
  })

  it('persists the broken marker even when interrupted resources cannot be stopped yet', async () => {
    const dir = tempDir()
    dirs.push(dir)
    const db = openDb(dir)
    const rooms = roomsRepo(db)
    rooms.create(makeRoom({ id: 'preparing2', status: 'preparing', hostPort: 41003 }))
    const backend = new FakeBackend()
    backend.stopRoomPod = async () => {
      throw new Error('runtime offline')
    }
    const logs: string[] = []

    await reconcile(backend, rooms, (line) => logs.push(line))

    expect(rooms.get('preparing2')).toMatchObject({ status: 'broken', hostPort: null })
    expect(logs.some((line) => line.includes('runtime offline'))).toBe(true)
    db.close()
  })

  it('preserves an awake Room whose exact Android locale recovery is still gated', async () => {
    const dir = tempDir()
    dirs.push(dir)
    const db = openDb(dir)
    const rooms = roomsRepo(db)
    rooms.create(makeRoom({ id: 'locale001', provider: 'android', status: 'attention', hostPort: 41004 }))
    const backend = new FakeBackend()

    const result = await reconcile(
      backend,
      rooms,
      () => undefined,
      { preserveAwakeRoomIds: new Set(['locale001']) }
    )

    expect(result.roomsSlept).toEqual([])
    expect(rooms.get('locale001')).toMatchObject({ status: 'attention', hostPort: 41004 })
    expect(backend.calls).not.toContain('stopRoomPod:locale001')
    db.close()
  })

  it('never sends Windows VM rooms through OCI reconciliation', async () => {
    const windows = makeRoom({
      id: 'windows1',
      provider: 'windows',
      status: 'ready',
      runtime: { kind: 'windows', version: '11' },
      packageManager: { kind: 'none' },
      windows: { backend: 'vmware', templateId: 'c'.repeat(64), snapshot: 'clean' }
    })
    const rooms = { list: () => [windows], update: () => undefined } as unknown as ReturnType<typeof roomsRepo>
    const backend = new FakeBackend()

    const result = await reconcile(backend, rooms, () => undefined)

    expect(result.roomsSlept).toEqual([])
    expect(backend.calls).toEqual([])
  })
})

describe('reconcile stale one-shot jobs', () => {
  it('removes every startup job for a known Room while preserving canonical persistent containers', async () => {
    const room = makeRoom({ id: 'knownroom', status: 'sleeping' })
    const rooms = { list: () => [room] } as ReturnType<typeof roomsRepo>
    const backend = new FakeBackend()
    const runningJob = jobName(room.id, '11111111-2222-4333-8444-555555555555')
    const exitedJob = jobName(room.id, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    const interruptedEmulator = `dh-${room.id}-svc-emulator`
    backend.managedContainers = [
      { roomId: room.id, role: 'anchor', state: 'running', name: `dh-${room.id}-anchor` },
      { roomId: room.id, role: 'web', state: 'running', name: `dh-${room.id}-web` },
      { roomId: room.id, role: 'svc-postgres', state: 'running', name: `dh-${room.id}-svc-postgres` },
      { roomId: room.id, role: 'job', state: 'running', name: runningJob },
      { roomId: room.id, role: 'job', state: 'exited', name: exitedJob },
      { roomId: room.id, role: 'svc-emulator', state: 'created', name: interruptedEmulator }
    ]
    const logs: string[] = []

    const result = await reconcile(backend, rooms, (line) => logs.push(line))

    expect(result.straysRemoved).toEqual([runningJob, exitedJob, interruptedEmulator])
    expect(backend.managedContainers.map((container) => container.role)).toEqual(['anchor', 'web', 'svc-postgres'])
    expect(backend.calls).toEqual([
      `removeManagedContainer:${runningJob}`,
      `removeManagedContainer:${exitedJob}`,
      `removeManagedContainer:${interruptedEmulator}`
    ])
    expect(logs.slice(0, 2).every((line) => line.includes('stale job container'))).toBe(true)
    expect(logs[2]).toContain('interrupted emulator create')
  })
})
