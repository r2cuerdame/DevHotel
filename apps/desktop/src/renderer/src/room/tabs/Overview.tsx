import { useState } from 'react'
import type { RoomRecord } from '@devhotel/shared'
import { statusLabel, useStore, useT } from '../../state/store'
import { api } from '../../api'

/** Latest verified Room-owned APK path. Artifact export arrives with the Device Service. */
function LatestBuild({ room }: { room: RoomRecord }): React.JSX.Element | null {
  const inspection = useStore((s) => s.inspections[room.id])
  const t = useT()
  const build = inspection?.recentChanges.find((c) => c.kind === 'android-build' && c.verify?.ok)
  if (!build?.verify) return null
  const containerPath = build.verify.detail.replace(/^APK ready: /, '')
  const roomPath = containerPath.replace(/^\/workspace\//, '')
  return (
    <div className="change-item" style={{ marginTop: 8 }}>
      <span className="status-dot" data-status="ready" />
      <span className="title">
        <span className="eyebrow" style={{ display: 'block', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--brass)' }}>
          {t('android.lastBuild')}
        </span>
        <span className="mono small">{roomPath}</span>
      </span>
    </div>
  )
}

export function OverviewTab({ room, onShowHealth }: { room: RoomRecord; onShowHealth: () => void }): React.JSX.Element {
  const inspection = useStore((s) => s.inspections[room.id])
  const undoChange = useStore((s) => s.undoChange)
  const roomAction = useStore((s) => s.roomAction)
  const applyChange = useStore((s) => s.applyChange)
  const refreshInspection = useStore((s) => s.refreshInspection)
  const refreshRooms = useStore((s) => s.refreshRooms)
  const toast = useStore((s) => s.toast)
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

  async function workingStateAction(kind: 'sync' | 'migrate'): Promise<void> {
    await run(kind, async () => {
      try {
        const approvedHostPath = await api.app.pickFolder()
        if (!approvedHostPath) return
        if (kind === 'sync') await api.rooms.syncFromHost(room.id, approvedHostPath)
        else await api.rooms.moveIntoHotel(room.id, approvedHostPath)
        await Promise.all([refreshInspection(room.id), refreshRooms()])
        toast('success', kind === 'sync' ? t('working.synced') : t('working.roomOwned'))
      } catch (err) {
        toast('error', err instanceof Error ? err.message : String(err))
      }
    })
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

        <div className="hero-actions">
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

      {room.sourceType === 'linked-folder' && (
        <div className="panel-section">
          <h3>{t('working.title')}</h3>
          <div className="change-item">
            <span className="status-dot" data-status={room.syncStatus === 'modified' ? 'attention' : 'ready'} />
            <span className="title">
              {room.workspaceMode === 'legacy-host-bind'
                ? t('working.legacy')
                : room.hostSyncEnabled
                  ? t('working.roomOwned')
                  : t('working.detached')}
              <div className="small muted">
                {room.syncStatus === 'modified' ? t('working.modifiedHint') : `${t('working.synced')} · R${room.stateRevision}`}
              </div>
            </span>
            {room.workspaceMode === 'legacy-host-bind' && room.hostSyncEnabled && (
              <button className="btn primary" disabled={pending !== null} onClick={() => void workingStateAction('migrate')}>
                {t('working.moveIntoHotel')}
              </button>
            )}
            {room.workspaceMode === 'hotel' && room.hostSyncEnabled && (
              <button
                className="btn"
                disabled={pending !== null}
                title={room.syncStatus === 'modified' ? t('working.modifiedHint') : undefined}
                onClick={() => void workingStateAction('sync')}
              >
                {t('working.syncFromHost')}
              </button>
            )}
          </div>
        </div>
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
          <LatestBuild room={room} />
          <div className="change-item coming-next-card">
            <span className="status-dot" data-status="sleeping" />
            <span className="title">
              {t('android.deviceService')}
              <div className="small muted">{t('android.deviceServiceComingNext')}</div>
            </span>
            <span className="status-chip">{t('android.comingNext')}</span>
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
        <dd className="mono">
          {room.workspaceMode === 'hotel'
            ? `${t('working.roomOwned')} · R${room.stateRevision}`
            : room.sourceType === 'empty'
            ? t('overview.emptyRoom')
            : room.sourceType === 'linked-folder' && !room.hostSyncEnabled
              ? t('working.detached')
              : room.sourceRef}
        </dd>
        {!android && (
          <>
            <dt>{t('label.domain')}</dt>
            <dd className="mono">{room.domain}</dd>
          </>
        )}
      </dl>

    </>
  )
}
