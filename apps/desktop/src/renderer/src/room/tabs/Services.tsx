import type { RoomRecord } from '@devhotel/shared'
import { STATUS_LABEL, useStore } from '../../state/store'

export function ServicesTab({ room }: { room: RoomRecord }): React.JSX.Element {
  const roomAction = useStore((s) => s.roomAction)
  const running = room.status === 'running' || room.status === 'ready'

  return (
    <>
      <div className="panel-section">
        <h3>Web process</h3>
        <div className="change-item">
          <span className="status-dot" data-status={room.status} />
          <span className="title">
            <span className="mono">{room.startCommand}</span>
            <div className="small muted">
              {STATUS_LABEL[room.status]} · internal port {room.internalPort}
            </div>
          </span>
          <button className="btn" disabled={!running} onClick={() => void roomAction(room.id, 'restart')}>
            Restart
          </button>
        </div>
      </div>

      <div className="panel-section">
        <h3>Databases</h3>
        <p className="small muted">
          Per-room PostgreSQL and Redis arrive in a later release. Each room already has its own private network, so services
          will live inside the room at their standard ports without clashing with other rooms.
        </p>
      </div>
    </>
  )
}
