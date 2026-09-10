import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RoomOrchestrator } from '../orchestrator'
import { reconcile } from '../reconcile'
import type { Db } from '../store/db'
import { FakeBackend, FakeGateway, FakeWindowsVm, listeningPort, makeRoom, tempDir, testDb } from './fakes'

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

describe('Crash-atomic Room lifecycle and rollback', () => {
  const dirs: string[] = []
  const dbs: Db[] = []
  const closers: (() => void)[] = []

  afterEach(() => {
    for (const close of closers.splice(0)) close()
    for (const db of dbs.splice(0)) db.close()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  async function setup() {
    const userData = tempDir()
    dirs.push(userData)
    const db = testDb()
    dbs.push(db)
    const backend = new FakeBackend()
    const gateway = new FakeGateway()
    const windowsVm = new FakeWindowsVm()
    const listener = await listeningPort()
    closers.push(listener.close)
    backend.hostPort = listener.port
    const orch = new RoomOrchestrator({
      userData,
      backend,
      windowsVm,
      gateway: gateway.asGateway(),
      db,
      appVersion: 'test'
    })
    return { backend, gateway, windowsVm, orch, db, userData }
  }

  describe('createRoom rollback', () => {
    it('rolls back pod, route, and SQLite record if post-pod initialization fails', async () => {
      const { backend, gateway, orch, userData } = await setup()
      const sourceDir = tempDir()
      dirs.push(sourceDir)
      let createdRoomId: string | null = null
      let deletedRoomId: string | null = null

      orch.onEvent((event) => {
        if (event.kind === 'created') createdRoomId = event.roomId
        if (event.kind === 'deleted') deletedRoomId = event.roomId
      })

      // Simulate a post-pod setup failure during dependency installation
      const orchAny = orch as unknown as { engine: { execute: (...args: any[]) => Promise<any> } }
      const execute = orchAny.engine.execute.bind(orchAny.engine)
      orchAny.engine.execute = async (ctx: any, changeKind: any, params: any, actor: any) => {
        if (changeKind === 'deps-install') {
          throw new Error('pnpm install network timeout: ETIMEDOUT')
        }
        return execute(ctx, changeKind, params, actor)
      }

      await expect(
        orch.createRoom({
          project: 'rollback-app',
          nickname: 'dev',
          sourceType: 'linked-folder',
          sourceRef: sourceDir,
          actor: 'user'
        })
      ).rejects.toThrow(
        expect.objectContaining({
          name: 'DevHotelError',
          code: 'ROOM_CREATION_FAILED'
        })
      )

      expect(createdRoomId).not.toBeNull()
      const roomId = createdRoomId!
      expect(deletedRoomId).toBe(roomId)

      // Backend pod deletion must have been invoked with volumes: true
      expect(backend.calls.some((call) => call.startsWith(`deleteRoomPod:${roomId}`))).toBe(true)

      // Gateway route must be removed
      expect([...gateway.routes.values()].some((r) => r.domain.startsWith('rollback-app-dev'))).toBe(false)

      // SQLite record must be gone
      expect(orch.rooms.get(roomId)).toBeNull()

      // Room folder in userData must be removed
      expect(existsSync(join(userData, 'rooms', roomId))).toBe(false)
    })

    it('marks room as broken if cleanup pod deletion itself fails during rollback', async () => {
      const { backend, orch } = await setup()
      const sourceDir = tempDir()
      dirs.push(sourceDir)
      let createdRoomId: string | null = null

      orch.onEvent((event) => {
        if (event.kind === 'created') createdRoomId = event.roomId
      });

      (orch as any).engine.execute = async () => {
        throw new Error('deps installation failed')
      }

      backend.deleteRoomPod = async () => {
        throw new Error('docker daemon connection refused during rollback')
      }

      await expect(
        orch.createRoom({
          project: 'broken-app',
          nickname: 'dev',
          sourceType: 'linked-folder',
          sourceRef: sourceDir,
          actor: 'user'
        })
      ).rejects.toThrow(
        expect.objectContaining({
          name: 'DevHotelError',
          code: 'ROOM_CREATION_FAILED'
        })
      )

      expect(createdRoomId).not.toBeNull()
      const roomId = createdRoomId!

      // Room record is preserved with status 'broken' so operator or reconciliation can clean it up
      const room = orch.rooms.get(roomId)
      expect(room).not.toBeNull()
      expect(room?.status).toBe('broken')
    })
  })

  describe('deleteRoom two-phase crash-atomicity', () => {
    it('sets status to deleting in SQLite before pod deletion, rejecting concurrent operations', async () => {
      const { backend, orch } = await setup()
      const room = makeRoom({ id: 'delroom1', project: 'demo', nickname: 'del', domain: 'delroom1.localhost', status: 'ready' })
      orch.rooms.create(room)

      const deleteEntered = gate()
      const finishDelete = gate()
      const originalDelete = backend.deleteRoomPod.bind(backend)

      backend.deleteRoomPod = async (roomId: string) => {
        deleteEntered.open()
        await finishDelete.promise
        return originalDelete(roomId)
      }

      const deletingPromise = orch.deleteRoom(room.id, 'user')
      await deleteEntered.promise

      // Status in SQLite must be 'deleting' while pod deletion is running
      const liveRoom = orch.rooms.get(room.id)
      expect(liveRoom).not.toBeNull()
      expect(liveRoom?.status).toBe('deleting')

      // Concurrent delete must be rejected
      await expect(orch.deleteRoom(room.id, 'user')).rejects.toThrow(/being deleted/)

      // Concurrent operation start must be rejected
      expect(() => orch.startRoomOperation(room.id, 'agent')).toThrow(/being deleted/)

      finishDelete.open()
      await deletingPromise

      // Once deleted, record must be purged
      expect(orch.rooms.get(room.id)).toBeNull()
    })
  })

  describe('startup reconciliation for deleting and preparing rooms', () => {
    it('completes pending deletions and cleans up orphaned preparing room resources', async () => {
      const { backend, orch, userData } = await setup()

      // Room left in 'deleting' status from an interrupted shutdown
      const deletingRoom = makeRoom({ id: 'crashdel1', domain: 'crashdel1.localhost', status: 'deleting' })
      orch.rooms.create(deletingRoom)
      mkdirSync(join(userData, 'rooms', deletingRoom.id), { recursive: true })
      writeFileSync(join(userData, 'rooms', deletingRoom.id, 'manifest.json'), '{}')

      // Interrupted 'preparing' room
      const preparingRoom = makeRoom({ id: 'crashprep1', domain: 'crashprep1.localhost', status: 'preparing' })
      orch.rooms.create(preparingRoom)
      backend.managedContainers = [
        { roomId: 'crashprep1', role: 'web', state: 'created', name: 'dh-crashprep1-web' }
      ]
      backend.managedNetworks = [
        { roomId: 'crashprep1', name: 'dh-crashprep1-net' }
      ]

      const result = await reconcile(
        backend,
        orch.rooms,
        () => undefined,
        { userData }
      )

      // Deleting room must have had its pod deleted and SQLite row removed
      expect(backend.calls).toContain('deleteRoomPod:crashdel1')
      expect(orch.rooms.get(deletingRoom.id)).toBeNull()
      expect(existsSync(join(userData, 'rooms', deletingRoom.id))).toBe(false)
      expect(result.roomsDeleted).toContain('crashdel1')

      // Preparing room must be marked broken, and its stray container & bridge network removed
      expect(orch.rooms.get(preparingRoom.id)?.status).toBe('broken')
      expect(result.straysRemoved).toContain('dh-crashprep1-web')
      expect(result.networksRemoved).toContain('dh-crashprep1-net')
    })
  })
})
