import { z } from 'zod'
import { zAndroidApplicationId, zAndroidTargetSelector } from './androidAutomation'
import { zArtifactFilename, zArtifactId } from './artifacts'
import { ANDROID_LOCALE_MATRIX_MAX_ENTRIES, canonicalAndroidLocaleTag } from './androidLocales'
import { zRoomId } from './control'

export const ANDROID_ACCEPTANCE_REPORT_MAX_BYTES = 64 * 1024
export const ANDROID_ACCEPTANCE_REPORT_MAX_PER_ROOM = 100
export const ANDROID_ACCEPTANCE_REPORT_MAX_ROOM_BYTES = 4 * 1024 * 1024
export const ANDROID_ACCEPTANCE_MARKDOWN_MAX_BYTES = 64 * 1024
export const ANDROID_ACCEPTANCE_LOG_MAX_BYTES = 4 * 1024 * 1024
export const ANDROID_ACCEPTANCE_LOGS_MAX_TOTAL_BYTES = 16 * 1024 * 1024
export const ANDROID_ACCEPTANCE_PINNED_RUN_MAX_PER_ROOM = 100
export const ANDROID_ACCEPTANCE_PINNED_RUN_MAX_BYTES_PER_ROOM = 64 * 1024 * 1024
export const ANDROID_ACCEPTANCE_SCREENSHOTS_MAX_BYTES = 64 * 1024 * 1024
export const ANDROID_ACCEPTANCE_SCREENSHOTS_MAX_PIXELS = 64_000_000

export const zAndroidAcceptanceReportId = z.string().uuid()
export const zAndroidAcceptanceReportListLimit = z.number().int().min(1).max(20)
export const zAndroidAcceptanceStage = z.enum(['development', 'final-physical'])
export const zAndroidAcceptanceStepId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'safe acceptance step identifier')

const zSha256 = z.string().regex(/^[a-f0-9]{64}$/)
const zRunId = z.string().uuid()
const zLocaleTag = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/)
const zCanonicalAppLocaleTag = z
  .string()
  .min(2)
  .max(63)
  .refine((value) => canonicalAndroidLocaleTag(value) === value, 'canonical BCP 47 locale tag')
const zPid = z.number().int().positive().max(2_147_483_647)
const zPidList = (allowEmpty: boolean) => z
  .array(zPid)
  .min(allowEmpty ? 0 : 1)
  .max(128)
  .refine(
    (pids) => pids.every((pid, index) => index === 0 || pids[index - 1]! < pid),
    'process IDs must be unique and ascending'
  )
const zAndroidAcceptanceLocaleReadiness = z
  .object({
    adb: z.literal('device'),
    localeService: z.literal('ready'),
    application: z.literal('foreground'),
    process: z.literal('running'),
    attempts: z.number().int().min(2).max(512),
    consecutiveReadyChecks: z.literal(2),
    elapsedMs: z.number().int().nonnegative().max(120_000),
    pids: zPidList(false)
  })
  .strict()
const zAndroidAcceptanceLocaleProcess = z
  .object({
    beforePids: zPidList(true),
    afterPids: zPidList(false),
    restarted: z.boolean()
  })
  .strict()
  .superRefine((value, ctx) => {
    const same = value.beforePids.length === value.afterPids.length &&
      value.beforePids.every((pid, index) => pid === value.afterPids[index])
    if (value.restarted !== (value.beforePids.length > 0 && !same)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['restarted'], message: 'process restart flag is inconsistent' })
    }
  })
const zPrintableMetadata = (max: number) => z
  .string()
  .min(1)
  .max(max)
  .regex(/^[^\p{C}\p{Zl}\p{Zp}]+$/u, 'printable metadata')
const zDigestPinnedImageReference = z
  .string()
  .min(1)
  .max(512)
  .regex(
    /^[a-z0-9][a-z0-9._-]*(?::[0-9]+)?(?:\/[a-z0-9][a-z0-9._-]*)*@sha256:[a-f0-9]{64}$/,
    'digest-pinned OCI image reference'
  )
const zDeviceMetadata = (max: number) => zPrintableMetadata(max)
  .refine((value) => !/[\\/]/.test(value) && !/^[A-Za-z]:/.test(value), 'path-free device metadata')

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

export const zAndroidAcceptanceMacIdentity = z
  .object({
    algorithm: z.literal('hmac-sha256'),
    keyVersion: z.literal(1),
    domain: z.enum(['source', 'environment', 'retained-log', 'lease', 'report']),
    value: zSha256
  })
  .strict()
export type AndroidAcceptanceMacIdentity = z.infer<typeof zAndroidAcceptanceMacIdentity>

function zMacIdentityFor(domain: AndroidAcceptanceMacIdentity['domain']) {
  return zAndroidAcceptanceMacIdentity.refine((identity) => identity.domain === domain, {
    message: `acceptance identity domain must be ${domain}`
  })
}

const RESERVED_STEP_IDS = new Set([
  'devhotel.source-fingerprint',
  'devhotel.tracked-apk',
  'devhotel.target-readiness',
  'devhotel.crash-scenario'
])

export const zAndroidAcceptanceStepInput = z
  .object({
    id: zAndroidAcceptanceStepId,
    status: z.enum(['pass', 'fail']),
    screenshotArtifactIds: z.array(zArtifactId).max(16).optional(),
    logRunIds: z.array(zRunId).max(16).optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    const screenshots = value.screenshotArtifactIds ?? []
    const logs = value.logRunIds ?? []
    if (screenshots.length + logs.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'acceptance step must cite screenshot or log evidence' })
    }
    if (!unique(screenshots)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['screenshotArtifactIds'], message: 'duplicate artifact reference' })
    }
    if (!unique(logs)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['logRunIds'], message: 'duplicate run reference' })
    }
  })
export type AndroidAcceptanceStepInput = z.infer<typeof zAndroidAcceptanceStepInput>

export const zCreateAndroidAcceptanceReportBody = z
  .object({
    applicationId: zAndroidApplicationId,
    stage: zAndroidAcceptanceStage.default('development'),
    target: zAndroidTargetSelector.optional(),
    steps: z.array(zAndroidAcceptanceStepInput).min(1).max(32),
    includeCrashScenario: z.boolean().optional(),
    timeoutMs: z.number().int().min(1_000).max(120_000).optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!unique(value.steps.map((step) => step.id))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['steps'], message: 'acceptance step IDs must be unique' })
    }
    if (value.steps.some((step) => step.id.startsWith('devhotel.') || RESERVED_STEP_IDS.has(step.id))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['steps'], message: 'acceptance step ID is reserved by DevHotel' })
    }
    if (new Set(value.steps.flatMap((step) => step.screenshotArtifactIds ?? [])).size > 32) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['steps'], message: 'at most 32 screenshot artifacts may be referenced' })
    }
    if (new Set(value.steps.flatMap((step) => step.logRunIds ?? [])).size > 32) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['steps'], message: 'at most 32 retained runs may be referenced' })
    }
    if (value.stage === 'development' && value.target && value.target.kind !== 'emulator') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['target'], message: 'development acceptance is emulator-only' })
    }
    if (value.stage === 'final-physical' && (value.target?.kind !== 'physical' || !value.target.deviceId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['target'],
        message: 'final physical acceptance requires an explicit opaque physical device ID'
      })
    }
    if (value.stage === 'final-physical' && value.includeCrashScenario === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['includeCrashScenario'],
        message: 'final physical acceptance is read-only and cannot include a crash scenario'
      })
    }
  })
export type CreateAndroidAcceptanceReportInput = z.input<typeof zCreateAndroidAcceptanceReportBody>
export type ParsedAndroidAcceptanceReportInput = z.output<typeof zCreateAndroidAcceptanceReportBody>

const zEvidenceRefs = z
  .object({
    screenshotArtifactIds: z.array(zArtifactId).max(16),
    logRunIds: z.array(zRunId).max(16)
  })
  .strict()

export const zAndroidAcceptanceReportStep = z
  .object({
    id: zAndroidAcceptanceStepId,
    status: z.enum(['pass', 'fail']),
    source: z.enum(['devhotel', 'agent']),
    evidence: zEvidenceRefs
  })
  .strict()

const zAndroidAcceptanceScreenshotLocale = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('app'), tag: zCanonicalAppLocaleTag }).strict(),
  z.object({ scope: z.literal('system'), tag: zLocaleTag }).strict(),
  z.object({ scope: z.literal('unknown'), tag: z.null() }).strict()
])

export const zAndroidAcceptanceScreenshotRef = z
  .object({
    artifactId: zArtifactId,
    filename: zArtifactFilename,
    sha256: zSha256,
    sizeBytes: z.number().int().positive().max(16 * 1024 * 1024),
    capturedAt: z.string().datetime(),
    locale: zAndroidAcceptanceScreenshotLocale,
    retrieval: z
      .object({
        controlApiPath: z.string().min(1).max(256),
        mcpTool: z.literal('read_room_artifact')
      })
      .strict()
  })
  .strict()

const zRunStreamRef = z
  .object({
    bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    lines: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    retained: z.boolean()
  })
  .strict()

export const zAndroidAcceptanceLogRef = z
  .object({
    runId: zRunId,
    identity: zMacIdentityFor('retained-log'),
    sizeBytes: z.number().int().positive().max(ANDROID_ACCEPTANCE_LOG_MAX_BYTES),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    code: z.number().int().min(-2_147_483_648).max(2_147_483_647),
    stdout: zRunStreamRef,
    stderr: zRunStreamRef
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.stdout.retained && !value.stderr.retained) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'log reference must retain at least one stream' })
    }
    if (
      (value.stdout.retained && value.stdout.bytes > ANDROID_ACCEPTANCE_LOG_MAX_BYTES) ||
      (value.stderr.retained && value.stderr.bytes > ANDROID_ACCEPTANCE_LOG_MAX_BYTES)
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'retained stream exceeds the bounded log size' })
    }
    const durableBytes = (value.stdout.retained ? value.stdout.bytes : 0) +
      (value.stderr.retained ? value.stderr.bytes : 0)
    if (value.sizeBytes !== durableBytes) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sizeBytes'], message: 'log size does not match retained streams' })
    }
    if (Date.parse(value.finishedAt) < Date.parse(value.startedAt)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['finishedAt'], message: 'log finished before it started' })
    }
  })
export type AndroidAcceptanceLogRef = z.infer<typeof zAndroidAcceptanceLogRef>

const zAndroidAcceptanceReportBase = z
  .object({
    schema: z.literal(1),
    id: zAndroidAcceptanceReportId,
    roomId: zRoomId,
    stage: zAndroidAcceptanceStage,
    status: z.enum(['pass', 'fail']),
    applicationId: zAndroidApplicationId,
    createdAt: z.string().datetime(),
    actor: z.enum(['user', 'devhotel', 'agent']),
    room: z
      .object({
        stateRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        workspaceVolumeRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        sourceType: z.enum(['managed-git', 'linked-folder', 'empty']),
        sourceIdentity: zMacIdentityFor('source')
      })
      .strict(),
    image: z
      .object({ reference: zDigestPinnedImageReference, sha256: zSha256 })
      .strict(),
    target: z
      .object({
        kind: z.enum(['emulator', 'physical']),
        deviceId: z.string().regex(/^d[a-f0-9]{32}$/).nullable(),
        model: zDeviceMetadata(200).nullable(),
        androidVersion: zDeviceMetadata(64).nullable(),
        apiLevel: z.number().int().min(1).max(100),
        leaseIdentity: zMacIdentityFor('lease').nullable()
      })
      .strict(),
    build: z
      .object({
        changeId: z.string().uuid(),
        apkSha256: zSha256,
        artifactSizeBytes: z.number().int().positive().max(512 * 1024 * 1024),
        stateRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        workspaceVolumeRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        sourceIdentity: zMacIdentityFor('source'),
        environmentIdentity: zMacIdentityFor('environment'),
        execution: z
          .object({
            lifecycle: z.literal('isolated-snapshot'),
            cleanExecution: z.literal(true),
            persistentCacheVolumes: z.literal(false)
          })
          .strict(),
        imageReference: zDigestPinnedImageReference,
        imageSha256: zSha256,
        installedAt: z.string().datetime()
      })
      .strict(),
    locale: z
      .object({
        scope: z.literal('app'),
        apiLevel: z.number().int().min(33).max(100),
        localeTags: z
          .array(zCanonicalAppLocaleTag)
          .max(ANDROID_LOCALE_MATRIX_MAX_ENTRIES)
          .refine((tags) => unique(tags), 'app locale tags must be unique'),
        systemTag: zLocaleTag.nullable(),
        restored: z.literal(true),
        readiness: zAndroidAcceptanceLocaleReadiness,
        process: zAndroidAcceptanceLocaleProcess
      })
      .strict(),
    steps: z.array(zAndroidAcceptanceReportStep).min(4).max(40),
    crash: z
      .object({
        scenario: z.literal('am-crash'),
        runId: zRunId,
        observed: z.boolean(),
        pidsBefore: z.array(z.number().int().positive().max(2_147_483_647)).max(128),
        pidsAfter: z.array(z.number().int().positive().max(2_147_483_647)).max(128),
        commandCode: z.number().int().min(-2_147_483_648).max(2_147_483_647),
        log: z
          .object({
            sourceLines: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
            returnedLines: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
            truncated: z.boolean()
          })
          .strict()
      })
      .strict()
      .nullable(),
    screenshots: z.array(zAndroidAcceptanceScreenshotRef).max(32),
    logs: z.array(zAndroidAcceptanceLogRef).max(32)
  })
  .strict()

function refineAndroidAcceptanceReport(
  value: z.infer<typeof zAndroidAcceptanceReportBase>,
  ctx: z.RefinementCtx
): void {
  const physical = value.stage === 'final-physical'
  if ((value.target.kind === 'physical') !== physical) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['target', 'kind'], message: 'target does not match acceptance stage' })
  }
  if (value.locale.apiLevel !== value.target.apiLevel) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['locale', 'apiLevel'], message: 'app locale proof is for a different target API' })
  }
  if (
    value.locale.readiness.pids.length !== value.locale.process.afterPids.length ||
    value.locale.readiness.pids.some((pid, index) => pid !== value.locale.process.afterPids[index])
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['locale', 'readiness', 'pids'], message: 'stable readiness does not match the restored process' })
  }
  if (physical !== (value.target.deviceId !== null) || physical !== (value.target.leaseIdentity !== null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['target'], message: 'physical identity evidence is incomplete' })
  }
  if (physical && value.crash !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['crash'], message: 'final physical acceptance cannot mutate the app with a crash scenario' })
  }
  if (physical && value.locale.process.restarted) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['locale', 'process', 'restarted'], message: 'final physical acceptance must preserve the observed process' })
  }
  const imageDigest = /@sha256:([a-f0-9]{64})$/.exec(value.image.reference)?.[1]
  if (imageDigest !== value.image.sha256) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['image'], message: 'image reference and digest do not match' })
  }
  if (
    value.build.imageReference !== value.image.reference ||
    value.build.imageSha256 !== value.image.sha256 ||
    value.build.stateRevision !== value.room.stateRevision ||
    value.build.workspaceVolumeRevision !== value.room.workspaceVolumeRevision ||
    value.build.sourceIdentity.value !== value.room.sourceIdentity.value
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['build'], message: 'installed build provenance does not match the report generation' })
  }
  if (Date.parse(value.createdAt) < Date.parse(value.build.installedAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['createdAt'], message: 'report predates its installed build' })
  }
  const expectedStatus = value.steps.every((step) => step.status === 'pass') ? 'pass' : 'fail'
  if (value.status !== expectedStatus) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: 'report status does not match its step results' })
  }
  if (!unique(value.steps.map((step) => step.id))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['steps'], message: 'report step identifiers must be unique' })
  }
  const requiredSteps = new Set([
    'devhotel.source-fingerprint',
    'devhotel.tracked-apk',
    'devhotel.target-readiness'
  ])
  value.steps.forEach((step, index) => {
    const internal = requiredSteps.has(step.id) || step.id === 'devhotel.crash-scenario'
    if (step.id.startsWith('devhotel.') && !internal) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['steps', index, 'id'], message: 'unknown DevHotel verification step' })
    }
    if (internal) {
      if (
        step.source !== 'devhotel' ||
        step.evidence.screenshotArtifactIds.length !== 0 ||
        step.evidence.logRunIds.length !== 0
      ) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['steps', index], message: 'DevHotel step has caller evidence' })
      }
    } else if (step.source !== 'agent') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['steps', index, 'source'], message: 'caller step lost agent provenance' })
    } else if (
      step.evidence.screenshotArtifactIds.length === 0 &&
      step.evidence.logRunIds.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['steps', index, 'evidence'],
        message: 'caller step must cite screenshot or log evidence'
      })
    }
    if (!unique(step.evidence.screenshotArtifactIds) || !unique(step.evidence.logRunIds)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['steps', index, 'evidence'], message: 'step repeats an evidence reference' })
    }
  })
  for (const required of requiredSteps) {
    const step = value.steps.find((candidate) => candidate.id === required)
    if (!step || step.status !== 'pass') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['steps'], message: 'required DevHotel verification did not pass' })
    }
  }
  const crashStep = value.steps.find((step) => step.id === 'devhotel.crash-scenario')
  if ((value.crash === null) !== (crashStep === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['crash'], message: 'crash receipt and step must appear together' })
  }
  if (value.crash && crashStep) {
    if (crashStep.status !== (value.crash.observed ? 'pass' : 'fail')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['crash', 'observed'], message: 'crash result and step disagree' })
    }
    if (
      !unique(value.crash.pidsBefore.map(String)) ||
      !unique(value.crash.pidsAfter.map(String)) ||
      value.crash.log.returnedLines > value.crash.log.sourceLines
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['crash'], message: 'crash accounting is inconsistent' })
    }
    if (
      value.crash.observed &&
      (value.crash.commandCode !== 0 || value.crash.pidsBefore.length === 0 ||
        value.crash.pidsBefore.some((pid) => value.crash!.pidsAfter.includes(pid)))
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['crash', 'observed'], message: 'observed crash lacks process termination evidence' })
    }
  }

  const screenshotIds = new Set(value.screenshots.map((item) => item.artifactId))
  const logIds = new Set(value.logs.map((item) => item.runId))
  if (screenshotIds.size !== value.screenshots.length || logIds.size !== value.logs.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'report evidence references must be unique' })
  }
  if (value.screenshots.reduce((total, item) => total + item.sizeBytes, 0) > ANDROID_ACCEPTANCE_SCREENSHOTS_MAX_BYTES) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['screenshots'], message: 'report screenshot bytes exceed the aggregate limit' })
  }
  if (value.logs.reduce((total, item) => total + item.sizeBytes, 0) > ANDROID_ACCEPTANCE_LOGS_MAX_TOTAL_BYTES) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['logs'], message: 'report retained-log bytes exceed the aggregate limit' })
  }
  const citedScreenshotIds = new Set(value.steps.flatMap((step) => step.evidence.screenshotArtifactIds))
  const citedLogIds = new Set(value.steps.flatMap((step) => step.evidence.logRunIds))
  value.steps.forEach((step, index) => {
    for (const artifactId of step.evidence.screenshotArtifactIds) {
      if (!screenshotIds.has(artifactId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['steps', index, 'evidence'], message: 'step cites an absent screenshot' })
      }
    }
    for (const runId of step.evidence.logRunIds) {
      if (!logIds.has(runId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['steps', index, 'evidence'], message: 'step cites an absent log' })
      }
    }
  })
  for (const screenshot of value.screenshots) {
    if (!citedScreenshotIds.has(screenshot.artifactId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['screenshots'], message: 'screenshot is not cited by a step' })
    }
    const expectedPath = `/v1/rooms/${value.roomId}/artifacts/${screenshot.artifactId}/content`
    if (screenshot.retrieval.controlApiPath !== expectedPath) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['screenshots'], message: 'screenshot retrieval descriptor is invalid' })
    }
    if (
      Date.parse(screenshot.capturedAt) < Date.parse(value.build.installedAt) ||
      Date.parse(screenshot.capturedAt) > Date.parse(value.createdAt)
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['screenshots'], message: 'screenshot is outside the installed build window' })
    }
  }
  for (const log of value.logs) {
    if (!citedLogIds.has(log.runId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['logs'], message: 'log is not cited by a step' })
    }
    if (
      Date.parse(log.startedAt) < Date.parse(value.build.installedAt) ||
      Date.parse(log.finishedAt) > Date.parse(value.createdAt)
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['logs'], message: 'log is outside the installed build window' })
    }
  }
}

export const zAndroidAcceptanceReportUnsigned = zAndroidAcceptanceReportBase.superRefine(refineAndroidAcceptanceReport)
export type AndroidAcceptanceReportUnsigned = z.infer<typeof zAndroidAcceptanceReportUnsigned>

export const zAndroidAcceptanceReport = zAndroidAcceptanceReportBase
  .extend({ seal: zMacIdentityFor('report') })
  .superRefine(refineAndroidAcceptanceReport)
export type AndroidAcceptanceReport = z.infer<typeof zAndroidAcceptanceReport>

export interface AndroidAcceptanceReportSummary {
  id: string
  roomId: string
  stage: z.infer<typeof zAndroidAcceptanceStage>
  status: 'pass' | 'fail'
  applicationId: string
  createdAt: string
  targetKind: 'emulator' | 'physical'
  screenshotCount: number
  logCount: number
  seal: AndroidAcceptanceMacIdentity
  sizeBytes: number
}

export interface AndroidAcceptanceReportResult {
  report: AndroidAcceptanceReport
  markdown: string
}
