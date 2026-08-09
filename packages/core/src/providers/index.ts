import { AndroidRoomProvider } from './androidProvider'
import type { RoomProvider, RoomProviderInfo, RoomProviderKind } from './types'
import { WebRoomProvider } from './webProvider'
import { WindowsRoomProvider } from './windowsProvider'

const registry: Record<RoomProviderKind, RoomProvider> = {
  web: new WebRoomProvider(),
  android: new AndroidRoomProvider(),
  windows: new WindowsRoomProvider()
}

export function providers(): RoomProviderInfo[] {
  return Object.values(registry).map((p) => p.info)
}

export function getProvider(kind: RoomProviderKind): RoomProvider {
  return registry[kind]
}

export * from './types'
export * from './webProvider'
export * from './androidProvider'
export * from './windowsProvider'
