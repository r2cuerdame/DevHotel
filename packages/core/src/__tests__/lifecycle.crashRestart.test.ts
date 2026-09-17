import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DockerVolumeUsage } from '../backend/types'
import { depsVolume, srcVolume, svcVolume } from '../backend/naming'
import { depsGenKey, depsGenMaxKey } from '../changes/definitions/deps'
import { RoomOrchestrator } from '../orchestrator'
import type { Db } from '../store/db'
import { FakeBackend, FakeGateway, listeningPort, makeRoom, tempDir, testDb } from './fakes'
import { until } from './timing'

/**
 * Crash → fresh orchestrator sequences (issue #77).
 *
 * Each scenario drives a real `RoomOrchestrator` into the middle of a durable
 * mutation, then abandons that instance without `shutdown()` — the process
 * died — and constructs a brand-new orchestrator over the same SQLite file,
 * the same userData directory and the same engine state. What the second
 * (and third) `init()` does with the leftovers is the contract under test.
 *
 * The world that survives a crash is exactly: the database, the userData
 * tree, and whatever the engine holds. The world that does not survive is
 * every in-memory guard of the dead orchestrator. The fixture keeps the first
 * set and throws the second away.
 */

const ROOM_ID = 'crashrm1'
const NODE_MAJOR = '22'

function managedVolume(name: string, sizeBytes = 1_000): DockerVolumeUsage {
  return {
    name,
    driver: 'local',
    scope: 'local',
    mountpoint: `/var/lib/docker/volumes/${name}`,
    sizeBytes,
    sizeKnown: true,
    ownership: 'managed-labels',
    links: 0,
    linksKnown: true,
    labels: { 'devhotel.managed': '1', 'devhotel.room': ROOM_ID, 'devhotel.role': 'volume' }
  }
}

describe('crash → fresh orchestrator recovery', () => {
  const dirs: string[] = []
  const dbs: Db[] = []
  const closers: (() => void)[] = []

  afterEach(() => {
    for (const close of closers.splice(0)) close()
    for (const db of dbs.splice(0)) db.close()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  /** Everything that outlives a process: the database, userData, and the engine. */
  async function durableWorld() {
    const userData = tempDir()
    dirs.push(userData)
    const db = testDb()
    dbs.push(db)
    const backend = new FakeBackend()
    const listener = await listeningPort()
    closers.push(listener.close)
    backend.hostPort = listener.port
    return { userData, db, backend }
  }

  /** A fresh process: new orchestrator, new gateway, nothing remembered. */
  function boot(world: Awaited<ReturnType<typeof durableWorld>>) {
    const gateway = new FakeGateway()
    const orch = new RoomOrchestrator({
      userData: world.userData,
      backend: world.backend,
      gateway: gateway.asGateway(),
      db: world.db,
      appVersion: 'test'
    })
    return { orch, gateway }
  }

  function hotelRoom(overrides: Parameters<typeof makeRoom>[0] = {}) {
    return makeRoom({
      id: ROOM_ID,
      domain: 'crash-dev.localhost',
      sourceType: 'managed-git',
      sourceRef: 'https://example.test/demo.git',
      workspaceMode: 'hotel',
      syncStatus: 'synced',
      runtime: { kind: 'node', version: NODE_MAJOR },
      status: 'sleeping',
      hostPort: null,
      ...overrides
    })
  }

  describe('dependency generation', () => {
    it('recovers an install interrupted between the fresh generation and its publish, never recycles the number, and lets GC prove the leftover stale', async () => {
      const world = await durableWorld()
      const { backend } = world
      const first = boot(world)
      first.orch.rooms.create(hotelRoom())
      await first.orch.init()
      await first.orch.startRoom(ROOM_ID, 'user')
      expect(first.orch.rooms.get(ROOM_ID)?.status).toBe('ready')

      // The install into the fresh generation never returns: the process dies
      // while `pnpm install` is running against generation g1.
      backend.oneShotHandler = (_spec, cmd) => {
        if (cmd === 'pnpm install') return new Promise<never>(() => undefined) as never
        return { code: 0, stdout: '', stderr: '' }
      }
      const abandoned = first.orch.applyChange(ROOM_ID, { kind: 'deps-install', clean: true }, 'user')
      abandoned.catch(() => undefined)
      await until(() => backend.oneShotCalls.some((call) => call.cmd === 'pnpm install'), { what: 'the install to start' })
      expect(backend.calls).toContain(`resetVolume:${depsVolume(ROOM_ID, NODE_MAJOR)}-g1`)
      // What the engine holds after the crash: the published g0 and the half-written g1.
      backend.managedVolumes = [
        managedVolume(srcVolume(ROOM_ID)),
        managedVolume(depsVolume(ROOM_ID, NODE_MAJOR)),
        managedVolume(`${depsVolume(ROOM_ID, NODE_MAJOR)}-g1`)
      ]
      // ── crash ──
      backend.oneShotHandler = null
      backend.calls.length = 0

      const second = boot(world)
      await second.orch.init()

      expect(second.orch.startupStatus()).toMatchObject({ state: 'ready', backendOk: true })
      const [entry, ...rest] = second.orch.changes.list(ROOM_ID)
      expect(rest).toEqual([])
      expect(entry).toMatchObject({
        kind: 'deps-install',
        status: 'failed',
        verify: { ok: false, detail: expect.stringMatching(/interrupted while applying change #1/) },
        captured: { prevGen: 0, nodeMajor: NODE_MAJOR }
      })
      expect(entry!.steps).toEqual(['Create fresh dependency volume', 'Run pnpm install into the fresh volume'])
      const room = second.orch.rooms.get(ROOM_ID)!
      expect(room.status).toBe('attention')
      // The pointer never moved; the reservation is spent.
      expect(second.orch.settings.get(depsGenKey(ROOM_ID, NODE_MAJOR))).toBeNull()
      expect(second.orch.settings.get(depsGenMaxKey(ROOM_ID, NODE_MAJOR))).toBe('1')
      expect(second.orch.logs.tail(ROOM_ID, 'orchestrator').join('\n')).toMatch(/interrupted while applying change #1/)
      // A failed change is not undoable, and says so instead of guessing.
      await expect(second.orch.undoChange(ROOM_ID, entry!.id, 'user')).rejects.toThrow(/is failed and cannot be undone/)

      // GC sees the crash leftover as provably stale and the published generation as live.
      const report = await second.orch.reconcileVolumes()
      const byName = new Map(report.volumes.map((volume) => [volume.name, volume]))
      expect(byName.get(`${depsVolume(ROOM_ID, NODE_MAJOR)}-g1`)).toMatchObject({ class: 'orphaned-stale-deps', safeToDelete: true })
      expect(byName.get(depsVolume(ROOM_ID, NODE_MAJOR))).toMatchObject({ class: 'retained-active', safeToDelete: false })
      expect(byName.get(srcVolume(ROOM_ID))).toMatchObject({ safeToDelete: false })

      // The retry allocates above the spent reservation: g1 is never reused.
      await second.orch.startRoom(ROOM_ID, 'user')
      const retried = await second.orch.applyChange(ROOM_ID, { kind: 'deps-install', clean: true }, 'user')
      expect(retried.status).toBe('verified')
      expect(backend.calls).toContain(`resetVolume:${depsVolume(ROOM_ID, NODE_MAJOR)}-g2`)
      expect(backend.calls).not.toContain(`resetVolume:${depsVolume(ROOM_ID, NODE_MAJOR)}-g1`)
      expect(second.orch.settings.get(depsGenKey(ROOM_ID, NODE_MAJOR))).toBe('2')
      expect(second.orch.settings.get(depsGenMaxKey(ROOM_ID, NODE_MAJOR))).toBe('2')

      // Another restart changes nothing: the failed row stays failed, the
      // published pointer stays published, and the retry stays undoable.
      backend.calls.length = 0
      const third = boot(world)
      await third.orch.init()
      expect(third.orch.changes.list(ROOM_ID).map((change) => [change.seq, change.status]).sort()).toEqual([[1, 'failed'], [2, 'verified']])
      expect(third.orch.settings.get(depsGenKey(ROOM_ID, NODE_MAJOR))).toBe('2')
      expect(third.orch.settings.get(depsGenMaxKey(ROOM_ID, NODE_MAJOR))).toBe('2')
      expect(backend.calls.filter((call) => call.startsWith('resetVolume:'))).toEqual([])
    })
  })

  describe('service data', () => {
    it('keeps the safety backup of a version change interrupted mid-restore and surfaces the row as failed on every later start', async () => {
      const world = await durableWorld()
      const { backend, userData } = world
      const first = boot(world)
      first.orch.rooms.create(hotelRoom({ services: { postgres: { version: '16' } } }))
      await first.orch.init()
      await first.orch.startRoom(ROOM_ID, 'user')
      backend.serviceStates.set('postgres', 'running')

      // The old data volume is gone, the new container is up, and the restore
      // of the backup into it is where the process dies.
      backend.execInServiceFromFile = () => new Promise<never>(() => undefined)
      const abandoned = first.orch.applyChange(ROOM_ID, { kind: 'service-version', service: 'postgres', version: '17' }, 'user')
      abandoned.catch(() => undefined)
      await until(() => backend.calls.includes('createService:postgres:17'), { what: 'the new service to be created' })
      await until(() => first.orch.changes.list(ROOM_ID)[0]?.steps.includes('Restore the data into the new version') ?? false, {
        what: 'the restore step to start'
      })
      backend.managedVolumes = [managedVolume(srcVolume(ROOM_ID)), managedVolume(svcVolume(ROOM_ID, 'postgres'))]
      // ── crash ──
      delete (backend as Partial<FakeBackend>).execInServiceFromFile
      backend.calls.length = 0

      const second = boot(world)
      await second.orch.init()

      const [entry, ...rest] = second.orch.changes.list(ROOM_ID)
      expect(rest).toEqual([])
      expect(entry).toMatchObject({
        kind: 'service-version',
        status: 'failed',
        verify: { ok: false, detail: expect.stringMatching(/interrupted while applying change #1; captured safety data was preserved/) },
        captured: { prevVersion: '16', backupFile: expect.stringMatching(/postgres-.*\.sql$/) }
      })
      const backupFile = (entry!.captured as { backupFile: string }).backupFile
      expect(backupFile.startsWith(join(userData, 'rooms', ROOM_ID, 'backups'))).toBe(true)
      expect(existsSync(backupFile)).toBe(true)
      expect(statSync(backupFile).size).toBeGreaterThan(0)
      // The record already names the new version: that is the container that
      // exists. The data it should hold is in the backup, not in the volume.
      const room = second.orch.rooms.get(ROOM_ID)!
      expect(room.status).toBe('attention')
      expect(room.services.postgres).toEqual({ version: '17' })
      // Startup never restores data on its own, and never touches the service.
      expect(backend.calls.filter((call) => /^(removeService|createService|execInServiceFromFile|execInService):/.test(call))).toEqual([])
      // The declared service's volume is retained; nothing about the crash makes it collectable.
      const report = await second.orch.reconcileVolumes()
      expect(report.volumes.find((volume) => volume.name === svcVolume(ROOM_ID, 'postgres'))).toMatchObject({
        class: 'retained-active',
        safeToDelete: false
      })
      await expect(second.orch.undoChange(ROOM_ID, entry!.id, 'user')).rejects.toThrow(/is failed and cannot be undone/)

      // Idempotent: a third start finds nothing pending and changes nothing.
      backend.calls.length = 0
      const third = boot(world)
      await third.orch.init()
      expect(third.orch.changes.list(ROOM_ID)).toEqual([entry])
      expect(existsSync(backupFile)).toBe(true)
      expect(third.orch.rooms.get(ROOM_ID)?.services.postgres).toEqual({ version: '17' })
      expect(backend.calls.filter((call) => /^(removeService|createService|execInServiceFromFile|execInService):/.test(call))).toEqual([])
    })
  })

  describe('delete / tombstone', () => {
    function roomDir(userData: string): string {
      return join(userData, 'rooms', ROOM_ID)
    }

    it('finishes a deletion interrupted before the engine removed the pod, and a later start finds nothing', async () => {
      const world = await durableWorld()
      const { backend, userData } = world
      const first = boot(world)
      first.orch.rooms.create(hotelRoom())
      mkdirSync(roomDir(userData), { recursive: true })
      writeFileSync(join(roomDir(userData), 'manifest.json'), '{}')
      await first.orch.init()
      // The pod is the engine's; the row is ours. Crash while the engine is
      // still working on the pod.
      backend.managedContainers = [
        { roomId: ROOM_ID, role: 'anchor', state: 'exited', name: `dh-${ROOM_ID}-anchor` },
        { roomId: ROOM_ID, role: 'web', state: 'exited', name: `dh-${ROOM_ID}-web` }
      ]
      backend.managedNetworks = [{ roomId: ROOM_ID, name: `dh-${ROOM_ID}-net` }]
      backend.deleteRoomPod = () => new Promise<never>(() => undefined)
      const abandoned = first.orch.deleteRoom(ROOM_ID, 'user')
      abandoned.catch(() => undefined)
      await until(() => first.orch.rooms.get(ROOM_ID)?.status === 'deleting', { what: 'the durable deleting tombstone' })
      // ── crash ──
      delete (backend as Partial<FakeBackend>).deleteRoomPod
      backend.calls.length = 0

      const second = boot(world)
      const { reconciled } = await second.orch.init()

      expect(reconciled?.roomsDeleted).toEqual([ROOM_ID])
      expect(backend.calls).toContain(`deleteRoomPod:${ROOM_ID}`)
      expect(second.orch.rooms.get(ROOM_ID)).toBeNull()
      expect(existsSync(roomDir(userData))).toBe(false)
      expect([...second.gateway.routes.values()].some((route) => route.roomId === ROOM_ID)).toBe(false)
      // The tombstone was authoritative: nothing tried to wake or keep the Room.
      expect(backend.calls.filter((call) => call.startsWith('resumeRoomPod:') || call.startsWith('startRoomPod:'))).toEqual([])

      backend.calls.length = 0
      const third = boot(world)
      const again = await third.orch.init()
      expect(again.reconciled?.roomsDeleted).toBeUndefined()
      expect(backend.calls.filter((call) => call.startsWith('deleteRoomPod:'))).toEqual([])
      expect(third.orch.rooms.list()).toEqual([])
    })

    it('finishes a deletion interrupted after the pod was gone but before the row was dropped', async () => {
      const world = await durableWorld()
      const { backend, userData } = world
      const first = boot(world)
      first.orch.rooms.create(hotelRoom())
      mkdirSync(roomDir(userData), { recursive: true })
      writeFileSync(join(roomDir(userData), 'manifest.json'), '{}')
      await first.orch.init()
      // The engine finished; the process died before the row went away.
      const deleteRoomPod = backend.deleteRoomPod.bind(backend)
      backend.deleteRoomPod = async (roomId: string) => {
        await deleteRoomPod(roomId)
        return new Promise<never>(() => undefined)
      }
      const abandoned = first.orch.deleteRoom(ROOM_ID, 'user')
      abandoned.catch(() => undefined)
      await until(() => backend.calls.includes(`deleteRoomPod:${ROOM_ID}`), { what: 'the pod to be deleted' })
      expect(first.orch.rooms.get(ROOM_ID)?.status).toBe('deleting')
      // ── crash ──
      delete (backend as Partial<FakeBackend>).deleteRoomPod
      backend.managedContainers = []
      backend.managedNetworks = []
      backend.calls.length = 0

      const second = boot(world)
      const { reconciled } = await second.orch.init()

      expect(reconciled?.roomsDeleted).toEqual([ROOM_ID])
      expect(second.orch.rooms.get(ROOM_ID)).toBeNull()
      expect(existsSync(roomDir(userData))).toBe(false)
      // Volumes that name the dead Room are now provably orphaned: no row, no directory.
      backend.managedVolumes = [managedVolume(srcVolume(ROOM_ID))]
      const report = await second.orch.reconcileVolumes()
      expect(report.volumes[0]).toMatchObject({ class: 'orphaned-deleted-room', safeToDelete: true })

      const third = boot(world)
      const again = await third.orch.init()
      expect(again.reconciled?.roomsDeleted).toBeUndefined()
      expect(third.orch.rooms.list()).toEqual([])
    })

    it('keeps the tombstone when the engine refuses at startup, blocks wake, and completes on the next start', async () => {
      const world = await durableWorld()
      const { backend, userData } = world
      const first = boot(world)
      first.orch.rooms.create(hotelRoom())
      mkdirSync(roomDir(userData), { recursive: true })
      writeFileSync(join(roomDir(userData), 'manifest.json'), '{}')
      await first.orch.init()
      backend.deleteRoomPod = () => new Promise<never>(() => undefined)
      const abandoned = first.orch.deleteRoom(ROOM_ID, 'user')
      abandoned.catch(() => undefined)
      await until(() => first.orch.rooms.get(ROOM_ID)?.status === 'deleting', { what: 'the durable deleting tombstone' })
      // ── crash ── and the engine is unwell when the next process starts.
      backend.deleteRoomPod = async () => {
        throw new Error('volume is in use: another container still references it')
      }
      backend.calls.length = 0

      const second = boot(world)
      const { reconciled } = await second.orch.init()

      expect(reconciled?.roomsDeleted).toBeUndefined()
      expect(second.orch.rooms.get(ROOM_ID)?.status).toBe('deleting')
      expect(existsSync(roomDir(userData))).toBe(true)
      expect(reconciled?.plan?.actions).toContainEqual(expect.objectContaining({ kind: 'resume-delete', target: ROOM_ID }))
      // The tombstone still gates every lifecycle entry point in this process.
      expect(() => second.orch.startRoomOperation(ROOM_ID, 'agent')).toThrow(/being deleted/)
      expect(() => second.orch.applyChange(ROOM_ID, { kind: 'deps-install', clean: false }, 'user')).toThrow(/being deleted and cannot be modified/)
      // The volume is not collectable while the row exists: the Room is not gone, it is deleting.
      backend.managedVolumes = [managedVolume(srcVolume(ROOM_ID))]
      expect((await second.orch.reconcileVolumes()).volumes[0]?.safeToDelete).toBe(false)

      // The engine recovers; the next start completes what the tombstone recorded.
      delete (backend as Partial<FakeBackend>).deleteRoomPod
      backend.calls.length = 0
      const third = boot(world)
      const finished = await third.orch.init()
      expect(finished.reconciled?.roomsDeleted).toEqual([ROOM_ID])
      expect(third.orch.rooms.get(ROOM_ID)).toBeNull()
      expect(existsSync(roomDir(userData))).toBe(false)

      const fourth = boot(world)
      expect((await fourth.orch.init()).reconciled?.roomsDeleted).toBeUndefined()
      expect(fourth.orch.rooms.list()).toEqual([])
    })
  })
})
