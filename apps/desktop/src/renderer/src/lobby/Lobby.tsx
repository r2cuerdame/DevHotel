import { useStore } from '../state/store'
import { RoomCard } from './RoomCard'
import { NewRoomWizard } from './NewRoomWizard'

export function Lobby(): React.JSX.Element {
  const rooms = useStore((s) => s.rooms)
  const gateway = useStore((s) => s.gateway)
  const wizardOpen = useStore((s) => s.wizardOpen)
  const openWizard = useStore((s) => s.openWizard)

  return (
    <div className="lobby">
      <header className="lobby-top">
        <span className="wordmark">
          Dev<b>Hotel</b>
        </span>
        <span className="spacer" />
        <span className="backend-pill" title="Local gateway">
          <span className="status-dot" data-status={gateway?.running ? 'ready' : 'broken'} />
          {gateway?.running
            ? `Gateway on :${gateway.httpPort}${gateway.httpsPort ? ` · :${gateway.httpsPort}` : ''}`
            : 'Gateway offline'}
        </span>
      </header>

      <main className="card-grid">
        {rooms.length === 0 && (
          <div className="lobby-quiet">
            <span className="plate">The lobby is quiet</span>
            Check in your first project — pick a GitHub repository or a local folder.
          </div>
        )}
        {rooms.map((room) => (
          <RoomCard key={room.id} room={room} />
        ))}
        <button className="new-room-card" onClick={() => openWizard(true)}>
          <span className="key">⚿</span>
          <span>New Room</span>
        </button>
      </main>

      {wizardOpen && <NewRoomWizard />}
    </div>
  )
}
