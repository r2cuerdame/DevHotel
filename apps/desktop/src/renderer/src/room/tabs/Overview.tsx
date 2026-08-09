import type { RoomRecord } from '@devhotel/shared'
import { statusLabel, useStore, useT } from '../../state/store'
import { api } from '../../api'

export function OverviewTab({ room }: { room: RoomRecord }): React.JSX.Element {
  const inspection = useStore((s) => s.inspections[room.id])
  const undoChange = useStore((s) => s.undoChange)
  const t = useT()
  const url = inspection?.urls.app

  return (
    <>
      <dl className="kv">
        <dt>{t('label.status')}</dt>
        <dd>
          <span className="status-dot" data-status={room.status} style={{ display: 'inline-block', marginRight: 6 }} />
          {statusLabel(t, room.status)}
        </dd>
        <dt>URL</dt>
        <dd>
          {url ? (
            <a
              href={url}
              className="mono"
              style={{ color: 'var(--brass)' }}
              onClick={(e) => {
                e.preventDefault()
                void api.app.openExternal(url)
              }}
            >
              {url}
            </a>
          ) : (
            <span className="muted">—</span>
          )}
        </dd>
        <dt>{t('label.startCommand')}</dt>
        <dd className="mono">{room.startCommand}</dd>
        <dt>{t('label.runtime')}</dt>
        <dd>Node {room.runtime.version}</dd>
        <dt>{t('label.packageManager')}</dt>
        <dd>
          {room.packageManager.kind}
          {room.packageManager.version ? ` ${room.packageManager.version}` : ''}
        </dd>
        <dt>{t('label.source')}</dt>
        <dd className="mono">{room.sourceType === 'empty' ? t('overview.emptyRoom') : room.sourceRef}</dd>
      </dl>

      {inspection?.lastUndoable && (
        <div className="panel-section">
          <h3>{t('overview.lastChange')}</h3>
          <div className="change-item">
            <span className="title">{inspection.lastUndoable.title}</span>
            <button className="btn" onClick={() => void undoChange(room.id, inspection.lastUndoable!.id)}>
              ↶ {t('common.undo')}
            </button>
          </div>
        </div>
      )}

      {inspection?.latestCheck && inspection.latestCheck.overall !== 'healthy' && (
        <div className="panel-section">
          <h3>{t('overview.health')}</h3>
          <div className="row small muted">{t('overview.checksFailing')}</div>
        </div>
      )}
    </>
  )
}
