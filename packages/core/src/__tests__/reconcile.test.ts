import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reconcile } from '../reconcile'
import { jobName } from '../backend/naming'
import { RoomOrchestrator } from '../orchestrator'
import { openDb, type Db } from '../store/db'
import { roomsRepo } from '../store/roomsRepo'
import { FakeBackend, FakeGateway, makeRoom, tempDir, testDb } from './fakes'

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

  it('preserves an exact runtime retained by a higher-priority startup recovery fence', async () => {
    const room = makeRoom({ id: 'recover01', status: 'attention', hostPort: 41004 })
    const rooms = { list: () => [room], update: () => undefined } as unknown as ReturnType<typeof roomsRepo>
    const backend = new FakeBackend()

    const result = await reconcile(
      backend,
      rooms,
      () => undefined,
      { preserveAwakeRoomIds: new Set([room.id]) }
    )

    expect(result.roomsSlept).toEqual([])
    expect(backend.calls).toEqual([])
  })

  it('reclaims partially created containers and bridge networks of interrupted preparing rooms', async () => {
    const dir = tempDir()
    dirs.push(dir)
    const db = openDb(dir)
    const rooms = roomsRepo(db)
    rooms.create(makeRoom({ id: 'prep01', status: 'preparing', hostPort: 41001 }))
    const backend = new FakeBackend()
    backend.managedContainers = [
      { roomId: 'prep01', role: 'anchor', state: 'running', name: 'dh-prep01-anchor' },
      { roomId: 'prep01', role: 'web', state: 'running', name: 'dh-prep01-web' }
    ]
    backend.managedNetworks = [
      { roomId: 'prep01', name: 'dh-prep01-net' }
    ]
    const logs: string[] = []

    const result = await reconcile(backend, rooms, (line) => logs.push(line))

    expect(rooms.get('prep01')?.status).toBe('broken')
    expect(result.straysRemoved).toEqual(['dh-prep01-anchor', 'dh-prep01-web'])
    expect(result.networksRemoved).toEqual(['dh-prep01-net'])
    expect(backend.calls).toContain('removeManagedContainer:dh-prep01-anchor')
    expect(backend.calls).toContain('removeManagedContainer:dh-prep01-web')
    expect(backend.calls).toContain('removeManagedNetwork:dh-prep01-net')
    expect(backend.calls).not.toContain('adoptManagedNetwork:dh-prep01-net')
    db.close()
  })

  it('adopts surviving bridge networks of broken rooms instead of removing them', async () => {
    const dir = tempDir()
    dirs.push(dir)
    const db = openDb(dir)
    const rooms = roomsRepo(db)
    rooms.create(makeRoom({ id: 'broken01', status: 'broken', hostPort: null }))
    const backend = new FakeBackend()
    backend.managedNetworks = [
      { roomId: 'broken01', name: 'dh-broken01-net' }
    ]
    const logs: string[] = []

    const result = await reconcile(backend, rooms, (line) => logs.push(line))

    expect(result.networksRemoved).toEqual([])
    expect(backend.calls).toContain('adoptManagedNetwork:dh-broken01-net')
    expect(backend.calls).not.toContain('removeManagedNetwork:dh-broken01-net')
    db.close()
  })
})

describe('reconcile deleting rooms', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('never sends Windows VM rooms through OCI deleting reconciliation', async () => {
    const dir = tempDir()
    dirs.push(dir)
    const db = openDb(dir)
    const rooms = roomsRepo(db)
    const windows = makeRoom({
      id: 'windows1',
      provider: 'windows',
      status: 'deleting',
      runtime: { kind: 'windows', version: '11' },
      packageManager: { kind: 'none' },
      windows: { backend: 'vmware', templateId: 'c'.repeat(64), snapshot: 'clean' }
    })
    rooms.create(windows)
    const backend = new FakeBackend()

    const result = await reconcile(backend, rooms, () => undefined, { userData: dir })

    expect(backend.calls).toEqual([])
    expect(rooms.get('windows1')?.status).toBe('deleting')
    expect(result.roomsDeleted).toBeUndefined()
    db.close()
  })

  it('preserves room record in deleting status when deleteRoomPod fails during reconciliation', async () => {
    const dir = tempDir()
    dirs.push(dir)
    const db = openDb(dir)
    const rooms = roomsRepo(db)
    rooms.create(makeRoom({ id: 'deleting-fail', status: 'deleting' }))
    const backend = new FakeBackend()
    backend.deleteRoomPod = async () => {
      throw new Error('volume is in use')
    }
    const logs: string[] = []

    const result = await reconcile(backend, rooms, (line) => logs.push(line), { userData: dir })

    expect(rooms.get('deleting-fail')?.status).toBe('deleting')
    expect(result.roomsDeleted).toBeUndefined()
    expect(logs.some((line) => line.includes('could not finish deleting room pod deleting-fail: volume is in use'))).toBe(true)
    db.close()
  })

  it('completes teardown and purges SQLite row for rooms in deleting status', async () => {
    const dir = tempDir()
    dirs.push(dir)
    const db = openDb(dir)
    const rooms = roomsRepo(db)
    rooms.create(makeRoom({ id: 'deleting01', status: 'deleting' }))
    const backend = new FakeBackend()
    backend.managedContainers = [
      { roomId: 'deleting01', role: 'anchor', state: 'exited', name: 'dh-deleting01-anchor' }
    ]
    backend.managedNetworks = [
      { roomId: 'deleting01', name: 'dh-deleting01-net' }
    ]
    const logs: string[] = []

    const result = await reconcile(backend, rooms, (line) => logs.push(line), { userData: dir })

    expect(rooms.get('deleting01')).toBeNull()
    expect(backend.calls).toContain('deleteRoomPod:deleting01')
    expect(result.roomsDeleted).toEqual(['deleting01'])
    expect(logs.some((line) => line.includes('resuming deletion of room deleting01'))).toBe(true)
    db.close()
  })

  it('is idempotent under repeated restart injection when resources were already removed', async () => {
    const dir = tempDir()
    dirs.push(dir)
    const db = openDb(dir)
    const rooms = roomsRepo(db)
    rooms.create(makeRoom({ id: 'deleting02', status: 'deleting' }))
    const backend = new FakeBackend()

    const result1 = await reconcile(backend, rooms, () => undefined, { userData: dir })
    expect(rooms.get('deleting02')).toBeNull()
    expect(result1.roomsDeleted).toEqual(['deleting02'])

    const result2 = await reconcile(backend, rooms, () => undefined, { userData: dir })
    expect(result2.roomsDeleted).toBeUndefined()
    db.close()
  })
})

describe('reconcile stale one-shot jobs', () => {
  it('removes every startup job for a known Room while preserving canonical persistent containers', async () => {
    const room = makeRoom({ id: 'knownroom', status: 'sleeping' })
    const rooms = { list: () => [room], update: () => undefined } as unknown as ReturnType<typeof roomsRepo>
    const backend = new FakeBackend()
    const runningJob = jobName(room.id, '11111111-2222-4333-8444-555555555555')
    const exitedJob = jobName(room.id, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    const interruptedEmulator = `dh-${room.id}-svc-emulator`
    backend.managedContainers = [
      { roomId: room.id, role: 'anchor', state: 'exited', name: `dh-${room.id}-anchor` },
      { roomId: room.id, role: 'web', state: 'exited', name: `dh-${room.id}-web` },
      { roomId: room.id, role: 'svc-postgres', state: 'exited', name: `dh-${room.id}-svc-postgres` },
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
    expect(logs.slice(1, 3).every((line) => line.includes('stale job container'))).toBe(true)
    expect(logs[3]).toContain('interrupted emulator create')
  })
})

describe('reconcile sleeping room stray runtimes', () => {
  const dirs: string[] = []
  const dbs: ReturnType<typeof openDb>[] = []

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('detects and stops proven owned non-fenced stray containers for a sleeping room while preserving explicit recovery fences', async () => {
    const dir = tempDir()
    dirs.push(dir)
    const db = openDb(dir)
    dbs.push(db)
    const rooms = roomsRepo(db)
    rooms.create(makeRoom({ id: 'sleepstray', domain: 'sleepstray.localhost', status: 'sleeping', hostPort: null }))
    rooms.create(makeRoom({ id: 'sleepfenced', domain: 'sleepfenced.localhost', provider: 'android', status: 'sleeping', hostPort: null }))
    rooms.create(makeRoom({ id: 'sleepclean', domain: 'sleepclean.localhost', status: 'sleeping', hostPort: null }))

    const backend = new FakeBackend()
    backend.managedContainers = [
      { roomId: 'sleepstray', role: 'web', state: 'running', name: 'dh-sleepstray-web' },
      { roomId: 'sleepfenced', role: 'svc-emulator', state: 'running', name: 'dh-sleepfenced-svc-emulator' }
    ]
    const logs: string[] = []

    const result = await reconcile(
      backend,
      rooms,
      (line) => logs.push(line),
      { preserveAwakeRoomIds: new Set(['sleepfenced']) }
    )

    expect(result.roomsSlept).toEqual([])
    expect(result.straysRemoved).toEqual([])
    expect(backend.calls).toContain('stopRoomPod:sleepstray')
    expect(backend.calls).not.toContain('stopRoomPod:sleepfenced')
    expect(backend.calls).not.toContain('stopRoomPod:sleepclean')
    expect(rooms.get('sleepstray')?.status).toBe('sleeping')
    expect(rooms.get('sleepfenced')?.status).toBe('sleeping')
    expect(rooms.get('sleepclean')?.status).toBe('sleeping')
    expect(logs.some((l) => l.includes('sleepstray') && l.includes('stray runtime'))).toBe(true)
    expect(logs.some((l) => l.includes('sleepfenced') && l.includes('fenced'))).toBe(true)
  })

  it('marks an interrupted preparing room as broken even when included in preserveAwakeRoomIds', async () => {
    const dir = tempDir()
    dirs.push(dir)
    const db = openDb(dir)
    dbs.push(db)
    const rooms = roomsRepo(db)
    rooms.create(makeRoom({ id: 'prepfenced', domain: 'prepfenced.localhost', status: 'preparing', hostPort: 41005 }))
    const backend = new FakeBackend()
    const logs: string[] = []

    const result = await reconcile(
      backend,
      rooms,
      (line) => logs.push(line),
      { preserveAwakeRoomIds: new Set(['prepfenced']) }
    )

    expect(rooms.get('prepfenced')?.status).toBe('broken')
    expect(rooms.get('prepfenced')?.hostPort).toBeNull()
    expect(result.roomsSlept).toEqual([])
    expect(backend.calls).toContain('stopRoomPod:prepfenced')
    expect(logs.some((line) => line.includes('interrupted while preparing'))).toBe(true)
  })

  it('detects and stops paused stray containers for sleeping rooms', async () => {
    const dir = tempDir()
    dirs.push(dir)
    const db = openDb(dir)
    dbs.push(db)
    const rooms = roomsRepo(db)
    rooms.create(makeRoom({ id: 'sleeppaused', domain: 'sleeppaused.localhost', status: 'sleeping', hostPort: null }))
    const backend = new FakeBackend()
    backend.managedContainers = [
      { roomId: 'sleeppaused', role: 'web', state: 'paused', name: 'dh-sleeppaused-web' }
    ]
    const logs: string[] = []

    const result = await reconcile(backend, rooms, (line) => logs.push(line))

    expect(backend.calls).toContain('stopRoomPod:sleeppaused')
    expect(result.roomsSlept).toEqual([])
    expect(logs.some((l) => l.includes('sleeppaused') && l.includes('stray runtime'))).toBe(true)
  })
})

describe('reconcile isolates individual startup failures', () => {
  const dirs: string[] = []
  const dbs: Db[] = []

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function repo() {
    const dir = tempDir()
    dirs.push(dir)
    const db = openDb(dir)
    dbs.push(db)
    return roomsRepo(db)
  }

  it('keeps reconciling after one stray container cannot be removed', async () => {
    const rooms = repo()
    rooms.create(makeRoom({ id: 'awake0001', domain: 'awake.localhost', status: 'ready', hostPort: 41020 }))
    rooms.create(makeRoom({ id: 'broken001', domain: 'broken.localhost', status: 'broken', hostPort: null }))
    const backend = new FakeBackend()
    backend.managedContainers = [
      { roomId: 'gone00001', role: 'web', state: 'exited', name: 'dh-gone00001-web' },
      { roomId: 'gone00002', role: 'web', state: 'exited', name: 'dh-gone00002-web' }
    ]
    backend.managedNetworks = [
      { roomId: 'gone00002', name: 'dh-gone00002-net' },
      { roomId: 'broken001', name: 'dh-broken001-net' }
    ]
    const remove = backend.removeManagedContainer.bind(backend)
    backend.removeManagedContainer = async (name: string) => {
      if (name === 'dh-gone00001-web') {
        backend.calls.push(`removeManagedContainer:${name}`)
        throw new Error('container is locked')
      }
      await remove(name)
    }
    const logs: string[] = []

    const result = await reconcile(backend, rooms, (line) => logs.push(line))

    expect(result.straysFailed).toEqual(['dh-gone00001-web'])
    expect(result.straysRemoved).toEqual(['dh-gone00002-web'])
    expect(result.networksRemoved).toEqual(['dh-gone00002-net'])
    expect(backend.calls).toContain('removeManagedContainer:dh-gone00002-web')
    expect(backend.calls).toContain('removeManagedNetwork:dh-gone00002-net')
    expect(backend.calls).toContain('adoptManagedNetwork:dh-broken001-net')
    expect(backend.calls).toContain('stopRoomPod:broken001')
    expect(rooms.get('awake0001')).toMatchObject({ status: 'sleeping', hostPort: null })
    expect(result.roomsSlept).toEqual(['awake0001'])
    expect(result.roomsFailedToSleep).toBeUndefined()
    expect(logs.some((line) => line.includes('could not remove container dh-gone00001-web: container is locked'))).toBe(true)
  })

  it('marks a Room broken when it cannot be stopped and still sleeps the Rooms after it', async () => {
    const rooms = repo()
    rooms.create(makeRoom({ id: 'awake0001', domain: 'awake1.localhost', status: 'ready', hostPort: 41021 }))
    rooms.create(makeRoom({ id: 'awake0002', domain: 'awake2.localhost', status: 'running', hostPort: 41022 }))
    const backend = new FakeBackend()
    const stop = backend.stopRoomPod.bind(backend)
    backend.stopRoomPod = async (roomId: string) => {
      if (roomId === 'awake0001') {
        backend.calls.push(`stopRoomPod:${roomId}`)
        throw new Error('Room awake0001 stop incomplete')
      }
      await stop(roomId)
    }
    const logs: string[] = []

    const result = await reconcile(backend, rooms, (line) => logs.push(line))

    expect(rooms.get('awake0001')).toMatchObject({ status: 'broken', hostPort: null })
    expect(rooms.get('awake0002')).toMatchObject({ status: 'sleeping', hostPort: null })
    expect(result.roomsSlept).toEqual(['awake0002'])
    expect(result.roomsFailedToSleep).toEqual(['awake0001'])
    expect(result.straysFailed).toBeUndefined()
    expect(backend.calls).toContain('stopRoomPod:awake0002')
    expect(logs.some((line) => line.includes('could not stop room awake0001') && line.includes('stop incomplete'))).toBe(true)
  })

  it('finishes startup when a stray removal and a Room stop both fail', async () => {
    const userData = tempDir()
    dirs.push(userData)
    const db = testDb()
    dbs.push(db)
    const backend = new FakeBackend()
    const gateway = new FakeGateway()
    const orch = new RoomOrchestrator({ userData, db, backend, gateway: gateway.asGateway(), appVersion: 'test' })
    orch.rooms.create(makeRoom({ id: 'awake0001', domain: 'awake1.localhost', status: 'ready', hostPort: 41023 }))
    orch.rooms.create(makeRoom({ id: 'awake0002', domain: 'awake2.localhost', status: 'ready', hostPort: 41024 }))
    backend.managedContainers = [{ roomId: 'gone00001', role: 'web', state: 'exited', name: 'dh-gone00001-web' }]
    backend.removeManagedContainer = async () => {
      throw new Error('container is locked')
    }
    const stop = backend.stopRoomPod.bind(backend)
    backend.stopRoomPod = async (roomId: string) => {
      if (roomId === 'awake0001') throw new Error('Room awake0001 stop incomplete')
      await stop(roomId)
    }
    const internals = orch as unknown as {
      reconcileWindowsRooms: () => Promise<void>
      markInterruptedChanges: (slept: Set<string>) => Promise<void>
    }
    const windows = vi.spyOn(internals, 'reconcileWindowsRooms')
    const changes = vi.spyOn(internals, 'markInterruptedChanges')
    const browsersReconcile = vi.spyOn(orch.clientBrowsers, 'reconcile')
    const browsersStart = vi.spyOn(orch.clientBrowsers, 'start')

    const result = await orch.init()

    expect(orch.startupStatus()).toMatchObject({ state: 'ready', code: null })
    expect(result.reconciled).toMatchObject({
      straysFailed: ['dh-gone00001-web'],
      roomsFailedToSleep: ['awake0001'],
      roomsSlept: ['awake0002']
    })
    expect(orch.rooms.get('awake0001')).toMatchObject({ status: 'broken', hostPort: null })
    expect(orch.rooms.get('awake0002')).toMatchObject({ status: 'sleeping', hostPort: null })
    expect(windows).toHaveBeenCalled()
    expect(changes).toHaveBeenCalledWith(new Set(['awake0002']))
    expect(browsersReconcile).toHaveBeenCalled()
    expect(browsersStart).toHaveBeenCalled()
  })
})

describe('reconcile containment of unowned labeled containers', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('reports a malformed foreign labeled container and still reconciles every proven owned resource', async () => {
    const dir = tempDir()
    dirs.push(dir)
    const db = openDb(dir)
    const rooms = roomsRepo(db)
    rooms.create(makeRoom({ id: 'owned0001', domain: 'owned.localhost', status: 'ready', hostPort: 41010 }))
    const backend = new FakeBackend()
    const stray = jobName('gone00001', '11111111-2222-4333-8444-555555555555')
    backend.managedContainers = [{ roomId: 'gone00001', role: 'job', state: 'exited', name: stray }]
    backend.listManagedContainerInventory = async () => ({
      owned: backend.managedContainers,
      invalid: [{ name: 'someone-elses-container', reason: 'managed container ownership metadata is invalid' }]
    })
    const logs: string[] = []

    const result = await reconcile(backend, rooms, (line) => logs.push(line))

    expect(result.invalidContainers).toEqual([
      { name: 'someone-elses-container', reason: 'managed container ownership metadata is invalid' }
    ])
    expect(result.straysRemoved).toContain(stray)
    expect(rooms.get('owned0001')?.status).toBe('sleeping')
    expect(backend.calls).toContain(`removeManagedContainer:${stray}`)
    expect(backend.calls).not.toContain('removeManagedContainer:someone-elses-container')
    expect(logs.some((line) => line.includes('someone-elses-container') && line.includes('not owned by DevHotel'))).toBe(true)
    db.close()
  })
})
