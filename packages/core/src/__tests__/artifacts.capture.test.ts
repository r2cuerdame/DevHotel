import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { RoomOrchestrator } from '../orchestrator'
import type { Db } from '../store/db'
import { FakeAdbHost, FakeBackend, FakeGateway, makeRoom, tempDir, testDb } from './fakes'
import { screenshotPng } from './pngFixture'

describe('Android screenshot artifact capture', () => {
  const roots: string[] = []
  const dbs: Db[] = []

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function setup() {
    const userData = tempDir()
    roots.push(userData)
    const db = testDb()
    dbs.push(db)
    const backend = new FakeBackend()
    backend.emulatorStateValue = 'running'
    const adb = new FakeAdbHost([
      { serial: 'R5CT30ABCDE', state: 'device', model: 'SM_G991N', release: '14', sdk: '34' }
    ])
    const orch = new RoomOrchestrator({
      userData,
      db,
      backend,
      gateway: new FakeGateway().asGateway(),
      adb,
      appVersion: 'test'
    })
    orch.rooms.create(
      makeRoom({
        id: 'aaaa1111',
        provider: 'android',
        sourceType: 'managed-git',
        sourceRef: 'https://example.invalid/app.git',
        workspaceMode: 'hotel',
        syncStatus: 'synced',
        stateRevision: 7,
        workspaceVolumeRevision: 3,
        runtime: { kind: 'jdk', version: '17' },
        packageManager: { kind: 'gradle' },
        status: 'ready'
      })
    )
    return { userData, db, backend, adb, orch }
  }

  function emulatorStatus(backend: FakeBackend, png: Buffer) {
    backend.execInRoomHandler = (_roomId, cmd) => {
      if (cmd[0] === 'sh' && cmd.at(-1)?.includes('screencap')) {
        return { code: 0, stdout: png.toString('base64'), stderr: '' }
      }
      if (cmd[4] === 'pm' && cmd[5] === 'path') {
        return { code: 0, stdout: 'package:/data/app/base.apk\n', stderr: '' }
      }
      if (cmd[4] === 'sha256sum') {
        return { code: 0, stdout: `${'a'.repeat(64)}  /data/app/base.apk\n`, stderr: '' }
      }
      if (cmd[4] === 'sh' && cmd.at(-1)?.includes('dumpsys window')) {
        return { code: 0, stdout: 'mCurrentFocus=Window{1 u0 com.example.app/.MainActivity}\n', stderr: '' }
      }
      if (cmd[4] === 'getprop') return { code: 0, stdout: 'ko_KR\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
  }

  it('persists a named PNG with exact tracked app/build and Room metadata', async () => {
    const { backend, orch } = setup()
    const png = screenshotPng(3, 2, { text: 'Bearer must-not-survive' })
    emulatorStatus(backend, png)
    const changeId = '11111111-2222-4333-8444-555555555555'
    orch.androidInstalls.record({
      roomId: 'aaaa1111',
      target: { kind: 'emulator', targetId: 'aaaa1111', deviceId: null },
      applicationId: 'com.example.app',
      changeId,
      apkSha256: 'a'.repeat(64),
      installedAt: '2026-08-30T00:00:00.000Z'
    })

    const artifact = await orch.captureAndroidScreenshotArtifact(
      'aaaa1111',
      { filename: 'login-success.png' },
      'agent'
    )

    expect(artifact).toMatchObject({
      roomId: 'aaaa1111',
      filename: 'login-success.png',
      actor: 'agent',
      metadata: {
        room: { id: 'aaaa1111', stateRevision: 7, workspaceVolumeRevision: 3 },
        capture: { source: 'adb', width: 3, height: 2, orientation: 'landscape' },
        device: { kind: 'emulator', deviceId: null, apiLevel: 34 },
        app: { status: 'tracked-active', packageName: 'com.example.app' },
        locale: { tag: 'ko-KR', scope: 'system' },
        build: {
          exact: true,
          changeId,
          apkSha256: 'a'.repeat(64),
          installedAt: '2026-08-30T00:00:00.000Z'
        }
      }
    })
    const stored = orch.readRoomArtifactContent('aaaa1111', artifact.id).content
    expect(stored.toString('utf8')).not.toContain('must-not-survive')
    expect(JSON.stringify(artifact)).not.toMatch(/serial|leaseId|R5CT30ABCDE/)
  })

  it('validates Room-scoped associations before touching the target', async () => {
    const { backend, adb, orch } = setup()

    await expect(
      orch.captureAndroidScreenshotArtifact(
        'aaaa1111',
        {
          filename: 'wrong-association.png',
          association: { changeId: '11111111-2222-4333-8444-555555555555' }
        },
        'agent'
      )
    ).rejects.toMatchObject({ code: 'ARTIFACT_ASSOCIATION_NOT_FOUND' })
    expect(backend.execInRoomCalls).toEqual([])
    expect(adb.execs).toEqual([])
    expect(orch.listRoomArtifacts('aaaa1111')).toEqual([])
  })

  it('aborts publication when a physical lease is replaced after capture', async () => {
    const { adb, orch } = setup()
    await orch.refreshAndroidDevices()
    const attached = await orch.attachAndroidDevice('aaaa1111', {
      purpose: 'acceptance',
      workerId: 'worker-a'
    })
    if (attached.state !== 'granted') throw new Error('unreachable')
    orch.androidInstalls.record({
      roomId: 'aaaa1111',
      target: {
        kind: 'physical',
        targetId: attached.device.id,
        deviceId: attached.device.id,
        leaseId: attached.lease.id
      },
      applicationId: 'com.example.app',
      changeId: '11111111-2222-4333-8444-555555555555',
      apkSha256: 'b'.repeat(64),
      installedAt: '2026-08-30T00:00:00.000Z'
    })
    const png = screenshotPng()
    adb.execBinaryResultFor = async (_serial, args) => {
      if (args[0] !== 'exec-out') return null
      await orch.devices.release(attached.lease.id, 'replace during screenshot')
      const next = await orch.devices.requestDevice({
        roomId: 'aaaa1111',
        project: 'demo',
        purpose: 'acceptance',
        workerId: 'worker-b',
        constraints: { deviceId: attached.device.id }
      })
      expect(next.state).toBe('granted')
      return { code: 0, stdout: png, stderr: '', outputLimitExceeded: false }
    }

    await expect(
      orch.captureAndroidScreenshotArtifact('aaaa1111', { filename: 'lease-race.png' }, 'agent')
    ).rejects.toMatchObject({ code: 'lease-expired' })
    expect(orch.listRoomArtifacts('aaaa1111')).toEqual([])
  })

  it('records screen-mode capture against the Room emulator even with a phone attached', async () => {
    const { backend, adb, orch } = setup()
    await orch.refreshAndroidDevices()
    await orch.attachAndroidDevice('aaaa1111', { purpose: 'acceptance', workerId: 'worker-a' })
    adb.execs = []
    const png = screenshotPng(2, 4)
    backend.emulatorScreenPng = png.toString('base64')
    backend.execInRoomHandler = (_roomId, cmd) => {
      if (cmd[4] === 'sh' && cmd.at(-1)?.includes('dumpsys window')) return { code: 0, stdout: '', stderr: '' }
      if (cmd[4] === 'getprop') return { code: 0, stdout: 'en-US\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }

    const artifact = await orch.captureAndroidScreenshotArtifact(
      'aaaa1111',
      { filename: 'secure-screen.png', mode: 'screen' },
      'agent'
    )

    expect(artifact.metadata).toMatchObject({
      capture: { source: 'screen', width: 2, height: 4 },
      device: { kind: 'emulator', deviceId: null }
    })
    expect(adb.execs).toEqual([])
  })
})
