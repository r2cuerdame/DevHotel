import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { AndroidScreenshotArtifactMetadata } from '@devhotel/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { RoomArtifactPublicationError } from '../backend/types'
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
      app: { status: 'tracked-active', packageName: 'com.example.app' },
      locale: { tag: 'en-US', scope: 'system' },
      build: {
        exact: true,
        changeId: '11111111-2222-4333-8444-555555555555',
        apkSha256: 'a'.repeat(64),
        installedAt: '2026-08-30T00:00:00.000Z'
      },
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
    let privateStage = ''
    backend.publishRoomArtifactHandler = (input) => {
      privateStage = input.hostPngPath
      expect(backend.webPausedValue).toBe(true)
      expect(readFileSync(input.hostPngPath)).toEqual(orch.readRoomArtifactContent('aaaa1111', artifact.id).content)
      expect(input.expected).toEqual({ sizeBytes: artifact.sizeBytes, sha256: artifact.sha256 })
    }

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
    expect(backend.publishRoomArtifactCalls).toHaveLength(1)
    expect(backend.publishRoomArtifactCalls[0]).toMatchObject({
      roomId: 'aaaa1111',
      workspaceVolumeRevision: 2,
      relativePath: 'docs/evidence/login-success.png',
      stageToken: expect.stringMatching(/^[a-f0-9]{32}$/)
    })
    const pauseAt = backend.calls.indexOf('pauseWeb:aaaa1111')
    const publishAt = backend.calls.indexOf('publishRoomArtifact:aaaa1111:r2:docs/evidence/login-success.png')
    const unpauseAt = backend.calls.indexOf('unpauseWeb:aaaa1111')
    expect(pauseAt).toBeGreaterThanOrEqual(0)
    expect(publishAt).toBeGreaterThan(pauseAt)
    expect(unpauseAt).toBeGreaterThan(publishAt)
    expect(backend.execInRoomCalls).toEqual([])
    expect(backend.calls.some((call) => call.startsWith('copyIntoRoom:'))).toBe(false)
    expect(orch.rooms.get('aaaa1111')).toMatchObject({ stateRevision: 5, syncStatus: 'modified' })
    expect(orch.settings.get('artifactExportPending:aaaa1111')).toBeNull()
    expect(privateStage).not.toBe('')
    expect(existsSync(privateStage)).toBe(false)
    const tmp = join(userData, 'tmp')
    expect(existsSync(tmp) ? readdirSync(tmp) : []).toEqual([])
  })

  it('does not overwrite or mark the workspace modified when exact publication reports an existing destination', async () => {
    const { backend, orch } = setup()
    const artifact = publish(orch)
    backend.publishRoomArtifactHandler = () => {
      throw new RoomArtifactPublicationError('destination-exists', 'private helper detail')
    }

    await expect(
      orch.exportRoomArtifact('aaaa1111', artifact.id, { relativePath: 'docs/existing.png' }, 'agent')
    ).rejects.toMatchObject({ code: 'ARTIFACT_DESTINATION_EXISTS' })
    expect(orch.rooms.get('aaaa1111')).toMatchObject({ stateRevision: 4, syncStatus: expect.not.stringMatching(/^modified$/) })
    expect(orch.settings.get('artifactExportPending:aaaa1111')).toBeNull()
    expect(backend.calls).toContain('unpauseWeb:aaaa1111')
    expect(backend.webPausedValue).toBe(false)
    expect(backend.execInRoomCalls).toEqual([])
  })

  it('maps an unsafe atomic-publication parent without exposing helper diagnostics', async () => {
    const { backend, orch } = setup()
    const artifact = publish(orch)
    const privateDetail = 'unsafe parent /private/host/should-not-leak'
    backend.publishRoomArtifactHandler = () => {
      throw new RoomArtifactPublicationError('unsafe-parent', privateDetail)
    }

    let captured: unknown
    await orch.exportRoomArtifact(
      'aaaa1111', artifact.id, { relativePath: 'docs/unsafe.png' }, 'agent'
    ).catch((error: unknown) => { captured = error })
    expect(captured).toMatchObject({
      code: 'ARTIFACT_EXPORT_UNSAFE_PATH',
      message: 'Artifact export path contains an unsafe directory or value.'
    })
    expect(JSON.stringify(captured)).not.toContain(privateDetail)
    expect(orch.rooms.get('aaaa1111')).toMatchObject({ stateRevision: 4, syncStatus: expect.not.stringMatching(/^modified$/) })
  })

  it('recovers an applied-but-rejected pause without publishing or changing revision', async () => {
    const { backend, orch } = setup()
    const artifact = publish(orch)
    backend.pauseWeb = async (roomId) => {
      backend.calls.push(`pauseWeb:${roomId}`)
      backend.webPausedValue = true
      backend.webRunningUnpausedValue = false
      throw new Error('pause response was lost after apply')
    }

    await expect(
      orch.exportRoomArtifact('aaaa1111', artifact.id, { relativePath: 'docs/pause-race.png' }, 'agent')
    ).rejects.toMatchObject({ code: 'ARTIFACT_EXPORT_FENCE_CHANGED' })
    expect(backend.publishRoomArtifactCalls).toEqual([])
    expect(backend.calls).toContain('unpauseWeb:aaaa1111')
    expect(backend.webPausedValue).toBe(false)
    expect(orch.rooms.get('aaaa1111')).toMatchObject({ stateRevision: 4, status: 'ready' })
  })

  it('restores the runtime and withholds revision after helper or cleanup failure', async () => {
    const { backend, orch } = setup()
    const artifact = publish(orch)
    backend.publishRoomArtifactHandler = () => {
      throw new RoomArtifactPublicationError('helper-failed', 'private helper cleanup failed')
    }

    await expect(
      orch.exportRoomArtifact('aaaa1111', artifact.id, { relativePath: 'docs/helper-failed.png' }, 'agent')
    ).rejects.toMatchObject({ code: 'ARTIFACT_EXPORT_FAILED' })
    expect(backend.calls).toContain('unpauseWeb:aaaa1111')
    expect(backend.webPausedValue).toBe(false)
    expect(orch.rooms.get('aaaa1111')).toMatchObject({ stateRevision: 4, status: 'ready' })
  })

  it('keeps an ambiguous publication paused and atomically invalidates the Room fence', async () => {
    const { backend, orch } = setup()
    const artifact = publish(orch)
    backend.publishRoomArtifactHandler = () => {
      throw new RoomArtifactPublicationError('publication-ambiguous', 'private helper identity withheld')
    }

    let captured: unknown
    await orch.exportRoomArtifact(
      'aaaa1111', artifact.id, { relativePath: 'docs/ambiguous.png' }, 'agent'
    ).catch((error: unknown) => { captured = error })
    expect(captured).toMatchObject({
      code: 'ARTIFACT_EXPORT_PUBLICATION_AMBIGUOUS',
      evidence: { committed: null, retrySafe: false, relativePath: 'docs/ambiguous.png' }
    })
    expect(JSON.stringify(captured)).not.toContain('private helper identity withheld')
    expect(backend.calls).not.toContain('unpauseWeb:aaaa1111')
    expect(backend.calls.some((call) => call.startsWith('recreateWeb:'))).toBe(false)
    expect(backend.webPausedValue).toBe(true)
    expect(orch.rooms.get('aaaa1111')).toMatchObject({
      stateRevision: 5,
      syncStatus: 'modified',
      status: 'broken'
    })
    expect(orch.settings.get('artifactExportPending:aaaa1111')).not.toBeNull()
  })

  it('settles and fences a durable interrupted publication during startup', async () => {
    const { backend, orch } = setup()
    const pending = {
      version: 1,
      workspaceVolumeRevision: 2,
      relativePath: 'docs/interrupted.png',
      expected: { sizeBytes: 123, sha256: 'a'.repeat(64) },
      stageToken: 'b'.repeat(32)
    }
    orch.settings.set('artifactExportPending:aaaa1111', JSON.stringify(pending))
    backend.reconcileRoomArtifactPublicationHandler = () => 'committed'

    await orch.init()

    expect(backend.reconcileRoomArtifactPublicationCalls).toEqual([{
      roomId: 'aaaa1111',
      workspaceVolumeRevision: 2,
      relativePath: 'docs/interrupted.png',
      expected: pending.expected,
      stageToken: pending.stageToken
    }])
    expect(backend.calls.indexOf('stopRoomPod:aaaa1111')).toBeLessThan(
      backend.calls.indexOf('reconcileRoomArtifactPublication:aaaa1111:r2:docs/interrupted.png')
    )
    expect(orch.rooms.get('aaaa1111')).toMatchObject({
      stateRevision: 5,
      syncStatus: 'modified',
      status: 'broken',
      hostPort: null
    })
    expect(orch.settings.get('artifactExportPending:aaaa1111')).toBeNull()
  })

  it('keeps an unsettled startup intent while fencing the Room', async () => {
    const { backend, orch } = setup()
    const key = 'artifactExportPending:aaaa1111'
    orch.settings.set(key, JSON.stringify({
      version: 1,
      workspaceVolumeRevision: 2,
      relativePath: 'docs/unsettled.png',
      expected: { sizeBytes: 123, sha256: 'a'.repeat(64) },
      stageToken: 'b'.repeat(32)
    }))
    backend.reconcileRoomArtifactPublicationHandler = () => 'incomplete'

    await orch.init()

    expect(orch.rooms.get('aaaa1111')).toMatchObject({ stateRevision: 5, status: 'broken' })
    expect(orch.settings.get(key)).not.toBeNull()
  })

  it('returns success after an unpause failure is recovered by one exact web recreation', async () => {
    const { backend, orch } = setup()
    const artifact = publish(orch)
    backend.unpauseWeb = async (roomId) => {
      backend.calls.push(`unpauseWeb:${roomId}`)
      throw new Error('ambiguous unpause response')
    }
    backend.recreateWeb = async (spec) => {
      backend.calls.push(`recreateWeb:${spec.roomId}:node${spec.nodeMajor}:${spec.depsVolumeOverride ?? 'default'}`)
      backend.webPausedValue = false
      backend.webRunningUnpausedValue = true
    }

    await expect(
      orch.exportRoomArtifact('aaaa1111', artifact.id, { relativePath: 'docs/recovered.png' }, 'agent')
    ).resolves.toMatchObject({ relativePath: 'docs/recovered.png' })
    expect(backend.calls.filter((call) => call.startsWith('recreateWeb:'))).toHaveLength(1)
    expect(orch.rooms.get('aaaa1111')).toMatchObject({ stateRevision: 5, status: 'ready' })
  })

  it('does not mistake an exited unpaused web container for runtime recovery', async () => {
    const { backend, orch } = setup()
    const artifact = publish(orch)
    backend.pauseWeb = async (roomId) => {
      backend.calls.push(`pauseWeb:${roomId}`)
      backend.webPausedValue = false
      backend.webRunningUnpausedValue = false
      throw new Error('web exited while pause response was ambiguous')
    }
    backend.unpauseWeb = async (roomId) => {
      backend.calls.push(`unpauseWeb:${roomId}`)
      throw new Error('exited web cannot be unpaused')
    }
    backend.recreateWeb = async (spec) => {
      backend.calls.push(`recreateWeb:${spec.roomId}:node${spec.nodeMajor}:${spec.depsVolumeOverride ?? 'default'}`)
      backend.webRunningUnpausedValue = true
    }

    await expect(
      orch.exportRoomArtifact('aaaa1111', artifact.id, { relativePath: 'docs/exited-web.png' }, 'agent')
    ).rejects.toMatchObject({ code: 'ARTIFACT_EXPORT_FENCE_CHANGED' })
    expect(backend.publishRoomArtifactCalls).toEqual([])
    expect(backend.calls.filter((call) => call.startsWith('recreateWeb:'))).toHaveLength(1)
    expect(orch.rooms.get('aaaa1111')).toMatchObject({ stateRevision: 4, status: 'ready' })
  })

  it('records a committed mutation before marking a doubly failed runtime recovery broken', async () => {
    const { backend, orch } = setup()
    const artifact = publish(orch)
    backend.unpauseWeb = async (roomId) => {
      backend.calls.push(`unpauseWeb:${roomId}`)
      throw new Error('unpause failed')
    }
    backend.recreateWeb = async (spec) => {
      backend.calls.push(`recreateWeb:${spec.roomId}:node${spec.nodeMajor}:${spec.depsVolumeOverride ?? 'default'}`)
      throw new Error('recreate failed')
    }

    await expect(
      orch.exportRoomArtifact('aaaa1111', artifact.id, { relativePath: 'docs/committed.png' }, 'agent')
    ).rejects.toMatchObject({
      code: 'ARTIFACT_EXPORT_COMMITTED_RUNTIME_FAILED',
      evidence: { committed: true, retrySafe: false, relativePath: 'docs/committed.png' }
    })
    expect(orch.rooms.get('aaaa1111')).toMatchObject({ stateRevision: 5, syncStatus: 'modified', status: 'broken' })
  })

  it('marks the Room broken when publication commits but its revision update fails', async () => {
    const { backend, orch } = setup()
    const artifact = publish(orch)
    const update = orch.rooms.update.bind(orch.rooms)
    let revisionWrites = 0
    orch.rooms.update = (roomId, patch) => {
      if (patch.stateRevision !== undefined && revisionWrites++ === 0) {
        throw new Error('workspace revision storage failed')
      }
      update(roomId, patch)
    }

    await expect(
      orch.exportRoomArtifact('aaaa1111', artifact.id, { relativePath: 'docs/revision-failed.png' }, 'agent')
    ).rejects.toMatchObject({
      code: 'ARTIFACT_EXPORT_COMMITTED_CLEANUP_FAILED',
      evidence: { committed: true, retrySafe: false, relativePath: 'docs/revision-failed.png' }
    })
    expect(orch.rooms.get('aaaa1111')).toMatchObject({ stateRevision: 5, syncStatus: 'modified', status: 'broken' })
    expect(backend.calls).not.toContain('unpauseWeb:aaaa1111')
    expect(backend.calls.some((call) => call.startsWith('recreateWeb:'))).toBe(false)
    expect(backend.webPausedValue).toBe(true)
  })

  it('preserves both state-write failures when publication cannot persist either fence', async () => {
    const { backend, orch } = setup()
    const artifact = publish(orch)
    orch.rooms.update = () => { throw new Error('Room database writes unavailable') }

    let captured: unknown
    await orch.exportRoomArtifact(
      'aaaa1111', artifact.id, { relativePath: 'docs/state-unavailable.png' }, 'agent'
    ).catch((error: unknown) => { captured = error })
    expect(captured).toMatchObject({
      code: 'ARTIFACT_EXPORT_COMMITTED_CLEANUP_FAILED',
      evidence: { committed: true, retrySafe: false, relativePath: 'docs/state-unavailable.png' }
    })
    const committedError = captured as Error & { cause?: AggregateError }
    const outer = committedError.cause
    expect(outer).toBeInstanceOf(AggregateError)
    expect(outer?.errors[0]).toBeInstanceOf(AggregateError)
    expect((outer?.errors[0] as AggregateError).errors).toHaveLength(2)
    expect(backend.calls).not.toContain('unpauseWeb:aaaa1111')
    expect(backend.calls.some((call) => call.startsWith('recreateWeb:'))).toBe(false)
    expect(backend.webPausedValue).toBe(true)
  })

  it('refuses legacy Host-bound workspaces before staging any bytes', async () => {
    const { backend, orch } = setup('legacy-host-bind')
    const artifact = publish(orch)

    await expect(
      orch.exportRoomArtifact('aaaa1111', artifact.id, { relativePath: 'docs/shot.png' }, 'agent')
    ).rejects.toMatchObject({ code: 'ARTIFACT_EXPORT_NOT_ALLOWED' })
    expect(backend.publishRoomArtifactCalls).toEqual([])
    expect(backend.calls).not.toContain('pauseWeb:aaaa1111')
  })

  it('removes artifact receipts and content with the owning Room', async () => {
    const { userData, orch } = setup()
    const artifact = publish(orch)
    const artifactDirectory = join(userData, 'rooms', 'aaaa1111', 'artifacts', 'screenshots', artifact.id)
    expect(existsSync(artifactDirectory)).toBe(true)

    await orch.deleteRoom('aaaa1111', 'user')

    expect(existsSync(artifactDirectory)).toBe(false)
    expect(orch.artifacts.get('aaaa1111', artifact.id)).toBeNull()
  })
})
