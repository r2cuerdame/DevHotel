import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AndroidAcceptanceReportUnsigned, RoomRecord } from '@devhotel/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AndroidAcceptanceIntegrity } from '../androidAcceptanceIntegrity'
import {
  androidAcceptanceReportMarkdown,
  canonicalAcceptanceJson,
  sealAndroidAcceptanceReport,
  verifyAndroidAcceptanceReport
} from '../androidAcceptanceReport'
import { androidAcceptanceReportsRepo } from '../store/androidAcceptanceReportsRepo'
import { androidAppInstallsRepo } from '../store/androidAppInstallsRepo'
import { openDb, type Db } from '../store/db'
import { roomsRepo } from '../store/roomsRepo'

const ROOM_ID = 'aaaa1111'
const OTHER_ROOM_ID = 'bbbb2222'
const RUN_ID = '11111111-2222-4333-8444-555555555555'
let root: string
let db: Db

function room(id: string): RoomRecord {
  return {
    id,
    project: `project-${id}`,
    nickname: `Android ${id}`,
    roomNumber: id === ROOM_ID ? 201 : 202,
    provider: 'android',
    sourceType: 'managed-git',
    sourceRef: 'https://example.invalid/repo.git',
    workspaceMode: 'hotel',
    stateRevision: 3,
    workspaceVolumeRevision: 2,
    syncStatus: 'synced',
    lastSyncedAt: '2026-08-31T09:00:00.000Z',
    hostSyncEnabled: false,
    workspaceFingerprint: 'f'.repeat(64),
    runtime: { kind: 'jdk', version: '17' },
    packageManager: { kind: 'gradle' },
    startCommand: './gradlew assembleDebug',
    internalPort: 0,
    domain: `${id}.localhost`,
    https: false,
    status: 'ready',
    services: {},
    os: { env: {} },
    android: { device: 'Pixel 8', version: '14.0' },
    hostPort: null,
    createdAt: '2026-08-31T09:00:00.000Z',
    lastUsedAt: '2026-08-31T09:00:00.000Z',
    thumbPath: null
  }
}

function unsignedReport(
  integrity: AndroidAcceptanceIntegrity,
  overrides: Partial<AndroidAcceptanceReportUnsigned> = {}
): AndroidAcceptanceReportUnsigned {
  const sourceIdentity = integrity.identify('source', 'source-fingerprint')
  const log = {
    runId: RUN_ID,
    identity: integrity.identify('retained-log', 'retained bytes'),
    sizeBytes: 14,
    startedAt: '2026-08-31T10:30:00.000Z',
    finishedAt: '2026-08-31T10:31:00.000Z',
    code: 0,
    stdout: { bytes: 14, lines: 1, retained: true },
    stderr: { bytes: 0, lines: 0, retained: false }
  }
  return {
    schema: 1,
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    roomId: ROOM_ID,
    stage: 'development',
    status: 'pass',
    applicationId: 'com.example.app',
    createdAt: '2026-08-31T12:00:00.000Z',
    actor: 'agent',
    room: {
      stateRevision: 3,
      workspaceVolumeRevision: 2,
      sourceType: 'managed-git',
      sourceIdentity
    },
    image: {
      reference: `ghcr.io/devhotel/android@sha256:${'b'.repeat(64)}`,
      sha256: 'b'.repeat(64)
    },
    target: {
      kind: 'emulator',
      deviceId: null,
      model: 'Pixel 8',
      androidVersion: '15',
      apiLevel: 35,
      leaseIdentity: null
    },
    build: {
      changeId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
      apkSha256: 'c'.repeat(64),
      artifactSizeBytes: 4096,
      stateRevision: 3,
      workspaceVolumeRevision: 2,
      sourceIdentity,
      environmentIdentity: integrity.identify('environment', 'environment'),
      execution: {
        lifecycle: 'isolated-snapshot',
        cleanExecution: true,
        persistentCacheVolumes: false
      },
      imageReference: `ghcr.io/devhotel/android@sha256:${'b'.repeat(64)}`,
      imageSha256: 'b'.repeat(64),
      installedAt: '2026-08-31T10:00:00.000Z'
    },
    locale: {
      scope: 'app',
      apiLevel: 35,
      localeTags: [],
      systemTag: 'ko-KR',
      restored: true,
      readiness: {
        adb: 'device',
        localeService: 'ready',
        application: 'foreground',
        process: 'running',
        attempts: 2,
        consecutiveReadyChecks: 2,
        elapsedMs: 250,
        pids: [101]
      },
      process: { beforePids: [101], afterPids: [101], restarted: false }
    },
    steps: [
      { id: 'devhotel.source-fingerprint', status: 'pass', source: 'devhotel', evidence: { screenshotArtifactIds: [], logRunIds: [] } },
      { id: 'devhotel.tracked-apk', status: 'pass', source: 'devhotel', evidence: { screenshotArtifactIds: [], logRunIds: [] } },
      { id: 'devhotel.target-readiness', status: 'pass', source: 'devhotel', evidence: { screenshotArtifactIds: [], logRunIds: [] } },
      { id: 'instrumented-login', status: 'pass', source: 'agent', evidence: { screenshotArtifactIds: [], logRunIds: [log.runId] } }
    ],
    crash: null,
    screenshots: [],
    logs: [log],
    ...overrides
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devhotel-acceptance-repo-'))
  db = openDb(root)
  const rooms = roomsRepo(db)
  rooms.create(room(ROOM_ID))
  rooms.create(room(OTHER_ROOM_ID))
})

afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

describe('Android acceptance integrity', () => {
  it('uses canonical JSON, domain separation, and a durable installation-local key', () => {
    const integrity = new AndroidAcceptanceIntegrity(db)
    expect(canonicalAcceptanceJson({ z: [2, { b: true, a: false }], a: 1 }))
      .toBe('{"a":1,"z":[2,{"a":false,"b":true}]}')
    expect(integrity.identify('source', 'same').value)
      .not.toBe(integrity.identify('environment', 'same').value)

    const identity = integrity.identify('source', 'same')
    db.close()
    db = openDb(root)
    expect(new AndroidAcceptanceIntegrity(db).identify('source', 'same')).toEqual(identity)
  })

  it('seals bounded reports and rejects keyed or structured-row tampering', () => {
    const integrity = new AndroidAcceptanceIntegrity(db)
    const report = sealAndroidAcceptanceReport(unsignedReport(integrity), integrity)
    expect(verifyAndroidAcceptanceReport(report, integrity)).toEqual(report)
    expect(androidAcceptanceReportMarkdown(report)).toContain('Retained log evidence')
    expect(androidAcceptanceReportMarkdown(report)).not.toContain('retained bytes')
    expect(androidAcceptanceReportMarkdown(report)).not.toContain('C:\\')

    const tampered = structuredClone(report)
    tampered.applicationId = 'com.attacker.app'
    expect(() => verifyAndroidAcceptanceReport(tampered, integrity)).toThrow(/keyed seal/)

    const repo = androidAcceptanceReportsRepo(db, integrity)
    repo.insert(report)
    db.sqlite.prepare('UPDATE android_acceptance_reports SET status = ? WHERE id = ?').run('fail', report.id)
    expect(() => repo.getForRoom(ROOM_ID, report.id)).toThrow(/durable row/)
  })
})

describe('Android acceptance report persistence', () => {
  it('keeps reports Room-scoped and atomically pins deduplicated retained runs', () => {
    const integrity = new AndroidAcceptanceIntegrity(db)
    const repo = androidAcceptanceReportsRepo(db, integrity, {
      maxPinnedRunsPerRoom: 1,
      maxPinnedRunBytesPerRoom: 32
    })
    const first = sealAndroidAcceptanceReport(unsignedReport(integrity), integrity)
    expect(repo.insert(first)).toEqual(first)
    expect(repo.getForRoom(OTHER_ROOM_ID, first.id)).toBeNull()
    expect(repo.isRunPinned(ROOM_ID, RUN_ID)).toBe(true)
    expect(repo.isRunPinned(OTHER_ROOM_ID, RUN_ID)).toBe(false)

    const second = sealAndroidAcceptanceReport(unsignedReport(integrity, {
      id: 'cccccccc-dddd-4eee-8fff-000000000000',
      createdAt: '2026-08-31T12:01:00.000Z'
    }), integrity)
    repo.insert(second)
    expect(repo.usageForRoom(ROOM_ID).count).toBe(2)
    expect(repo.pinnedUsageForRoom(ROOM_ID)).toEqual({ count: 1, bytes: 14 })
  })

  it('rolls back both report and pins when the retained-run quota is exceeded', () => {
    const integrity = new AndroidAcceptanceIntegrity(db)
    const repo = androidAcceptanceReportsRepo(db, integrity, {
      maxPinnedRunsPerRoom: 1,
      maxPinnedRunBytesPerRoom: 32
    })
    repo.insert(sealAndroidAcceptanceReport(unsignedReport(integrity), integrity))

    const nextRunId = '99999999-8888-4777-8666-555555555555'
    const nextUnsigned = unsignedReport(integrity, {
      id: 'cccccccc-dddd-4eee-8fff-000000000000',
      createdAt: '2026-08-31T12:01:00.000Z'
    })
    nextUnsigned.logs = [{
      ...nextUnsigned.logs[0]!,
      runId: nextRunId,
      identity: integrity.identify('retained-log', 'other bytes')
    }]
    nextUnsigned.steps[3]!.evidence.logRunIds = [nextRunId]

    expect(() => repo.insert(sealAndroidAcceptanceReport(nextUnsigned, integrity))).toThrow(/quota reached/)
    expect(repo.usageForRoom(ROOM_ID).count).toBe(1)
    expect(repo.pinnedUsageForRoom(ROOM_ID)).toEqual({ count: 1, bytes: 14 })
    expect(repo.isRunPinned(ROOM_ID, nextRunId)).toBe(false)
  })

  it('fails closed when an immutable retained-run snapshot is changed', () => {
    const integrity = new AndroidAcceptanceIntegrity(db)
    const repo = androidAcceptanceReportsRepo(db, integrity)
    const report = sealAndroidAcceptanceReport(unsignedReport(integrity), integrity)
    repo.insert(report)
    db.sqlite.prepare(
      'UPDATE android_acceptance_run_snapshots SET identity_hmac = ? WHERE room_id = ? AND run_id = ?'
    ).run('0'.repeat(64), ROOM_ID, RUN_ID)
    expect(() => repo.getForRoom(ROOM_ID, report.id)).toThrow(/retained-run pin/)
  })

  it('releases Room-owned reports and run pins when the Room is deleted', () => {
    const integrity = new AndroidAcceptanceIntegrity(db)
    const repo = androidAcceptanceReportsRepo(db, integrity)
    repo.insert(sealAndroidAcceptanceReport(unsignedReport(integrity), integrity))

    expect(() => roomsRepo(db).delete(ROOM_ID)).not.toThrow()
    expect(db.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM android_acceptance_reports WHERE room_id = ?'
    ).get(ROOM_ID)).toEqual({ count: 0 })
    expect(db.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM android_acceptance_run_snapshots WHERE room_id = ?'
    ).get(ROOM_ID)).toEqual({ count: 0 })
  })
})

describe('Android install-private acceptance provenance', () => {
  it('keeps the public receipt unchanged while round-tripping strict private provenance', () => {
    const integrity = new AndroidAcceptanceIntegrity(db)
    const installs = androidAppInstallsRepo(db)
    const target = { kind: 'emulator' as const, targetId: ROOM_ID, deviceId: null }
    const provenance = {
      artifactSizeBytes: 4096,
      stateRevision: 3,
      workspaceVolumeRevision: 2,
      sourceIdentity: integrity.identify('source', 'source-fingerprint'),
      environmentIdentity: integrity.identify('environment', 'environment'),
      imageReference: `ghcr.io/devhotel/android@sha256:${'b'.repeat(64)}`,
      imageSha256: 'b'.repeat(64)
    }
    const receipt = installs.record({
      roomId: ROOM_ID,
      target,
      applicationId: 'com.example.app',
      changeId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
      apkSha256: 'c'.repeat(64),
      installedAt: '2026-08-31T10:00:00.000Z',
      packageIncarnation: 'd'.repeat(64),
      logFence: null,
      installUserId: 0,
      installUserSerial: 42,
      acceptanceProvenance: provenance
    })
    expect(receipt).toEqual({
      roomId: ROOM_ID,
      target: { kind: 'emulator', deviceId: null },
      applicationId: 'com.example.app',
      changeId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
      apkSha256: 'c'.repeat(64),
      installedAt: '2026-08-31T10:00:00.000Z'
    })
    expect(installs.acceptanceProvenance(ROOM_ID, target, 'com.example.app')).toEqual(provenance)
  })

  it('rejects malformed private provenance before publishing an install receipt', () => {
    const integrity = new AndroidAcceptanceIntegrity(db)
    const installs = androidAppInstallsRepo(db)
    const target = { kind: 'emulator' as const, targetId: ROOM_ID, deviceId: null }
    expect(() => installs.record({
      roomId: ROOM_ID,
      target,
      applicationId: 'com.example.app',
      changeId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
      apkSha256: 'c'.repeat(64),
      installedAt: '2026-08-31T10:00:00.000Z',
      packageIncarnation: 'd'.repeat(64),
      logFence: null,
      installUserId: 0,
      installUserSerial: 42,
      acceptanceProvenance: {
        artifactSizeBytes: 4096,
        stateRevision: 3,
        workspaceVolumeRevision: 2,
        sourceIdentity: integrity.identify('lease', 'wrong-domain'),
        environmentIdentity: integrity.identify('environment', 'environment'),
        imageReference: `ghcr.io/devhotel/android@sha256:${'b'.repeat(64)}`,
        imageSha256: 'b'.repeat(64)
      }
    })).toThrow(/provenance is invalid/)
    expect(installs.get(ROOM_ID, target, 'com.example.app')).toBeNull()
  })
})
