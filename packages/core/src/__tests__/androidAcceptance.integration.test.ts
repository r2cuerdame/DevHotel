import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  AndroidAcceptanceReport,
  AndroidForegroundInstallContext,
  AndroidScreenshotArtifactMetadata
} from '@devhotel/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AndroidAcceptanceIntegrity } from '../androidAcceptanceIntegrity'
import { androidBuildEnvironmentRevision } from '../changes/definitions/androidBuild'
import type { AndroidAppLocaleRestoreFence, AndroidForegroundInstallEvidence } from '../devices/androidAutomation'
import { RoomOrchestrator } from '../orchestrator'
import { ANDROID_IMAGE } from '../providers/androidProvider'
import type { Db } from '../store/db'
import { settingsRepo } from '../store/settingsRepo'
import { RunOutputStore } from '../runOutput'
import { FakeAdbHost, FakeBackend, FakeGateway, makeRoom, tempDir, testDb } from './fakes'
import { screenshotPng } from './pngFixture'

const ROOM_ID = 'aaaa1111'
const APP_ID = 'com.example.app'
const CHANGE_ID = '11111111-2222-4333-8444-555555555555'
const INSTALLED_AT = '2026-08-30T00:00:00.000Z'
const APK_SHA256 = 'a'.repeat(64)

describe('Android acceptance orchestration', () => {
  const roots: string[] = []
  const dbs: Db[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    for (const db of dbs.splice(0)) db.close()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function setup(options: {
    crashFailure?: boolean
    firstRestoreFailure?: boolean
    processDrift?: boolean
    restoreFailure?: boolean
    sourceDriftDuringRestore?: boolean
  } = {}) {
    const behavior = { ...options }
    const userData = tempDir()
    roots.push(userData)
    const db = testDb()
    dbs.push(db)
    const backend = new FakeBackend()
    backend.emulatorStateValue = 'running'
    backend.workspaceFingerprintValue = 'f'.repeat(64)
    const gateway = new FakeGateway()
    const adb = new FakeAdbHost()
    const orch = new RoomOrchestrator({
      userData,
      db,
      backend,
      gateway: gateway.asGateway(),
      adb,
      appVersion: 'test'
    })
    orch.rooms.create(makeRoom({
      id: ROOM_ID,
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
    }))
    const room = orch.rooms.get(ROOM_ID)!
    const integrity = new AndroidAcceptanceIntegrity(db)
    const imageSha256 = /@sha256:([a-f0-9]{64})$/.exec(ANDROID_IMAGE)![1]!
    const target = { kind: 'emulator' as const, targetId: ROOM_ID, deviceId: null }
    const packageIncarnation = 'b'.repeat(64)
    const receipt = orch.androidInstalls.record({
      roomId: ROOM_ID,
      target,
      applicationId: APP_ID,
      changeId: CHANGE_ID,
      apkSha256: APK_SHA256,
      installedAt: INSTALLED_AT,
      packageIncarnation,
      logFence: null,
      installUserId: 0,
      installUserSerial: 42,
      acceptanceProvenance: {
        artifactSizeBytes: 4096,
        stateRevision: room.stateRevision,
        workspaceVolumeRevision: room.workspaceVolumeRevision,
        sourceIdentity: integrity.identify('source', backend.workspaceFingerprintValue),
        environmentIdentity: integrity.identify('environment', androidBuildEnvironmentRevision(room)),
        imageReference: ANDROID_IMAGE,
        imageSha256
      }
    })
    orch.changes.append({
      id: CHANGE_ID,
      roomId: ROOM_ID,
      kind: 'android-run',
      title: 'Verified Android run',
      actor: 'agent',
      component: 'Build',
      before: null,
      after: null,
      captured: null,
      steps: [],
      verify: { ok: true, detail: 'verified' },
      undoable: false,
      undoStrategy: 'none',
      status: 'verified',
      rawLogPath: null,
      createdAt: INSTALLED_AT,
      undoneAt: null
    })

    const status: AndroidForegroundInstallContext['status'] = {
      target: {
        kind: 'emulator',
        deviceId: null,
        nickname: 'Room emulator',
        model: 'Pixel 8',
        androidVersion: '15',
        apiLevel: 35
      },
      installedApplicationIds: [APP_ID],
      foregroundApplicationId: APP_ID,
      locale: 'ko-KR'
    }
    const evidence: AndroidForegroundInstallEvidence = {
      context: { status, receipt },
      seal: {
        targetKind: 'emulator',
        targetId: ROOM_ID,
        deviceId: null,
        leaseId: null,
        roomId: ROOM_ID,
        applicationId: APP_ID,
        changeId: CHANGE_ID,
        apkSha256: APK_SHA256,
        installedAt: INSTALLED_AT,
        packageIncarnation,
        logFence: null,
        installUserId: 0,
        installUserSerial: 42
      }
    }
    const calls = { applyLocales: 0, launch: 0 }
    const restoreFence = {
      targetKind: 'emulator' as const,
      targetId: ROOM_ID,
      deviceId: null,
      leaseId: null,
      roomId: ROOM_ID,
      applicationId: APP_ID,
      changeId: CHANGE_ID,
      apkSha256: APK_SHA256,
      installedAt: INSTALLED_AT,
      packageIncarnation,
      installUserId: 0,
      installUserSerial: 42,
      apiLevel: 35
    }
    let insideScreenWitness = false
    const applyLocales = async () => {
      calls.applyLocales += 1
      if (behavior.sourceDriftDuringRestore) backend.workspaceFingerprintValue = 'e'.repeat(64)
      if (behavior.restoreFailure || (behavior.firstRestoreFailure && calls.applyLocales === 1)) {
        throw new Error('locale restore failed')
      }
      const pids = behavior.processDrift ? [202] : [101]
      return {
        target: status.target,
        applicationId: APP_ID,
        apiLevel: 35,
        localeTags: ['en-US'],
        previousLocaleTags: ['en-US'],
        pids,
        restoreFence,
        process: { beforePids: pids, afterPids: pids, restarted: false },
        readiness: {
          adb: 'device' as const,
          localeService: 'ready' as const,
          application: 'foreground' as const,
          process: 'running' as const,
          attempts: 2,
          consecutiveReadyChecks: 2 as const,
          elapsedMs: 250,
          pids
        }
      }
    }
    const session = {
      target: status.target,
      withActiveUserScreenWitness: async <T>(
        action: (signal: AbortSignal) => Promise<T>
      ): Promise<T> => {
        insideScreenWitness = true
        try {
          return await action(new AbortController().signal)
        } finally {
          insideScreenWitness = false
        }
      },
      foregroundInstallEvidence: async (): Promise<AndroidForegroundInstallEvidence> => structuredClone(evidence),
      trackedInstallSeal: async () => structuredClone(evidence.seal!),
      appLocaleSnapshot: async () => ({ apiLevel: 35, localeTags: ['en-US'], pids: [101], restoreFence }),
      proveAppLocaleFinalState: async () => ({ apiLevel: 35, localeTags: ['en-US'], pids: [101], restoreFence }),
      applyAppLocalesAndWait: applyLocales,
      restoreAppLocalesFromFence: applyLocales,
      launch: async () => {
        if (insideScreenWitness) throw new Error('launch must precede the strict screen witness')
        calls.launch += 1
      },
      crashScenario: async () => {
        if (behavior.crashFailure) throw new Error('crash probe failed')
        return {
          target: status.target,
          applicationId: APP_ID,
          scenario: 'am-crash' as const,
          runId: '99999999-8888-4777-8666-555555555555',
          observed: true,
          pidsBefore: [101],
          pidsAfter: [],
          evidence: { code: 0, stdout: '', stderr: '', truncated: false },
          logcat: {
            target: status.target,
            applicationId: APP_ID,
            since: null,
            lines: [],
            sourceLines: 0,
            truncated: false
          }
        }
      }
    }
    const internal = orch as unknown as {
      openAndroidAutomationSessionLocked(roomId: string, selector: unknown): Promise<typeof session>
    }
    const openSessionSpy = vi.spyOn(internal, 'openAndroidAutomationSessionLocked').mockResolvedValue(session)

    const rawSecret = `ghp_${'A'.repeat(24)}`
    const run = orch.runs.begin(ROOM_ID, ['test-command', rawSecret], 'agent', { maxBytes: 256 })
    run.push('stdout', `${rawSecret}\n${'x'.repeat(2_000)}\n`)
    expect(orch.runs.complete(run, 0).retained).toBe(true)
    return {
      adb,
      backend,
      behavior,
      calls,
      db,
      evidence,
      gateway,
      openSessionSpy,
      orch,
      runId: run.runId,
      rawSecret,
      session,
      userData
    }
  }

  function setupPhysical() {
    const test = setup()
    ;(test.orch.devices as unknown as {
      lastAvailability: { ok: boolean; detail: string }
    }).lastAvailability = { ok: true, detail: 'test physical adb is available' }
    const deviceId = `d${'1'.repeat(32)}`
    const leaseId = '77777777-8888-4999-aaaa-bbbbbbbbbbbb'
    const at = new Date().toISOString()
    test.db.sqlite.prepare(
      `INSERT INTO android_devices (
         id, serial, physical_identity, nickname, model, android_version, api_level,
         connection, health, first_seen_at, last_seen_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'usb', 'ready', ?, ?)`
    ).run(deviceId, 'R5CT30ACCEPT', '8'.repeat(64), 'Acceptance phone', 'Pixel 8', '15', 35, at, at)
    test.db.sqlite.prepare(
      `INSERT INTO android_device_leases (
         id, device_id, room_id, project, issue_ref, run_id, worker_id, purpose, state,
         acquired_at, heartbeat_at, activity_at, ttl_ms, max_duration_ms, released_at, release_reason
       ) VALUES (?, ?, ?, ?, NULL, NULL, ?, 'acceptance', 'active', ?, ?, ?, ?, ?, NULL, NULL)`
    ).run(leaseId, deviceId, ROOM_ID, 'Example', `pid:${process.pid}`, at, at, at, 600_000, 3_600_000)
    const room = test.orch.rooms.get(ROOM_ID)!
    const emulatorProvenance = test.orch.androidInstalls.acceptanceProvenance(
      ROOM_ID,
      { kind: 'emulator', targetId: ROOM_ID, deviceId: null },
      APP_ID
    )!
    const target = { kind: 'physical' as const, targetId: deviceId, deviceId, leaseId }
    test.orch.androidInstalls.record({
      roomId: ROOM_ID,
      target,
      applicationId: APP_ID,
      changeId: CHANGE_ID,
      apkSha256: APK_SHA256,
      installedAt: INSTALLED_AT,
      packageIncarnation: 'b'.repeat(64),
      logFence: null,
      installUserId: 0,
      installUserSerial: 42,
      acceptanceProvenance: {
        ...emulatorProvenance,
        stateRevision: room.stateRevision,
        workspaceVolumeRevision: room.workspaceVolumeRevision
      }
    })
    const restoreFence = {
      targetKind: 'physical' as const,
      targetId: deviceId,
      deviceId,
      leaseId,
      roomId: ROOM_ID,
      applicationId: APP_ID,
      changeId: CHANGE_ID,
      apkSha256: APK_SHA256,
      installedAt: INSTALLED_AT,
      packageIncarnation: 'b'.repeat(64),
      installUserId: 0,
      installUserSerial: 42,
      apiLevel: 35
    }
    const snapshot = { apiLevel: 35, localeTags: ['en-US'], pids: [101], restoreFence }
    const calls = {
      snapshot: 0,
      prove: 0,
      screenWitness: 0,
      foregroundEvidence: 0,
      launch: 0,
      crash: 0,
      applyLocales: 0,
      restoreLocales: 0
    }
    const physicalSession = {
      target: {
        kind: 'physical' as const,
        deviceId,
        nickname: 'Acceptance phone',
        model: 'Pixel 8',
        androidVersion: '15',
        apiLevel: 35
      },
      appLocaleSnapshot: async () => {
        calls.snapshot += 1
        return structuredClone(snapshot)
      },
      proveAppLocaleFinalState: async () => {
        calls.prove += 1
        return structuredClone(snapshot)
      },
      withActiveUserScreenWitness: async () => {
        calls.screenWitness += 1
        throw new Error('physical acceptance must not start a screen witness')
      },
      foregroundInstallEvidence: async () => {
        calls.foregroundEvidence += 1
        throw new Error('physical acceptance must use the composite locale/install proof')
      },
      launch: async () => { calls.launch += 1 },
      crashScenario: async () => { calls.crash += 1 },
      applyAppLocalesAndWait: async () => { calls.applyLocales += 1 },
      restoreAppLocalesFromFence: async () => { calls.restoreLocales += 1 }
    }
    test.openSessionSpy.mockResolvedValue(physicalSession as never)
    return { ...test, calls: { ...test.calls, physical: calls }, deviceId, leaseId, physicalSession, target }
  }

  function withSecondConnection(test: { db: Db }, mutate: (sqlite: DatabaseSync) => void): void {
    const database = test.db.sqlite.prepare('PRAGMA database_list').get() as { file: string } | undefined
    if (!database?.file) throw new Error('test database path is unavailable')
    const sqlite = new DatabaseSync(database.file)
    try {
      sqlite.exec('PRAGMA foreign_keys=ON')
      sqlite.exec('PRAGMA journal_mode=WAL')
      mutate(sqlite)
    } finally {
      sqlite.close()
    }
  }

  function secondRetentionStore(test: { db: Db; userData: string }): {
    runs: RunOutputStore
    sqlite: DatabaseSync
    close(): void
  } {
    const database = test.db.sqlite.prepare('PRAGMA database_list').get() as { file: string } | undefined
    if (!database?.file) throw new Error('test database path is unavailable')
    const sqlite = new DatabaseSync(database.file)
    sqlite.exec('PRAGMA foreign_keys=ON')
    sqlite.exec('PRAGMA journal_mode=WAL')
    const runs = new RunOutputStore(test.userData, {
      maxRetainedRuns: 1,
      isPinned: (roomId, runId) => Boolean(sqlite.prepare(
        'SELECT 1 FROM android_acceptance_run_snapshots WHERE room_id = ? AND run_id = ?'
      ).get(roomId, runId)),
      withRetentionTransaction: (run) => {
        sqlite.exec('BEGIN IMMEDIATE')
        try {
          const result = run()
          sqlite.exec('COMMIT')
          return result
        } catch (error) {
          if (sqlite.isTransaction) sqlite.exec('ROLLBACK')
          throw error
        }
      }
    })
    return { runs, sqlite, close: () => sqlite.close() }
  }

  type PhysicalAcceptanceCommit = (
    report: AndroidAcceptanceReport,
    lease: { id: string; deviceId: string; roomId: string },
    fence: AndroidAppLocaleRestoreFence,
    gate: {
      token: string
      leaseId: string
      deviceId: string
      roomId: string
      ownerWorkerId: string
    }
  ) => AndroidAcceptanceReport

  function beforePhysicalCommit(test: ReturnType<typeof setupPhysical>, mutate: () => void): void {
    const internal = test.orch as unknown as {
      commitPhysicalAndroidAcceptanceReport: PhysicalAcceptanceCommit
    }
    const commit = internal.commitPhysicalAndroidAcceptanceReport.bind(test.orch)
    vi.spyOn(internal, 'commitPhysicalAndroidAcceptanceReport').mockImplementation((report, lease, fence, gate) => {
      mutate()
      return commit(report, lease, fence, gate)
    })
  }

  it('seals and rereads one secret-safe emulator report while atomically pinning exact run bytes', async () => {
    const test = setup()
    const verificationTransactions: boolean[] = []
    const verifyLog = test.orch.runs.verifyRetainedReference.bind(test.orch.runs)
    vi.spyOn(test.orch.runs, 'verifyRetainedReference').mockImplementation((...args) => {
      verificationTransactions.push(test.db.sqlite.isTransaction)
      return verifyLog(...args)
    })
    const result = await test.orch.createAndroidAcceptanceReport(ROOM_ID, {
      applicationId: APP_ID,
      steps: [{ id: 'instrumented-login', status: 'pass', logRunIds: [test.runId] }]
    }, 'agent')

    expect(result.report).toMatchObject({
      schema: 1,
      roomId: ROOM_ID,
      stage: 'development',
      status: 'pass',
      target: { kind: 'emulator', deviceId: null, apiLevel: 35, leaseIdentity: null },
      build: { changeId: CHANGE_ID, apkSha256: APK_SHA256 },
      locale: {
        scope: 'app',
        apiLevel: 35,
        localeTags: ['en-US'],
        systemTag: 'ko-KR',
        restored: true,
        readiness: { consecutiveReadyChecks: 2, pids: [101] }
      },
      logs: [expect.objectContaining({ runId: test.runId })]
    })
    expect(test.orch.androidAcceptanceReports.isRunPinned(ROOM_ID, test.runId)).toBe(true)
    expect(test.orch.listAndroidAcceptanceReports(ROOM_ID)).toEqual([
      expect.objectContaining({ id: result.report.id, seal: result.report.seal })
    ])
    expect(test.orch.getAndroidAcceptanceReport(ROOM_ID, result.report.id)).toEqual(result)
    expect(JSON.stringify(result)).not.toContain(test.rawSecret)
    expect(JSON.stringify(result)).not.toContain('test-command')
    expect(result.report.room.sourceIdentity.value).not.toBe(test.backend.workspaceFingerprintValue)
    expect(verificationTransactions).toContain(false)
    expect(verificationTransactions.filter(Boolean)).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain(`"sourceFingerprint":"${test.backend.workspaceFingerprintValue}"`)
    expect(JSON.stringify(result)).not.toMatch(/"leaseId"\s*:|"serial"\s*:|[A-Z]:\\/)

    const logPath = join(test.userData, 'rooms', ROOM_ID, 'runs', test.runId, 'stdout.log')
    writeFileSync(logPath, Buffer.alloc(result.report.logs[0]!.sizeBytes, 0x78))
    expect(() => test.orch.getAndroidAcceptanceReport(ROOM_ID, result.report.id))
      .toThrowError(expect.objectContaining({ code: 'ANDROID_ACCEPTANCE_EVIDENCE_CORRUPT' }))
  })

  it('publishes no report when the Room source changes across the final source fence', async () => {
    const test = setup()
    vi.spyOn(test.backend, 'fingerprintWorkspace')
      .mockResolvedValueOnce('f'.repeat(64))
      .mockResolvedValueOnce('e'.repeat(64))

    await expect(test.orch.createAndroidAcceptanceReport(ROOM_ID, {
      applicationId: APP_ID,
      steps: [{ id: 'source-race', status: 'pass', logRunIds: [test.runId] }]
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_ACCEPTANCE_SOURCE_CHANGED' })
    expect(test.orch.listAndroidAcceptanceReports(ROOM_ID)).toEqual([])
    expect(test.orch.androidAcceptanceReports.isRunPinned(ROOM_ID, test.runId)).toBe(false)
  })

  it('rejects an external workspace writer that races the final device restoration', async () => {
    const test = setup({ sourceDriftDuringRestore: true })

    await expect(test.orch.createAndroidAcceptanceReport(ROOM_ID, {
      applicationId: APP_ID,
      steps: [{ id: 'external-writer-race', status: 'pass', logRunIds: [test.runId] }]
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_ACCEPTANCE_SOURCE_CHANGED' })

    expect(test.backend.pauseRoomArtifactWebCalls.length).toBeGreaterThanOrEqual(4)
    expect(test.backend.restoreRoomArtifactWebCalls).toHaveLength(1)
    expect(test.orch.settings.get(`androidAcceptanceRestorePending:${ROOM_ID}`)).toBeNull()
    expect(test.orch.listAndroidAcceptanceReports(ROOM_ID)).toEqual([])
    expect(test.orch.androidAcceptanceReports.isRunPinned(ROOM_ID, test.runId)).toBe(false)
  })

  it('seals the immutable source snapshot when a writer lands immediately after the last live hash', async () => {
    const test = setup()
    let racedAfterLastLiveHash = false
    test.backend.fingerprintWorkspaceHandler = (workspaceVolumeOverride) => {
      if (workspaceVolumeOverride) {
        return test.backend.workspaceVolumeFingerprints.get(workspaceVolumeOverride) ??
          test.backend.workspaceFingerprintValue
      }
      const observed = test.backend.workspaceFingerprintValue
      if (!racedAfterLastLiveHash && test.backend.pauseRoomArtifactWebCalls.length >= 4) {
        racedAfterLastLiveHash = true
        test.backend.workspaceFingerprintValue = 'e'.repeat(64)
      }
      return observed
    }

    const result = await test.orch.createAndroidAcceptanceReport(ROOM_ID, {
      applicationId: APP_ID,
      steps: [{ id: 'post-hash-writer', status: 'pass', logRunIds: [test.runId] }]
    }, 'agent')

    expect(racedAfterLastLiveHash).toBe(true)
    expect(test.backend.workspaceFingerprintValue).toBe('e'.repeat(64))
    expect(result.report.room.sourceIdentity).toEqual(result.report.build.sourceIdentity)
    expect(test.orch.settings.get(`androidAcceptanceRestorePending:${ROOM_ID}`)).toBeNull()
  })

  it('rejects screenshot evidence captured from a replaced same-API device', async () => {
    const test = setup()
    const capturedAt = new Date(Date.now() - 1_000).toISOString()
    const metadata: AndroidScreenshotArtifactMetadata = {
      schema: 1,
      room: { id: ROOM_ID, stateRevision: 7, workspaceVolumeRevision: 3 },
      capture: {
        source: 'adb',
        capturedAt,
        width: 3,
        height: 2,
        orientation: 'landscape'
      },
      device: {
        kind: 'emulator',
        deviceId: null,
        model: 'Older Pixel',
        androidVersion: '14',
        apiLevel: 35
      },
      app: { status: 'tracked-active', packageName: APP_ID },
      locale: { tag: 'en-US', scope: 'app' },
      build: { exact: true, changeId: CHANGE_ID, apkSha256: APK_SHA256, installedAt: INSTALLED_AT },
      association: { changeId: null, runId: null }
    }
    const screenshot = test.orch.artifacts.publishScreenshot({
      roomId: ROOM_ID,
      filename: 'stale-device.png',
      png: screenshotPng(3, 2),
      actor: 'agent',
      createdAt: capturedAt,
      metadata
    })

    await expect(test.orch.createAndroidAcceptanceReport(ROOM_ID, {
      applicationId: APP_ID,
      steps: [{ id: 'same-api-replacement', status: 'pass', screenshotArtifactIds: [screenshot.id] }]
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_ACCEPTANCE_SCREENSHOT_MISMATCH' })
    expect(test.orch.listAndroidAcceptanceReports(ROOM_ID)).toEqual([])
  })

  it('lets an unproven crash restoration dominate and publishes no report or run pin', async () => {
    const test = setup({ crashFailure: true, restoreFailure: true })

    await expect(test.orch.createAndroidAcceptanceReport(ROOM_ID, {
      applicationId: APP_ID,
      includeCrashScenario: true,
      steps: [{ id: 'crash-recovery', status: 'pass', logRunIds: [test.runId] }]
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_ACCEPTANCE_RESTORE_FAILED' })

    expect(test.calls.launch).toBe(3)
    expect(test.calls.applyLocales).toBe(3)
    expect(test.orch.listAndroidAcceptanceReports(ROOM_ID)).toEqual([])
    expect(test.orch.androidAcceptanceReports.isRunPinned(ROOM_ID, test.runId)).toBe(false)
  })

  it('restores after a crash probe failure before returning the primary error', async () => {
    const test = setup({ crashFailure: true })

    await expect(test.orch.createAndroidAcceptanceReport(ROOM_ID, {
      applicationId: APP_ID,
      includeCrashScenario: true,
      steps: [{ id: 'crash-primary', status: 'pass', logRunIds: [test.runId] }]
    }, 'agent')).rejects.toThrow('crash probe failed')

    expect(test.calls.launch).toBe(2)
    expect(test.calls.applyLocales).toBe(2)
    expect(test.orch.listAndroidAcceptanceReports(ROOM_ID)).toEqual([])
    expect(test.orch.androidAcceptanceReports.isRunPinned(ROOM_ID, test.runId)).toBe(false)
  })

  it('keeps the crash primary dominant when a retry proves restoration', async () => {
    const test = setup({ crashFailure: true, firstRestoreFailure: true })

    await expect(test.orch.createAndroidAcceptanceReport(ROOM_ID, {
      applicationId: APP_ID,
      includeCrashScenario: true,
      steps: [{ id: 'crash-retry', status: 'pass', logRunIds: [test.runId] }]
    }, 'agent')).rejects.toThrow('crash probe failed')

    expect(test.calls.launch).toBe(3)
    expect(test.calls.applyLocales).toBe(3)
    expect(test.orch.listAndroidAcceptanceReports(ROOM_ID)).toEqual([])
    expect(test.orch.androidAcceptanceReports.isRunPinned(ROOM_ID, test.runId)).toBe(false)
  })

  it('publishes crash evidence only after exact app-locale and stable PID restoration', async () => {
    const test = setup()

    const result = await test.orch.createAndroidAcceptanceReport(ROOM_ID, {
      applicationId: APP_ID,
      includeCrashScenario: true,
      steps: [{ id: 'crash-success', status: 'pass', logRunIds: [test.runId] }]
    }, 'agent')

    expect(test.calls.launch).toBe(2)
    expect(test.calls.applyLocales).toBe(2)
    expect(result.report).toMatchObject({
      status: 'pass',
      crash: { observed: true, pidsBefore: [101], pidsAfter: [] },
      locale: { restored: true, readiness: { consecutiveReadyChecks: 2, pids: [101] } }
    })
  })

  it('owns a bounded durable restore intent before the first crash mutation and clears it after proof', async () => {
    const test = setup()
    const key = `androidAcceptanceRestorePending:${ROOM_ID}`
    const crashScenario = test.session.crashScenario
    let observedIntent: string | null = null
    test.backend.pauseRoomArtifactWebHandler = async () => {
      if (test.backend.pauseRoomArtifactWebCalls.length !== 1) return
      const raw = test.orch.settings.get(key)
      expect(raw).not.toBeNull()
      expect(JSON.parse(raw!)).toMatchObject({
        runtimeFence: {
          containerId: 'e'.repeat(64),
          workspaceVolume: `dh-${ROOM_ID}-src-r3`,
          runtimeSpecSha256: 'f'.repeat(64),
          volumeSetSha256: 'b'.repeat(64),
          networkAuthorityId: 'a'.repeat(64),
          networkId: 'c'.repeat(64)
        }
      })
    }
    test.session.crashScenario = async () => {
      observedIntent = test.orch.settings.get(key)
      expect(observedIntent).not.toBeNull()
      expect(Buffer.byteLength(observedIntent!, 'utf8')).toBeLessThanOrEqual(8 * 1024)
      expect(JSON.parse(observedIntent!)).toMatchObject({
        version: 1,
        roomStateRevision: 7,
        workspaceVolumeRevision: 3,
        applicationId: APP_ID,
        install: {
          targetKind: 'emulator',
          targetId: ROOM_ID,
          leaseId: null,
          packageIncarnation: 'b'.repeat(64),
          installUserId: 0,
          installUserSerial: 42
        },
        originalLocale: { apiLevel: 35, localeTags: ['en-US'], pids: [101] }
      })
      return crashScenario()
    }

    await test.orch.createAndroidAcceptanceReport(ROOM_ID, {
      applicationId: APP_ID,
      includeCrashScenario: true,
      steps: [{ id: 'durable-crash', status: 'pass', logRunIds: [test.runId] }]
    }, 'agent')

    expect(observedIntent).not.toBeNull()
    expect(test.orch.settings.get(key)).toBeNull()
  })

  it('runs no acceptance writer when another process wins a distinct Room recovery intent after preflight', async () => {
    const test = setup()
    const localeKey = `androidLocaleRestorePending:${ROOM_ID}`
    const acceptanceKey = `androidAcceptanceRestorePending:${ROOM_ID}`
    const artifactKey = `artifactExportPending:${ROOM_ID}`
    const keys = [localeKey, acceptanceKey, artifactKey] as const
    const competingValue = JSON.stringify({ version: 'foreign-locale-owner' })
    const runtimeFence = {
      containerId: 'e'.repeat(64),
      workspaceVolume: `dh-${ROOM_ID}-src-r3`,
      runtimeSpecSha256: 'f'.repeat(64),
      volumeSetSha256: 'b'.repeat(64),
      networkAuthorityId: 'a'.repeat(64),
      networkId: 'c'.repeat(64),
      networkSandboxId: 'd'.repeat(64)
    }
    let competingClaim = false
    test.backend.captureRoomArtifactWebFenceHandler = () => {
      // createAndroidAcceptanceReport already passed withRoomLock's advisory
      // reads. Model a second desktop process winning just before this process
      // attempts its distinct acceptance-intent insert.
      withSecondConnection(test, (sqlite) => {
        competingClaim = settingsRepo({ sqlite, close() {} })
          .setIfAbsentWhenKeysAbsent(localeKey, competingValue, keys)
      })
      return runtimeFence
    }

    await expect(test.orch.createAndroidAcceptanceReport(ROOM_ID, {
      applicationId: APP_ID,
      includeCrashScenario: true,
      steps: [{ id: 'cross-process-intent-race', status: 'pass', logRunIds: [test.runId] }]
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_ACCEPTANCE_RESTORE_REQUIRED' })

    expect(competingClaim).toBe(true)
    expect(test.orch.settings.get(localeKey)).toBe(competingValue)
    expect(test.orch.settings.get(acceptanceKey)).toBeNull()
    expect(test.calls.launch).toBe(0)
    expect(test.calls.applyLocales).toBe(0)
    expect(test.backend.pauseRoomArtifactWebCalls).toEqual([])
    expect(test.backend.restoreRoomArtifactWebCalls).toEqual([])
    expect(test.backend.calls.some((call) => call.startsWith('copyVolume:'))).toBe(false)
    expect(test.orch.listAndroidAcceptanceReports(ROOM_ID)).toEqual([])
  })

  it('retains a failed restore intent as a mutation gate and recovers it during startup', async () => {
    const test = setup({ restoreFailure: true })
    const key = `androidAcceptanceRestorePending:${ROOM_ID}`

    await expect(test.orch.createAndroidAcceptanceReport(ROOM_ID, {
      applicationId: APP_ID,
      includeCrashScenario: true,
      steps: [{ id: 'startup-recovery', status: 'pass', logRunIds: [test.runId] }]
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_ACCEPTANCE_RESTORE_FAILED' })

    const retained = test.orch.settings.get(key)
    expect(retained).not.toBeNull()
    await expect(test.orch.androidRunCrashScenario(ROOM_ID, {
      applicationId: APP_ID,
      scenario: 'am-crash',
      runId: 'blocked-while-restore-pending',
      target: { kind: 'emulator' }
    })).rejects.toMatchObject({ code: 'ANDROID_ACCEPTANCE_RESTORE_REQUIRED' })

    test.behavior.restoreFailure = false
    // Recovery must also repair status left by an older shutdown/reconcile
    // implementation instead of deadlocking behind its own pending gate.
    test.orch.rooms.update(ROOM_ID, { status: 'sleeping' })
    await test.orch.init()

    expect(test.orch.settings.get(key)).toBeNull()
    expect(test.calls.launch).toBe(4)
    expect(test.calls.applyLocales).toBe(4)
    expect(test.orch.listAndroidAcceptanceReports(ROOM_ID)).toEqual([])
  })

  it('publishes final physical metadata from unchanged composite proofs with zero external writers', async () => {
    const test = setupPhysical()
    const fingerprint = vi.spyOn(test.backend, 'fingerprintWorkspace')
    const verificationTransactions: boolean[] = []
    const verifyLog = test.orch.runs.verifyRetainedReference.bind(test.orch.runs)
    vi.spyOn(test.orch.runs, 'verifyRetainedReference').mockImplementation((...args) => {
      verificationTransactions.push(test.db.sqlite.isTransaction)
      return verifyLog(...args)
    })

    const result = await test.orch.createAndroidAcceptanceReport(ROOM_ID, {
      applicationId: APP_ID,
      stage: 'final-physical',
      target: { kind: 'physical', deviceId: test.deviceId },
      steps: [{ id: 'physical-observation', status: 'pass', logRunIds: [test.runId] }]
    }, 'agent')

    expect(result.report).toMatchObject({
      stage: 'final-physical',
      target: { kind: 'physical', deviceId: test.deviceId },
      locale: {
        localeTags: ['en-US'],
        systemTag: null,
        restored: true,
        process: { beforePids: [101], afterPids: [101], restarted: false }
      },
      crash: null
    })
    expect(test.calls.physical).toEqual({
      snapshot: 1,
      prove: 2,
      screenWitness: 0,
      foregroundEvidence: 0,
      launch: 0,
      crash: 0,
      applyLocales: 0,
      restoreLocales: 0
    })
    expect(fingerprint).not.toHaveBeenCalled()
    expect(test.backend.captureRoomArtifactWebFenceCalls).toEqual([])
    expect(test.backend.pauseRoomArtifactWebCalls).toEqual([])
    expect(test.backend.restoreRoomArtifactWebCalls).toEqual([])
    expect(test.backend.calls).toEqual([])
    expect(test.orch.settings.get(`androidAcceptanceRestorePending:${ROOM_ID}`)).toBeNull()
    expect(test.orch.androidAcceptanceReports.isRunPinned(ROOM_ID, test.runId)).toBe(true)
    expect(verificationTransactions).toEqual([false, true])
  })

  it('rejects a physical writer after the final proof gate is acquired and never invokes its Host callback', async () => {
    const test = setupPhysical()
    const originalProof = test.physicalSession.proveAppLocaleFinalState
    let hostCalls = 0
    const internal = test.orch as unknown as {
      withDeviceHeartbeat<T>(
        roomId: string,
        deviceId: string,
        leaseId: string,
        run: (signal: AbortSignal) => Promise<T>,
        busy?: boolean,
        callerSignal?: AbortSignal,
        mode?: 'writer' | 'read' | 'proof'
      ): Promise<T>
    }
    test.physicalSession.proveAppLocaleFinalState = async () => {
      const result = await originalProof()
      if (test.calls.physical.prove === 2) {
        await expect(internal.withDeviceHeartbeat(
          ROOM_ID,
          test.deviceId,
          test.leaseId,
          async () => {
            hostCalls += 1
            return { code: 0, stdout: '', stderr: '' }
          }
        )).rejects.toMatchObject({ code: 'ANDROID_ACCEPTANCE_PROOF_ACTIVE' })
      }
      return result
    }

    await expect(test.orch.createAndroidAcceptanceReport(ROOM_ID, {
      applicationId: APP_ID,
      stage: 'final-physical',
      target: { kind: 'physical', deviceId: test.deviceId },
      steps: [{ id: 'proof-blocks-writer', status: 'pass', logRunIds: [test.runId] }]
    }, 'agent')).resolves.toMatchObject({ report: { stage: 'final-physical' } })

    expect(hostCalls).toBe(0)
    expect(test.db.sqlite.prepare('SELECT COUNT(*) AS count FROM android_physical_operation_intents').get())
      .toEqual({ count: 0 })
    expect(test.db.sqlite.prepare('SELECT COUNT(*) AS count FROM android_physical_acceptance_proof_gates').get())
      .toEqual({ count: 0 })
  })

  it('blocks every physical Host ADB gateway under a live proof before target or receipt side effects', async () => {
    const test = setupPhysical()
    test.openSessionSpy.mockRestore()
    const stagedApk = join(test.userData, 'proof-gated.apk')
    writeFileSync(stagedApk, Buffer.from('sealed-apk-test-bytes'))
    const receiptBefore = structuredClone(test.orch.androidInstalls.get(ROOM_ID, test.target, APP_ID))
    const internal = test.orch as unknown as {
      beginPhysicalAcceptanceProof(lease: { id: string; deviceId: string; roomId: string }): {
        token: string
        leaseId: string
        deviceId: string
        roomId: string
        ownerWorkerId: string
      }
      releasePhysicalAcceptanceProof(gate: {
        token: string
        leaseId: string
        deviceId: string
        roomId: string
        ownerWorkerId: string
      }): void
      installStagedApkOnPhysicalLocked(
        roomId: string,
        deviceId: string,
        leaseId: string,
        applicationId: string,
        stagedApk: string,
        publicRoomPath: string
      ): Promise<unknown>
    }
    const gate = internal.beginPhysicalAcceptanceProof({
      id: test.leaseId,
      deviceId: test.deviceId,
      roomId: ROOM_ID
    })
    try {
      await expect(test.orch.androidLaunchApp(ROOM_ID, {
        applicationId: APP_ID,
        target: { kind: 'physical', deviceId: test.deviceId }
      })).rejects.toMatchObject({ code: 'ANDROID_ACCEPTANCE_PROOF_ACTIVE' })
      await expect(test.orch.adbOnDevice(
        ROOM_ID,
        ['shell', 'input', 'keyevent', '4'],
        { deviceId: test.deviceId }
      )).rejects.toMatchObject({ code: 'ANDROID_ACCEPTANCE_PROOF_ACTIVE' })
      await expect(test.orch.androidScreenshot(ROOM_ID, 'auto'))
        .rejects.toMatchObject({ code: 'ANDROID_ACCEPTANCE_PROOF_ACTIVE' })
      await expect(internal.installStagedApkOnPhysicalLocked(
        ROOM_ID,
        test.deviceId,
        test.leaseId,
        APP_ID,
        stagedApk,
        '[sealed test APK]'
      )).rejects.toMatchObject({ code: 'ANDROID_ACCEPTANCE_PROOF_ACTIVE' })
    } finally {
      internal.releasePhysicalAcceptanceProof(gate)
    }

    expect(test.adb.execs).toEqual([])
    expect(test.orch.androidInstalls.get(ROOM_ID, test.target, APP_ID)).toEqual(receiptBefore)
    expect(test.db.sqlite.prepare('SELECT COUNT(*) AS count FROM android_physical_operation_intents').get())
      .toEqual({ count: 0 })
  })

  it('retains a crashed writer intent as a device-wide hard gate for proof and later writers', async () => {
    const test = setupPhysical()
    const staleIntentId = '12121212-3434-4567-8899-abcdefabcdef'
    withSecondConnection(test, (sqlite) => {
      sqlite.prepare(
        `INSERT INTO android_physical_operation_intents
           (id, lease_id, device_id, room_id, owner_worker_id, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(staleIntentId, test.leaseId, test.deviceId, ROOM_ID, 'pid:999999', new Date().toISOString())
      expect(() => sqlite.prepare(
        `INSERT INTO android_physical_operation_intents
           (id, lease_id, device_id, room_id, owner_worker_id, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        '13131313-3434-4567-8899-abcdefabcdef',
        test.leaseId,
        test.deviceId,
        ROOM_ID,
        `pid:${process.pid}`,
        new Date().toISOString()
      )).toThrow(/UNIQUE constraint failed/i)
    })
    test.openSessionSpy.mockClear()

    await expect(test.orch.createAndroidAcceptanceReport(ROOM_ID, {
      applicationId: APP_ID,
      stage: 'final-physical',
      target: { kind: 'physical', deviceId: test.deviceId },
      steps: [{ id: 'stale-writer-hard-gate', status: 'pass', logRunIds: [test.runId] }]
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_ACCEPTANCE_TARGET_BUSY' })

    expect(test.openSessionSpy).not.toHaveBeenCalled()
    expect(test.orch.listAndroidAcceptanceReports(ROOM_ID)).toEqual([])
    expect(test.orch.androidAcceptanceReports.isRunPinned(ROOM_ID, test.runId)).toBe(false)
    expect(test.db.sqlite.prepare(
      'SELECT id, lease_id AS leaseId FROM android_physical_operation_intents WHERE device_id = ?'
    ).get(test.deviceId)).toEqual({ id: staleIntentId, leaseId: test.leaseId })
  })

  it('does not let lease replacement bypass a crashed device-wide writer intent', () => {
    const test = setupPhysical()
    const nextLeaseId = '99999999-8888-4777-aaaa-bbbbbbbbbbbb'
    withSecondConnection(test, (sqlite) => {
      sqlite.prepare(
        `INSERT INTO android_physical_operation_intents
           (id, lease_id, device_id, room_id, owner_worker_id, started_at)
         VALUES (?, ?, ?, ?, 'pid:999999', ?)`
      ).run('14141414-3434-4567-8899-abcdefabcdef', test.leaseId, test.deviceId, ROOM_ID, new Date().toISOString())
      sqlite.prepare(
        `UPDATE android_device_leases
            SET state = 'released', released_at = ?, release_reason = 'test replacement'
          WHERE id = ?`
      ).run(new Date().toISOString(), test.leaseId)
      sqlite.prepare(
        `INSERT INTO android_device_leases (
           id, device_id, room_id, project, issue_ref, run_id, worker_id, purpose, state,
           acquired_at, heartbeat_at, activity_at, ttl_ms, max_duration_ms, released_at, release_reason
         ) VALUES (?, ?, ?, 'Example', NULL, NULL, ?, 'acceptance', 'active', ?, ?, ?, 600000, 3600000, NULL, NULL)`
      ).run(
        nextLeaseId,
        test.deviceId,
        ROOM_ID,
        `pid:${process.pid}`,
        new Date().toISOString(),
        new Date().toISOString(),
        new Date().toISOString()
      )
    })
    const internal = test.orch as unknown as {
      beginPhysicalDeviceOperation(roomId: string, deviceId: string, leaseId: string): unknown
    }

    expect(() => internal.beginPhysicalDeviceOperation(ROOM_ID, test.deviceId, nextLeaseId))
      .toThrow(/prior physical Android writer may still own this target/i)
    expect(test.db.sqlite.prepare(
      'SELECT lease_id AS leaseId FROM android_physical_operation_intents WHERE device_id = ?'
    ).get(test.deviceId)).toEqual({ leaseId: test.leaseId })
  })

  it('clears only a provably dead read-only proof owner and retains a live replacement', () => {
    const test = setupPhysical()
    const internal = test.orch as unknown as {
      reconcileInterruptedPhysicalAcceptanceProofGates(): void
    }
    const insert = test.db.sqlite.prepare(
      `INSERT INTO android_physical_acceptance_proof_gates
         (token, lease_id, device_id, room_id, owner_worker_id, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    insert.run(
      '15151515-3434-4567-8899-abcdefabcdef',
      test.leaseId,
      test.deviceId,
      ROOM_ID,
      'pid:0',
      new Date().toISOString()
    )

    internal.reconcileInterruptedPhysicalAcceptanceProofGates()
    expect(test.db.sqlite.prepare('SELECT COUNT(*) AS count FROM android_physical_acceptance_proof_gates').get())
      .toEqual({ count: 0 })

    insert.run(
      '16161616-3434-4567-8899-abcdefabcdef',
      test.leaseId,
      test.deviceId,
      ROOM_ID,
      `pid:${process.pid}`,
      new Date().toISOString()
    )
    internal.reconcileInterruptedPhysicalAcceptanceProofGates()
    expect(test.db.sqlite.prepare(
      'SELECT token, owner_worker_id AS ownerWorkerId FROM android_physical_acceptance_proof_gates'
    ).get()).toEqual({
      token: '16161616-3434-4567-8899-abcdefabcdef',
      ownerWorkerId: `pid:${process.pid}`
    })
  })

  it('rolls back report, run pins, and proof-gate release when publication fails after insert', async () => {
    const test = setupPhysical()
    const insert = test.orch.androidAcceptanceReports.insert.bind(test.orch.androidAcceptanceReports)
    vi.spyOn(test.orch.androidAcceptanceReports, 'insert').mockImplementation((report) => {
      insert(report)
      throw new Error('simulated failure after report and run-pin insert')
    })

    await expect(test.orch.createAndroidAcceptanceReport(ROOM_ID, {
      applicationId: APP_ID,
      stage: 'final-physical',
      target: { kind: 'physical', deviceId: test.deviceId },
      steps: [{ id: 'atomic-publication-rollback', status: 'pass', logRunIds: [test.runId] }]
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_ACCEPTANCE_STORE_FAILED' })

    expect(test.db.sqlite.prepare('SELECT COUNT(*) AS count FROM android_acceptance_reports').get())
      .toEqual({ count: 0 })
    expect(test.db.sqlite.prepare('SELECT COUNT(*) AS count FROM android_acceptance_run_snapshots').get())
      .toEqual({ count: 0 })
    expect(test.db.sqlite.prepare('SELECT COUNT(*) AS count FROM android_acceptance_report_runs').get())
      .toEqual({ count: 0 })
    expect(test.db.sqlite.prepare('SELECT COUNT(*) AS count FROM android_physical_acceptance_proof_gates').get())
      .toEqual({ count: 0 })
  })

  it('rejects an old proof token and preserves the exact replacement gate', async () => {
    const test = setupPhysical()
    const replacementToken = '17171717-3434-4567-8899-abcdefabcdef'
    beforePhysicalCommit(test, () => withSecondConnection(test, (sqlite) => {
      const prior = sqlite.prepare(
        `SELECT lease_id, device_id, room_id
           FROM android_physical_acceptance_proof_gates
          WHERE device_id = ?`
      ).get(test.deviceId) as { lease_id: string; device_id: string; room_id: string }
      sqlite.prepare('DELETE FROM android_physical_acceptance_proof_gates WHERE device_id = ?').run(test.deviceId)
      sqlite.prepare(
        `INSERT INTO android_physical_acceptance_proof_gates
           (token, lease_id, device_id, room_id, owner_worker_id, started_at)
         VALUES (?, ?, ?, ?, 'foreign-worker', ?)`
      ).run(replacementToken, prior.lease_id, prior.device_id, prior.room_id, new Date().toISOString())
    }))

    await expect(test.orch.createAndroidAcceptanceReport(ROOM_ID, {
      applicationId: APP_ID,
      stage: 'final-physical',
      target: { kind: 'physical', deviceId: test.deviceId },
      steps: [{ id: 'replacement-proof-gate', status: 'pass', logRunIds: [test.runId] }]
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_ACCEPTANCE_PROOF_CHANGED' })

    expect(test.orch.listAndroidAcceptanceReports(ROOM_ID)).toEqual([])
    expect(test.orch.androidAcceptanceReports.isRunPinned(ROOM_ID, test.runId)).toBe(false)
    expect(test.db.sqlite.prepare(
      'SELECT token, owner_worker_id AS ownerWorkerId FROM android_physical_acceptance_proof_gates'
    ).get()).toEqual({ token: replacementToken, ownerWorkerId: 'foreign-worker' })
  })

  it('fails a prune-first publication during final in-transaction log verification', async () => {
    const test = setupPhysical()
    const newer = test.orch.runs.begin(ROOM_ID, ['newer-before-prune'], 'agent', { maxBytes: 256 })
    newer.push('stdout', `newer:${'x'.repeat(2_000)}\n`)
    test.orch.runs.complete(newer, 0)
    const pruner = secondRetentionStore(test)
    beforePhysicalCommit(test, () => pruner.runs.prune(ROOM_ID))

    try {
      await expect(test.orch.createAndroidAcceptanceReport(ROOM_ID, {
        applicationId: APP_ID,
        stage: 'final-physical',
        target: { kind: 'physical', deviceId: test.deviceId },
        steps: [{ id: 'prune-first', status: 'pass', logRunIds: [test.runId] }]
      }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_ACCEPTANCE_LOG_CHANGED' })
    } finally {
      pruner.close()
    }

    expect(() => test.orch.runs.retainedReference(ROOM_ID, test.runId, 4_000_000)).toThrow()
    expect(test.orch.listAndroidAcceptanceReports(ROOM_ID)).toEqual([])
    expect(test.orch.androidAcceptanceReports.isRunPinned(ROOM_ID, test.runId)).toBe(false)
    expect(test.db.sqlite.prepare('SELECT COUNT(*) AS count FROM android_physical_acceptance_proof_gates').get())
      .toEqual({ count: 0 })
  })

  it('skips a second-process prune while report publication owns BEGIN IMMEDIATE, then preserves the pin', async () => {
    const test = setupPhysical()
    const newer = test.orch.runs.begin(ROOM_ID, ['newer-before-busy-prune'], 'agent', { maxBytes: 256 })
    newer.push('stdout', `newer:${'x'.repeat(2_000)}\n`)
    test.orch.runs.complete(newer, 0)
    const pruner = secondRetentionStore(test)
    let pruneAttempts = 0
    let pruneAcquired = 0
    const busyPruner = new RunOutputStore(test.userData, {
      maxRetainedRuns: 1,
      isPinned: (roomId, runId) => Boolean(pruner.sqlite.prepare(
        'SELECT 1 FROM android_acceptance_run_snapshots WHERE room_id = ? AND run_id = ?'
      ).get(roomId, runId)),
      withRetentionTransaction: (run) => {
        pruneAttempts += 1
        pruner.sqlite.exec('BEGIN IMMEDIATE')
        pruneAcquired += 1
        try {
          const result = run()
          pruner.sqlite.exec('COMMIT')
          return result
        } catch (error) {
          if (pruner.sqlite.isTransaction) pruner.sqlite.exec('ROLLBACK')
          throw error
        }
      }
    })
    const insert = test.orch.androidAcceptanceReports.insert.bind(test.orch.androidAcceptanceReports)
    vi.spyOn(test.orch.androidAcceptanceReports, 'insert').mockImplementation((report) => {
      busyPruner.prune(ROOM_ID)
      expect(test.db.sqlite.isTransaction).toBe(true)
      expect(() => test.orch.runs.retainedReference(ROOM_ID, test.runId, 4_000_000)).not.toThrow()
      return insert(report)
    })

    let result: Awaited<ReturnType<typeof test.orch.createAndroidAcceptanceReport>>
    try {
      result = await test.orch.createAndroidAcceptanceReport(ROOM_ID, {
        applicationId: APP_ID,
        stage: 'final-physical',
        target: { kind: 'physical', deviceId: test.deviceId },
        steps: [{ id: 'busy-prune-skip', status: 'pass', logRunIds: [test.runId] }]
      }, 'agent')
      expect(pruneAttempts).toBe(1)
      expect(pruneAcquired).toBe(0)
      pruner.runs.prune(ROOM_ID)
      expect(test.orch.androidAcceptanceReports.isRunPinned(ROOM_ID, test.runId)).toBe(true)
      expect(test.orch.runs.retainedReference(ROOM_ID, test.runId, 4_000_000).runId).toBe(test.runId)
      expect(test.orch.getAndroidAcceptanceReport(ROOM_ID, result.report.id).report.id).toBe(result.report.id)
    } finally {
      pruner.close()
    }
  })

  it('keeps report-first pinned log bytes through later transactional pruning', async () => {
    const test = setupPhysical()
    const result = await test.orch.createAndroidAcceptanceReport(ROOM_ID, {
      applicationId: APP_ID,
      stage: 'final-physical',
      target: { kind: 'physical', deviceId: test.deviceId },
      steps: [{ id: 'report-first', status: 'pass', logRunIds: [test.runId] }]
    }, 'agent')

    for (let index = 0; index < 24; index += 1) {
      const run = test.orch.runs.begin(ROOM_ID, ['newer', String(index)], 'agent', { maxBytes: 256 })
      run.push('stdout', `${index}:${'x'.repeat(2_000)}\n`)
      test.orch.runs.complete(run, 0)
    }

    expect(test.orch.androidAcceptanceReports.isRunPinned(ROOM_ID, test.runId)).toBe(true)
    expect(test.orch.runs.retainedReference(ROOM_ID, test.runId, 4_000_000).runId).toBe(test.runId)
    expect(test.orch.getAndroidAcceptanceReport(ROOM_ID, result.report.id).report.id).toBe(result.report.id)
  })

  it('rejects a physical crash request in shared parsing before lease, session, backend, or pending work', async () => {
    const test = setupPhysical()
    const lease = vi.spyOn(test.orch.devices, 'leaseForRoom')
    const fingerprint = vi.spyOn(test.backend, 'fingerprintWorkspace')
    test.openSessionSpy.mockClear()

    await expect(test.orch.createAndroidAcceptanceReport(ROOM_ID, {
      applicationId: APP_ID,
      stage: 'final-physical',
      target: { kind: 'physical', deviceId: test.deviceId },
      includeCrashScenario: true,
      steps: [{ id: 'invalid-physical-crash', status: 'pass', logRunIds: [test.runId] }]
    }, 'agent')).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ path: ['includeCrashScenario'] })])
    })

    expect(lease).not.toHaveBeenCalled()
    expect(test.openSessionSpy).not.toHaveBeenCalled()
    expect(fingerprint).not.toHaveBeenCalled()
    expect(test.backend.calls).toEqual([])
    expect(test.orch.settings.get(`androidAcceptanceRestorePending:${ROOM_ID}`)).toBeNull()
    expect(test.orch.listAndroidAcceptanceReports(ROOM_ID)).toEqual([])
    expect(test.orch.androidAcceptanceReports.isRunPinned(ROOM_ID, test.runId)).toBe(false)
  })

  it('publishes no physical report or pin when the exact lease closes before BEGIN IMMEDIATE', async () => {
    const test = setupPhysical()
    beforePhysicalCommit(test, () => withSecondConnection(test, (sqlite) => {
      sqlite.prepare(
        `UPDATE android_device_leases
            SET state = 'released', released_at = ?, release_reason = 'test close'
          WHERE id = ?`
      ).run(new Date().toISOString(), test.leaseId)
    }))

    await expect(test.orch.createAndroidAcceptanceReport(ROOM_ID, {
      applicationId: APP_ID,
      stage: 'final-physical',
      target: { kind: 'physical', deviceId: test.deviceId },
      steps: [{ id: 'lease-close-race', status: 'pass', logRunIds: [test.runId] }]
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_ACCEPTANCE_LEASE_CHANGED' })

    expect(test.orch.listAndroidAcceptanceReports(ROOM_ID)).toEqual([])
    expect(test.orch.androidAcceptanceReports.isRunPinned(ROOM_ID, test.runId)).toBe(false)
  })

  it('publishes no physical report or pin when Room authority changes before BEGIN IMMEDIATE', async () => {
    const test = setupPhysical()
    beforePhysicalCommit(test, () => withSecondConnection(test, (sqlite) => {
      sqlite.prepare('UPDATE rooms SET state_revision = state_revision + 1 WHERE id = ?').run(ROOM_ID)
    }))

    await expect(test.orch.createAndroidAcceptanceReport(ROOM_ID, {
      applicationId: APP_ID,
      stage: 'final-physical',
      target: { kind: 'physical', deviceId: test.deviceId },
      steps: [{ id: 'room-authority-race', status: 'pass', logRunIds: [test.runId] }]
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_ACCEPTANCE_SOURCE_CHANGED' })

    expect(test.orch.listAndroidAcceptanceReports(ROOM_ID)).toEqual([])
    expect(test.orch.androidAcceptanceReports.isRunPinned(ROOM_ID, test.runId)).toBe(false)
  })

  it('publishes no physical report or pin when tracked install provenance changes before BEGIN IMMEDIATE', async () => {
    const test = setupPhysical()
    beforePhysicalCommit(test, () => withSecondConnection(test, (sqlite) => {
      sqlite.prepare(
        `UPDATE android_app_installs
            SET acceptance_source_identity_hmac = ?
          WHERE target_kind = 'physical' AND target_id = ? AND application_id = ?`
      ).run('9'.repeat(64), test.deviceId, APP_ID)
    }))

    await expect(test.orch.createAndroidAcceptanceReport(ROOM_ID, {
      applicationId: APP_ID,
      stage: 'final-physical',
      target: { kind: 'physical', deviceId: test.deviceId },
      steps: [{ id: 'install-authority-race', status: 'pass', logRunIds: [test.runId] }]
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_ACCEPTANCE_SOURCE_CHANGED' })

    expect(test.orch.listAndroidAcceptanceReports(ROOM_ID)).toEqual([])
    expect(test.orch.androidAcceptanceReports.isRunPinned(ROOM_ID, test.runId)).toBe(false)
  })

  it('moves a byte-exact sleeping pending Room through the production automation status gate', async () => {
    const test = setup({ restoreFailure: true })
    const key = `androidAcceptanceRestorePending:${ROOM_ID}`
    await expect(test.orch.createAndroidAcceptanceReport(ROOM_ID, {
      applicationId: APP_ID,
      includeCrashScenario: true,
      steps: [{ id: 'sleeping-startup-gate', status: 'pass', logRunIds: [test.runId] }]
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_ACCEPTANCE_RESTORE_FAILED' })
    test.orch.rooms.update(ROOM_ID, { status: 'sleeping' })
    test.backend.emulatorStateValue = 'exited'
    test.openSessionSpy.mockRestore()

    await test.orch.init()

    expect(test.backend.calls).toContain(`startExistingEmulatorForRecovery:${ROOM_ID}`)
    expect(test.backend.emulatorStateValue).toBe('running')
    expect(test.orch.rooms.get(ROOM_ID)?.status).toBe('attention')
    expect(test.orch.settings.get(key)).not.toBeNull()
  })

  it('withholds the report and retains the byte-exact gate when exact runtime restore fails', async () => {
    const test = setup()
    const key = `androidAcceptanceRestorePending:${ROOM_ID}`
    const room = test.orch.rooms.get(ROOM_ID)!
    test.gateway.routes.set(room.domain, {
      domain: room.domain,
      roomId: ROOM_ID,
      targetPort: room.hostPort ?? 45000,
      https: room.https
    })
    let rawBeforeRestore: string | null = null
    test.backend.restoreRoomArtifactWebHandler = async () => {
      rawBeforeRestore = test.orch.settings.get(key)
      throw new Error('exact runtime restore failed')
    }

    await expect(test.orch.createAndroidAcceptanceReport(ROOM_ID, {
      applicationId: APP_ID,
      steps: [{ id: 'runtime-restore', status: 'pass', logRunIds: [test.runId] }]
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_ACCEPTANCE_RESTORE_FAILED' })

    expect(rawBeforeRestore).not.toBeNull()
    expect(test.orch.settings.get(key)).toBe(rawBeforeRestore)
    expect(test.orch.listAndroidAcceptanceReports(ROOM_ID)).toEqual([])
    expect(test.orch.androidAcceptanceReports.isRunPinned(ROOM_ID, test.runId)).toBe(false)
    expect(test.gateway.routes.has(room.domain)).toBe(false)
    expect(test.orch.rooms.get(ROOM_ID)?.status).toBe('attention')
    await expect(test.orch.androidRunCrashScenario(ROOM_ID, {
      applicationId: APP_ID,
      scenario: 'am-crash',
      runId: 'blocked-after-runtime-restore-failure',
      target: { kind: 'emulator' }
    })).rejects.toMatchObject({ code: 'ANDROID_ACCEPTANCE_RESTORE_REQUIRED' })
  })

  it('re-proves the exact foreground target after runtime restoration before releasing CAS', async () => {
    const test = setup()
    const key = `androidAcceptanceRestorePending:${ROOM_ID}`
    test.backend.restoreRoomArtifactWebHandler = async () => {
      test.evidence.context.status.foregroundApplicationId = null
    }

    await expect(test.orch.createAndroidAcceptanceReport(ROOM_ID, {
      applicationId: APP_ID,
      steps: [{ id: 'post-runtime-target-proof', status: 'pass', logRunIds: [test.runId] }]
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_ACCEPTANCE_RESTORE_FAILED' })

    expect(test.calls.applyLocales).toBe(2)
    expect(test.orch.settings.get(key)).not.toBeNull()
    expect(test.orch.listAndroidAcceptanceReports(ROOM_ID)).toEqual([])
    expect(test.orch.androidAcceptanceReports.isRunPinned(ROOM_ID, test.runId)).toBe(false)
  })

  it('does not mutate a replacement install while startup recovery remains gated', async () => {
    const test = setup({ restoreFailure: true })
    const key = `androidAcceptanceRestorePending:${ROOM_ID}`

    await expect(test.orch.createAndroidAcceptanceReport(ROOM_ID, {
      applicationId: APP_ID,
      includeCrashScenario: true,
      steps: [{ id: 'replacement-install', status: 'pass', logRunIds: [test.runId] }]
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_ACCEPTANCE_RESTORE_FAILED' })
    const retained = test.orch.settings.get(key)
    expect(retained).not.toBeNull()

    const room = test.orch.rooms.get(ROOM_ID)!
    const integrity = new AndroidAcceptanceIntegrity(test.db)
    const imageSha256 = /@sha256:([a-f0-9]{64})$/.exec(ANDROID_IMAGE)![1]!
    test.orch.androidInstalls.record({
      roomId: ROOM_ID,
      target: { kind: 'emulator', targetId: ROOM_ID, deviceId: null },
      applicationId: APP_ID,
      changeId: CHANGE_ID,
      apkSha256: APK_SHA256,
      installedAt: INSTALLED_AT,
      packageIncarnation: '9'.repeat(64),
      logFence: null,
      installUserId: 0,
      installUserSerial: 42,
      acceptanceProvenance: {
        artifactSizeBytes: 4096,
        stateRevision: room.stateRevision,
        workspaceVolumeRevision: room.workspaceVolumeRevision,
        sourceIdentity: integrity.identify('source', test.backend.workspaceFingerprintValue),
        environmentIdentity: integrity.identify('environment', androidBuildEnvironmentRevision(room)),
        imageReference: ANDROID_IMAGE,
        imageSha256
      }
    })
    test.behavior.restoreFailure = false

    await test.orch.init()

    expect(test.orch.settings.get(key)).toBe(retained)
    expect(test.calls.launch).toBe(3)
    expect(test.calls.applyLocales).toBe(3)
    expect(test.backend.restoreRoomArtifactWebCalls).toHaveLength(2)
    expect(test.backend.calls).not.toContain(`stopRoomPod:${ROOM_ID}`)
    expect(test.orch.rooms.get(ROOM_ID)?.status).toBe('attention')
    expect(test.orch.listAndroidAcceptanceReports(ROOM_ID)).toEqual([])
  })

  it('preserves pending acceptance runtime and target authority during shutdown', async () => {
    const test = setup({ restoreFailure: true })
    const key = `androidAcceptanceRestorePending:${ROOM_ID}`

    await expect(test.orch.createAndroidAcceptanceReport(ROOM_ID, {
      applicationId: APP_ID,
      includeCrashScenario: true,
      steps: [{ id: 'shutdown-fence', status: 'pass', logRunIds: [test.runId] }]
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_ACCEPTANCE_RESTORE_FAILED' })
    const retained = test.orch.settings.get(key)
    test.backend.calls.length = 0

    await expect(test.orch.shutdown()).rejects.toThrow(/shutdown blocked/i)

    expect(test.orch.settings.get(key)).toBe(retained)
    expect(test.orch.rooms.get(ROOM_ID)?.status).not.toBe('sleeping')
    expect(test.backend.calls).not.toContain(`stopRoomPod:${ROOM_ID}`)
  })

  it('preflights pending acceptance recovery before delete-all removes any Room', async () => {
    const test = setup({ restoreFailure: true })
    const key = `androidAcceptanceRestorePending:${ROOM_ID}`

    await expect(test.orch.createAndroidAcceptanceReport(ROOM_ID, {
      applicationId: APP_ID,
      includeCrashScenario: true,
      steps: [{ id: 'delete-all-fence', status: 'pass', logRunIds: [test.runId] }]
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_ACCEPTANCE_RESTORE_FAILED' })
    const retained = test.orch.settings.get(key)
    test.backend.calls.length = 0

    await expect(test.orch.deleteAllRooms('agent'))
      .rejects.toMatchObject({ code: 'ANDROID_ACCEPTANCE_RESTORE_REQUIRED' })

    expect(test.orch.settings.get(key)).toBe(retained)
    expect(test.orch.rooms.get(ROOM_ID)).not.toBeNull()
    expect(test.backend.calls).not.toContain(`deleteRoomPod:${ROOM_ID}`)
  })

  it('preserves a foreign CAS replacement and publishes no candidate report', async () => {
    const test = setup()
    const key = `androidAcceptanceRestorePending:${ROOM_ID}`
    const foreign = '{"foreign":"restore-owner"}'
    test.backend.restoreRoomArtifactWebHandler = async () => {
      test.orch.settings.set(key, foreign)
    }

    await expect(test.orch.createAndroidAcceptanceReport(ROOM_ID, {
      applicationId: APP_ID,
      steps: [{ id: 'cas-owner', status: 'pass', logRunIds: [test.runId] }]
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_ACCEPTANCE_RESTORE_REQUIRED' })

    expect(test.orch.settings.get(key)).toBe(foreign)
    expect(test.orch.listAndroidAcceptanceReports(ROOM_ID)).toEqual([])
    expect(test.orch.androidAcceptanceReports.isRunPinned(ROOM_ID, test.runId)).toBe(false)
  })

  it('rejects pre-proof process drift after proving cleanup without misreporting restoration failure', async () => {
    const test = setup({ processDrift: true })

    await expect(test.orch.createAndroidAcceptanceReport(ROOM_ID, {
      applicationId: APP_ID,
      steps: [{ id: 'stable-process', status: 'pass', logRunIds: [test.runId] }]
    }, 'agent')).rejects.toMatchObject({ code: 'ANDROID_ACCEPTANCE_TARGET_CHANGED' })

    expect(test.calls.applyLocales).toBe(2)
    expect(test.orch.listAndroidAcceptanceReports(ROOM_ID)).toEqual([])
    expect(test.orch.androidAcceptanceReports.isRunPinned(ROOM_ID, test.runId)).toBe(false)
  })
})
