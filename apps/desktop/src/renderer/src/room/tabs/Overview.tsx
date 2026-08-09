import type { RoomRecord } from '@devhotel/shared'
import { statusLabel, useStore, useT } from '../../state/store'
import { api } from '../../api'

export function OverviewTab({ room, onShowHealth }: { room: RoomRecord; onShowHealth: () => void }): React.JSX.Element {
  const inspection = useStore((s) => s.inspections[room.id])
  const undoChange = useStore((s) => s.undoChange)
  const roomAction = useStore((s) => s.roomAction)
  const busy = useStore((s) => s.busy[room.id])
  const t = useT()
  const url = inspection?.urls.app
  const running = room.status === 'running' || room.status === 'ready' || room.status === 'attention'

  return (
    <>
      <div className="panel-hero">
        <div className="hero-head">
          <span className="room-no">№ {room.roomNumber}</span>
          <div style={{ minWidth: 0 }}>
            <div className="hero-title">
              {room.project} <span>/ {room.nickname}</span>
            </div>
            <div className="hero-chips">
              Node {room.runtime.version} · {room.packageManager.kind}
              {room.https ? ' · HTTPS' : ''}
            </div>
          </div>
          <span className="status-chip" data-status={room.status}>
            <span className="status-dot" data-status={room.status} />
            {busy ?? statusLabel(t, room.status)}
          </span>
        </div>

        {url && (
          <button className="url-pill" onClick={() => void api.app.openExternal(url)} title={t('overview.openInBrowser')}>
            {room.https && <span aria-hidden>🔒</span>}
            <span className="url-text">{url}</span>
            <span className="ext" aria-hidden>
              ↗
            </span>
          </button>
        )}

        <div className="hero-actions">
          {running ? (
            <button className="btn" onClick={() => void roomAction(room.id, 'sleep')} disabled={!!busy}>
              {t('bar.sleep')}
            </button>
          ) : (
            <button
              className="btn primary"
              onClick={() => void roomAction(room.id, 'start')}
              disabled={!!busy || room.status === 'preparing'}
            >
              {room.status === 'sleeping' ? t('bar.wake') : t('bar.start')}
            </button>
          )}
          <button className="btn" onClick={() => void roomAction(room.id, 'restart')} disabled={!running || !!busy}>
            {t('common.restart')}
          </button>
        </div>
      </div>

      {inspection?.lastUndoable && (
        <div className="undo-card">
          <span className="title">
            <span className="eyebrow">{t('overview.lastChange')}</span>
            {inspection.lastUndoable.title}
          </span>
          <button className="btn" onClick={() => void undoChange(room.id, inspection.lastUndoable!.id)}>
            ↶ {t('common.undo')}
          </button>
        </div>
      )}

      {inspection?.latestCheck && inspection.latestCheck.overall !== 'healthy' && (
        <button className="undo-card" style={{ width: '100%', borderColor: 'var(--warn)' }} onClick={onShowHealth}>
          <span className="title">
            <span className="eyebrow" style={{ color: 'var(--warn)' }}>
              {t('tabs.health')}
            </span>
            {t('overview.checksFailing')}
          </span>
        </button>
      )}

      <div className="panel-section">
        <h3>{t('services.webProcess')}</h3>
        <div className="change-item">
          <span className="status-dot" data-status={room.status} />
          <span className="title">
            <span className="mono">{room.startCommand}</span>
            <div className="small muted">{t('services.processMeta', { status: statusLabel(t, room.status), port: room.internalPort })}</div>
          </span>
        </div>
      </div>

      <dl className="kv">
        <dt>{t('label.source')}</dt>
        <dd className="mono">{room.sourceType === 'empty' ? t('overview.emptyRoom') : room.sourceRef}</dd>
        <dt>{t('label.domain')}</dt>
        <dd className="mono">{room.domain}</dd>
        <dt>{t('label.packageManager')}</dt>
        <dd>
          {room.packageManager.kind}
          {room.packageManager.version ? ` ${room.packageManager.version}` : ''}
        </dd>
      </dl>

      <div className="panel-section">
        <h3>{t('services.databases')}</h3>
        <p className="small muted">{t('services.databasesHint')}</p>
      </div>
    </>
  )
}
