/**
 * Long DevHotel operations (waking a Room today) are tracked so a caller that
 * gives up waiting can still learn the truth. A call timeout is a fact about
 * the *connection*; only the operation record says whether the work itself is
 * still running, finished, or failed.
 */

export type OperationKind = 'room-start' | 'android-run'

/** `running` is not an outcome — poll until `succeeded` or `failed`. */
export type OperationStatus = 'running' | 'succeeded' | 'failed'

/**
 * `skipped` means the stage did not complete but deliberately did not stop the
 * operation — an already-awake Room, or an emulator still booting after the
 * grace window. Its `detail` says which.
 */
export type OperationStageStatus = 'running' | 'done' | 'skipped' | 'failed'

/** Stage keys an operation can report. */
export const OPERATION_STAGES = [
  'preparing',
  'container-start',
  'emulator-boot',
  'services-start',
  'web-start',
  'verify',
  'adb-ready',
  'vm-start',
  'build',
  'install',
  'launch',
  'complete'
] as const

/** Stage keys a Room start can report, in the order they can occur. */
export const ROOM_START_STAGES = [
  'preparing',
  'container-start',
  'emulator-boot',
  'services-start',
  'web-start',
  'verify',
  'adb-ready',
  'vm-start',
  'complete'
] as const

/** Stage keys an Android run can report. */
export const ANDROID_RUN_STAGES = [
  'preparing',
  'build',
  'emulator-boot',
  'install',
  'launch',
  'verify',
  'complete'
] as const

export type OperationStageKey = (typeof OPERATION_STAGES)[number]

export interface OperationStage {
  key: OperationStageKey
  /** Human-readable, safe to show verbatim in a UI or an agent transcript. */
  label: string
  status: OperationStageStatus
  detail: string | null
  /** Advisory tracking failures that did not control or abort the Room work. */
  warnings?: string[]
  startedAt: string
  endedAt: string | null
}

export interface OperationError {
  /** The stage that was running when the operation failed. */
  stage: OperationStageKey
  message: string
}

export interface OperationRecord {
  /** Durable ID: it survives the call that created it and an app restart. */
  id: string
  kind: OperationKind
  roomId: string
  actor: 'user' | 'devhotel' | 'agent'
  /**
   * Stable, bounded identity of the request that created this operation.
   * A repeated operation ID is idempotent only when this identity also matches.
   */
  requestKey?: string
  status: OperationStatus
  /** Current stage while running; the last stage reached once terminal. */
  stage: OperationStageKey
  stages: OperationStage[]
  /** Terminal error details; null while running and on success. */
  error: OperationError | null
  startedAt: string
  updatedAt: string
  finishedAt: string | null
}
