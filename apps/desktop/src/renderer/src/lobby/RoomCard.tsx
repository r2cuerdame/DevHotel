import type { RoomRecord } from '@devhotel/shared'
import { STATUS_LABEL, stackLine, useStore } from '../state/store'

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function RoomCard({ room }: { room: RoomRecord }): React.JSX.Element {
  const openRoom = useStore((s) => s.openRoom)
  const busy = useStore((s) => s.busy[room.id])
  const asleep = room.status === 'sleeping'

  return (
    <button className="room-card" onClick={() => openRoom(room.id)}>
      <div className="room-thumb">
        {room.thumbPath ? (
          <img
            className={asleep ? 'asleep' : undefined}
            src={`devhotel-thumb://${room.id}/thumb.png?t=${encodeURIComponent(room.lastUsedAt)}`}
            alt=""
          />
        ) : (
          <span className="plate">№ {room.roomNumber}</span>
        )}
      </div>
      <div className="room-card-body">
        <div className="room-card-head">
          <span className="room-no">№ {room.roomNumber}</span>
          <span className="room-title">
            {room.project} <span>/ {room.nickname}</span>
          </span>
        </div>
        <div className="room-meta">
          <span className="status-dot" data-status={room.status} />
          <span>{busy ?? STATUS_LABEL[room.status]}</span>
          <span className="sep" />
          <span>{relTime(room.lastUsedAt)}</span>
        </div>
        <div className="room-meta">{stackLine(room)}</div>
      </div>
    </button>
  )
}
