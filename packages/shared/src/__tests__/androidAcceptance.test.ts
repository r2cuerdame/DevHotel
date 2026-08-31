import { describe, expect, it } from 'vitest'
import {
  zAndroidAcceptanceReport,
  zCreateAndroidAcceptanceReportBody,
  type AndroidAcceptanceReport
} from '../androidAcceptance'

const ROOM_ID = 'aaaa1111'
const ARTIFACT_ID = '11111111-2222-4333-8444-555555555555'

function identity(domain: AndroidAcceptanceReport['seal']['domain'], value = 'a'.repeat(64)) {
  return { algorithm: 'hmac-sha256' as const, keyVersion: 1 as const, domain, value }
}

function validReport(): AndroidAcceptanceReport {
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
      sourceIdentity: identity('source')
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
      artifactSizeBytes: 1024,
      stateRevision: 3,
      workspaceVolumeRevision: 2,
      sourceIdentity: identity('source'),
      environmentIdentity: identity('environment', 'd'.repeat(64)),
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
      localeTags: ['en-US'],
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
        pids: [42]
      },
      process: { beforePids: [41], afterPids: [42], restarted: true }
    },
    steps: [
      {
        id: 'devhotel.source-fingerprint',
        status: 'pass',
        source: 'devhotel',
        evidence: { screenshotArtifactIds: [], logRunIds: [] }
      },
      {
        id: 'devhotel.tracked-apk',
        status: 'pass',
        source: 'devhotel',
        evidence: { screenshotArtifactIds: [], logRunIds: [] }
      },
      {
        id: 'devhotel.target-readiness',
        status: 'pass',
        source: 'devhotel',
        evidence: { screenshotArtifactIds: [], logRunIds: [] }
      },
      {
        id: 'login-screen',
        status: 'pass',
        source: 'agent',
        evidence: { screenshotArtifactIds: [ARTIFACT_ID], logRunIds: [] }
      }
    ],
    crash: null,
    screenshots: [{
      artifactId: ARTIFACT_ID,
      filename: 'login-screen.png',
      sha256: 'e'.repeat(64),
      sizeBytes: 2048,
      capturedAt: '2026-08-31T11:00:00.000Z',
      locale: { tag: 'ko-KR', scope: 'app' },
      retrieval: {
        controlApiPath: `/v1/rooms/${ROOM_ID}/artifacts/${ARTIFACT_ID}/content`,
        mcpTool: 'read_room_artifact'
      }
    }],
    logs: [],
    seal: identity('report', 'f'.repeat(64))
  }
}

function validPhysicalReport(): AndroidAcceptanceReport {
  const report = validReport()
  report.stage = 'final-physical'
  report.target = {
    ...report.target,
    kind: 'physical',
    deviceId: `d${'1'.repeat(32)}`,
    leaseIdentity: identity('lease', '9'.repeat(64))
  }
  report.locale.systemTag = null
  report.locale.process = { beforePids: [42], afterPids: [42], restarted: false }
  return report
}

describe('Android acceptance request contract', () => {
  it('defaults development acceptance to the emulator and rejects mixed stages', () => {
    const base = {
      applicationId: 'com.example.app',
      steps: [{ id: 'login', status: 'pass' as const, screenshotArtifactIds: [ARTIFACT_ID] }]
    }
    expect(zCreateAndroidAcceptanceReportBody.parse(base)).toMatchObject({ stage: 'development' })
    expect(zCreateAndroidAcceptanceReportBody.safeParse({
      ...base,
      target: { kind: 'physical', deviceId: `d${'1'.repeat(32)}` }
    }).success).toBe(false)
    expect(zCreateAndroidAcceptanceReportBody.safeParse({
      ...base,
      stage: 'final-physical'
    }).success).toBe(false)
    expect(zCreateAndroidAcceptanceReportBody.safeParse({
      ...base,
      stage: 'final-physical',
      target: { kind: 'physical', deviceId: `d${'1'.repeat(32)}` }
    }).success).toBe(true)
    const crash = zCreateAndroidAcceptanceReportBody.safeParse({
      ...base,
      stage: 'final-physical',
      target: { kind: 'physical', deviceId: `d${'1'.repeat(32)}` },
      includeCrashScenario: true
    })
    expect(crash.success).toBe(false)
    if (!crash.success) {
      expect(crash.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['includeCrashScenario'] })
      ]))
    }
  })

  it('rejects caller-controlled DevHotel steps, duplicate evidence, and unknown fields', () => {
    expect(zCreateAndroidAcceptanceReportBody.safeParse({
      applicationId: 'com.example.app',
      steps: [{ id: 'devhotel.fake', status: 'pass', screenshotArtifactIds: [ARTIFACT_ID] }]
    }).success).toBe(false)
    expect(zCreateAndroidAcceptanceReportBody.safeParse({
      applicationId: 'com.example.app',
      steps: [{ id: 'login', status: 'pass', logRunIds: [ARTIFACT_ID, ARTIFACT_ID] }]
    }).success).toBe(false)
    expect(zCreateAndroidAcceptanceReportBody.safeParse({
      applicationId: 'com.example.app',
      steps: [{ id: 'login', status: 'pass' }],
      rawLog: 'secret'
    }).success).toBe(false)
  })
})

describe('Android acceptance report contract', () => {
  it('accepts one internally proved, Room-scoped report', () => {
    expect(zAndroidAcceptanceReport.parse(validReport())).toEqual(validReport())
    expect(zAndroidAcceptanceReport.parse(validPhysicalReport())).toEqual(validPhysicalReport())
  })

  it('requires final physical receipts to describe an unchanged process and no crash mutation', () => {
    const restarted = validPhysicalReport()
    restarted.locale.process = { beforePids: [42], afterPids: [43], restarted: true }
    expect(zAndroidAcceptanceReport.safeParse(restarted).success).toBe(false)

    const crashed = validPhysicalReport()
    crashed.crash = {
      scenario: 'am-crash',
      runId: '99999999-8888-4777-8666-555555555555',
      observed: true,
      pidsBefore: [42],
      pidsAfter: [],
      commandCode: 0,
      log: { sourceLines: 1, returnedLines: 1, truncated: false }
    }
    expect(zAndroidAcceptanceReport.safeParse(crashed).success).toBe(false)
  })

  it('binds status, target, provenance, evidence and retrieval descriptors', () => {
    const mutations: Array<(report: AndroidAcceptanceReport) => void> = [
      (report) => { report.status = 'fail' },
      (report) => { report.target.kind = 'physical' },
      (report) => { report.build.sourceIdentity = identity('source', '9'.repeat(64)) },
      (report) => { report.steps[3]!.evidence.screenshotArtifactIds = [] },
      (report) => { report.screenshots[0]!.retrieval.controlApiPath = '/tmp/private.png' },
      (report) => { report.screenshots[0]!.capturedAt = '2026-08-31T09:00:00.000Z' },
      (report) => { report.locale.apiLevel = 34 },
      (report) => { report.locale.readiness.pids = [99] },
      (report) => { report.screenshots[0]!.locale = { scope: 'unknown', tag: 'ko-KR' } as never },
      (report) => {
        report.image.reference = `C:\\private\\android@sha256:${'b'.repeat(64)}`
        report.build.imageReference = report.image.reference
      }
    ]
    for (const mutate of mutations) {
      const report = structuredClone(validReport())
      mutate(report)
      expect(zAndroidAcceptanceReport.safeParse(report).success).toBe(false)
    }
  })

  it('requires process termination evidence for a passing crash receipt', () => {
    const report = validReport()
    report.steps.push({
      id: 'devhotel.crash-scenario',
      status: 'pass',
      source: 'devhotel',
      evidence: { screenshotArtifactIds: [], logRunIds: [] }
    })
    report.crash = {
      scenario: 'am-crash',
      runId: '99999999-8888-4777-8666-555555555555',
      observed: true,
      pidsBefore: [42],
      pidsAfter: [42],
      commandCode: 0,
      log: { sourceLines: 5, returnedLines: 5, truncated: false }
    }
    expect(zAndroidAcceptanceReport.safeParse(report).success).toBe(false)
    report.crash.pidsAfter = []
    expect(zAndroidAcceptanceReport.safeParse(report).success).toBe(true)
  })

  it('rejects a sealed caller step whose evidence arrays are both empty', () => {
    const report = validReport()
    report.steps[3]!.evidence.screenshotArtifactIds = []
    report.screenshots = []

    expect(zAndroidAcceptanceReport.safeParse(report).success).toBe(false)
  })
})
