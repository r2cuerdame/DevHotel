import type { RoomPlan } from '@devhotel/shared'
import type { WebSpec } from '../backend/types'
import type { RoomProvider, RoomProviderInfo } from './types'

const NOT_AVAILABLE =
  'Android Rooms are not available yet — they arrive after Web Rooms are rock-solid (goal.md §21.4). ' +
  'Plan: docs/superpowers/specs/2026-08-10-android-room-provider-design.md'

/** Honest stub (goal.md §18.2): registered so the app can say why Android is absent, never to fake it. */
export class AndroidRoomProvider implements RoomProvider {
  readonly info: RoomProviderInfo = {
    kind: 'android',
    label: 'Android Room',
    available: false,
    unavailableReason: 'Arrives after Web Rooms are rock-solid (goal.md §21.4)'
  }

  async detect(): Promise<RoomPlan> {
    throw new Error(NOT_AVAILABLE)
  }

  buildSpec(): WebSpec {
    throw new Error(NOT_AVAILABLE)
  }

  components(): string[] {
    return []
  }
}
