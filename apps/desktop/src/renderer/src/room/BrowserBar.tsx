import { useEffect, useRef, useState } from 'react'
import { IPC, type RoomRecord } from '@devhotel/shared'
import { api } from '../api'
import { statusLabel, useStore, useT } from '../state/store'
import { CloneRoomModal } from './CloneRoomModal'

export function BrowserBar({
  room,
  configOpen,
  onToggleConfig,
  onModalChange
}: {
  room: RoomRecord
  configOpen: boolean
  onToggleConfig: () => void
  onModalChange: (open: boolean) => void
}): React.JSX.Element {
  const backToLobby = useStore((s) => s.backToLobby)
  const roomAction = useStore((s) => s.roomAction)
  const preview = useStore((s) => s.previews[room.id])
  const gateway = useStore((s) => s.gateway)
  const busy = useStore((s) => s.busy[room.id])
  const t = useT()
  const [menuOpen, setMenuOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [cloneOpen, setCloneOpen] = useState(false)
  const [nickname, setNickname] = useState(room.nickname)
  const [devtoolsOpen, setDevtoolsOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: MouseEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menuOpen])

  useEffect(() => {
    setDevtoolsOpen(false)
  }, [room.id])

  useEffect(
    () =>
      api.on(IPC.evPreviewDevTools, (roomId: string, open: boolean) => {
        if (roomId === room.id) setDevtoolsOpen(open)
      }),
    [room.id]
  )

  useEffect(() => {
    // WebContentsView is a native child above renderer DOM. Hide it while any
    // toolbar overlay is open so the menu/modal can actually be seen.
    onModalChange(menuOpen || renameOpen || cloneOpen)
    return () => onModalChange(false)
  }, [cloneOpen, menuOpen, onModalChange, renameOpen])

  const running = room.status === 'running' || room.status === 'ready' || room.status === 'attention'
  const web = room.provider === 'web'
  const siteControlsEnabled = web && running && !configOpen
  const httpsPort = gateway?.httpsPort
  const httpPort = gateway?.httpPort
  const url =
    preview?.url ??
    (room.https
      ? `https://${room.domain}${httpsPort && httpsPort !== 443 ? `:${httpsPort}` : ''}`
      : `http://${room.domain}${httpPort && httpPort !== 80 ? `:${httpPort}` : ''}`)

  return (
    <div className="browser-bar">
      <button className="btn browser-lobby" title={t('bar.backToLobby')} onClick={backToLobby}>
        <span aria-hidden>←</span>
        <span>{t('bar.lobby')}</span>
      </button>

      <div className="room-identity" title={`${room.project} / ${room.nickname}`}>
        <span className="room-no">№ {room.roomNumber}</span>
        <span>
          {room.project} <i>/ {room.nickname}</i>
        </span>
      </div>

      {web && (
        <div className="browser-nav" aria-label={t('tabs.site')}>
          <button
            className="icon-btn"
            title={t('common.back')}
            disabled={!siteControlsEnabled || !preview?.canGoBack}
            onClick={() => void api.preview.nav(room.id, 'back')}
          >
            ←
          </button>
          <button
            className="icon-btn"
            title={t('bar.forward')}
            disabled={!siteControlsEnabled || !preview?.canGoForward}
            onClick={() => void api.preview.nav(room.id, 'forward')}
          >
            →
          </button>
          <button
            className="icon-btn"
            title={t('bar.reload')}
            disabled={!siteControlsEnabled}
            onClick={() => void api.preview.nav(room.id, 'reload')}
          >
            ⟳
          </button>
        </div>
      )}

      <div className={`domain-pill${web ? '' : ' build-room-pill'}`} title={web ? url : t('android.buildOnlyHint')}>
        {web && room.https && <span title="HTTPS">🔒</span>}
        <span className="url">{web ? url : t('android.buildRoom')}</span>
        <span className="status-label">
          <span className="status-dot" data-status={room.status} />
          {busy ?? statusLabel(t, room.status)}
        </span>
      </div>

      {running ? (
        <button className="btn" disabled={!!busy} onClick={() => void roomAction(room.id, 'restart')}>
          {t('common.restart')}
        </button>
      ) : (
        <button
          className="btn primary"
          disabled={room.status === 'preparing' || !!busy}
          onClick={() => void roomAction(room.id, 'start')}
        >
          {room.status === 'sleeping' ? t('bar.wake') : t('bar.start')}
        </button>
      )}

      <div ref={menuRef} className="bar-menu-anchor">
        <button
          className="icon-btn"
          title={t('bar.more')}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          onClick={() => setMenuOpen((open) => !open)}
        >
          ☰
        </button>
        {menuOpen && (
          <div className="bar-menu" role="menu">
            <MenuItem
              label={t('bar.roomDetails')}
              active={configOpen}
              onClick={() => {
                setMenuOpen(false)
                onToggleConfig()
              }}
            />
            <div className="bar-menu-sep" />
            {running && (
              <MenuItem
                label={t('bar.sleep')}
                onClick={() => {
                  setMenuOpen(false)
                  void roomAction(room.id, 'sleep')
                }}
              />
            )}
            {web && (
              <>
                <label className="bar-menu-switch" data-disabled={!siteControlsEnabled || undefined}>
                  <span>{t('bar.devtools')}</span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={devtoolsOpen}
                    disabled={!siteControlsEnabled}
                    onChange={() => void api.preview.devtools(room.id).then(setDevtoolsOpen)}
                  />
                </label>
              </>
            )}
            {web && running && <div className="bar-menu-sep" />}
            {web && running && (
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
            {web && (
              <MenuItem
                label={t('bar.cloneRoom')}
                onClick={() => {
                  setCloneOpen(true)
                  setMenuOpen(false)
                }}
              />
            )}
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
          <form
            className="modal compact-modal"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault()
              if (!nickname.trim() || nickname.trim() === room.nickname) return
              void api.rooms.rename(room.id, nickname.trim()).then(() => {
                setRenameOpen(false)
                void useStore.getState().refreshRooms()
                void useStore.getState().refreshInspection(room.id)
              }).catch((error: unknown) => {
                useStore.getState().toast('error', error instanceof Error ? error.message : String(error))
              })
            }}
          >
            <h2>{t('rename.title')}</h2>
            <div className="field">
              <label htmlFor="rename-nick">{t('wizard.nickname')}</label>
              <input id="rename-nick" value={nickname} maxLength={60} onChange={(event) => setNickname(event.target.value)} autoFocus />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setRenameOpen(false)}>
                {t('common.cancel')}
              </button>
              <button type="submit" className="btn primary" disabled={!nickname.trim() || nickname.trim() === room.nickname}>
                {t('rename.save')}
              </button>
            </div>
          </form>
        </div>
      )}

      {cloneOpen && <CloneRoomModal room={room} onClose={() => setCloneOpen(false)} />}
    </div>
  )
}

function MenuItem({
  label,
  onClick,
  danger,
  active
}: {
  label: string
  onClick: () => void
  danger?: boolean
  active?: boolean
}): React.JSX.Element {
  return (
    <button className="bar-menu-item" data-active={active || undefined} data-danger={danger || undefined} onClick={onClick}>
      <span>{label}</span>
      {active && <span aria-hidden>✓</span>}
    </button>
  )
}
