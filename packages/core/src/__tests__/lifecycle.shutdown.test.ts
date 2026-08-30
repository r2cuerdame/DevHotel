import { rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RoomOrchestrator } from '../orchestrator'
import { openDb, type Db } from '../store/db'
import { FakeAdbHost, FakeBackend, FakeGateway, listeningPort, makeRoom, tempDir } from './fakes'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('RoomOrchestrator shutdown gate', () => {
  let db: Db
  let userData: string
  let backend: FakeBackend
  let gateway: FakeGateway
  let orch: RoomOrchestrator
  let closePort: () => void

  beforeEach(async () => {
    userData = tempDir()
    db = openDb(userData)
    backend = new FakeBackend()
    gateway = new FakeGateway()
    const listener = await listeningPort()
    backend.hostPort = listener.port
    closePort = listener.close
    orch = new RoomOrchestrator({
      userData,
      backend,
      gateway: gateway.asGateway(),
      db,
      appVersion: 'test',
      adb: new FakeAdbHost([{ serial: 'R5CT30ABCDE', state: 'device', model: 'SM_G991N', release: '14', sdk: '34' }])
    })
  })

  afterEach(() => {
    closePort()
    db.close()
    rmSync(userData, { recursive: true, force: true })
  })

  it('waits for an admitted clone, rejects new lifecycle work, then sleeps the stable room list', async () => {
    const source = makeRoom({
      id: 'source10',
      project: 'managed',
      nickname: 'dev',
      sourceType: 'managed-git',
      sourceRef: 'https://example.test/managed.git',
      workspaceMode: 'hotel',
      syncStatus: 'synced',
      domain: 'managed-dev.localhost',
      hostPort: backend.hostPort
    })
    orch.rooms.create(source)
    const entered = deferred()
    const release = deferred()
    backend.copyVolume = async (from, to) => {
      backend.calls.push(`copyVolume:${from}:${to}`)
      entered.resolve()
      await release.promise
    }

    const cloneTask = orch.cloneRoom({
      sourceRoomId: source.id,
      nickname: 'stage',
      copyDependencies: false,
      services: 'exclude',
      actor: 'user'
    })
    await entered.promise

    let shutdownFinished = false
    const shutdownTask = orch.shutdown().then(() => {
      shutdownFinished = true
    })
    await Promise.resolve()
    expect(shutdownFinished).toBe(false)
    expect(backend.calls.some((call) => call.startsWith('stopRoomPod:'))).toBe(false)
    await expect(orch.startRoom(source.id, 'user')).rejects.toThrow(/shutting down/)

    release.resolve()
    const cloned = await cloneTask
    await shutdownTask
    expect(orch.rooms.get(source.id)?.status).toBe('sleeping')
    expect(orch.rooms.get(cloned.id)?.status).toBe('sleeping')
    expect(backend.calls).toContain(`stopRoomPod:${source.id}`)
    expect(backend.calls).toContain(`stopRoomPod:${cloned.id}`)
  })

  it('serializes a preparing clone target mutation and drains it before shutdown inventories rooms', async () => {
    const source = makeRoom({
      id: 'source14',
      project: 'managed',
      nickname: 'dev',
      sourceType: 'managed-git',
      sourceRef: 'https://example.test/managed.git',
      workspaceMode: 'hotel',
      syncStatus: 'synced',
      domain: 'managed-barrier.localhost',
      hostPort: backend.hostPort
    })
    orch.rooms.create(source)
    const entered = deferred()
    const release = deferred()
    backend.copyVolume = async (from, to) => {
      backend.calls.push(`copyVolume:${from}:${to}`)
      entered.resolve()
      await release.promise
    }

    const cloneTask = orch.cloneRoom({
      sourceRoomId: source.id,
      nickname: 'barrier',
      copyDependencies: false,
      services: 'exclude',
      actor: 'user'
    })
    await entered.promise
    const preparing = orch.listRooms().find((room) => room.id !== source.id)
    expect(preparing?.status).toBe('preparing')

    let targetSleepFinished = false
    const targetSleep = orch.sleepRoom(preparing!.id, 'user').then(() => {
      targetSleepFinished = true
    })
    await Promise.resolve()
    expect(targetSleepFinished).toBe(false)
    expect(backend.calls).not.toContain(`stopRoomPod:${preparing!.id}`)

    const shutdownTask = orch.shutdown()
    release.resolve()
    const cloned = await cloneTask
    await targetSleep
    await shutdownTask

    const targetStartedAt = backend.calls.indexOf(`startWeb:${cloned.id}`)
    const targetStoppedAt = backend.calls.indexOf(`stopRoomPod:${cloned.id}`)
    expect(targetStartedAt).toBeGreaterThanOrEqual(0)
    expect(targetStoppedAt).toBeGreaterThan(targetStartedAt)
    expect(orch.rooms.get(cloned.id)?.status).toBe('sleeping')
    expect(orch.rooms.get(source.id)?.status).toBe('sleeping')
  })

  it('tracks creation before its room lock exists and shutdown sleeps the completed room', async () => {
    const entered = deferred()
    const release = deferred()
    const createRoomPod = backend.createRoomPod.bind(backend)
    backend.createRoomPod = async (spec, opts) => {
      entered.resolve()
      await release.promise
      return createRoomPod(spec, opts)
    }

    const createTask = orch.createRoom({
      sourceType: 'empty',
      sourceRef: '',
      project: 'new-app',
      nickname: 'dev',
      actor: 'user'
    })
    await entered.promise
    const shutdownTask = orch.shutdown()
    expect(orch.shutdown()).toBe(shutdownTask)
    await expect(
      orch.createRoom({ sourceType: 'empty', sourceRef: '', project: 'late-app', nickname: 'dev', actor: 'user' })
    ).rejects.toThrow(/shutting down/)
    expect(backend.calls.some((call) => call.startsWith('stopRoomPod:'))).toBe(false)

    release.resolve()
    const created = await createTask
    await shutdownTask
    expect(orch.rooms.get(created.id)?.status).toBe('sleeping')
    expect(backend.calls).toContain(`stopRoomPod:${created.id}`)
  })

  it('attempts every Room and the gateway before rejecting aggregated stop failures', async () => {
    const first = makeRoom({ id: 'stopfail', project: 'first', nickname: 'dev', roomNumber: 201, domain: 'first.localhost' })
    const second = makeRoom({ id: 'stopokay', project: 'second', nickname: 'dev', roomNumber: 202, domain: 'second.localhost' })
    orch.rooms.create(first)
    orch.rooms.create(second)
    const stopRoomPod = backend.stopRoomPod.bind(backend)
    backend.stopRoomPod = async (roomId) => {
      backend.calls.push(`attemptStop:${roomId}`)
      if (roomId === first.id) throw new Error('simulated stop failure')
      await stopRoomPod(roomId)
    }
    let gatewayStopped = false
    gateway.stop = async () => {
      gatewayStopped = true
    }

    await expect(orch.shutdown()).rejects.toBeInstanceOf(AggregateError)
    expect(backend.calls).toContain(`attemptStop:${first.id}`)
    expect(backend.calls).toContain(`attemptStop:${second.id}`)
    expect(orch.rooms.get(second.id)?.status).toBe('sleeping')
    expect(gatewayStopped).toBe(true)
  })

  it('releases the physical-device lease when shutting down a broken Android Room', async () => {
    const room = makeRoom({
      id: 'broken15',
      project: 'android-broken',
      nickname: 'dev',
      provider: 'android',
      runtime: { kind: 'jdk', version: '17' },
      packageManager: { kind: 'gradle' },
      startCommand: 'gradle assembleDebug --no-daemon',
      internalPort: 6080,
      status: 'ready'
    })
    orch.rooms.create(room)
    await orch.refreshAndroidDevices()
    const attached = await orch.attachAndroidDevice(room.id, {
      purpose: 'acceptance',
      workerId: 'worker-a'
    })
    if (attached.state !== 'granted') throw new Error('unreachable')
    orch.rooms.update(room.id, { status: 'broken' })

    await orch.shutdown()

    expect(orch.devices.leaseForRoom(room.id)).toBeNull()
    expect(orch.androidDeviceStatus().devices[0]?.leaseOwner).toBeNull()
    expect(backend.calls).toContain(`stopRoomPod:${room.id}`)
    expect(orch.rooms.get(room.id)?.status).toBe('broken')
  })

  it('drains an admitted clone before clean removal snapshots and deletes its stable inventory', async () => {
    const source = makeRoom({
      id: 'source11',
      project: 'managed',
      nickname: 'dev',
      sourceType: 'managed-git',
      sourceRef: 'https://example.test/managed.git',
      workspaceMode: 'hotel',
      syncStatus: 'synced',
      domain: 'managed-clean.localhost',
      hostPort: backend.hostPort
    })
    orch.rooms.create(source)
    const entered = deferred()
    const release = deferred()
    backend.copyVolume = async (from, to) => {
      backend.calls.push(`copyVolume:${from}:${to}`)
      entered.resolve()
      await release.promise
    }

    const cloneTask = orch.cloneRoom({
      sourceRoomId: source.id,
      nickname: 'clean-copy',
      copyDependencies: false,
      services: 'exclude',
      actor: 'user'
    })
    await entered.promise
    const cleanupTask = orch.deleteAllRooms('user')
    await Promise.resolve()
    expect(backend.calls.some((call) => call.startsWith('deleteRoomPod:'))).toBe(false)
    await expect(orch.renameRoom(source.id, 'too-late')).rejects.toThrow(/removing its data/)

    release.resolve()
    const clone = await cloneTask
    const result = await cleanupTask
    expect(result.deletedRooms).toBe(2)
    expect(orch.listRooms()).toEqual([])
    expect(backend.calls).toContain(`deleteRoomPod:${source.id}`)
    expect(backend.calls).toContain(`deleteRoomPod:${clone.id}`)
    await expect(
      orch.createRoom({ sourceType: 'empty', sourceRef: '', project: 'late-app', nickname: 'dev', actor: 'user' })
    ).rejects.toThrow(/removing its data/)
    await expect(orch.shutdown()).resolves.toBeUndefined()
  })

  it('keeps failed cleanup ownership and reopens the mutation gate for a safe retry', async () => {
    const room = makeRoom({ id: 'retry001', project: 'retry', nickname: 'dev', domain: 'retry.localhost' })
    orch.rooms.create(room)
    const realDelete = backend.deleteRoomPod.bind(backend)
    let fail = true
    backend.deleteRoomPod = async (roomId) => {
      if (fail) throw new Error('runtime unavailable')
      return realDelete(roomId)
    }

    await expect(orch.deleteAllRooms('user')).rejects.toThrow(/runtime unavailable/)
    expect(orch.rooms.get(room.id)).toBeDefined()
    await orch.renameRoom(room.id, 'retryable')

    fail = false
    await expect(orch.deleteAllRooms('user')).resolves.toMatchObject({ deletedRooms: 1 })
    expect(orch.listRooms()).toEqual([])
  })

  it('surfaces a crash-interrupted pending change without discarding its captured backup', async () => {
    const room = makeRoom({ id: 'pending1', project: 'pending', nickname: 'dev', domain: 'pending.localhost' })
    orch.rooms.create(room)
    orch.changes.append({
      id: 'pending-change-1',
      roomId: room.id,
      kind: 'service-version',
      title: 'PostgreSQL 16 → 17',
      actor: 'user',
      component: 'PostgreSQL',
      before: { version: '16' },
      after: { version: '17' },
      captured: { prevVersion: '16', backupFile: 'postgres-safety.sql' },
      steps: ['Back up the current data'],
      verify: null,
      undoable: true,
      undoStrategy: 'backup-recreate-restore',
      status: 'pending',
      rawLogPath: null,
      createdAt: '2026-08-10T10:00:00.000Z',
      undoneAt: null
    })

    await orch.init()

    expect(orch.rooms.get(room.id)?.status).toBe('attention')
    expect(orch.changes.get('pending-change-1')).toMatchObject({
      status: 'failed',
      captured: { prevVersion: '16', backupFile: 'postgres-safety.sql' },
      steps: ['Back up the current data'],
      verify: { ok: false }
    })
    expect(orch.changes.get('pending-change-1')?.verify?.detail).toMatch(/interrupted.*preserved/)
  })

  it('cleans an interrupted Android build snapshot before failing the pending Change', async () => {
    const room = makeRoom({ id: 'android1', provider: 'android', workspaceMode: 'hotel' })
    const changeId = '11111111-2222-4333-8444-555555555555'
    orch.rooms.create(room)
    orch.changes.append({
      id: changeId,
      roomId: room.id,
      kind: 'android-build',
      title: 'Debug APK built',
      actor: 'agent',
      component: 'Build',
      before: null,
      after: null,
      captured: { executionLifecycle: 'in-process-only' },
      steps: ['Room resumed'],
      verify: null,
      undoable: false,
      undoStrategy: 'none',
      status: 'pending',
      rawLogPath: null,
      createdAt: '2026-08-10T10:00:00.000Z',
      undoneAt: null
    })

    await orch.init()

    expect(backend.calls).toContain(`removeWorkspaceSnapshot:${changeId}`)
    expect(orch.changes.get(changeId)).toMatchObject({ status: 'failed', verify: { ok: false } })
    expect(orch.rooms.get(room.id)?.status).toBe('attention')
  })

  it('keeps interrupted Android cleanup pending so startup can retry after backend recovery', async () => {
    const room = makeRoom({ id: 'android2', provider: 'android', workspaceMode: 'hotel' })
    const changeId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    orch.rooms.create(room)
    orch.changes.append({
      id: changeId,
      roomId: room.id,
      kind: 'android-build',
      title: 'Debug APK built',
      actor: 'agent',
      component: 'Build',
      before: null,
      after: null,
      captured: null,
      steps: [],
      verify: null,
      undoable: false,
      undoStrategy: 'none',
      status: 'pending',
      rawLogPath: null,
      createdAt: '2026-08-10T10:00:00.000Z',
      undoneAt: null
    })
    backend.removeWorkspaceSnapshot = async () => {
      throw new Error('engine offline')
    }

    await orch.init()

    expect(orch.changes.get(changeId)).toMatchObject({
      status: 'pending',
      verify: { ok: false, detail: expect.stringMatching(/retry on next startup.*engine offline/) }
    })
    expect(orch.rooms.get(room.id)?.status).toBe('attention')
  })
})
