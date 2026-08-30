import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { AndroidScreenshotArtifactMetadata } from '@devhotel/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { RoomOrchestrator } from '../orchestrator'
import type { Db } from '../store/db'
import { FakeAdbHost, FakeBackend, FakeGateway, makeRoom, tempDir, testDb } from './fakes'
import { screenshotPng } from './pngFixture'

describe('Room screenshot artifact export', () => {
  const roots: string[] = []
  const dbs: Db[] = []

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function setup(workspaceMode: 'hotel' | 'legacy-host-bind' = 'hotel') {
    const userData = tempDir()
    roots.push(userData)
    const db = testDb()
    dbs.push(db)
    const backend = new FakeBackend()
    const orch = new RoomOrchestrator({
      userData,
      db,
      backend,
      gateway: new FakeGateway().asGateway(),
      adb: new FakeAdbHost(),
      appVersion: 'test'
    })
    orch.rooms.create(
      makeRoom({
        id: 'aaaa1111',
        provider: 'android',
        sourceType: workspaceMode === 'hotel' ? 'managed-git' : 'linked-folder',
        sourceRef: workspaceMode === 'hotel' ? 'https://example.invalid/app.git' : 'C:\\private\\app',
        workspaceMode,
        status: 'ready',
        stateRevision: 4,
        workspaceVolumeRevision: 2
      })
    )
    return { userData, backend, orch }
  }

  function publish(orch: RoomOrchestrator) {
    const metadata: AndroidScreenshotArtifactMetadata = {
      schema: 1,
      room: { id: 'aaaa1111', stateRevision: 4, workspaceVolumeRevision: 2 },
      capture: {
        source: 'adb',
        capturedAt: '2026-08-31T00:00:00.000Z',
        width: 2,
        height: 3,
        orientation: 'portrait'
      },
      device: { kind: 'emulator', deviceId: null, model: 'Pixel 8', androidVersion: '15', apiLevel: 35 },
      app: { status: 'untracked-or-none', packageName: null },
      locale: { tag: 'en-US', scope: 'system' },
      build: { exact: false, changeId: null, apkSha256: null, installedAt: null },
      association: { changeId: null, runId: null }
    }
    return orch.artifacts.publishScreenshot({
      roomId: 'aaaa1111',
      filename: 'login-success.png',
      png: screenshotPng(),
      actor: 'agent',
      createdAt: metadata.capture.capturedAt,
      metadata
    })
  }

  it('publishes a new repo-relative PNG and returns GitHub Markdown', async () => {
    const { backend, orch, userData } = setup()
    const artifact = publish(orch)

    const result = await orch.exportRoomArtifact(
      'aaaa1111',
      artifact.id,
      { relativePath: 'docs/evidence/login-success.png' },
      'agent'
    )

    expect(result).toMatchObject({
      artifactId: artifact.id,
      path: '/workspace/docs/evidence/login-success.png',
      markdown: '![login-success.png](docs/evidence/login-success.png)',
      sha256: artifact.sha256
    })
    expect(backend.execInRoomCalls.map(({ cmd }) => cmd)).toEqual(
      expect.arrayContaining([
        ['mkdir', '-p', '/workspace/docs/evidence'],
        expect.arrayContaining(['ln', expect.stringMatching(/^\/workspace\/\.devhotel-artifact-/), '/workspace/docs/evidence/login-success.png'])
      ])
    )
    expect(orch.rooms.get('aaaa1111')).toMatchObject({ stateRevision: 5, syncStatus: 'modified' })
    const tmp = join(userData, 'tmp')
    expect(existsSync(tmp) ? readdirSync(tmp) : []).toEqual([])
  })

  it('does not overwrite or mark the workspace modified when publication fails', async () => {
    const { backend, orch } = setup()
    const artifact = publish(orch)
    backend.execInRoomHandler = (_roomId, cmd) =>
      cmd[0] === 'ln' ? { code: 1, stdout: '', stderr: 'File exists' } : { code: 0, stdout: '', stderr: '' }

    await expect(
      orch.exportRoomArtifact('aaaa1111', artifact.id, { relativePath: 'existing.png' }, 'agent')
    ).rejects.toMatchObject({ code: 'ARTIFACT_DESTINATION_EXISTS' })
    expect(orch.rooms.get('aaaa1111')).toMatchObject({ stateRevision: 4, syncStatus: expect.not.stringMatching(/^modified$/) })
    expect(backend.execInRoomCalls.map(({ cmd }) => cmd[0])).toEqual(expect.arrayContaining(['rm', 'rmdir']))
  })

  it('refuses legacy Host-bound workspaces before staging any bytes', async () => {
    const { backend, orch } = setup('legacy-host-bind')
    const artifact = publish(orch)

    await expect(
      orch.exportRoomArtifact('aaaa1111', artifact.id, { relativePath: 'docs/shot.png' }, 'agent')
    ).rejects.toMatchObject({ code: 'ARTIFACT_EXPORT_NOT_ALLOWED' })
    expect(backend.execInRoomCalls).toEqual([])
    expect(backend.calls.some((call) => call.startsWith('copyIntoRoom:'))).toBe(false)
  })
})
