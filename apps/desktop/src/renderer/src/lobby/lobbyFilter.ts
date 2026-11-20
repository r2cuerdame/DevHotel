import type { ProviderKind, RoomRecord, RoomStatus } from '@devhotel/shared'
import type { Translation } from '../i18n'

export type LobbyProviderFilter = 'all' | ProviderKind
export type LobbyStatusFilter = 'all' | 'active' | 'sleeping' | 'attention'

export interface LobbyFilterState {
  query: string
  provider: LobbyProviderFilter
  status: LobbyStatusFilter
}

export interface LobbyRoomSummary {
  total: number
  active: number
  sleeping: number
  attention: number
  byProvider: Record<ProviderKind, number>
}

export type RoomProviderBadgeKey = 'lobby.providerWeb' | 'lobby.providerAndroid' | 'lobby.providerWindows'

export const DEFAULT_LOBBY_FILTER: LobbyFilterState = {
  query: '',
  provider: 'all',
  status: 'all'
}

export function isActiveRoomStatus(status: RoomStatus): boolean {
  return status === 'running' || status === 'ready' || status === 'preparing'
}

export function isAttentionRoomStatus(status: RoomStatus): boolean {
  return status === 'attention' || status === 'broken'
}

export function matchesLobbyStatus(status: RoomStatus, filter: LobbyStatusFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'active') return isActiveRoomStatus(status)
  if (filter === 'sleeping') return status === 'sleeping'
  return isAttentionRoomStatus(status)
}

export function matchesLobbyQuery(
  room: Pick<RoomRecord, 'project' | 'nickname' | 'roomNumber' | 'domain'>,
  query: string
): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  const numberText = String(room.roomNumber)
  const haystacks = [
    room.project,
    room.nickname,
    `${room.project} / ${room.nickname}`,
    numberText,
    `№ ${numberText}`,
    `№${numberText}`,
    `#${numberText}`,
    room.domain
  ]
  return haystacks.some((value) => value.toLowerCase().includes(needle))
}

export function filterLobbyRooms<
  T extends Pick<RoomRecord, 'project' | 'nickname' | 'roomNumber' | 'domain' | 'provider' | 'status'>
>(rooms: readonly T[], filter: LobbyFilterState): T[] {
  return rooms.filter((room) => {
    if (filter.provider !== 'all' && room.provider !== filter.provider) return false
    if (!matchesLobbyStatus(room.status, filter.status)) return false
    return matchesLobbyQuery(room, filter.query)
  })
}

export function summarizeLobbyRooms(
  rooms: readonly Pick<RoomRecord, 'provider' | 'status'>[]
): LobbyRoomSummary {
  const summary: LobbyRoomSummary = {
    total: rooms.length,
    active: 0,
    sleeping: 0,
    attention: 0,
    byProvider: { web: 0, android: 0, windows: 0 }
  }
  for (const room of rooms) {
    summary.byProvider[room.provider] += 1
    if (isActiveRoomStatus(room.status)) summary.active += 1
    else if (room.status === 'sleeping') summary.sleeping += 1
    else if (isAttentionRoomStatus(room.status)) summary.attention += 1
  }
  return summary
}

export function hasActiveLobbyFilters(filter: LobbyFilterState): boolean {
  return filter.query.trim().length > 0 || filter.provider !== 'all' || filter.status !== 'all'
}

export function roomProviderBadgeKey(provider: ProviderKind): RoomProviderBadgeKey & keyof Translation {
  if (provider === 'android') return 'lobby.providerAndroid'
  if (provider === 'windows') return 'lobby.providerWindows'
  return 'lobby.providerWeb'
}
