import type { RoomPlan, RoomRecord } from '@devhotel/shared'
import type { WebSpec } from '../backend/types'
import type { DetectOptions } from '../detect/detector'
import type { SourceReader } from '../detect/sourceReader'

export type RoomProviderKind = 'web' | 'android' | 'windows'

export interface RoomProviderInfo {
  kind: RoomProviderKind
  label: string
  available: boolean
  unavailableReason?: string
}

/**
 * Provider seam per goal.md §18.1 — a provider owns what is genuinely
 * room-kind-specific today: source detection, the container spec of the
 * serving process, and the component list it manages. Lifecycle, changes,
 * checks and the gateway stay shared in RoomOrchestrator. Rationale and the
 * Android plan: docs/superpowers/specs/2026-08-10-android-room-provider-design.md
 */
export interface RoomProvider {
  readonly info: RoomProviderInfo
  /** Detect source → Room Plan (goal.md §8) */
  detect(src: SourceReader, opts: DetectOptions): Promise<RoomPlan>
  /** Container spec for the room's serving process; deps-volume override arrives via `overrides`, never from settings */
  buildSpec(room: RoomRecord, overrides?: Partial<WebSpec>): WebSpec
  /** Component names this provider manages today (goal.md §5.6) — what exists, not what is planned */
  components(): string[]
}
