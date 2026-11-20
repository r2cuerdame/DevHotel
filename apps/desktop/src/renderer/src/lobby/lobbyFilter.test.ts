import { describe, expect, it } from 'vitest'
import type { ProviderKind, RoomStatus } from '@devhotel/shared'
import { LOCALES, translate } from '../i18n'
import {
  DEFAULT_LOBBY_FILTER,
  filterLobbyRooms,
  hasActiveLobbyFilters,
  roomProviderBadgeKey,
  summarizeLobbyRooms
} from './lobbyFilter'

interface SampleRoom {
  id: string
  project: string
  nickname: string
  roomNumber: number
  domain: string
  provider: ProviderKind
  status: RoomStatus
}

const ROOMS: readonly SampleRoom[] = [
  {
    id: 'r1',
    project: 'LoopOffice',
    nickname: 'main-web',
    roomNumber: 101,
    domain: 'loopoffice-main.devhotel.local',
    provider: 'web',
    status: 'running'
  },
  {
    id: 'r2',
    project: 'TheNext',
    nickname: 'PixelQA',
    roomNumber: 204,
    domain: 'thenext-pixel.devhotel.local',
    provider: 'android',
    status: 'ready'
  },
  {
    id: 'r3',
    project: 'CapturePack',
    nickname: 'win-clean',
    roomNumber: 309,
    domain: 'capturepack-win.devhotel.local',
    provider: 'windows',
    status: 'sleeping'
  },
  {
    id: 'r4',
    project: 'Adisad',
    nickname: 'staging-hotfix',
    roomNumber: 105,
    domain: 'adisad-hotfix.devhotel.local',
    provider: 'web',
    status: 'attention'
  },
  {
    id: 'r5',
    project: 'GuguApp',
    nickname: 'emulator-boot',
    roomNumber: 208,
    domain: 'gugu-emu.devhotel.local',
    provider: 'android',
    status: 'preparing'
  },
  {
    id: 'r6',
    project: 'LegacyTool',
    nickname: 'broken-vm',
    roomNumber: 312,
    domain: 'legacy-vm.devhotel.local',
    provider: 'windows',
    status: 'broken'
  },
  {
    id: 'r7',
    project: 'TempRoom',
    nickname: 'cleanup',
    roomNumber: 401,
    domain: 'temp.devhotel.local',
    provider: 'web',
    status: 'deleting'
  }
]

describe('lobbyFilter', () => {
  it('returns all rooms for default filters and ignores surrounding whitespace', () => {
    expect(filterLobbyRooms(ROOMS, DEFAULT_LOBBY_FILTER)).toHaveLength(ROOMS.length)
    expect(filterLobbyRooms(ROOMS, { ...DEFAULT_LOBBY_FILTER, query: '   ' })).toHaveLength(ROOMS.length)
  })

  it('matches project, nickname, room number, and domain case-insensitively', () => {
    expect(filterLobbyRooms(ROOMS, { ...DEFAULT_LOBBY_FILTER, query: 'THENEXT' }).map((r) => r.id)).toEqual(['r2'])
    expect(filterLobbyRooms(ROOMS, { ...DEFAULT_LOBBY_FILTER, query: '  pixelqa ' }).map((r) => r.id)).toEqual(['r2'])
    expect(filterLobbyRooms(ROOMS, { ...DEFAULT_LOBBY_FILTER, query: '309' }).map((r) => r.id)).toEqual(['r3'])
    expect(filterLobbyRooms(ROOMS, { ...DEFAULT_LOBBY_FILTER, query: '№ 204' }).map((r) => r.id)).toEqual(['r2'])
    expect(filterLobbyRooms(ROOMS, { ...DEFAULT_LOBBY_FILTER, query: '#105' }).map((r) => r.id)).toEqual(['r4'])
    expect(filterLobbyRooms(ROOMS, { ...DEFAULT_LOBBY_FILTER, query: 'gugu-emu.devhotel' }).map((r) => r.id)).toEqual(['r5'])
  })

  it('filters by provider kind individually', () => {
    expect(filterLobbyRooms(ROOMS, { ...DEFAULT_LOBBY_FILTER, provider: 'web' }).map((r) => r.id)).toEqual([
      'r1',
      'r4',
      'r7'
    ])
    expect(filterLobbyRooms(ROOMS, { ...DEFAULT_LOBBY_FILTER, provider: 'android' }).map((r) => r.id)).toEqual([
      'r2',
      'r5'
    ])
    expect(filterLobbyRooms(ROOMS, { ...DEFAULT_LOBBY_FILTER, provider: 'windows' }).map((r) => r.id)).toEqual([
      'r3',
      'r6'
    ])
  })

  it('groups running, ready, and preparing under active and attention and broken under attention', () => {
    expect(filterLobbyRooms(ROOMS, { ...DEFAULT_LOBBY_FILTER, status: 'active' }).map((r) => r.id)).toEqual([
      'r1',
      'r2',
      'r5'
    ])
    expect(filterLobbyRooms(ROOMS, { ...DEFAULT_LOBBY_FILTER, status: 'sleeping' }).map((r) => r.id)).toEqual(['r3'])
    expect(filterLobbyRooms(ROOMS, { ...DEFAULT_LOBBY_FILTER, status: 'attention' }).map((r) => r.id)).toEqual([
      'r4',
      'r6'
    ])
  })

  it('combines query, provider, and status filters and yields empty when nothing matches', () => {
    expect(
      filterLobbyRooms(ROOMS, { query: 'emu', provider: 'android', status: 'active' }).map((r) => r.id)
    ).toEqual(['r5'])
    expect(filterLobbyRooms(ROOMS, { query: 'emu', provider: 'web', status: 'active' })).toEqual([])
    expect(filterLobbyRooms(ROOMS, { query: '', provider: 'android', status: 'sleeping' })).toEqual([])
  })

  it('reports whether any filter is active', () => {
    expect(hasActiveLobbyFilters(DEFAULT_LOBBY_FILTER)).toBe(false)
    expect(hasActiveLobbyFilters({ ...DEFAULT_LOBBY_FILTER, query: '   ' })).toBe(false)
    expect(hasActiveLobbyFilters({ ...DEFAULT_LOBBY_FILTER, query: '101' })).toBe(true)
    expect(hasActiveLobbyFilters({ ...DEFAULT_LOBBY_FILTER, provider: 'android' })).toBe(true)
    expect(hasActiveLobbyFilters({ ...DEFAULT_LOBBY_FILTER, status: 'attention' })).toBe(true)
  })

  it('summarizes total, active, sleeping, attention, and per-provider counts', () => {
    expect(summarizeLobbyRooms([])).toEqual({
      total: 0,
      active: 0,
      sleeping: 0,
      attention: 0,
      byProvider: { web: 0, android: 0, windows: 0 }
    })
    expect(summarizeLobbyRooms(ROOMS)).toEqual({
      total: 7,
      active: 3,
      sleeping: 1,
      attention: 2,
      byProvider: { web: 3, android: 2, windows: 2 }
    })
  })

  it('returns localized badge keys for all room providers across every supported locale', () => {
    const providers: readonly ProviderKind[] = ['web', 'android', 'windows']
    expect(roomProviderBadgeKey('web')).toBe('lobby.providerWeb')
    expect(roomProviderBadgeKey('android')).toBe('lobby.providerAndroid')
    expect(roomProviderBadgeKey('windows')).toBe('lobby.providerWindows')

    for (const locale of LOCALES) {
      for (const provider of providers) {
        const label = translate(locale.id, roomProviderBadgeKey(provider))
        expect(label.trim().length).toBeGreaterThan(0)
      }
    }
  })
})
