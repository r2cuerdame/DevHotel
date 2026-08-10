import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { RoomOrchestrator } from '../orchestrator'
import type { Db } from '../store/db'
import { FakeBackend, FakeGateway, makeRoom, tempDir, testDb } from './fakes'

describe('Android build-only lifecycle', () => {
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

  it('creates a standalone Room with no relay, emulator, preview route, or KVM dependency', async () => {
    const { backend, gateway, orch } = setup()
    backend.createEmulator = async () => {
      throw new Error('NO_KVM')
    }
    backend.removeEmulator = async () => {
      throw new Error('emulator lifecycle must not be touched')
    }

    const room = await orch.createRoom({
      provider: 'android',
      sourceType: 'empty',
      sourceRef: '',
      project: 'android-demo',
      nickname: 'dev',
      actor: 'user'
    })

    expect(room).toMatchObject({ provider: 'android', status: 'ready', hostPort: null })
    expect(backend.lastWebSpec).toMatchObject({ standalone: true, workspaceMode: 'empty' })
    expect(backend.calls).not.toContain(expect.stringContaining('recreateAnchor'))
    expect(backend.calls).not.toContain(expect.stringContaining('createEmulator'))
    expect(gateway.status().routes).toEqual([])
    expect(orch.inspectRoom(room.id).urls.app).toBe('about:blank')
  })

  it('wakes a legacy Android record as build-only without touching retained emulator data', async () => {
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
      hostPort: 45123,
      android: { device: 'Samsung Galaxy S10', version: '14.0' }
    })
    orch.rooms.create(room)
    await gateway.setRoute({ domain: room.domain, roomId: room.id, targetPort: 45123, https: false })
    backend.recreateAnchor = async () => {
      throw new Error('build-only wake must not recreate an anchor')
    }
    backend.createEmulator = async () => {
      throw new Error('NO_KVM')
    }
    backend.removeEmulator = async () => {
      throw new Error('retained emulator container/data must not be removed on wake')
    }

    await orch.startRoom(room.id, 'user')

    expect(orch.rooms.get(room.id)).toMatchObject({ status: 'ready', hostPort: null })
    expect(backend.lastWebSpec?.standalone).toBe(true)
    expect(backend.calls.some((call) => call.startsWith('recreateWeb:'))).toBe(true)
    expect(gateway.status().routes).toEqual([])

    const callsAfterWake = [...backend.calls]
    await orch.startRoom(room.id, 'user')
    expect(backend.calls).toEqual(callsAfterWake)
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
