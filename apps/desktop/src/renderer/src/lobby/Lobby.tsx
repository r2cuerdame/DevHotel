import { useMemo, useState } from 'react'
import type { Translation } from '../i18n'
import { useStore, useT } from '../state/store'
import { RoomCard } from './RoomCard'
import { NewRoomWizard } from './NewRoomWizard'
import { SettingsModal } from './SettingsModal'
import { HotelServicesModal } from './HotelServicesModal'
import { AndroidPairingModal } from './AndroidPairingModal'
import {
  DEFAULT_LOBBY_FILTER,
  filterLobbyRooms,
  hasActiveLobbyFilters,
  summarizeLobbyRooms,
  type LobbyProviderFilter,
  type LobbyStatusFilter
} from './lobbyFilter'

const PROVIDER_FILTERS: readonly { id: LobbyProviderFilter; labelKey: keyof Translation }[] = [
  { id: 'all', labelKey: 'lobby.filterAll' },
  { id: 'web', labelKey: 'lobby.filterWeb' },
  { id: 'android', labelKey: 'lobby.filterAndroid' },
  { id: 'windows', labelKey: 'lobby.filterWindows' }
]

const STATUS_FILTERS: readonly { id: LobbyStatusFilter; labelKey: keyof Translation }[] = [
  { id: 'all', labelKey: 'lobby.statusAll' },
  { id: 'active', labelKey: 'lobby.statusActive' },
  { id: 'sleeping', labelKey: 'lobby.statusSleeping' },
  { id: 'attention', labelKey: 'lobby.statusAttention' }
]

export function Lobby(): React.JSX.Element {
  const rooms = useStore((s) => s.rooms)
  const wizardOpen = useStore((s) => s.wizardOpen)
  const openWizard = useStore((s) => s.openWizard)
  const t = useT()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [servicesOpen, setServicesOpen] = useState(false)
  const [pairingOpen, setPairingOpen] = useState(false)
  const [query, setQuery] = useState(DEFAULT_LOBBY_FILTER.query)
  const [provider, setProvider] = useState<LobbyProviderFilter>(DEFAULT_LOBBY_FILTER.provider)
  const [status, setStatus] = useState<LobbyStatusFilter>(DEFAULT_LOBBY_FILTER.status)

  const filter = useMemo(() => ({ query, provider, status }), [query, provider, status])
  const summary = useMemo(() => summarizeLobbyRooms(rooms), [rooms])
  const visibleRooms = useMemo(() => filterLobbyRooms(rooms, filter), [rooms, filter])
  const filtering = hasActiveLobbyFilters(filter)

  function resetFilters(): void {
    setQuery(DEFAULT_LOBBY_FILTER.query)
    setProvider(DEFAULT_LOBBY_FILTER.provider)
    setStatus(DEFAULT_LOBBY_FILTER.status)
  }

  return (
    <div className="lobby">
      <header className="lobby-top">
        <span className="wordmark">
          Dev<b>Hotel</b>
        </span>
        <span className="spacer" />
        <button className="btn pairing-entry" onClick={() => setPairingOpen(true)}>{t('pairing.entry')}</button>
        <button className="btn hotel-services-entry" onClick={() => setServicesOpen(true)}>{t('hotelServices.title')}</button>
        <button className="icon-btn" title={t('lobby.settings')} onClick={() => setSettingsOpen(true)}>
          ⚙
        </button>
      </header>

      {rooms.length > 0 && (
        <section className="lobby-toolbar" aria-label={t('lobby.searchLabel')}>
          <div className="lobby-search">
            <input
              type="text"
              className="lobby-search-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query.length > 0) setQuery('')
              }}
              placeholder={t('lobby.searchPlaceholder')}
              aria-label={t('lobby.searchLabel')}
            />
            {query.length > 0 && (
              <button
                type="button"
                className="lobby-search-clear"
                title={t('common.clear')}
                aria-label={t('common.clear')}
                onClick={() => setQuery('')}
              >
                ×
              </button>
            )}
          </div>

          <div className="lobby-filter-groups">
            <div className="lobby-filter-group" role="group">
              {PROVIDER_FILTERS.map((item) => {
                const count = item.id === 'all' ? summary.total : summary.byProvider[item.id]
                return (
                  <button
                    key={item.id}
                    type="button"
                    className="lobby-chip"
                    data-active={provider === item.id}
                    aria-pressed={provider === item.id}
                    onClick={() => setProvider(item.id)}
                  >
                    <span>{t(item.labelKey)}</span>
                    <span className="lobby-chip-count">{count}</span>
                  </button>
                )
              })}
            </div>

            <div className="lobby-filter-group" role="group">
              {STATUS_FILTERS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="lobby-chip"
                  data-active={status === item.id}
                  aria-pressed={status === item.id}
                  onClick={() => setStatus(item.id)}
                >
                  {t(item.labelKey)}
                </button>
              ))}
            </div>
          </div>

          <div className="lobby-summary">
            {filtering
              ? t('lobby.summaryFiltered', {
                  shown: visibleRooms.length,
                  total: summary.total,
                  active: summary.active
                })
              : t('lobby.summaryCount', {
                  total: summary.total,
                  active: summary.active
                })}
          </div>
        </section>
      )}

      <main className="card-grid">
        {rooms.length === 0 && (
          <div className="lobby-quiet">
            <span className="plate">{t('lobby.quietTitle')}</span>
            {t('lobby.quietHint')}
          </div>
        )}
        {rooms.length > 0 && visibleRooms.length === 0 && (
          <div className="lobby-quiet lobby-no-match">
            <span className="plate">{t('lobby.noMatchTitle')}</span>
            <p>{t('lobby.noMatchHint')}</p>
            <button type="button" className="btn" onClick={resetFilters}>
              {t('lobby.resetFilters')}
            </button>
          </div>
        )}
        {visibleRooms.map((room) => (
          <RoomCard key={room.id} room={room} />
        ))}
        <button className="new-room-card" onClick={() => openWizard(true)}>
          <span className="key">⚿</span>
          <span>{t('lobby.newRoom')}</span>
        </button>
      </main>

      {wizardOpen && <NewRoomWizard />}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {servicesOpen && <HotelServicesModal onClose={() => setServicesOpen(false)} />}
      {pairingOpen && <AndroidPairingModal onClose={() => setPairingOpen(false)} />}
    </div>
  )
}
