import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
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
    const gateway = new FakeGateway()
    const orch = new RoomOrchestrator({
      userData,
      db,
      backend,
      gateway: gateway.asGateway(),
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
    return { userData, backend, gateway, orch }
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

  function observeContainment({ backend, gateway, orch }: ReturnType<typeof setup>) {
    const events: string[] = []
    let managedContainerLists = 0
    const removeRoute = gateway.removeRoute.bind(gateway)
    gateway.removeRoute = (domain) => {
      events.push('route')
      removeRoute(domain)
    }
    const detach = orch.logs.detach.bind(orch.logs)
    orch.logs.detach = (roomId) => {
      events.push('logs')
      detach(roomId)
    }
    const update = orch.rooms.update.bind(orch.rooms)
    orch.rooms.update = (roomId, patch) => {
      if (patch.status === 'broken' && patch.hostPort === null) events.push('state')
      update(roomId, patch)
    }
    const listManagedContainers = backend.listManagedContainers.bind(backend)
    backend.listManagedContainers = async () => {
      managedContainerLists += 1
      return listManagedContainers()
    }
    return {
      events,
      managedContainerListCount: () => managedContainerLists
    }
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

  it('never overwrites a recovery intent claimed after the Room lock was admitted', async () => {
    const { backend, orch } = setup()
    const artifact = publish(orch)
    const key = 'artifactExportPending:aaaa1111'
    const priorOwner = JSON.stringify({ version: 'external-owner' })
    const claim = orch.settings.setIfAbsent.bind(orch.settings)
    orch.settings.setIfAbsent = (settingKey, value) => {
      orch.settings.set(key, priorOwner)
      return claim(settingKey, value)
    }

    await expect(
      orch.exportRoomArtifact('aaaa1111', artifact.id, { relativePath: 'docs/cas-race.png' }, 'agent')
    ).rejects.toMatchObject({ code: 'ARTIFACT_EXPORT_RECOVERY_REQUIRED' })

    expect(orch.settings.get(key)).toBe(priorOwner)
    expect(backend.publishRoomArtifactCalls).toEqual([])
    expect(backend.calls).not.toContain('pauseWeb:aaaa1111')
    expect(backend.calls).not.toContain('unpauseWeb:aaaa1111')
    expect(backend.calls.some((call) => call.startsWith('recreateWeb:'))).toBe(false)
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

  it('removes ingress and stops an ambiguous replacement runtime before returning', async () => {
    const { backend, gateway, orch } = setup()
    const artifact = publish(orch)
    const room = orch.rooms.get('aaaa1111')!
    await gateway.setRoute({ domain: room.domain, roomId: room.id, targetPort: 4321, https: false })
    let replacementWasRunning = false
    backend.publishRoomArtifactHandler = () => {
      replacementWasRunning = true
      backend.webPausedValue = false
      backend.webRunningUnpausedValue = true
      backend.managedContainers = [{
        roomId: 'aaaa1111',
        role: 'job',
        state: 'exited',
        name: 'dh-aaaa1111-job-11111111-2222-4333-8444-555555555555'
      }]
      throw new RoomArtifactPublicationError('publication-ambiguous', 'private helper identity withheld')
    }
    backend.stopRoomPod = async (roomId) => {
      backend.calls.push(`stopRoomPod:${roomId}`)
      backend.webRunningUnpausedValue = false
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
    expect(backend.calls).toContain('stopRoomPod:aaaa1111')
    expect(backend.calls).toContain(
      'removeManagedContainer:dh-aaaa1111-job-11111111-2222-4333-8444-555555555555'
    )
    expect(backend.managedContainers).toEqual([])
    expect(gateway.routes.has(room.domain)).toBe(false)
    expect(replacementWasRunning).toBe(true)
    expect(backend.webRunningUnpausedValue).toBe(false)
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
    backend.managedContainers = [{
      roomId: 'aaaa1111',
      role: 'job',
      state: 'created',
      name: 'dh-aaaa1111-job-stale-artifact-helper'
    }]
    backend.reconcileRoomArtifactPublicationHandler = () => 'committed'

    await orch.init()

    expect(backend.reconcileRoomArtifactPublicationCalls).toEqual([{
      roomId: 'aaaa1111',
      workspaceVolumeRevision: 2,
      relativePath: 'docs/interrupted.png',
      expected: pending.expected,
      stageToken: pending.stageToken
    }])
    const removeAt = backend.calls.indexOf('removeManagedContainer:dh-aaaa1111-job-stale-artifact-helper')
    const stopAt = backend.calls.indexOf('stopRoomPod:aaaa1111')
    const finalizeAt = backend.calls.indexOf(
      'reconcileRoomArtifactPublication:aaaa1111:r2:docs/interrupted.png'
    )
    expect(removeAt).toBeGreaterThanOrEqual(0)
    expect(stopAt).toBeGreaterThan(removeAt)
    expect(finalizeAt).toBeGreaterThan(stopAt)
    expect(orch.rooms.get('aaaa1111')).toMatchObject({
      stateRevision: 5,
      syncStatus: 'modified',
      status: 'broken',
      hostPort: null
    })
    expect(orch.settings.get('artifactExportPending:aaaa1111')).toBeNull()
  })

  it('retains the hard recovery gate when stale helper removal cannot be proven', async () => {
    const { backend, orch } = setup()
    const key = 'artifactExportPending:aaaa1111'
    const raw = JSON.stringify({
      version: 1,
      workspaceVolumeRevision: 2,
      relativePath: 'docs/removal-unproven.png',
      expected: { sizeBytes: 123, sha256: 'a'.repeat(64) },
      stageToken: 'b'.repeat(32)
    })
    orch.settings.set(key, raw)
    backend.managedContainers = [{
      roomId: 'aaaa1111',
      role: 'job',
      state: 'created',
      name: 'dh-aaaa1111-job-stale-artifact-helper'
    }]
    backend.removeManagedContainer = async (name) => {
      backend.calls.push(`removeManagedContainer:${name}`)
      throw new Error('exact helper removal could not be proved')
    }

    await expect(orch.init()).rejects.toThrow('exact helper removal could not be proved')

    expect(backend.calls).toContain('removeManagedContainer:dh-aaaa1111-job-stale-artifact-helper')
    expect(backend.reconcileRoomArtifactPublicationCalls).toEqual([])
    expect(orch.settings.get(key)).toBe(raw)
    expect(orch.rooms.get('aaaa1111')).toMatchObject({ status: 'broken', hostPort: null })
    expect(() => orch.startRoomOperation('aaaa1111', 'agent')).toThrowError(
      expect.objectContaining({ code: 'ARTIFACT_EXPORT_RECOVERY_REQUIRED' })
    )
  })

  it('retains startup recovery ownership when a committed finalizer cannot settle', async () => {
    const { backend, orch } = setup()
    const key = 'artifactExportPending:aaaa1111'
    const raw = JSON.stringify({
      version: 1,
      workspaceVolumeRevision: 2,
      relativePath: 'docs/finalizer-retained.png',
      expected: { sizeBytes: 123, sha256: 'a'.repeat(64) },
      stageToken: 'b'.repeat(32)
    })
    orch.settings.set(key, raw)
    backend.reconcileRoomArtifactPublicationHandler = () => {
      throw new RoomArtifactPublicationError(
        'publication-ambiguous',
        'private retained finalizer identity'
      )
    }

    await orch.init()

    expect(backend.reconcileRoomArtifactPublicationCalls).toHaveLength(1)
    expect(orch.settings.get(key)).toBe(raw)
    expect(orch.rooms.get('aaaa1111')).toMatchObject({ status: 'broken', hostPort: null })
    expect(() => orch.startRoomOperation('aaaa1111', 'agent')).toThrowError(
      expect.objectContaining({ code: 'ARTIFACT_EXPORT_RECOVERY_REQUIRED' })
    )
  })

  it('treats an exactly rolled-back unsafe parent as a terminal startup outcome', async () => {
    const { backend, orch } = setup()
    const key = 'artifactExportPending:aaaa1111'
    orch.settings.set(key, JSON.stringify({
      version: 1,
      workspaceVolumeRevision: 2,
      relativePath: 'docs/unsafe-parent.png',
      expected: { sizeBytes: 123, sha256: 'a'.repeat(64) },
      stageToken: 'b'.repeat(32)
    }))
    backend.reconcileRoomArtifactPublicationHandler = () => 'unsafe-parent'

    await orch.init()

    expect(orch.settings.get(key)).toBeNull()
    expect(orch.rooms.get('aaaa1111')).toMatchObject({ stateRevision: 5, status: 'broken' })
  })

  it('reclaims only exact stale private PNG staging after stale jobs are absent', async () => {
    const { userData, orch } = setup()
    const temporaryRoot = join(userData, 'tmp')
    mkdirSync(temporaryRoot, { recursive: true })
    const stale = mkdtempSync(join(temporaryRoot, 'artifact-export-'))
    writeFileSync(join(stale, 'content.png'), screenshotPng())
    const unexpected = mkdtempSync(join(temporaryRoot, 'artifact-export-'))
    writeFileSync(join(unexpected, 'do-not-delete.txt'), 'private unrelated data')

    await orch.init()

    expect(existsSync(stale)).toBe(false)
    expect(readFileSync(join(unexpected, 'do-not-delete.txt'), 'utf8')).toBe('private unrelated data')
  })

  it('reclaims an exact quarantine left by a crash without recursive deletion', async () => {
    const { userData, orch } = setup()
    const temporaryRoot = join(userData, 'tmp')
    mkdirSync(temporaryRoot, { recursive: true })
    const quarantine = join(temporaryRoot, `.artifact-export-cleanup-${'a'.repeat(32)}`)
    mkdirSync(quarantine)
    writeFileSync(join(quarantine, 'content.png'), screenshotPng())

    await orch.init()

    expect(existsSync(quarantine)).toBe(false)
    expect(readdirSync(temporaryRoot)).toEqual([])
  })

  it('rejects a linked temporary root before staging and preserves outside files', async () => {
    const { backend, orch, userData } = setup()
    const artifact = publish(orch)
    const outside = tempDir()
    roots.push(outside)
    writeFileSync(join(outside, 'sentinel.txt'), 'keep')
    symlinkSync(outside, join(userData, 'tmp'), 'junction')

    await expect(
      orch.exportRoomArtifact('aaaa1111', artifact.id, { relativePath: 'docs/rejected.png' }, 'agent')
    ).rejects.toMatchObject({ code: 'ARTIFACT_EXPORT_FAILED' })

    expect(readFileSync(join(outside, 'sentinel.txt'), 'utf8')).toBe('keep')
    expect(readdirSync(outside)).toEqual(['sentinel.txt'])
    expect(backend.calls).not.toContain('pauseWeb:aaaa1111')
  })

  it('settles and fences before every unrelated fallible startup stage', async () => {
    for (const stage of ['gateway', 'health', 'reconcile'] as const) {
      const { backend, gateway, orch } = setup()
      const key = 'artifactExportPending:aaaa1111'
      const pending = {
        version: 1,
        workspaceVolumeRevision: 2,
        relativePath: `docs/interrupted-before-${stage}.png`,
        expected: { sizeBytes: 123, sha256: 'a'.repeat(64) },
        stageToken: 'b'.repeat(32)
      }
      orch.settings.set(key, JSON.stringify(pending))
      backend.reconcileRoomArtifactPublicationHandler = () => 'committed'
      const failureCall = `startup-failure:${stage}`
      if (stage === 'gateway') {
        gateway.start = async () => {
          backend.calls.push(failureCall)
          throw new Error(failureCall)
        }
      } else if (stage === 'health') {
        backend.health = async () => {
          backend.calls.push(failureCall)
          throw new Error(failureCall)
        }
      } else {
        backend.listManagedNetworks = async () => {
          backend.calls.push(failureCall)
          throw new Error(failureCall)
        }
      }

      await expect(orch.init()).rejects.toThrow(failureCall)

      const stopCall = backend.calls.indexOf('stopRoomPod:aaaa1111')
      const recoveryCall = backend.calls.indexOf(
        `reconcileRoomArtifactPublication:aaaa1111:r2:${pending.relativePath}`
      )
      expect(stopCall).toBeGreaterThanOrEqual(0)
      expect(recoveryCall).toBeGreaterThan(stopCall)
      expect(backend.calls.indexOf(failureCall)).toBeGreaterThan(recoveryCall)
      expect(orch.rooms.get('aaaa1111')).toMatchObject({
        stateRevision: 5,
        syncStatus: 'modified',
        status: 'broken',
        hostPort: null
      })
      expect(orch.settings.get(key)).toBeNull()
    }
  })

  it('keeps an unsettled startup intent while fencing the Room', async () => {
    const { backend, orch } = setup()
    const key = 'artifactExportPending:aaaa1111'
    const raw = JSON.stringify({
      version: 1,
      workspaceVolumeRevision: 2,
      relativePath: 'docs/unsettled.png',
      expected: { sizeBytes: 123, sha256: 'a'.repeat(64) },
      stageToken: 'b'.repeat(32)
    })
    orch.settings.set(key, raw)
    backend.reconcileRoomArtifactPublicationHandler = () => 'incomplete'

    await orch.init()

    expect(orch.rooms.get('aaaa1111')).toMatchObject({ stateRevision: 5, status: 'broken' })
    expect(orch.settings.get(key)).toBe(raw)
    expect(() => orch.startRoomOperation('aaaa1111', 'agent')).toThrowError(
      expect.objectContaining({ code: 'ARTIFACT_EXPORT_RECOVERY_REQUIRED' })
    )
    await expect(
      orch.exportRoomArtifact('aaaa1111', '11111111-2222-4333-8444-555555555555', { relativePath: 'docs/new.png' }, 'agent')
    ).rejects.toMatchObject({ code: 'ARTIFACT_EXPORT_RECOVERY_REQUIRED' })
    await expect(orch.components('aaaa1111')).rejects.toMatchObject({ code: 'ARTIFACT_EXPORT_RECOVERY_REQUIRED' })
    await expect(orch.pullRoomFile('aaaa1111', '/workspace/README.md')).rejects.toMatchObject({
      code: 'ARTIFACT_EXPORT_RECOVERY_REQUIRED'
    })
    expect(orch.settings.get(key)).toBe(raw)
    await expect(orch.sleepRoom('aaaa1111', 'user')).resolves.toBeUndefined()
    expect(orch.rooms.get('aaaa1111')).toMatchObject({ status: 'broken', hostPort: null })
    expect(orch.settings.get(key)).toBe(raw)
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
    expect(orch.rooms.get('aaaa1111')).toMatchObject({
      stateRevision: 6,
      syncStatus: 'modified',
      status: 'broken',
      hostPort: null
    })
    expect(backend.calls).toContain('stopRoomPod:aaaa1111')
  })

  it('contains a committed runtime when recovery-intent release is rejected or fails', async () => {
    for (const mode of ['ownership-changed', 'storage-error'] as const) {
      const context = setup()
      const { backend, gateway, orch } = context
      const artifact = publish(orch)
      const key = 'artifactExportPending:aaaa1111'
      const replacement = JSON.stringify({ version: 'external-owner' })
      const room = orch.rooms.get('aaaa1111')!
      orch.rooms.update(room.id, { hostPort: 4321 })
      await gateway.setRoute({ domain: room.domain, roomId: room.id, targetPort: 4321, https: false })
      const containment = observeContainment(context)
      let ownedValue = ''
      const deleteIfValue = orch.settings.deleteIfValue.bind(orch.settings)
      orch.settings.deleteIfValue = (settingKey, value) => {
        if (settingKey !== key) return deleteIfValue(settingKey, value)
        ownedValue = value
        if (mode === 'ownership-changed') {
          orch.settings.set(key, replacement)
          return false
        }
        throw new Error('settings CAS unavailable after publication')
      }
      backend.publishRoomArtifactHandler = () => {
        backend.managedContainers = [{
          roomId: 'aaaa1111',
          role: 'job',
          state: 'exited',
          name: 'dh-aaaa1111-job-11111111-2222-4333-8444-666666666666'
        }]
      }
      let actualRuntimeRunning = false
      backend.unpauseWeb = async (roomId) => {
        backend.calls.push(`unpauseWeb:${roomId}`)
        actualRuntimeRunning = true
        backend.webPausedValue = false
        backend.webRunningUnpausedValue = true
      }
      backend.stopRoomPod = async (roomId) => {
        containment.events.push('stop')
        backend.calls.push(`stopRoomPod:${roomId}`)
        actualRuntimeRunning = false
        backend.webRunningUnpausedValue = false
      }

      await expect(
        orch.exportRoomArtifact(
          'aaaa1111',
          artifact.id,
          { relativePath: `docs/intent-${mode}.png` },
          'agent'
        )
      ).rejects.toMatchObject({
        code: 'ARTIFACT_EXPORT_COMMITTED_CLEANUP_FAILED',
        evidence: { committed: true, retrySafe: false, relativePath: `docs/intent-${mode}.png` }
      })

      expect(ownedValue).not.toBe('')
      expect(orch.settings.get(key)).toBe(mode === 'ownership-changed' ? replacement : ownedValue)
      expect(gateway.routes.has(room.domain)).toBe(false)
      expect(containment.events.slice(0, 4)).toEqual(['route', 'logs', 'state', 'stop'])
      expect(containment.managedContainerListCount()).toBe(2)
      expect(backend.calls).toContain('stopRoomPod:aaaa1111')
      expect(backend.calls).toContain(
        'removeManagedContainer:dh-aaaa1111-job-11111111-2222-4333-8444-666666666666'
      )
      expect(backend.managedContainers).toEqual([])
      expect(backend.calls).toContain('unpauseWeb:aaaa1111')
      expect(backend.calls.some((call) => call.startsWith('recreateWeb:'))).toBe(false)
      expect(actualRuntimeRunning).toBe(false)
      expect(orch.rooms.get('aaaa1111')).toMatchObject({
        stateRevision: 6,
        syncStatus: 'modified',
        status: 'broken',
        hostPort: null
      })
    }
  })

  it('contains an applied replacement when final runtime recovery proof is unavailable', async () => {
    const context = setup()
    const { backend, gateway, orch } = context
    const artifact = publish(orch)
    const key = 'artifactExportPending:aaaa1111'
    const room = orch.rooms.get('aaaa1111')!
    orch.rooms.update(room.id, { hostPort: 4321 })
    await gateway.setRoute({ domain: room.domain, roomId: room.id, targetPort: 4321, https: false })
    const containment = observeContainment(context)
    let probes = 0
    let actualRuntimeRunning = false
    backend.webRunningUnpaused = async (roomId) => {
      backend.calls.push(`webRunningUnpaused:${roomId}`)
      probes += 1
      if (probes === 1) return false
      throw new Error('final exact runtime probe unavailable')
    }
    backend.unpauseWeb = async (roomId) => {
      backend.calls.push(`unpauseWeb:${roomId}`)
      actualRuntimeRunning = true
      backend.webPausedValue = false
      backend.webRunningUnpausedValue = true
      throw new Error('unpause response was lost after apply')
    }
    backend.recreateWeb = async (spec) => {
      backend.calls.push(`recreateWeb:${spec.roomId}:node${spec.nodeMajor}:${spec.depsVolumeOverride ?? 'default'}`)
      actualRuntimeRunning = true
      backend.webPausedValue = false
      backend.webRunningUnpausedValue = true
      backend.managedContainers = [{
        roomId: 'aaaa1111',
        role: 'job',
        state: 'created',
        name: 'dh-aaaa1111-job-11111111-2222-4333-8444-777777777777'
      }]
      throw new Error('recreate response was lost after apply')
    }
    backend.stopRoomPod = async (roomId) => {
      containment.events.push('stop')
      backend.calls.push(`stopRoomPod:${roomId}`)
      actualRuntimeRunning = false
      backend.webRunningUnpausedValue = false
    }

    await expect(
      orch.exportRoomArtifact('aaaa1111', artifact.id, { relativePath: 'docs/recovery-unproven.png' }, 'agent')
    ).rejects.toMatchObject({
      code: 'ARTIFACT_EXPORT_COMMITTED_RUNTIME_FAILED',
      evidence: { committed: true, retrySafe: false, relativePath: 'docs/recovery-unproven.png' }
    })

    expect(probes).toBe(2)
    expect(actualRuntimeRunning).toBe(false)
    expect(orch.settings.get(key)).not.toBeNull()
    expect(() => orch.startRoomOperation('aaaa1111', 'agent')).toThrowError(
      expect.objectContaining({ code: 'ARTIFACT_EXPORT_RECOVERY_REQUIRED' })
    )
    expect(gateway.routes.has(room.domain)).toBe(false)
    expect(containment.events.slice(0, 4)).toEqual(['route', 'logs', 'state', 'stop'])
    expect(containment.managedContainerListCount()).toBe(2)
    expect(backend.calls).toContain('stopRoomPod:aaaa1111')
    expect(backend.calls).toContain(
      'removeManagedContainer:dh-aaaa1111-job-11111111-2222-4333-8444-777777777777'
    )
    expect(backend.managedContainers).toEqual([])
    expect(backend.webRunningUnpausedValue).toBe(false)
    expect(orch.rooms.get('aaaa1111')).toMatchObject({
      stateRevision: 6,
      syncStatus: 'modified',
      status: 'broken',
      hostPort: null
    })
  })

  it('retains the hard recovery gate when runtime containment cannot persist its database fence', async () => {
    const { backend, gateway, orch } = setup()
    const artifact = publish(orch)
    const key = 'artifactExportPending:aaaa1111'
    const room = orch.rooms.get('aaaa1111')!
    orch.rooms.update(room.id, { hostPort: 4321 })
    await gateway.setRoute({ domain: room.domain, roomId: room.id, targetPort: 4321, https: false })
    const update = orch.rooms.update.bind(orch.rooms)
    orch.rooms.update = (roomId, patch) => {
      if (patch.status === 'broken') throw new Error('containment database fence unavailable')
      update(roomId, patch)
    }
    backend.webRunningUnpaused = async (roomId) => {
      backend.calls.push(`webRunningUnpaused:${roomId}`)
      return false
    }
    backend.unpauseWeb = async (roomId) => {
      backend.calls.push(`unpauseWeb:${roomId}`)
      throw new Error('unpause failed')
    }
    backend.recreateWeb = async (spec) => {
      backend.calls.push(`recreateWeb:${spec.roomId}:node${spec.nodeMajor}:${spec.depsVolumeOverride ?? 'default'}`)
      throw new Error('recreate failed')
    }

    await expect(
      orch.exportRoomArtifact('aaaa1111', artifact.id, { relativePath: 'docs/fence-retained.png' }, 'agent')
    ).rejects.toMatchObject({ code: 'ARTIFACT_EXPORT_COMMITTED_RUNTIME_FAILED' })

    expect(orch.settings.get(key)).not.toBeNull()
    expect(() => orch.startRoomOperation('aaaa1111', 'agent')).toThrowError(
      expect.objectContaining({ code: 'ARTIFACT_EXPORT_RECOVERY_REQUIRED' })
    )
    expect(gateway.routes.has(room.domain)).toBe(false)
    expect(backend.calls).toContain('stopRoomPod:aaaa1111')
    expect(orch.rooms.get('aaaa1111')).toMatchObject({
      stateRevision: 5,
      syncStatus: 'modified',
      status: 'ready',
      hostPort: 4321
    })
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
    expect(outer?.errors).toHaveLength(2)
    expect(outer?.errors.map((error) => (error as Error).message)).toEqual([
      'Room database writes unavailable',
      'Room database writes unavailable'
    ])
    expect(backend.calls).not.toContain('unpauseWeb:aaaa1111')
    expect(backend.calls.some((call) => call.startsWith('recreateWeb:'))).toBe(false)
    expect(backend.calls).toContain('stopRoomPod:aaaa1111')
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
