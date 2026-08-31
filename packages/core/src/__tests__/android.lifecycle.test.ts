import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { RoomOrchestrator } from '../orchestrator'
import type { Db } from '../store/db'
import { FakeBackend, FakeGateway, makeRoom, tempDir, testDb } from './fakes'

describe('Android room lifecycle', () => {
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
    const gateway = new FakeGateway()
    const orch = new RoomOrchestrator({ userData, backend, gateway: gateway.asGateway(), db, appVersion: 'test' })
    return { backend, gateway, orch }
  }

  it('creates a served Room whose site is the relayed emulator screen', async () => {
    const { backend, gateway, orch } = setup()

    const room = await orch.createRoom({
      provider: 'android',
      sourceType: 'empty',
      sourceRef: '',
      project: 'android-demo',
      nickname: 'dev',
      actor: 'user'
    })

    expect(room).toMatchObject({ provider: 'android', status: 'ready', hostPort: backend.hostPort })
    expect(backend.lastWebSpec).toMatchObject({ workspaceMode: 'empty', internalPort: 6080 })
    expect(backend.lastWebSpec?.standalone).toBeUndefined()
    expect(backend.calls.some((call) => call.startsWith('createEmulator:'))).toBe(true)
    expect(gateway.status().routes).toEqual([{ domain: room.domain, roomId: room.id, https: false }])
    expect(orch.inspectRoom(room.id).urls.app).toContain('/vnc.html?autoconnect=true')
  })

  it('wakes an Android record with a fresh anchor and a fresh emulator in its netns', async () => {
    const { backend, gateway, orch } = setup()
    const room = makeRoom({
      provider: 'android',
      sourceType: 'empty',
      sourceRef: '',
      workspaceMode: 'empty',
      syncStatus: 'empty',
      runtime: { kind: 'jdk', version: '17' },
      packageManager: { kind: 'gradle' },
      startCommand: 'gradle assembleDebug --no-daemon',
      internalPort: 6080,
      status: 'sleeping',
      hostPort: null,
      android: { device: 'Pixel 6', version: '15.0' }
    })
    orch.rooms.create(room)
    orch.androidInstalls.record({
      roomId: room.id,
      target: { kind: 'emulator', targetId: room.id, deviceId: null },
      applicationId: 'com.example.old',
      changeId: '11111111-2222-4333-8444-555555555555',
      apkSha256: 'a'.repeat(64),
      installedAt: '2026-08-31T00:00:00.000Z',
      packageIncarnation: '0'.repeat(64),
      logFence: null,
      installUserId: 0
    })

    await orch.startRoom(room.id, 'user')

    expect(orch.rooms.get(room.id)).toMatchObject({ status: 'ready', hostPort: backend.hostPort })
    const anchorAt = backend.calls.indexOf(`recreateAnchor:${room.id}:6080`)
    const createAt = backend.calls.indexOf(`createEmulator:${room.id}:Pixel 6:15.0`)
    expect(anchorAt).toBeGreaterThanOrEqual(0)
    expect(createAt).toBeGreaterThan(anchorAt)
    expect(backend.calls.some((call) => call.startsWith('recreateWeb:'))).toBe(true)
    expect(backend.calls.some((call) => call.startsWith('createService:'))).toBe(false)
    expect(orch.androidInstalls.list(room.id, {
      kind: 'emulator', targetId: room.id, deviceId: null
    })).toEqual([])
    expect(gateway.status().routes).toEqual([{ domain: room.domain, roomId: room.id, https: false }])

    const callsAfterWake = [...backend.calls]
    await orch.startRoom(room.id, 'user')
    expect(backend.calls).toEqual(callsAfterWake)
  })

  it('keeps the room usable for builds when the emulator cannot start (no KVM / pull failure)', async () => {
    const { backend, orch } = setup()
    backend.createEmulator = async () => {
      throw new Error('NO_KVM: /dev/kvm cannot be found')
    }

    const room = await orch.createRoom({
      provider: 'android',
      sourceType: 'empty',
      sourceRef: '',
      project: 'android-nokvm',
      nickname: 'dev',
      actor: 'user'
    })

    expect(room.status).toBe('ready')
    expect(backend.calls.some((call) => call.startsWith('recreateWeb:') || call.startsWith('createRoomPod:'))).toBe(true)

    await orch.sleepRoom(room.id, 'user')
    await orch.startRoom(room.id, 'user')
    expect(orch.rooms.get(room.id)!.status).toBe('ready')
  })

  it('records an immutable APK build without marking the live working state as changed', async () => {
    const { backend, orch } = setup()
    const room = makeRoom({
      provider: 'android',
      sourceType: 'managed-git',
      sourceRef: 'https://example.test/android.git',
      workspaceMode: 'hotel',
      stateRevision: 12,
      workspaceVolumeRevision: 2,
      syncStatus: 'synced',
      runtime: { kind: 'jdk', version: '17' },
      packageManager: { kind: 'gradle' },
      startCommand: './gradlew assembleDebug --no-daemon',
      hostPort: null
    })
    backend.workspaceFingerprintValue = 'd'.repeat(64)
    orch.rooms.create(room)

    const entry = await orch.applyChange(room.id, { kind: 'android-build' }, 'agent')

    expect(entry.status).toBe('verified')
    expect(orch.rooms.get(room.id)).toMatchObject({
      stateRevision: 12,
      workspaceVolumeRevision: 2,
      syncStatus: 'synced'
    })
    expect(backend.lastWebSpec?.workspaceVolumeOverride).toContain(`src-build-${entry.id.replaceAll('-', '')}`)
  })
})
