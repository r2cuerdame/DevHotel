import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RoomOrchestrator } from '../orchestrator'
import type { ClientBrowserLaunchRequest, ClientBrowserRuntime, LaunchedClientBrowser } from '../browser/runtime'
import { depsGenKey } from '../changes/definitions/deps'
import type { Db } from '../store/db'
import { FakeAdbHost, FakeBackend, FakeGateway, listeningPort, makeRoom, tempDir, testDb } from './fakes'

class FakeResetBrowserRuntime implements ClientBrowserRuntime {
  readonly kind = 'fake'
  readonly stopped: string[] = []
  private nextPid = 7000

  async availability() {
    return { available: true, detail: 'fake' }
  }

  async launch(request: ClientBrowserLaunchRequest): Promise<LaunchedClientBrowser> {
    const pid = this.nextPid++
    return {
      pid,
      browserKind: 'chromium',
      devtoolsHost: '127.0.0.1',
      devtoolsPort: 40_000 + pid,
      cdpWsUrl: `ws://127.0.0.1:${40_000 + pid}/devtools/browser/fake-${request.sessionId}`,
      stop: async () => {
        this.stopped.push(request.sessionId)
      }
    }
  }

  async probe() {
    return { processAlive: true, cdpReachable: false, cdpWsUrl: null, browserVersion: null }
  }

  async stopOrphan() {
    return true
  }
}

describe('Room reset', () => {
  const dirs: string[] = []
  const dbs: Db[] = []
  let backend: FakeBackend
  let orch: RoomOrchestrator
  let cleared: string[]
  // verifyWebUp probes the relay for real, so the Room needs a live port
  let webPort: { port: number; close: () => void }

  beforeEach(async () => {
    webPort = await listeningPort()
    const userData = tempDir()
    dirs.push(userData)
    const db = testDb()
    dbs.push(db)
    backend = new FakeBackend()
    cleared = []
    orch = new RoomOrchestrator({
      userData,
      backend,
      gateway: new FakeGateway().asGateway(),
      db,
      appVersion: 'test',
      clearBrowserData: async (roomId) => {
        cleared.push(roomId)
      }
    })
  })

  afterEach(() => {
    webPort.close()
    for (const db of dbs.splice(0)) db.close()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function room(overrides = {}) {
    const record = makeRoom({
      sourceType: 'managed-git',
      sourceRef: 'https://example.test/repo.git',
      workspaceMode: 'hotel',
      syncStatus: 'synced',
      services: { postgres: { version: '17' }, redis: { version: '8' } },
      status: 'ready',
      hostPort: webPort.port,
      thumbPath: 'C:\\thumb.png',
      ...overrides
    })
    orch.rooms.create(record)
    // an awake Room with its apps up: the safety dump needs them running
    backend.serviceStates.set('postgres', 'running')
    backend.serviceStates.set('redis', 'running')
    return record
  }

  it('rebuilds what the Room can rebuild and keeps its identity', async () => {
    const before = room()

    const entry = await orch.applyChange(
      before.id,
      { kind: 'room-reset', reinstallDependencies: true, clearCaches: true, services: 'empty', clearBrowserData: true },
      'user'
    )

    expect(entry.status).toBe('verified')
    // safety dump before any data is destroyed, then fresh empty services
    expect(backend.calls).toContain('execInServiceToFile:postgres:pg_dump')
    const backupAt = backend.calls.findIndex((c) => c.startsWith('execInServiceToFile:postgres'))
    const removeAt = backend.calls.indexOf('removeService:postgres:with-volume')
    expect(backupAt).toBeLessThan(removeAt)
    expect(backend.calls).toContain('createService:postgres:17')
    // the cache volume stays mounted by the web container, so it is emptied in
    // place — removing it would be refused and abort the reset half-done
    expect(backend.calls).toContain('clearVolumeContents:dh-room1abc-cache')
    expect(backend.calls).not.toContain('resetVolume:dh-room1abc-cache')
    // dependencies come back as a NEW generation; the live volume is never wiped
    expect(orch.settings.get(depsGenKey(before.id, '22'))).toBe('1')
    expect(backend.calls.some((c) => c.startsWith('runOneShot:dh-room1abc-deps-node22-g1:'))).toBe(true)
    expect(cleared).toEqual([before.id])

    const after = orch.rooms.get(before.id)!
    expect(after).toMatchObject({
      id: before.id,
      roomNumber: before.roomNumber,
      nickname: before.nickname,
      domain: before.domain,
      startCommand: before.startCommand,
      sourceRef: before.sourceRef,
      services: { postgres: { version: '17' }, redis: { version: '8' } },
      thumbPath: null
    })
  })

  it('takes the apps out when asked, and never claims an undo it cannot honour', async () => {
    const record = room()
    const entry = await orch.applyChange(
      record.id,
      { kind: 'room-reset', reinstallDependencies: false, clearCaches: false, services: 'remove', clearBrowserData: false },
      'user'
    )

    expect(entry.undoable).toBe(false)
    expect(orch.rooms.get(record.id)?.services).toEqual({})
    expect(backend.calls).toContain('removeService:redis:with-volume')
    expect(backend.calls.some((c) => c.startsWith('createService:'))).toBe(false)
  })

  it('refuses an empty selection, a legacy Host-bound Room, and app data while asleep', async () => {
    const record = room()
    await expect(
      orch.applyChange(
        record.id,
        { kind: 'room-reset', reinstallDependencies: false, clearCaches: false, services: 'keep', clearBrowserData: false },
        'user'
      )
    ).rejects.toThrow(/at least one/)

    orch.rooms.update(record.id, { status: 'sleeping', hostPort: null })
    await expect(
      orch.applyChange(
        record.id,
        { kind: 'room-reset', reinstallDependencies: false, clearCaches: false, services: 'empty', clearBrowserData: false },
        'user'
      )
    ).rejects.toThrow(/Start the room and its postgres app/)

    // Android Rooms mount no dependency layer: an install would land in the
    // user's source tree, so it is refused rather than silently misdirected
    orch.rooms.update(record.id, { status: 'ready', hostPort: webPort.port, provider: 'android' })
    await expect(
      orch.applyChange(
        record.id,
        { kind: 'room-reset', reinstallDependencies: true, clearCaches: false, services: 'keep', clearBrowserData: false },
        'user'
      )
    ).rejects.toThrow(/no dependency layer/)

    orch.rooms.update(record.id, { provider: 'web', workspaceMode: 'legacy-host-bind' })
    await expect(
      orch.applyChange(
        record.id,
        { kind: 'room-reset', reinstallDependencies: false, clearCaches: true, services: 'keep', clearBrowserData: false },
        'user'
      )
    ).rejects.toThrow(/legacy Host-bound/)
    expect(backend.calls.some((c) => c.startsWith('removeService:'))).toBe(false)
  })

  it('stops active Client Browsers and removes the Room’s persistent profile when clearBrowserData is selected without touching other Rooms', async () => {
    const userData = tempDir()
    dirs.push(userData)
    const db = testDb()
    dbs.push(db)
    const browserRuntime = new FakeResetBrowserRuntime()
    const headlessOrch = new RoomOrchestrator({
      userData,
      backend,
      gateway: new FakeGateway().asGateway(),
      db,
      appVersion: 'test',
      adb: new FakeAdbHost([]),
      clientBrowserRuntime: browserRuntime
    })
    await headlessOrch.init()
    try {
      const roomA = makeRoom({
        id: 'resetbr1',
        nickname: 'a',
        domain: 'a.localhost',
        sourceType: 'managed-git',
        sourceRef: 'https://example.test/repo.git',
        workspaceMode: 'hotel',
        syncStatus: 'synced',
        services: {},
        status: 'ready',
        hostPort: webPort.port
      })
      const roomB = makeRoom({
        id: 'resetbr2',
        nickname: 'b',
        domain: 'b.localhost',
        roomNumber: 202,
        sourceType: 'managed-git',
        sourceRef: 'https://example.test/repo.git',
        workspaceMode: 'hotel',
        syncStatus: 'synced',
        services: {},
        status: 'ready',
        hostPort: webPort.port
      })
      headlessOrch.rooms.create(roomA)
      headlessOrch.rooms.create(roomB)

      const aPersistent = await headlessOrch.clientBrowsers.allocate(roomA.id, { profileMode: 'persistent' })
      const aEphemeral = await headlessOrch.clientBrowsers.allocate(roomA.id, { profileMode: 'ephemeral' })
      const bPersistent = await headlessOrch.clientBrowsers.allocate(roomB.id, { profileMode: 'persistent' })

      const aProfileFile = join(userData, 'client-browsers', 'persistent', roomA.id, 'cookies.json')
      const bProfileFile = join(userData, 'client-browsers', 'persistent', roomB.id, 'cookies.json')
      writeFileSync(aProfileFile, '{"room":"a"}')
      writeFileSync(bProfileFile, '{"room":"b"}')

      // Resetting caches without clearBrowserData leaves Client Browsers and persistent profiles intact.
      const keepBrowserEntry = await headlessOrch.applyChange(
        roomA.id,
        { kind: 'room-reset', reinstallDependencies: false, clearCaches: true, services: 'keep', clearBrowserData: false },
        'user'
      )
      expect(keepBrowserEntry.status).toBe('verified')
      expect(headlessOrch.clientBrowsers.listForRoom(roomA.id).map((s) => s.id)).toEqual([aPersistent.session.id, aEphemeral.session.id])
      expect(existsSync(aProfileFile)).toBe(true)

      // Resetting with clearBrowserData stops Room A's Client Browsers and deletes its persistent profile, leaving Room B untouched.
      const clearBrowserEntry = await headlessOrch.applyChange(
        roomA.id,
        { kind: 'room-reset', reinstallDependencies: false, clearCaches: false, services: 'keep', clearBrowserData: true },
        'user'
      )
      expect(clearBrowserEntry.status).toBe('verified')
      expect(browserRuntime.stopped).toContain(aPersistent.session.id)
      expect(browserRuntime.stopped).toContain(aEphemeral.session.id)
      expect(headlessOrch.clientBrowsers.listForRoom(roomA.id)).toEqual([])
      expect(existsSync(join(userData, 'client-browsers', 'persistent', roomA.id))).toBe(false)

      expect(browserRuntime.stopped).not.toContain(bPersistent.session.id)
      expect(headlessOrch.clientBrowsers.listForRoom(roomB.id).map((s) => s.id)).toEqual([bPersistent.session.id])
      expect(existsSync(bProfileFile)).toBe(true)
    } finally {
      await headlessOrch.shutdown().catch(() => undefined)
    }
  })
})
