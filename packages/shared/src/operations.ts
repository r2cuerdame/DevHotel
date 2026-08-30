/**
 * Long DevHotel operations (waking a Room today) are tracked so a caller that
 * gives up waiting can still learn the truth. A call timeout is a fact about
 * the *connection*; only the operation record says whether the work itself is
 * still running, finished, or failed.
 */

export type OperationKind = 'room-start'

/** `running` is not an outcome — poll until `succeeded` or `failed`. */
export type OperationStatus = 'running' | 'succeeded' | 'failed'

/**
 * `skipped` means the stage did not complete but deliberately did not stop the
 * operation — an already-awake Room, or an emulator still booting after the
 * grace window. Its `detail` says which.
 */
export type OperationStageStatus = 'running' | 'done' | 'skipped' | 'failed'

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

export type OperationStageKey = (typeof ROOM_START_STAGES)[number]

export interface OperationStage {
  key: OperationStageKey
  /** Human-readable, safe to show verbatim in a UI or an agent transcript. */
  label: string
  status: OperationStageStatus
  detail: string | null
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
