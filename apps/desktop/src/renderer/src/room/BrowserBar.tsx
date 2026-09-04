import { useEffect, useRef, useState } from 'react'
import { IPC, type RuntimeRoomRecord } from '@devhotel/shared'
import { api } from '../api'
import { runtimeCapabilities } from './runtimeCapabilities'
import { statusLabel, useStore, useT } from '../state/store'
import { CloneRoomModal } from './CloneRoomModal'
import { ResetRoomModal } from './ResetRoomModal'

export function BrowserBar({
  room,
  configOpen,
  onToggleConfig,
  onModalChange
}: {
  room: RuntimeRoomRecord
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
  const [resetOpen, setResetOpen] = useState(false)
  const [nickname, setNickname] = useState(room.nickname)
  const [devtoolsOpen, setDevtoolsOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
    }
  }, [])

  const handleCopyUrl = async (): Promise<void> => {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      useStore.getState().toast('success', t('bar.copied'))
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
      copyTimeoutRef.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      useStore.getState().toast('error', 'Failed to copy URL')
    }
  }

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
    onModalChange(menuOpen || renameOpen || cloneOpen || resetOpen)
    return () => onModalChange(false)
  }, [cloneOpen, menuOpen, onModalChange, renameOpen, resetOpen])

  const { fullyRunning: running, hasLiveComponent } = runtimeCapabilities(room)
  const web = room.provider === 'web'
  const windows = room.provider === 'windows'
  // android rooms serve the emulator screen — their bar behaves like a site too
  const served = web || room.provider === 'android'
  const siteControlsEnabled = served && running && !configOpen
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

      {served && (
        <div className="browser-nav" aria-label={t('tabs.site')}>
          {web && (
            <>
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
            </>
          )}
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

      <div
        className={`domain-pill${served ? '' : ' build-room-pill'}`}
        title={web ? url : windows ? t('windows.noPreview') : t('android.buildOnlyHint')}
      >
        {web && room.https && <span title="HTTPS">🔒</span>}
        <span className="url">
          {web
            ? url
            : room.provider === 'android'
              ? `📱 ${room.android?.device ?? 'Samsung Galaxy S10'} · Android ${room.android?.version ?? '14.0'} · AOSP`
              : `⊞ ${t('windows.pill')}${room.windows?.snapshot ? ` · ${room.windows.snapshot}` : ''}`}
        </span>
        {web && (
          <button
            type="button"
            className={`copy-btn${copied ? ' copied' : ''}`}
            title={copied ? t('bar.copied') : t('bar.copyUrl')}
            aria-label={t('bar.copyUrl')}
            onClick={(e) => {
              e.stopPropagation()
              void handleCopyUrl()
            }}
          >
            {copied ? (
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path fillRule="evenodd" d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path fillRule="evenodd" d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25v-7.5z" />
                <path fillRule="evenodd" d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25v-7.5zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25h-7.5z" />
              </svg>
            )}
          </button>
        )}
        <span className="status-label">
          <span className="status-dot" data-status={room.status} />
          {busy ?? statusLabel(t, room.status)}
        </span>
      </div>

      {windows && running ? (
        <button
          className="btn primary"
          disabled={!!busy}
          onClick={() => {
            void api.rooms
              .openWindows(room.id)
              .catch((err: unknown) => useStore.getState().toast('error', err instanceof Error ? err.message : String(err)))
          }}
        >
          {t('windows.openVmware')}
        </button>
      ) : running ? (
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
            {hasLiveComponent && (
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
            {served && running && <div className="bar-menu-sep" />}
            {web && (
              <MenuItem
                label={copied ? t('bar.copied') : t('bar.copyUrl')}
                onClick={() => {
                  void handleCopyUrl()
                  setMenuOpen(false)
                }}
              />
            )}
            {served && running && (
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
              label={windows ? t('windows.resetMenu') : t('reset.menu')}
              onClick={() => {
                setResetOpen(true)
                setMenuOpen(false)
              }}
            />
            {!windows && (
              <MenuItem
                label={t('diag.copyDiagnostic')}
                onClick={() => {
                  void useStore.getState().copyDiagnostic(room.id)
                  setMenuOpen(false)
                }}
              />
            )}
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
      {resetOpen && <ResetRoomModal room={room} onClose={() => setResetOpen(false)} />}
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
