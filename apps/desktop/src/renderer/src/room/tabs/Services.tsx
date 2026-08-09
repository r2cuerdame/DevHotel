import type { RoomRecord } from '@devhotel/shared'
import { statusLabel, useStore, useT } from '../../state/store'

export function ServicesTab({ room }: { room: RoomRecord }): React.JSX.Element {
  const roomAction = useStore((s) => s.roomAction)
  const t = useT()
  const running = room.status === 'running' || room.status === 'ready'

  return (
    <>
      <div className="panel-section">
        <h3>{t('services.webProcess')}</h3>
        <div className="change-item">
          <span className="status-dot" data-status={room.status} />
          <span className="title">
            <span className="mono">{room.startCommand}</span>
            <div className="small muted">
              {t('services.processMeta', { status: statusLabel(t, room.status), port: room.internalPort })}
            </div>
          </span>
          <button className="btn" disabled={!running} onClick={() => void roomAction(room.id, 'restart')}>
            {t('common.restart')}
          </button>
        </div>
      </div>

      <div className="panel-section">
        <h3>{t('services.databases')}</h3>
        <p className="small muted">{t('services.databasesHint')}</p>
      </div>
    </>
  )
}
