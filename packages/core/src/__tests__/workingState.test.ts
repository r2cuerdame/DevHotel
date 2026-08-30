import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { srcVolume } from '../backend/naming'
import { depsGenKey, depsGenMaxKey, depsVolumeForGen } from '../changes/definitions/deps'
import { RoomOrchestrator } from '../orchestrator'
import { retainedWorkspaceGenKey, workspaceSyncBaseKey } from '../workingState'
import { serializeWorkspaceSnapshot, WorkspaceDriftError } from '../workspaceDrift'
import { buildDiagnostic } from '../diagnostics/bundle'
import type { Db } from '../store/db'
import { FakeBackend, FakeGateway, listeningPort, makeRoom, tempDir, testDb } from './fakes'
import { workspaceGenMaxKey } from '../workingState'

describe('Room-owned working state', () => {
  let db: Db
  let userData: string
  let sourceDir: string
  let backend: FakeBackend
  let orch: RoomOrchestrator
  let closePort: () => void

  beforeEach(async () => {
    db = testDb()
    userData = tempDir()
    sourceDir = join(tempDir(), 'project')
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'package.json'), JSON.stringify({ name: 'demo', scripts: { dev: 'node server.js' } }))
    backend = new FakeBackend()
    const listener = await listeningPort()
    backend.hostPort = listener.port
    closePort = listener.close
    orch = new RoomOrchestrator({
      userData,
      backend,
      gateway: new FakeGateway().asGateway(),
      db,
      appVersion: 'test'
    })
  })

  afterEach(() => {
    closePort()
    db.close()
    rmSync(userData, { recursive: true, force: true })
    rmSync(sourceDir, { recursive: true, force: true })
  })

  it('imports a new Local Folder through the backend and runs on an owned volume', async () => {
    const room = await orch.createRoom({
      sourceType: 'linked-folder',
      sourceRef: sourceDir,
      project: 'demo',
      nickname: 'dev',
      actor: 'user'
    })

    expect(room.workspaceMode).toBe('hotel')
    expect(room.workspaceVolumeRevision).toBe(1)
    expect(room.hostSyncEnabled).toBe(true)
    expect(room.workspaceFingerprint).toBe('fake-workspace-fingerprint')
    expect(backend.calls).toContain(`importHostFolder:${sourceDir}:r1`)
    expect(backend.lastWebSpec?.workspaceMode).toBe('hotel')
    expect(backend.lastWebSpec?.workspaceVolumeRevision).toBe(1)
  })

  it('blocks Agent commands before they can mutate a legacy Host bind', async () => {
    const room = makeRoom()
    orch.rooms.create(room)

    await expect(orch.execInRoom(room.id, ['sh', '-lc', 'touch owned-by-agent'], undefined, 'agent')).rejects.toThrow(
      /legacy Host-bound/
    )
    expect(backend.calls).not.toContain(expect.stringContaining('execInRoom'))
  })

  it('never includes a linked Host absolute path in copied diagnostics', () => {
    const room = makeRoom({ sourceRef: 'C:\\Users\\private\\secret-project' })
    const text = buildDiagnostic({
      room,
      appVersion: 'test',
      report: null,
      recentChanges: [],
      gateway: { running: false, httpPort: null, httpsPort: null, routes: [] },
      webLogTail: [],
      customPatterns: []
    })

    expect(text).not.toContain(room.sourceRef)
    expect(text).toContain('legacy Host-bound compatibility mode')
  })

  it('blocks Agent Quick Changes on a legacy Host bind', async () => {
    const room = makeRoom()
    orch.rooms.create(room)

    await expect(
      orch.applyChange(room.id, { kind: 'start-command', command: 'node other.js' }, 'agent')
    ).rejects.toThrow(/legacy Host-bound/)
    expect(orch.rooms.get(room.id)?.startCommand).toBe(room.startCommand)
    expect(orch.changes.list(room.id)).toEqual([])
  })

  it('refuses Host sync when an untracked terminal or process edit changed the Room tree', async () => {
    const room = makeRoom({
      sourceType: 'linked-folder',
      sourceRef: sourceDir,
      workspaceMode: 'hotel',
      workspaceVolumeRevision: 1,
      stateRevision: 4,
      syncStatus: 'synced',
      lastSyncedAt: '2026-08-10T10:00:00.000Z',
      hostSyncEnabled: true,
      workspaceFingerprint: 'previous-fingerprint'
    })
    orch.rooms.create(room)
    backend.workspaceFingerprintValue = 'current-fingerprint'

    await expect(orch.syncFromHost(room.id, 'user')).rejects.toThrow(/Room files changed/)
    expect(orch.rooms.get(room.id)?.syncStatus).toBe('modified')
    expect(backend.calls.some((call) => call.startsWith('importHostFolder:'))).toBe(false)
  })

  it('reports only meaningful source drift with exact paths and reasons', async () => {
    const room = makeRoom({
      sourceType: 'linked-folder',
      sourceRef: sourceDir,
      workspaceMode: 'hotel',
      workspaceVolumeRevision: 1,
      stateRevision: 4,
      syncStatus: 'synced',
      hostSyncEnabled: true,
      workspaceFingerprint: 'a'.repeat(64)
    })
    orch.rooms.create(room)
    orch.settings.set(
      workspaceSyncBaseKey(room.id),
      serializeWorkspaceSnapshot({
        fingerprint: 'a'.repeat(64),
        entries: [{ path: 'app/src/main/java/App.kt', kind: 'file', identity: 'old-source' }]
      })
    )
    backend.workspaceFingerprintValue = 'b'.repeat(64)
    // The OCI snapshot policy has already removed app/build/** and .gradle/**;
    // mixed build output plus this edit therefore exposes only the source path.
    backend.workspaceSnapshotEntries = [
      { path: 'app/src/main/java/App.kt', kind: 'file', identity: 'new-source' }
    ]

    const error = await orch.syncFromHost(room.id, 'user').catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(WorkspaceDriftError)
    expect((error as WorkspaceDriftError).toResponse()).toMatchObject({
      error: 'workspace_drift',
      conflictReason: 'room-source-modified',
      changedPaths: [{ path: 'app/src/main/java/App.kt', reason: 'modified' }]
    })
    expect(backend.calls.some((call) => call.startsWith('importHostFolder:'))).toBe(false)
  })

  it('upgrades a clean pre-path-baseline Room without accepting unknown drift', async () => {
    const room = makeRoom({
      sourceType: 'linked-folder',
      sourceRef: sourceDir,
      workspaceMode: 'hotel',
      workspaceVolumeRevision: 1,
      syncStatus: 'synced',
      hostSyncEnabled: true,
      workspaceFingerprint: 'legacy-fingerprint'
    })
    orch.rooms.create(room)
    backend.workspaceFingerprintValue = 'new-policy-fingerprint'
    backend.legacyWorkspaceFingerprintValue = 'legacy-fingerprint'
    backend.workspaceSnapshotEntries = [
      { path: 'app/src/main/java/App.kt', kind: 'file', identity: 'source' }
    ]

    await expect(orch.syncFromHost(room.id, 'user')).resolves.toMatchObject({ syncStatus: 'synced' })
    expect(orch.settings.get(workspaceSyncBaseKey(room.id))).toContain('app/src/main/java/App.kt')
  })

  it('upgrades a legacy baseline when only newly excluded generated output appeared', async () => {
    const room = makeRoom({
      sourceType: 'linked-folder',
      sourceRef: sourceDir,
      workspaceMode: 'hotel',
      workspaceVolumeRevision: 1,
      syncStatus: 'synced',
      hostSyncEnabled: true,
      workspaceFingerprint: 'legacy-fingerprint'
    })
    orch.rooms.create(room)
    backend.workspaceFingerprintValue = 'new-policy-fingerprint'
    backend.legacyWorkspaceFingerprintValue = 'legacy-with-new-output'
    backend.legacyCurrentExclusionsFingerprintValue = 'legacy-fingerprint'
    backend.workspaceSnapshotEntries = [
      { path: 'app/src/main/java/App.kt', kind: 'file', identity: 'source' }
    ]

    await expect(orch.syncFromHost(room.id, 'user')).resolves.toMatchObject({ syncStatus: 'synced' })
    expect(orch.settings.get(workspaceSyncBaseKey(room.id))).toContain('app/src/main/java/App.kt')
  })

  it('lets agents sync under the Room grant, refuses once revoked, and never lets them migrate', async () => {
    const room = makeRoom({
      sourceType: 'linked-folder',
      sourceRef: sourceDir,
      workspaceMode: 'hotel',
      workspaceVolumeRevision: 1,
      stateRevision: 4,
      syncStatus: 'synced',
      hostSyncEnabled: true,
      workspaceFingerprint: 'same-fingerprint'
    })
    orch.rooms.create(room)
    backend.workspaceFingerprintValue = 'same-fingerprint'

    expect(orch.agentHostSyncAllowed(room.id)).toBe(true)
    const synced = await orch.syncFromHost(room.id, 'agent')
    expect(synced.syncStatus).toBe('synced')
    // journaled honestly as the agent, not laundered as the user
    expect(orch.listChanges(room.id)[0]).toMatchObject({ kind: 'sync-from-host', actor: 'agent' })

    orch.setAgentHostSync(room.id, false, 'user')
    expect(orch.agentHostSyncAllowed(room.id)).toBe(false)
    orch.rooms.update(room.id, { workspaceFingerprint: 'same-fingerprint' })
    await expect(orch.syncFromHost(room.id, 'agent')).rejects.toThrow(/revoked/)
    // the human can still sync the same Room themselves
    await expect(orch.syncFromHost(room.id, 'user')).resolves.toMatchObject({ syncStatus: 'synced' })
  })

  it('never lets an agent move a legacy Host-bound Room into the Hotel', async () => {
    const room = makeRoom({
      sourceType: 'linked-folder',
      sourceRef: sourceDir,
      workspaceMode: 'legacy-host-bind',
      syncStatus: 'legacy',
      hostSyncEnabled: true
    })
    orch.rooms.create(room)
    await expect(orch.moveIntoHotel(room.id, 'agent')).rejects.toThrow(/explicit user action/)
    expect(backend.calls.some((call) => call.startsWith('importHostFolder:'))).toBe(false)
  })

  it('reset baseline accepts the current Room files and unblocks the refused sync', async () => {
    const room = makeRoom({
      sourceType: 'linked-folder',
      sourceRef: sourceDir,
      workspaceMode: 'hotel',
      workspaceVolumeRevision: 1,
      stateRevision: 4,
      syncStatus: 'modified',
      lastSyncedAt: '2026-08-10T10:00:00.000Z',
      hostSyncEnabled: true,
      workspaceFingerprint: 'stale-baseline-from-before-the-build'
    })
    orch.rooms.create(room)
    backend.workspaceFingerprintValue = 'current-fingerprint'

    await expect(orch.syncFromHost(room.id, 'user')).rejects.toThrow(/Room files changed/)

    const reset = await orch.resetSyncBaseline(room.id, 'agent')
    expect(reset).toMatchObject({ syncStatus: 'synced', workspaceFingerprint: 'current-fingerprint' })
    // recorded for the human, and it never touches Host files
    expect(orch.listChanges(room.id)[0]).toMatchObject({ kind: 'reset-sync-baseline', actor: 'agent' })
    expect(backend.calls.some((call) => call.startsWith('importHostFolder:'))).toBe(false)

    // the previously refused sync now proceeds
    await expect(orch.syncFromHost(room.id, 'user')).resolves.toMatchObject({ syncStatus: 'synced' })
    expect(backend.calls.some((call) => call.startsWith('importHostFolder:'))).toBe(true)
  })

  it('inspects exact Room drift and requires explicit confirmation before one-step Host resync', async () => {
    const room = makeRoom({
      sourceType: 'linked-folder',
      sourceRef: sourceDir,
      workspaceMode: 'hotel',
      workspaceVolumeRevision: 1,
      stateRevision: 4,
      syncStatus: 'modified',
      lastSyncedAt: '2026-08-10T10:00:00.000Z',
      hostSyncEnabled: true,
      workspaceFingerprint: 'a'.repeat(64)
    })
    orch.rooms.create(room)
    orch.settings.set(
      workspaceSyncBaseKey(room.id),
      serializeWorkspaceSnapshot({
        fingerprint: 'a'.repeat(64),
        entries: [{ path: 'src/app.ts', kind: 'file', identity: 'old-source' }]
      })
    )
    backend.workspaceFingerprintValue = 'b'.repeat(64)
    backend.workspaceSnapshotEntries = [{ path: 'src/app.ts', kind: 'file', identity: 'room-edit' }]

    const refused = await orch.safeResyncFromHost(room.id, 'agent')

    expect(refused).toMatchObject({
      status: 'confirmation-required',
      before: { stateRevision: 4, workspaceVolumeRevision: 1, syncStatus: 'modified' },
      drift: {
        status: 'changed',
        baselineEvidence: 'path-snapshot',
        changedPaths: [{ path: 'src/app.ts', reason: 'modified' }]
      },
      confirmation: { required: true, provided: false, token: expect.any(String) }
    })
    expect(backend.calls.some((call) => call.startsWith('importHostFolder:'))).toBe(false)
    expect(orch.settings.get(workspaceSyncBaseKey(room.id))).toContain('old-source')

    if (refused.status !== 'confirmation-required') throw new Error('expected a confirmation preview')
    const completed = await orch.safeResyncFromHost(room.id, 'agent', refused.confirmation.token)

    expect(completed).toMatchObject({
      status: 'synced',
      before: { stateRevision: 4, workspaceVolumeRevision: 1, syncStatus: 'modified' },
      after: { stateRevision: 5, workspaceVolumeRevision: 2, syncStatus: 'synced' },
      confirmation: { required: true, provided: true },
      baselineReset: true,
      retainedWorkspaceVolumeRevision: 1
    })
    expect(backend.calls).toContain(`pauseWeb:${room.id}`)
    expect(backend.calls).toContain(`importHostFolder:${sourceDir}:r2`)
    expect(orch.settings.get(retainedWorkspaceGenKey(room.id))).toBe('1')
    expect(orch.listChanges(room.id)[0]).toMatchObject({ kind: 'safe-resync-from-host', actor: 'agent' })

    const importCount = backend.calls.filter((call) => call.startsWith('importHostFolder:')).length
    const replay = await orch.safeResyncFromHost(room.id, 'agent', refused.confirmation.token)
    expect(replay).toMatchObject({
      status: 'confirmation-required',
      drift: { status: 'clean' },
      confirmation: { required: true, provided: false, token: expect.any(String) }
    })
    expect(backend.calls.filter((call) => call.startsWith('importHostFolder:'))).toHaveLength(importCount)
  })

  it('returns a fresh preview when Room source changes after the confirmation token was issued', async () => {
    const room = makeRoom({
      sourceType: 'linked-folder',
      sourceRef: sourceDir,
      workspaceMode: 'hotel',
      workspaceVolumeRevision: 1,
      stateRevision: 4,
      syncStatus: 'modified',
      hostSyncEnabled: true,
      workspaceFingerprint: 'a'.repeat(64)
    })
    orch.rooms.create(room)
    orch.settings.set(
      workspaceSyncBaseKey(room.id),
      serializeWorkspaceSnapshot({
        fingerprint: 'a'.repeat(64),
        entries: [{ path: 'src/app.ts', kind: 'file', identity: 'baseline' }]
      })
    )
    backend.workspaceFingerprintValue = 'b'.repeat(64)
    backend.workspaceSnapshotEntries = [
      { path: 'src/app.ts', kind: 'file', identity: 'first-room-edit' }
    ]

    const preview = await orch.safeResyncFromHost(room.id, 'user')
    if (preview.status !== 'confirmation-required') throw new Error('expected a confirmation preview')

    backend.workspaceFingerprintValue = 'c'.repeat(64)
    backend.workspaceSnapshotEntries = [
      { path: 'src/app.ts', kind: 'file', identity: 'unseen-later-edit' }
    ]
    const refreshed = await orch.safeResyncFromHost(room.id, 'user', preview.confirmation.token)

    expect(refreshed).toMatchObject({
      status: 'confirmation-required',
      drift: { changedPaths: [{ path: 'src/app.ts', reason: 'modified' }] },
      confirmation: { required: true, provided: false, token: expect.any(String) }
    })
    if (refreshed.status !== 'confirmation-required') throw new Error('expected a refreshed preview')
    expect(refreshed.confirmation.token).not.toBe(preview.confirmation.token)
    expect(backend.calls.some((call) => call.startsWith('importHostFolder:'))).toBe(false)
  })

  it('does not persist a reconstructed path baseline while returning a confirmation preview', async () => {
    const room = makeRoom({
      sourceType: 'linked-folder',
      sourceRef: sourceDir,
      workspaceMode: 'hotel',
      workspaceVolumeRevision: 2,
      stateRevision: 6,
      syncStatus: 'modified',
      hostSyncEnabled: true,
      workspaceFingerprint: 'a'.repeat(64)
    })
    orch.rooms.create(room)
    orch.settings.set(retainedWorkspaceGenKey(room.id), '1')
    backend.snapshotWorkspace = async (_roomId, revision) =>
      revision === 1
        ? {
            fingerprint: 'a'.repeat(64),
            entries: [{ path: 'src/app.ts', kind: 'file' as const, identity: 'retained-baseline' }]
          }
        : {
            fingerprint: 'b'.repeat(64),
            entries: [{ path: 'src/app.ts', kind: 'file' as const, identity: 'current-room-edit' }]
          }

    const preview = await orch.safeResyncFromHost(room.id, 'user')

    expect(preview).toMatchObject({
      status: 'confirmation-required',
      drift: {
        status: 'changed',
        baselineEvidence: 'path-snapshot',
        changedPaths: [{ path: 'src/app.ts', reason: 'modified' }]
      }
    })
    expect(orch.settings.get(workspaceSyncBaseKey(room.id))).toBeNull()
    expect(orch.rooms.get(room.id)).toMatchObject({
      stateRevision: 6,
      workspaceVolumeRevision: 2,
      syncStatus: 'modified'
    })
    expect(backend.calls.some((call) => call.startsWith('importHostFolder:'))).toBe(false)
  })

  it('serializes file ingress with confirmation so a completed push must be previewed again', async () => {
    const room = makeRoom({
      sourceType: 'linked-folder',
      sourceRef: sourceDir,
      workspaceMode: 'hotel',
      workspaceVolumeRevision: 1,
      stateRevision: 4,
      syncStatus: 'modified',
      hostSyncEnabled: true,
      workspaceFingerprint: 'a'.repeat(64)
    })
    orch.rooms.create(room)
    orch.settings.set(
      workspaceSyncBaseKey(room.id),
      serializeWorkspaceSnapshot({
        fingerprint: 'a'.repeat(64),
        entries: [{ path: 'src/app.ts', kind: 'file', identity: 'baseline' }]
      })
    )
    backend.workspaceFingerprintValue = 'b'.repeat(64)
    backend.workspaceSnapshotEntries = [
      { path: 'src/app.ts', kind: 'file', identity: 'previewed-room-edit' }
    ]
    const preview = await orch.safeResyncFromHost(room.id, 'user')
    if (preview.status !== 'confirmation-required') throw new Error('expected a confirmation preview')

    let releaseCopy!: () => void
    let announceCopy!: () => void
    const copyEntered = new Promise<void>((resolve) => { announceCopy = resolve })
    const copyMayFinish = new Promise<void>((resolve) => { releaseCopy = resolve })
    const copyIntoRoom = backend.copyIntoRoom.bind(backend)
    backend.copyIntoRoom = async (...args) => {
      announceCopy()
      await copyMayFinish
      await copyIntoRoom(...args)
      backend.workspaceFingerprintValue = 'c'.repeat(64)
      backend.workspaceSnapshotEntries = [
        { path: 'src/app.ts', kind: 'file', identity: 'previewed-room-edit' },
        { path: 'src/pushed.ts', kind: 'file', identity: 'queued-push' }
      ]
    }

    const pushing = orch.pushRoomFile(room.id, '/workspace/src/pushed.ts', 'cHVzaGVk')
    await copyEntered
    let confirmationSettled = false
    const confirming = orch.safeResyncFromHost(room.id, 'user', preview.confirmation.token).then((outcome) => {
      confirmationSettled = true
      return outcome
    })
    await Promise.resolve()

    expect(confirmationSettled).toBe(false)
    expect(backend.calls.some((call) => call.startsWith('importHostFolder:'))).toBe(false)

    releaseCopy()
    await pushing
    const refreshed = await confirming
    expect(refreshed).toMatchObject({
      status: 'confirmation-required',
      drift: {
        changedPaths: [
          { path: 'src/app.ts', reason: 'modified' },
          { path: 'src/pushed.ts', reason: 'added' }
        ]
      }
    })
    expect(backend.calls.some((call) => call.startsWith('importHostFolder:'))).toBe(false)
  })

  it('safe Host resync needs no destructive confirmation when inspection is clean', async () => {
    const room = makeRoom({
      sourceType: 'linked-folder',
      sourceRef: sourceDir,
      workspaceMode: 'hotel',
      workspaceVolumeRevision: 1,
      stateRevision: 7,
      syncStatus: 'synced',
      hostSyncEnabled: true,
      workspaceFingerprint: 'a'.repeat(64)
    })
    orch.rooms.create(room)
    orch.settings.set(
      workspaceSyncBaseKey(room.id),
      serializeWorkspaceSnapshot({
        fingerprint: 'a'.repeat(64),
        entries: [{ path: 'src/app.ts', kind: 'file', identity: 'same-source' }]
      })
    )
    backend.workspaceFingerprintValue = 'a'.repeat(64)
    backend.workspaceSnapshotEntries = [{ path: 'src/app.ts', kind: 'file', identity: 'same-source' }]

    const completed = await orch.safeResyncFromHost(room.id, 'user')

    expect(completed).toMatchObject({
      status: 'synced',
      drift: { status: 'clean', changedPaths: [] },
      confirmation: { required: false, provided: false }
    })
  })

  it('fails closed when an old Room has no path baseline that can prove its drift', async () => {
    const room = makeRoom({
      sourceType: 'linked-folder',
      sourceRef: sourceDir,
      workspaceMode: 'hotel',
      workspaceVolumeRevision: 1,
      stateRevision: 2,
      syncStatus: 'synced',
      hostSyncEnabled: true,
      workspaceFingerprint: 'a'.repeat(64)
    })
    orch.rooms.create(room)
    backend.workspaceFingerprintValue = 'b'.repeat(64)
    backend.legacyWorkspaceFingerprintValue = 'c'.repeat(64)
    backend.legacyCurrentExclusionsFingerprintValue = 'd'.repeat(64)

    const refused = await orch.safeResyncFromHost(room.id, 'user')

    expect(refused).toMatchObject({
      status: 'confirmation-required',
      drift: { status: 'unknown', baselineEvidence: 'unavailable', changedPaths: [] },
      confirmation: { required: true, provided: false, token: expect.any(String) }
    })
    expect(backend.calls.some((call) => call.startsWith('importHostFolder:'))).toBe(false)
  })

  it('refuses a confirmed safe resync if Room source changes again while Host import is staged', async () => {
    const room = makeRoom({
      sourceType: 'linked-folder',
      sourceRef: sourceDir,
      workspaceMode: 'hotel',
      workspaceVolumeRevision: 1,
      stateRevision: 4,
      syncStatus: 'modified',
      hostSyncEnabled: true,
      workspaceFingerprint: 'a'.repeat(64)
    })
    orch.rooms.create(room)
    const baseline = {
      fingerprint: 'a'.repeat(64),
      entries: [{ path: 'src/app.ts', kind: 'file' as const, identity: 'baseline' }]
    }
    const inspected = {
      fingerprint: 'b'.repeat(64),
      entries: [{ path: 'src/app.ts', kind: 'file' as const, identity: 'confirmed-room-edit' }]
    }
    const changedAgain = {
      fingerprint: 'c'.repeat(64),
      entries: [{ path: 'src/app.ts', kind: 'file' as const, identity: 'later-terminal-edit' }]
    }
    orch.settings.set(workspaceSyncBaseKey(room.id), serializeWorkspaceSnapshot(baseline))
    let roomSnapshotCalls = 0
    backend.snapshotWorkspace = async (_roomId, revision) => {
      if (revision === 2) return { fingerprint: 'd'.repeat(64), entries: [] }
      roomSnapshotCalls += 1
      return roomSnapshotCalls <= 3 ? inspected : changedAgain
    }

    const preview = await orch.safeResyncFromHost(room.id, 'user')
    if (preview.status !== 'confirmation-required') throw new Error('expected a confirmation preview')
    const error = await orch
      .safeResyncFromHost(room.id, 'user', preview.confirmation.token)
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(WorkspaceDriftError)
    expect((error as WorkspaceDriftError).changedPaths).toEqual([
      { path: 'src/app.ts', reason: 'modified' }
    ])
    expect(backend.calls).toContain(`pauseWeb:${room.id}`)
    expect(backend.calls).toContain(`unpauseWeb:${room.id}`)
    expect(backend.calls).toContain('removeWorkspaceVolume:r2')
    expect(orch.rooms.get(room.id)).toMatchObject({
      workspaceVolumeRevision: 1,
      stateRevision: 4,
      syncStatus: 'modified'
    })
    expect(orch.settings.get(workspaceSyncBaseKey(room.id))).toContain('baseline')
  })

  it('restores runtime, metadata, baseline, and recovery pointer when final journal publication fails', async () => {
    const room = makeRoom({
      sourceType: 'linked-folder',
      sourceRef: sourceDir,
      workspaceMode: 'hotel',
      workspaceVolumeRevision: 1,
      stateRevision: 4,
      syncStatus: 'modified',
      lastSyncedAt: '2026-08-10T10:00:00.000Z',
      hostSyncEnabled: true,
      workspaceFingerprint: 'a'.repeat(64)
    })
    orch.rooms.create(room)
    const baseline = serializeWorkspaceSnapshot({
      fingerprint: 'a'.repeat(64),
      entries: [{ path: 'src/app.ts', kind: 'file', identity: 'baseline' }]
    })
    orch.settings.set(workspaceSyncBaseKey(room.id), baseline)
    orch.settings.set(retainedWorkspaceGenKey(room.id), '7')
    backend.workspaceFingerprintValue = 'b'.repeat(64)
    backend.workspaceSnapshotEntries = [
      { path: 'src/app.ts', kind: 'file', identity: 'confirmed-room-edit' }
    ]

    const preview = await orch.safeResyncFromHost(room.id, 'user')
    if (preview.status !== 'confirmation-required') throw new Error('expected a confirmation preview')
    orch.changes.append = () => {
      throw new Error('SQLITE_IOERR: journal publication failed')
    }

    const error = await orch
      .safeResyncFromHost(room.id, 'user', preview.confirmation.token)
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('journal publication failed')
    expect(orch.rooms.get(room.id)).toMatchObject({
      workspaceMode: 'hotel',
      workspaceVolumeRevision: 1,
      stateRevision: 4,
      syncStatus: 'modified',
      lastSyncedAt: '2026-08-10T10:00:00.000Z',
      workspaceFingerprint: 'a'.repeat(64)
    })
    expect(orch.settings.get(workspaceSyncBaseKey(room.id))).toBe(baseline)
    expect(orch.settings.get(retainedWorkspaceGenKey(room.id))).toBe('7')
    expect(backend.lastWebSpec?.workspaceVolumeRevision).toBe(1)
    expect(backend.calls).toContain('removeWorkspaceVolume:r2')
  })

  it('refuses agent file transfer for legacy Host-bound rooms, whose workspace is the Host folder', async () => {
    const room = makeRoom({
      sourceType: 'linked-folder',
      sourceRef: sourceDir,
      workspaceMode: 'legacy-host-bind',
      syncStatus: 'legacy',
      hostSyncEnabled: true
    })
    orch.rooms.create(room)
    await expect(orch.pullRoomFile(room.id, '/workspace/.env')).rejects.toThrow(/legacy Host-bound/)
    await expect(orch.pushRoomFile(room.id, '/workspace/evil.sh', 'ZXZpbA==')).rejects.toThrow(/legacy Host-bound/)
    expect(backend.calls.some((call) => call.startsWith('copyFromRoom:') || call.startsWith('copyIntoRoom:'))).toBe(false)
  })

  it('refuses a baseline reset for rooms with no Host link', async () => {
    const room = makeRoom({
      sourceType: 'managed-git',
      sourceRef: 'https://example.test/repo.git',
      workspaceMode: 'hotel',
      hostSyncEnabled: false,
      syncStatus: 'modified'
    })
    orch.rooms.create(room)
    await expect(orch.resetSyncBaseline(room.id, 'agent')).rejects.toThrow(/detached/)
  })

  it('publishes a successfully staged Host import as a new source generation', async () => {
    const room = makeRoom({
      sourceType: 'linked-folder',
      sourceRef: sourceDir,
      workspaceMode: 'hotel',
      workspaceVolumeRevision: 1,
      stateRevision: 4,
      syncStatus: 'synced',
      lastSyncedAt: '2026-08-10T10:00:00.000Z',
      hostSyncEnabled: true,
      workspaceFingerprint: 'same-fingerprint'
    })
    orch.rooms.create(room)
    // A malformed future pointer must never be interpreted as the generation
    // that is about to become active and removed during best-effort cleanup.
    orch.settings.set(retainedWorkspaceGenKey(room.id), '2junk')
    backend.workspaceFingerprintValue = 'same-fingerprint'

    const synced = await orch.syncFromHost(room.id, 'user')

    expect(synced.workspaceVolumeRevision).toBe(2)
    expect(synced.stateRevision).toBe(5)
    expect(synced.syncStatus).toBe('synced')
    expect(backend.calls).toContain(`importHostFolder:${sourceDir}:r2`)
    expect(backend.lastWebSpec?.workspaceVolumeRevision).toBe(2)
    // the replaced generation survives this sync so a wrong sync is recoverable
    expect(backend.calls).not.toContain('removeWorkspaceVolume:r1')
    expect(orch.settings.get(retainedWorkspaceGenKey(room.id))).toBe('1')

    // ...and the next sync drops it, so only one spare generation is kept
    backend.workspaceFingerprintValue = 'same-fingerprint'
    orch.rooms.update(room.id, { workspaceFingerprint: 'same-fingerprint' })
    const again = await orch.syncFromHost(room.id, 'user')
    expect(again.workspaceVolumeRevision).toBe(3)
    expect(backend.calls).toContain('removeWorkspaceVolume:r1')
    expect(backend.calls).not.toContain('removeWorkspaceVolume:r2')
    expect(orch.settings.get(retainedWorkspaceGenKey(room.id))).toBe('2')
  })

  it('never reuses a failed Host-sync workspace generation', async () => {
    const room = makeRoom({
      sourceType: 'linked-folder',
      sourceRef: sourceDir,
      workspaceMode: 'hotel',
      workspaceVolumeRevision: 1,
      stateRevision: 4,
      syncStatus: 'synced',
      hostSyncEnabled: true,
      workspaceFingerprint: 'same-fingerprint',
      hostPort: backend.hostPort
    })
    orch.rooms.create(room)
    orch.settings.set(workspaceGenMaxKey(room.id), '1')
    backend.workspaceFingerprintValue = 'same-fingerprint'
    const importHostFolder = backend.importHostFolder.bind(backend)
    let failed = false
    backend.importHostFolder = async (roomId, hostPath, revision) => {
      if (!failed) {
        failed = true
        backend.calls.push(`importHostFolder:${hostPath}:r${revision}`)
        throw new Error('staged import failed')
      }
      await importHostFolder(roomId, hostPath, revision)
    }

    await expect(orch.syncFromHost(room.id, 'user')).rejects.toThrow(/staged import failed/)
    expect(backend.calls).toContain('removeWorkspaceVolume:r2')
    expect(orch.settings.get(workspaceGenMaxKey(room.id))).toBe('2')

    const synced = await orch.syncFromHost(room.id, 'user')
    expect(synced.workspaceVolumeRevision).toBe(3)
    expect(backend.calls).toContain(`importHostFolder:${sourceDir}:r3`)
  })

  it('restores the prior runtime and metadata when publishing a staged sync fails', async () => {
    const room = makeRoom({
      sourceType: 'linked-folder',
      sourceRef: sourceDir,
      workspaceMode: 'hotel',
      workspaceVolumeRevision: 1,
      stateRevision: 9,
      syncStatus: 'synced',
      lastSyncedAt: '2026-08-10T10:00:00.000Z',
      hostSyncEnabled: true,
      workspaceFingerprint: 'same-fingerprint'
    })
    orch.rooms.create(room)
    backend.workspaceFingerprintValue = 'same-fingerprint'
    let failedPublish = false
    backend.recreateWeb = async (spec) => {
      backend.calls.push(`recreateWeb:r${spec.workspaceVolumeRevision}`)
      backend.lastWebSpec = spec
      if (spec.workspaceVolumeRevision === 2 && !failedPublish) {
        failedPublish = true
        throw new Error('publish failed')
      }
    }

    await expect(orch.syncFromHost(room.id, 'user')).rejects.toThrow(/publish failed/)

    expect(orch.rooms.get(room.id)).toMatchObject({
      workspaceMode: 'hotel',
      workspaceVolumeRevision: 1,
      stateRevision: 9,
      syncStatus: 'synced',
      workspaceFingerprint: 'same-fingerprint'
    })
    expect(backend.calls).toContain('recreateWeb:r2')
    expect(backend.calls).toContain('recreateWeb:r1')
    expect(backend.calls).toContain('removeWorkspaceVolume:r2')
    expect(backend.calls).not.toContain('removeWorkspaceVolume:r1')
  })

  it('clones an imported Local Folder volume but detaches the target from the Host path', async () => {
    const source = makeRoom({
      id: 'source01',
      sourceType: 'linked-folder',
      sourceRef: sourceDir,
      workspaceMode: 'hotel',
      workspaceVolumeRevision: 1,
      stateRevision: 3,
      syncStatus: 'modified',
      hostSyncEnabled: true,
      workspaceFingerprint: 'fingerprint'
    })
    orch.rooms.create(source)

    const cloned = await orch.cloneRoom({
      sourceRoomId: source.id,
      nickname: 'agent-branch',
      copyDependencies: false,
      services: 'exclude',
      actor: 'user'
    })

    expect(cloned.workspaceMode).toBe('hotel')
    expect(cloned.hostSyncEnabled).toBe(false)
    expect(cloned.sourceType).toBe('linked-folder')
    expect(backend.calls).toContain(
      `copyVolume:${srcVolume(source.id, 1)}:${srcVolume(cloned.id, 1)}`
    )
  })

  function packageRoom() {
    const room = makeRoom({
      sourceType: 'managed-git',
      sourceRef: 'https://example.test/demo.git',
      workspaceMode: 'hotel',
      workspaceVolumeRevision: 1,
      stateRevision: 7,
      syncStatus: 'synced',
      hostSyncEnabled: false,
      workspaceFingerprint: 'synced-baseline',
      hostPort: backend.hostPort
    })
    orch.rooms.create(room)
    orch.settings.set(workspaceGenMaxKey(room.id), '1')
    return room
  }

  it('publishes package manifest/lock and dependencies as one fresh Room generation', async () => {
    const room = packageRoom()
    const entry = await orch.applyChange(
      room.id,
      { kind: 'package-install', name: 'zod', version: '4.0.0', dev: false },
      'user'
    )

    expect(entry).toMatchObject({ status: 'verified', undoable: true })
    expect(orch.rooms.get(room.id)).toMatchObject({
      workspaceVolumeRevision: 2,
      stateRevision: 8,
      syncStatus: 'modified',
      workspaceFingerprint: 'synced-baseline'
    })
    expect(orch.settings.get(depsGenKey(room.id, '22'))).toBe('1')
    expect(orch.settings.get(workspaceGenMaxKey(room.id))).toBe('2')
    expect(orch.settings.get(depsGenMaxKey(room.id, '22'))).toBe('1')
    expect(backend.calls).toContain(`pauseWeb:${room.id}`)
    expect(backend.calls).toContain(`copyVolume:${srcVolume(room.id, 1)}:${srcVolume(room.id, 2)}`)
    expect(backend.calls).toContain(`unpauseWeb:${room.id}`)
    expect(backend.calls).toContain(`resetVolume:${depsVolumeForGen(room.id, '22', 1)}`)
    expect(backend.calls).toContain(`runOneShot:${depsVolumeForGen(room.id, '22', 1)}:pnpm add --save-exact zod@4.0.0`)
    expect(backend.lastWebSpec).toMatchObject({ workspaceVolumeRevision: 2, depsVolumeOverride: depsVolumeForGen(room.id, '22', 1) })
  })

  it('cleans both staged generations and preserves every published pointer when install fails', async () => {
    const room = packageRoom()
    backend.oneShotResult = { code: 1, stdout: '', stderr: 'registry unavailable after partial staging' }

    const entry = await orch.applyChange(
      room.id,
      { kind: 'package-install', name: 'zod', version: '4.0.0', dev: false },
      'user'
    )

    expect(entry.status).toBe('rolled-back')
    expect(orch.rooms.get(room.id)).toMatchObject({
      workspaceVolumeRevision: 1,
      stateRevision: 7,
      syncStatus: 'synced',
      workspaceFingerprint: 'synced-baseline'
    })
    expect(orch.settings.get(depsGenKey(room.id, '22'))).toBeNull()
    expect(backend.calls).toContain('removeWorkspaceVolume:r2')
    expect(backend.calls).toContain('removeDependencyVolume:node22:g1')
  })

  it('recreates the previously published web runtime when source unpause fails', async () => {
    const room = packageRoom()
    backend.unpauseWeb = async (roomId: string) => {
      backend.calls.push(`unpauseWeb:${roomId}`)
      throw new Error('container could not be unpaused')
    }

    const entry = await orch.applyChange(
      room.id,
      { kind: 'package-install', name: 'zod', version: '4.0.0', dev: false },
      'user'
    )

    expect(entry.status).toBe('rolled-back')
    expect(orch.rooms.get(room.id)).toMatchObject({
      workspaceVolumeRevision: 1,
      stateRevision: 7,
      syncStatus: 'synced'
    })
    expect(orch.settings.get(depsGenKey(room.id, '22'))).toBeNull()
    expect(backend.calls).toContain(`recreateWeb:${room.id}:node22:default`)
    expect(backend.lastWebSpec).toMatchObject({ workspaceVolumeRevision: 1, depsVolumeOverride: undefined })
    expect(backend.calls).toContain('removeWorkspaceVolume:r2')
    expect(backend.calls).toContain('removeDependencyVolume:node22:g1')
  })

  it('rejects publish when the live workspace changes during staged package installation', async () => {
    const room = packageRoom()
    let fingerprintCall = 0
    backend.fingerprintWorkspace = async () => {
      fingerprintCall += 1
      if (fingerprintCall <= 2) return 'old-generation-at-copy'
      if (fingerprintCall === 3) return 'installed-staged-generation'
      return 'old-generation-with-concurrent-terminal-edit'
    }

    const entry = await orch.applyChange(
      room.id,
      { kind: 'package-install', name: 'zod', version: '4.0.0', dev: false },
      'user'
    )

    expect(entry).toMatchObject({
      status: 'rolled-back',
      verify: { ok: false, detail: expect.stringContaining('Room workspace changed') }
    })
    expect(orch.rooms.get(room.id)).toMatchObject({
      workspaceVolumeRevision: 1,
      stateRevision: 8,
      syncStatus: 'modified',
      workspaceFingerprint: 'synced-baseline'
    })
    expect(orch.settings.get(depsGenKey(room.id, '22'))).toBeNull()
    expect(backend.calls.filter((call) => call === `pauseWeb:${room.id}`)).toHaveLength(2)
    expect(backend.calls.filter((call) => call === `unpauseWeb:${room.id}`)).toHaveLength(2)
    expect(backend.calls.some((call) => call.startsWith(`recreateWeb:${room.id}:`))).toBe(false)
    expect(backend.calls).toContain('removeWorkspaceVolume:r2')
    expect(backend.calls).toContain('removeDependencyVolume:node22:g1')
  })

  it('publishes while sleeping and wakes on the installed workspace and dependency generations', async () => {
    const room = packageRoom()
    orch.rooms.update(room.id, { status: 'sleeping', hostPort: null })
    backend.calls.length = 0
    backend.lastWebSpec = null

    const entry = await orch.applyChange(
      room.id,
      { kind: 'package-install', name: 'zod', version: '4.0.0', dev: false },
      'user'
    )

    expect(entry.status).toBe('verified')
    expect(orch.rooms.get(room.id)).toMatchObject({
      status: 'sleeping',
      workspaceVolumeRevision: 2,
      stateRevision: 8,
      syncStatus: 'modified'
    })
    expect(backend.calls).not.toContain(`pauseWeb:${room.id}`)
    expect(backend.calls).not.toContain(`unpauseWeb:${room.id}`)
    expect(backend.calls.some((call) => call.startsWith(`recreateWeb:${room.id}:`))).toBe(false)

    await orch.startRoom(room.id, 'user')

    expect(orch.rooms.get(room.id)?.status).toBe('ready')
    expect(backend.lastWebSpec).toMatchObject({
      workspaceVolumeRevision: 2,
      depsVolumeOverride: depsVolumeForGen(room.id, '22', 1)
    })
  })

  it('immediately undoes a package install by swapping both pointers back', async () => {
    const room = packageRoom()
    const installed = await orch.applyChange(
      room.id,
      { kind: 'package-install', name: 'zod', version: '4.0.0', dev: false },
      'user'
    )

    const undone = await orch.undoChange(room.id, installed.id, 'user')

    expect(undone.status).toBe('verified')
    expect(orch.rooms.get(room.id)).toMatchObject({ workspaceVolumeRevision: 1, stateRevision: 9, syncStatus: 'modified' })
    expect(orch.settings.get(depsGenKey(room.id, '22'))).toBe('0')
    expect(backend.calls).toContain('removeWorkspaceVolume:r2')
    expect(backend.calls).toContain('removeDependencyVolume:node22:g1')
  })

  it('rejects package Undo after a later workspace revision', async () => {
    const room = packageRoom()
    const installed = await orch.applyChange(
      room.id,
      { kind: 'package-install', name: 'zod', version: '4.0.0', dev: false },
      'user'
    )
    orch.rooms.update(room.id, { stateRevision: 9, syncStatus: 'modified' })

    await expect(orch.undoChange(room.id, installed.id, 'user')).rejects.toThrow(/discard later workspace edits/)
    expect(orch.rooms.get(room.id)?.workspaceVolumeRevision).toBe(2)
    expect(orch.settings.get(depsGenKey(room.id, '22'))).toBe('1')
  })

  it('rejects package Undo after an untracked terminal edit changes the workspace fingerprint', async () => {
    const room = packageRoom()
    backend.workspaceFingerprintValue = 'package-generation'
    const installed = await orch.applyChange(
      room.id,
      { kind: 'package-install', name: 'zod', version: '4.0.0', dev: false },
      'user'
    )
    backend.workspaceFingerprintValue = 'later-terminal-edit'

    await expect(orch.undoChange(room.id, installed.id, 'user')).rejects.toThrow(/workspace files changed/)
    expect(orch.rooms.get(room.id)?.workspaceVolumeRevision).toBe(2)
    expect(orch.settings.get(depsGenKey(room.id, '22'))).toBe('1')
  })

  it('never reuses failed or undone package generations', async () => {
    const room = packageRoom()
    backend.oneShotResult = { code: 1, stdout: '', stderr: 'first generation failed' }
    await orch.applyChange(room.id, { kind: 'package-install', name: 'zod', version: '4.0.0', dev: false }, 'user')

    backend.oneShotResult = { code: 0, stdout: '', stderr: '' }
    await orch.applyChange(room.id, { kind: 'package-install', name: 'zod', version: '4.0.1', dev: false }, 'user')

    expect(orch.rooms.get(room.id)?.workspaceVolumeRevision).toBe(3)
    expect(orch.settings.get(depsGenKey(room.id, '22'))).toBe('2')
    expect(backend.calls).toContain(`copyVolume:${srcVolume(room.id, 1)}:${srcVolume(room.id, 3)}`)
    expect(backend.calls).toContain(`resetVolume:${depsVolumeForGen(room.id, '22', 2)}`)
  })
})
