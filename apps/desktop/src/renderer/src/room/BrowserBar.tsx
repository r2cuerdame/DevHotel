import { useEffect, useRef, useState } from 'react'
import type { RoomRecord } from '@devhotel/shared'
import { api } from '../api'
import { statusLabel, useStore, useT } from '../state/store'
import { ROOM_PAGES, type RoomPage } from './RoomPages'

const VIEWPORTS: { id: string; label: string | null; size: { width: number; height: number } | null }[] = [
  { id: 'auto', label: null, size: null },
  { id: 'desktop', label: '1920×1080', size: { width: 1920, height: 1080 } },
  { id: 'laptop', label: '1366×768', size: { width: 1366, height: 768 } },
  { id: 'ipad', label: 'iPad 820×1180', size: { width: 820, height: 1180 } },
  { id: 'iphone', label: 'iPhone 390×844', size: { width: 390, height: 844 } },
  { id: 'galaxy', label: 'Galaxy 412×915', size: { width: 412, height: 915 } }
]

export function BrowserBar({
  room,
  page,
  onNavigate
}: {
  room: RoomRecord
  page: RoomPage
  onNavigate: (page: RoomPage) => void
}): React.JSX.Element {
  const backToLobby = useStore((s) => s.backToLobby)
  const roomAction = useStore((s) => s.roomAction)
  const preview = useStore((s) => s.previews[room.id])
  const gateway = useStore((s) => s.gateway)
  const busy = useStore((s) => s.busy[room.id])
  const t = useT()
  const [menuOpen, setMenuOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [nickname, setNickname] = useState(room.nickname)
  const [devtoolsOpen, setDevtoolsOpen] = useState(false)
  const [viewport, setViewport] = useState('auto')
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const close = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menuOpen])

  useEffect(() => {
    setDevtoolsOpen(false)
    setViewport('auto')
  }, [room.id])

  const running = room.status === 'running' || room.status === 'ready' || room.status === 'attention'
  const android = room.provider === 'android'
  const onSite = page === 'site'
  const httpsPort = gateway?.httpsPort
  const httpPort = gateway?.httpPort
  const url =
    (onSite && preview?.url) ||
    (room.https
      ? `https://${room.domain}${httpsPort && httpsPort !== 443 ? `:${httpsPort}` : ''}`
      : `http://${room.domain}${httpPort && httpPort !== 80 ? `:${httpPort}` : ''}`)

  const pageLabel = ROOM_PAGES.find((p) => p.id === page)

  return (
    <div className="browser-bar">
      <button className="icon-btn" title={t('bar.backToLobby')} onClick={backToLobby}>
        ⌂
      </button>
      {!android && (
        <>
          <button
            className="icon-btn"
            title={t('common.back')}
            disabled={!onSite || !preview?.canGoBack}
            onClick={() => void api.preview.nav(room.id, 'back')}
          >
            ←
          </button>
          <button
            className="icon-btn"
            title={t('bar.forward')}
            disabled={!onSite || !preview?.canGoForward}
            onClick={() => void api.preview.nav(room.id, 'forward')}
          >
            →
          </button>
          <button
            className="icon-btn"
            title={t('bar.reload')}
            disabled={!onSite || !running}
            onClick={() => void api.preview.nav(room.id, 'reload')}
          >
            ⟳
          </button>
        </>
      )}

      <div className="domain-pill">
        {onSite && room.https && <span title="HTTPS">🔒</span>}
        <span className="url">
          {android
            ? t('android.pill', { project: room.project, nickname: room.nickname })
            : onSite
              ? url
              : `devhotel · ${pageLabel ? t(pageLabel.key) : ''} — ${room.project} / ${room.nickname}`}
        </span>
        <span className="status-label">
          <span className="status-dot" data-status={room.status} style={{ display: 'inline-block', marginRight: 6 }} />
          {busy ?? statusLabel(t, room.status)}
        </span>
      </div>

      {!android && onSite && running && (
        <>
          <button
            className="icon-btn"
            title={t('bar.devtools')}
            aria-pressed={devtoolsOpen}
            style={devtoolsOpen ? { border: '1px solid var(--brass)', color: 'var(--brass)' } : undefined}
            onClick={() => void api.preview.devtools(room.id).then(setDevtoolsOpen)}
          >
            {'</>'}
          </button>
          <select
            className="btn"
            title={t('viewport.title')}
            value={viewport}
            onChange={(e) => {
              const id = e.target.value
              setViewport(id)
              const vp = VIEWPORTS.find((v) => v.id === id)
              void api.preview.viewport(room.id, vp?.size ?? null)
            }}
          >
            {VIEWPORTS.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label ?? t('viewport.auto')}
              </option>
            ))}
          </select>
        </>
      )}

      {running ? (
        <>
          <button className="btn" disabled={!!busy} onClick={() => void roomAction(room.id, 'restart')}>
            {t('common.restart')}
          </button>
          <button className="btn" disabled={!!busy} onClick={() => void roomAction(room.id, 'sleep')}>
            {t('bar.sleep')}
          </button>
        </>
      ) : (
        <button
          className="btn primary"
          disabled={room.status === 'preparing' || !!busy}
          onClick={() => void roomAction(room.id, 'start')}
        >
          {room.status === 'sleeping' ? t('bar.wake') : t('bar.start')}
        </button>
      )}

      {!android && (
        <button
          className="icon-btn"
          title={t('bar.roomDetails')}
          onClick={() => onNavigate(onSite ? 'overview' : 'site')}
          aria-pressed={!onSite}
        >
          {onSite ? '☰' : '◉'}
        </button>
      )}

      <div ref={menuRef} style={{ position: 'relative' }}>
        <button className="icon-btn" title={t('bar.more')} onClick={() => setMenuOpen((v) => !v)}>
          ⋯
        </button>
        {menuOpen && (
          <div className="bar-menu">
            {!android && (
              <MenuItem
                label={t('bar.openExternal')}
                onClick={() => {
                  void api.app.openExternal(url)
                  setMenuOpen(false)
                }}
              />
            )}
            {room.sourceType === 'linked-folder' && (
              <MenuItem
                label={t('bar.openSourceFolder')}
                onClick={() => {
                  void api.app.openPath(room.sourceRef)
                  setMenuOpen(false)
                }}
              />
            )}
            <MenuItem
              label={t('bar.rename')}
              onClick={() => {
                setNickname(room.nickname)
                setRenameOpen(true)
                setMenuOpen(false)
              }}
            />
            <MenuItem
              label={t('diag.copyDiagnostic')}
              onClick={() => {
                void useStore.getState().copyDiagnostic(room.id)
                setMenuOpen(false)
              }}
            />
            <div className="bar-menu-sep" />
            <MenuItem
              label={t('bar.deleteRoom')}
              danger
              onClick={() => {
                setMenuOpen(false)
                if (window.confirm(t('bar.deleteConfirm', { project: room.project, nickname: room.nickname }))) {
                  void roomAction(room.id, 'delete')
                }
              }}
            />
          </div>
        )}
      </div>

      {renameOpen && (
        <div className="modal-backdrop" onClick={() => setRenameOpen(false)}>
          <div className="modal" style={{ width: 380 }} onClick={(e) => e.stopPropagation()}>
            <h2>{t('rename.title')}</h2>
            <div className="field">
              <label htmlFor="rename-nick">{t('wizard.nickname')}</label>
              <input id="rename-nick" value={nickname} onChange={(e) => setNickname(e.target.value)} autoFocus />
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setRenameOpen(false)}>
                {t('common.cancel')}
              </button>
              <button
                className="btn primary"
                disabled={!nickname.trim() || nickname.trim() === room.nickname}
                onClick={() => {
                  void api.rooms.rename(room.id, nickname.trim()).then(() => {
                    setRenameOpen(false)
                    void useStore.getState().refreshRooms()
                    void useStore.getState().refreshInspection(room.id)
                  })
                }}
              >
                {t('rename.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function MenuItem({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      style={{
        textAlign: 'left',
        padding: '8px 10px',
        borderRadius: 6,
        color: danger ? 'var(--bad)' : undefined
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--walnut)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      {label}
    </button>
  )
}
