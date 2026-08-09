import { useEffect, useRef, useState } from 'react'
import type { RoomRecord } from '@devhotel/shared'
import { api } from '../api'
import { STATUS_LABEL, useStore } from '../state/store'

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
  const [menuOpen, setMenuOpen] = useState(false)
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
      <button className="icon-btn" title="Back to Lobby" onClick={backToLobby}>
        ⌂
      </button>
      <button
        className="icon-btn"
        title="Back"
        disabled={!preview?.canGoBack}
        onClick={() => void api.preview.nav(room.id, 'back')}
      >
        ←
      </button>
      <button
        className="icon-btn"
        title="Forward"
        disabled={!preview?.canGoForward}
        onClick={() => void api.preview.nav(room.id, 'forward')}
      >
        →
      </button>
      <button className="icon-btn" title="Reload" disabled={!running} onClick={() => void api.preview.nav(room.id, 'reload')}>
        ⟳
      </button>

      <div className="domain-pill">
        {room.https && <span title="HTTPS">🔒</span>}
        <span className="url">{url}</span>
        <span className="status-label">
          <span className="status-dot" data-status={room.status} style={{ display: 'inline-block', marginRight: 6 }} />
          {STATUS_LABEL[room.status]}
        </span>
      </div>

      {running ? (
        <>
          <button className="btn" onClick={() => void roomAction(room.id, 'restart')}>
            Restart
          </button>
          <button className="btn" onClick={() => void roomAction(room.id, 'sleep')}>
            Sleep
          </button>
        </>
      ) : (
        <button className="btn primary" disabled={room.status === 'preparing'} onClick={() => void roomAction(room.id, 'start')}>
          {room.status === 'sleeping' ? 'Wake' : 'Start'}
        </button>
      )}

      <button className="icon-btn" title="Room details" onClick={onTogglePanel} aria-pressed={panelOpen}>
        {panelOpen ? '▤' : '☰'}
      </button>

      <div ref={menuRef} style={{ position: 'relative' }}>
        <button className="icon-btn" title="More" onClick={() => setMenuOpen((v) => !v)}>
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
              label="Open in default browser"
              onClick={() => {
                void api.app.openExternal(url)
                setMenuOpen(false)
              }}
            />
            {room.sourceType === 'linked-folder' && (
              <MenuItem
                label="Open source folder"
                onClick={() => {
                  void api.app.openPath(room.sourceRef)
                  setMenuOpen(false)
                }}
              />
            )}
            <MenuItem
              label="Copy diagnostic"
              onClick={() => {
                void useStore.getState().copyDiagnostic(room.id)
                setMenuOpen(false)
              }}
            />
            <MenuItem
              label="Delete room…"
              danger
              onClick={() => {
                setMenuOpen(false)
                if (
                  window.confirm(
                    `Delete ${room.project} / ${room.nickname}?\n\nThis removes the room's environment, dependencies and data. Sleeping keeps everything — deleting does not.`
                  )
                ) {
                  void roomAction(room.id, 'delete')
                }
              }}
            />
          </div>
        )}
      </div>
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
