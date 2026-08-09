import { useState } from 'react'
import type { RoomRecord, ServiceKind } from '@devhotel/shared'
import { statusLabel, useStore, useT } from '../../state/store'
import { api } from '../../api'
import type { Translation } from '../../i18n'

const SERVICES: { id: ServiceKind; label: string; addVersion: string; addKey: keyof Translation }[] = [
  { id: 'postgres', label: 'PostgreSQL', addVersion: '17', addKey: 'services.addPostgres' },
  { id: 'redis', label: 'Redis', addVersion: '8', addKey: 'services.addRedis' }
]

export function OverviewTab({ room, onShowHealth }: { room: RoomRecord; onShowHealth: () => void }): React.JSX.Element {
  const inspection = useStore((s) => s.inspections[room.id])
  const undoChange = useStore((s) => s.undoChange)
  const roomAction = useStore((s) => s.roomAction)
  const applyChange = useStore((s) => s.applyChange)
  const busy = useStore((s) => s.busy[room.id])
  const t = useT()
  const url = inspection?.urls.app
  const running = room.status === 'running' || room.status === 'ready' || room.status === 'attention'
  const android = room.provider === 'android'
  const [pending, setPending] = useState<string | null>(null)

  async function run(kind: string, fn: () => Promise<unknown>): Promise<void> {
    setPending(kind)
    try {
      await fn()
    } finally {
      setPending(null)
    }
  }

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
              {android
                ? `JDK ${room.runtime.version} · ${room.packageManager.kind}`
                : `Node ${room.runtime.version} · ${room.packageManager.kind}${room.https ? ' · HTTPS' : ''}`}
            </div>
          </div>
          <span className="status-chip" data-status={room.status}>
            <span className="status-dot" data-status={room.status} />
            {busy ?? statusLabel(t, room.status)}
          </span>
        </div>

        {!android && url && (
          <button className="url-pill" onClick={() => void api.app.openExternal(url)} title={t('overview.openInBrowser')}>
            {room.https && <span aria-hidden>🔒</span>}
            <span className="url-text">{url}</span>
            <span className="ext" aria-hidden>
              ↗
            </span>
          </button>
        )}

        <div className="hero-actions" style={android ? { gridTemplateColumns: '1fr 1fr 1fr' } : undefined}>
          {android && (
            <button
              className={running ? 'btn primary' : 'btn'}
              onClick={() => void run('build', () => applyChange(room.id, { kind: 'android-build' }))}
              disabled={!running || !!busy || pending !== null}
            >
              {pending === 'build' ? t('android.building') : t('android.buildApk')}
            </button>
          )}
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

      {android ? (
        <div className="panel-section">
          <h3>{t('android.buildCommand')}</h3>
          <div className="change-item">
            <span className="status-dot" data-status={room.status} />
            <span className="title">
              <span className="mono">{room.startCommand}</span>
              <div className="small muted">{t('android.apkHint')}</div>
            </span>
          </div>
        </div>
      ) : (
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
      )}

      <dl className="kv">
        <dt>{t('label.source')}</dt>
        <dd className="mono">{room.sourceType === 'empty' ? t('overview.emptyRoom') : room.sourceRef}</dd>
        {!android && (
          <>
            <dt>{t('label.domain')}</dt>
            <dd className="mono">{room.domain}</dd>
          </>
        )}
        <dt>{t('label.packageManager')}</dt>
        <dd>
          {room.packageManager.kind}
          {room.packageManager.version ? ` ${room.packageManager.version}` : ''}
        </dd>
      </dl>

      {!android && (
        <div className="panel-section">
          <h3>{t('services.databases')}</h3>
          {SERVICES.map(({ id, label }) => {
            const svc = room.services[id]
            if (!svc) return null
            return (
              <div key={id} className="change-item">
                <span className="status-dot" data-status={running ? 'ready' : 'sleeping'} />
                <span className="title">
                  {label} <span className="muted">{svc.version}</span>
                </span>
                <button
                  className="btn"
                  disabled={pending !== null}
                  onClick={() => void run(`${id}-backup`, () => applyChange(room.id, { kind: 'db-backup', service: id }))}
                >
                  {pending === `${id}-backup` ? t('common.applying') : t('services.backup')}
                </button>
                <button
                  className="btn"
                  disabled={pending !== null}
                  onClick={() => void run(`${id}-restart`, () => applyChange(room.id, { kind: 'service-restart', service: id }))}
                >
                  {pending === `${id}-restart` ? t('common.applying') : t('common.restart')}
                </button>
                <button
                  className="btn danger"
                  disabled={pending !== null}
                  onClick={() => {
                    if (window.confirm(t('services.removeConfirm', { service: label }))) {
                      void run(`${id}-remove`, () => applyChange(room.id, { kind: 'service-remove', service: id }))
                    }
                  }}
                >
                  {pending === `${id}-remove` ? t('common.applying') : t('services.remove')}
                </button>
              </div>
            )
          })}
          {SERVICES.some(({ id }) => !room.services[id]) && (
            <div className="row wrap" style={{ marginBottom: 8 }}>
              {SERVICES.filter(({ id }) => !room.services[id]).map(({ id, addVersion, addKey }) => (
                <button
                  key={id}
                  className="btn"
                  disabled={pending !== null}
                  onClick={() => void run(`${id}-add`, () => applyChange(room.id, { kind: 'service-add', service: id, version: addVersion }))}
                >
                  {pending === `${id}-add` ? t('common.applying') : t(addKey)}
                </button>
              ))}
            </div>
          )}
          <p className="small muted">{t('services.servicesHint')}</p>
        </div>
      )}
    </>
  )
}
