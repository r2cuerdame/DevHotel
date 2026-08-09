import type { RoomPlan } from '@devhotel/shared'
import type { WebSpec } from '../backend/types'
import type { RoomProvider, RoomProviderInfo } from './types'

const NOT_AVAILABLE =
  'Windows Rooms are not available yet — Windows-app build isolation needs Windows containers, which is a later ' +
  'exploration once Web and Android rooms are daily-usable.'

/** Honest stub (goal.md §18.2): visible on the roadmap, never faked in the UI. */
export class WindowsRoomProvider implements RoomProvider {
  readonly info: RoomProviderInfo = {
    kind: 'windows',
    label: 'Windows Room',
    available: false,
    unavailableReason: 'Arrives after Web and Android rooms are daily-usable'
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
