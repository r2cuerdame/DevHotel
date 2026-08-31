import { z } from 'zod'

/** High-level Android automation never accepts or returns a raw adb serial. */
export const zAndroidApplicationId = z
  .string()
  .min(3)
  .max(223)
  .regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/, 'valid Android applicationId')

export const zAndroidActivityName = z
  .string()
  .min(2)
  .max(223)
  .regex(/^(?:\.[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*|[A-Za-z][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+)$/, 'valid Android activity class')

export const zAndroidTargetSelector = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('auto') }).strict(),
  z.object({ kind: z.literal('emulator') }).strict(),
  z.object({ kind: z.literal('physical'), deviceId: z.string().regex(/^d[a-f0-9]{32}$/).optional() }).strict()
])
export type AndroidTargetSelector = z.infer<typeof zAndroidTargetSelector>

const zAndroidExtraKey = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/, 'safe Android extra key')
const zAndroidExtraValue = z.union([
  z.string().max(1024).refine((value) => !value.includes('\u0000'), 'NUL-free string extra'),
  z.boolean(),
  z.number().int().min(-2_147_483_648).max(2_147_483_647)
])
export const zAndroidExtras = z.record(zAndroidExtraKey, zAndroidExtraValue).refine(
  (extras) => Object.keys(extras).length <= 16,
  'at most 16 extras'
)
export type AndroidExtras = z.infer<typeof zAndroidExtras>

const targetField = { target: zAndroidTargetSelector.optional() }

export const zAndroidLaunchAppBody = z
  .object({
    applicationId: zAndroidApplicationId,
    activity: zAndroidActivityName.optional(),
    extras: zAndroidExtras.optional(),
    ...targetField
  })
  .strict()
export type AndroidLaunchAppInput = z.infer<typeof zAndroidLaunchAppBody>

export const zAndroidForceStopBody = z
  .object({ applicationId: zAndroidApplicationId, ...targetField })
  .strict()
export type AndroidForceStopInput = z.infer<typeof zAndroidForceStopBody>

export const zAndroidTextMatch = z.enum(['exact', 'contains'])
// Permit the join controls needed by emoji/complex scripts while continuing
// to reject other control, invisible-format, surrogate, and line-separator code points.
const printableAndroidText = /^(?:[^\p{C}\p{Zl}\p{Zp}]|[\u200c\u200d])*$/u
const androidTextFields = {
  applicationId: zAndroidApplicationId,
  text: z.string().min(1).max(200).regex(printableAndroidText, 'printable text'),
  match: zAndroidTextMatch.optional(),
  ...targetField
}

export const zAndroidWaitForTextBody = z
  .object({
    ...androidTextFields,
    timeoutMs: z.number().int().min(250).max(120_000).optional(),
    pollIntervalMs: z.number().int().min(250).max(5_000).optional()
  })
  .strict()
export type AndroidWaitForTextInput = z.infer<typeof zAndroidWaitForTextBody>

export const zAndroidTapTextBody = z.object(androidTextFields).strict()
export type AndroidTapTextInput = z.infer<typeof zAndroidTapTextBody>

export const zAndroidDumpUiBody = z
  .object({
    applicationId: zAndroidApplicationId,
    filter: z.string().max(200).regex(printableAndroidText, 'printable filter').optional(),
    maxNodes: z.number().int().min(1).max(500).optional(),
    ...targetField
  })
  .strict()
export type AndroidDumpUiInput = z.infer<typeof zAndroidDumpUiBody>

export const zAndroidLogcatBody = z
  .object({
    applicationId: zAndroidApplicationId,
    since: z.string().datetime({ offset: true }).optional(),
    filter: z.string().max(200).regex(printableAndroidText, 'printable filter').optional(),
    maxLines: z.number().int().min(1).max(500).optional(),
    ...targetField
  })
  .strict()
export type AndroidLogcatInput = z.infer<typeof zAndroidLogcatBody>

export const zAndroidCrashScenario = z.enum(['am-crash'])
export const zAndroidRunCrashScenarioBody = z
  .object({
    applicationId: zAndroidApplicationId,
    scenario: zAndroidCrashScenario,
    runId: z.string().trim().min(1).max(200).regex(printableAndroidText, 'printable run ID'),
    ...targetField
  })
  .strict()
export type AndroidRunCrashScenarioInput = z.infer<typeof zAndroidRunCrashScenarioBody>

export interface AndroidAutomationTarget {
  kind: 'emulator' | 'physical'
  /** Opaque broker identity. Null for the Room-owned emulator. */
  deviceId: string | null
  nickname: string
  model: string | null
  androidVersion: string | null
  apiLevel: number | null
}

export interface AndroidInstallReceipt {
  roomId: string
  target: Pick<AndroidAutomationTarget, 'kind' | 'deviceId'>
  applicationId: string
  changeId: string
  apkSha256: string
  installedAt: string
}

export interface AndroidAutomationStatus {
  target: AndroidAutomationTarget
  installedApplicationIds: string[]
  /** Untracked foreground packages are deliberately collapsed to null. */
  foregroundApplicationId: string | null
  locale: string | null
}

/** Trusted composition result; the physical lease capability itself is never exposed. */
export interface AndroidForegroundInstallContext {
  status: AndroidAutomationStatus
  receipt: AndroidInstallReceipt | null
}

export interface AndroidCommandEvidence {
  code: number
  stdout: string
  stderr: string
  truncated: boolean
}

export interface AndroidUiNode {
  text: string
  contentDescription: string
  resourceId: string
  className: string
  clickable: boolean
  enabled: boolean
  bounds: { left: number; top: number; right: number; bottom: number }
  center: { x: number; y: number }
}

export interface AndroidLaunchResult {
  target: AndroidAutomationTarget
  applicationId: string
  component: string
  evidence: AndroidCommandEvidence
}

export interface AndroidForceStopResult {
  target: AndroidAutomationTarget
  applicationId: string
  evidence: AndroidCommandEvidence
}

export interface AndroidUiDumpResult {
  target: AndroidAutomationTarget
  applicationId: string
  nodes: AndroidUiNode[]
  scannedNodes: number
  truncated: boolean
}

export interface AndroidWaitForTextResult {
  target: AndroidAutomationTarget
  applicationId: string
  matched: AndroidUiNode
  elapsedMs: number
  attempts: number
}

interface AndroidTapTextResultBase {
  target: AndroidAutomationTarget
  applicationId: string
  tapped: AndroidUiNode
  /** A tap is never safe to repeat automatically, including after an uncertain transport boundary. */
  retrySafe: false
}

export type AndroidTapTextResult = AndroidTapTextResultBase & (
  | { outcome: 'confirmed'; evidence: AndroidCommandEvidence }
  /** Input returned success, but its post-input screen outcome could not be authorized. */
  | { outcome: 'committed'; evidence: null }
  /** Input execution began, but DevHotel could not prove whether Android committed it. */
  | { outcome: 'indeterminate'; evidence: null }
)

export interface AndroidLogcatResult {
  target: AndroidAutomationTarget
  applicationId: string
  since: string
  lines: string[]
  sourceLines: number
  truncated: boolean
}

export interface AndroidCrashScenarioResult {
  target: AndroidAutomationTarget
  applicationId: string
  scenario: z.infer<typeof zAndroidCrashScenario>
  runId: string
  observed: boolean
  pidsBefore: number[]
  pidsAfter: number[]
  evidence: AndroidCommandEvidence
  logcat: AndroidLogcatResult
}
