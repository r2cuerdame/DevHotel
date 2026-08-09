import { useEffect, useRef, useState } from 'react'
import type { RoomRecord } from '@devhotel/shared'
import { api } from '../api'
import { statusLabel, useStore, useT } from '../state/store'

export function BrowserBar({
  room,
  panelOpen,
  onTogglePanel
}: {
  room: RoomRecord
  panelOpen: boolean
  onTogglePanel: () => void
}): React.JSX.Element {
  const backToLobby = useStore((s) => s.backToLobby)
  const roomAction = useStore((s) => s.roomAction)
  const preview = useStore((s) => s.previews[room.id])
  const gateway = useStore((s) => s.gateway)
  const t = useT()
  const [menuOpen, setMenuOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [nickname, setNickname] = useState(room.nickname)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const close = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menuOpen])

  const running = room.status === 'running' || room.status === 'ready' || room.status === 'attention'
  const httpsPort = gateway?.httpsPort
  const httpPort = gateway?.httpPort
  const url =
    preview?.url ??
    (room.https
      ? `https://${room.domain}${httpsPort && httpsPort !== 443 ? `:${httpsPort}` : ''}`
      : `http://${room.domain}${httpPort && httpPort !== 80 ? `:${httpPort}` : ''}`)

  return (
    <div className="browser-bar">
      <button className="icon-btn" title={t('bar.backToLobby')} onClick={backToLobby}>
        ⌂
      </button>
      <button
        className="icon-btn"
        title={t('common.back')}
        disabled={!preview?.canGoBack}
        onClick={() => void api.preview.nav(room.id, 'back')}
      >
        ←
      </button>
      <button
        className="icon-btn"
        title={t('bar.forward')}
        disabled={!preview?.canGoForward}
        onClick={() => void api.preview.nav(room.id, 'forward')}
      >
        →
      </button>
      <button className="icon-btn" title={t('bar.reload')} disabled={!running} onClick={() => void api.preview.nav(room.id, 'reload')}>
        ⟳
      </button>

      <div className="domain-pill">
        {room.https && <span title="HTTPS">🔒</span>}
        <span className="url">{url}</span>
        <span className="status-label">
          <span className="status-dot" data-status={room.status} style={{ display: 'inline-block', marginRight: 6 }} />
          {statusLabel(t, room.status)}
        </span>
      </div>

      {running ? (
        <>
          <button className="btn" onClick={() => void roomAction(room.id, 'restart')}>
            {t('common.restart')}
          </button>
          <button className="btn" onClick={() => void roomAction(room.id, 'sleep')}>
            {t('bar.sleep')}
          </button>
        </>
      ) : (
        <button className="btn primary" disabled={room.status === 'preparing'} onClick={() => void roomAction(room.id, 'start')}>
          {room.status === 'sleeping' ? t('bar.wake') : t('bar.start')}
        </button>
      )}

      <button className="icon-btn" title={t('bar.roomDetails')} onClick={onTogglePanel} aria-pressed={panelOpen}>
        {panelOpen ? '▤' : '☰'}
      </button>

      <div ref={menuRef} style={{ position: 'relative' }}>
        <button className="icon-btn" title={t('bar.more')} onClick={() => setMenuOpen((v) => !v)}>
          ⋯
        </button>
        {menuOpen && (
          <div
            style={{
              position: 'absolute',
              right: 0,
              top: 34,
              background: 'var(--walnut-2)',
              border: '1px solid var(--line)',
              borderRadius: 8,
              padding: 6,
              zIndex: 30,
              width: 220,
              display: 'flex',
              flexDirection: 'column'
            }}
          >
            <MenuItem
              label={t('bar.openExternal')}
              onClick={() => {
                void api.app.openExternal(url)
                setMenuOpen(false)
              }}
            />
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
