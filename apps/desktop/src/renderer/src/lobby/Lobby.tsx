import { useState } from 'react'
import { useStore, useT } from '../state/store'
import { RoomCard } from './RoomCard'
import { NewRoomWizard } from './NewRoomWizard'
import { SettingsModal } from './SettingsModal'
import { HotelServicesModal } from './HotelServicesModal'
import { AndroidPairingModal } from './AndroidPairingModal'

export function Lobby(): React.JSX.Element {
  const rooms = useStore((s) => s.rooms)
  const wizardOpen = useStore((s) => s.wizardOpen)
  const openWizard = useStore((s) => s.openWizard)
  const t = useT()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [servicesOpen, setServicesOpen] = useState(false)
  const [pairingOpen, setPairingOpen] = useState(false)

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
      {servicesOpen && <HotelServicesModal onClose={() => setServicesOpen(false)} />}
      {pairingOpen && <AndroidPairingModal onClose={() => setPairingOpen(false)} />}
    </div>
  )
}
