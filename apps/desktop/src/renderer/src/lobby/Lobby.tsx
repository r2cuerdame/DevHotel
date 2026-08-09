import { useState } from 'react'
import { useStore, useT } from '../state/store'
import { RoomCard } from './RoomCard'
import { NewRoomWizard } from './NewRoomWizard'
import { SettingsModal } from './SettingsModal'

export function Lobby(): React.JSX.Element {
  const rooms = useStore((s) => s.rooms)
  const gateway = useStore((s) => s.gateway)
  const wizardOpen = useStore((s) => s.wizardOpen)
  const openWizard = useStore((s) => s.openWizard)
  const t = useT()
  const [settingsOpen, setSettingsOpen] = useState(false)

  return (
    <div className="lobby">
      <header className="lobby-top">
        <span className="wordmark">
          Dev<b>Hotel</b>
        </span>
        <span className="spacer" />
        <span className="backend-pill" title={t('lobby.gatewayTitle')}>
          <span className="status-dot" data-status={gateway?.running ? 'ready' : 'broken'} />
          {gateway?.running
            ? t('lobby.gatewayOn', { ports: `:${gateway.httpPort}${gateway.httpsPort ? ` · :${gateway.httpsPort}` : ''}` })
            : t('lobby.gatewayOffline')}
        </span>
        <button className="icon-btn" title={t('lobby.settings')} onClick={() => setSettingsOpen(true)}>
          ⚙
        </button>
      </header>

      <main className="card-grid">
        {rooms.length === 0 && (
          <div className="lobby-quiet">
            <span className="plate">{t('lobby.quietTitle')}</span>
            {t('lobby.quietHint')}
          </div>
        )}
        {rooms.map((room) => (
          <RoomCard key={room.id} room={room} />
        ))}
        <button className="new-room-card" onClick={() => openWizard(true)}>
          <span className="key">⚿</span>
          <span>{t('lobby.newRoom')}</span>
        </button>
      </main>

      {wizardOpen && <NewRoomWizard />}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}
