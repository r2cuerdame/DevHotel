import type { RuntimeRoomRecord } from '@devhotel/shared'

type RuntimeRoom = Pick<RuntimeRoomRecord, 'provider' | 'runtimeStatus'>

export interface RuntimeCapabilities {
  fullyRunning: boolean
  hasLiveComponent: boolean
  androidBuildReady: boolean
  androidRunReady: boolean
}

/** Keep recovery controls separate from work that a surviving component can still perform. */
export function runtimeCapabilities(room: RuntimeRoom): RuntimeCapabilities {
  const fullyRunning = room.runtimeStatus.state === 'running'
  const mainRunning = room.runtimeStatus.main === 'running'
  const emulatorRunning = room.runtimeStatus.emulator === 'running'
  const android = room.provider === 'android'

  return {
    fullyRunning,
    hasLiveComponent: fullyRunning || mainRunning || emulatorRunning,
    androidBuildReady: android && mainRunning,
    androidRunReady: android && mainRunning && emulatorRunning
  }
}
