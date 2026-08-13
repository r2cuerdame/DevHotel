import { useEffect, useRef, useState } from 'react'
import { IPC, type PreviewLayout } from '@devhotel/shared'
import { api } from '../api'
import { statusLabel, useStore, useT } from '../state/store'
import { BrowserBar } from './BrowserBar'
import { RoomConfig, type ConfigTab } from './DetailPanel'
import {
  clampSplitRatio,
  createPreviewLayout,
  DEFAULT_DESKTOP_TABLET_PRESET,
  DEFAULT_MOBILE_PRESET,
  DESKTOP_TABLET_PRESETS,
  loadPreviewPresetId,
  loadSplitEnabled,
  loadSplitRatio,
  MOBILE_PRESETS,
  PREVIEW_SPLIT_GUTTER,
  savePreviewPresetId,
  saveSplitEnabled,
  saveSplitRatio,
  splitLeftWidth
} from './previewLayout'

/** The emulator screen is 540×1140 (or rotated) — the preview pins to that aspect. */
const EMULATOR_PORTRAIT = { width: 540, height: 1140 }
const EMULATOR_LANDSCAPE = { width: 1140, height: 540 }

export function RoomView({ roomId }: { roomId: string }): React.JSX.Element {
  const room = useStore((s) => s.rooms.find((r) => r.id === roomId))
  const busy = useStore((s) => s.busy[roomId])
  const roomAction = useStore((s) => s.roomAction)
  const t = useT()
  const running = !!room && (room.status === 'running' || room.status === 'ready' || room.status === 'attention')
  const [configOpen, setConfigOpen] = useState(false)
  const [configTab, setConfigTab] = useState<ConfigTab>('overview')
  const [modalOpen, setModalOpen] = useState(false)
  const [devtoolsOpen, setDevtoolsOpen] = useState(false)
  const [leftPreset, setLeftPreset] = useState(() =>
    loadPreviewPresetId(window.localStorage, roomId, 'left', DESKTOP_TABLET_PRESETS, DEFAULT_DESKTOP_TABLET_PRESET)
  )
  const [rightPreset, setRightPreset] = useState(() =>
    loadPreviewPresetId(window.localStorage, roomId, 'right', MOBILE_PRESETS, DEFAULT_MOBILE_PRESET)
  )
  const [splitEnabled, setSplitEnabled] = useState(() => loadSplitEnabled(window.localStorage, roomId))
  const [splitRatio, setSplitRatio] = useState(() => loadSplitRatio(window.localStorage, roomId))
  /** non-null while the splitter is being dragged — native panes hide and DOM placeholders track the pointer */
  const [dragRatio, setDragRatio] = useState<number | null>(null)
  const [hostWidth, setHostWidth] = useState(0)
  const hostRef = useRef<HTMLDivElement>(null)

  const android = room?.provider === 'android'
  const emulatorLandscape = room?.android?.orientation === 'landscape'
  const previewLayout: PreviewLayout = android
    ? { mode: 'single', leftViewport: null, rightViewport: { width: 390, height: 844 } }
    : createPreviewLayout(leftPreset, rightPreset, splitEnabled, splitRatio)
  const previewLayoutRef = useRef(previewLayout)
  previewLayoutRef.current = previewLayout

  const detailsOpen = configOpen
  const showSite = running
  const dragging = dragRatio !== null
  const previewVisible = showSite && !modalOpen && !detailsOpen && !dragging

  useEffect(() => {
    const el = hostRef.current
    if (!el || !showSite) {
      void api.preview.detach().catch(() => undefined)
      return
    }
    const report = (): void => {
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) return
      setHostWidth(Math.round(r.width))
      let bounds = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
      if (android) {
        // pin the phone screen to its aspect (portrait or landscape) and
        // center it, so the device fills its frame edge to edge
        const aspect = emulatorLandscape ? EMULATOR_LANDSCAPE : EMULATOR_PORTRAIT
        const width = Math.min(bounds.width, Math.round((bounds.height * aspect.width) / aspect.height))
        const height = Math.min(bounds.height, Math.round((width * aspect.height) / aspect.width))
        bounds = {
          x: bounds.x + Math.round((bounds.width - width) / 2),
          y: bounds.y + Math.round((bounds.height - height) / 2),
          width,
          height
        }
      }
      void api.preview
        .setBounds(roomId, bounds)
        .then(() => api.preview.layout(roomId, previewLayoutRef.current))
        .catch(() => undefined)
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    window.addEventListener('resize', report)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', report)
      void api.preview.detach().catch(() => undefined)
    }
  }, [roomId, showSite, android, emulatorLandscape])

  useEffect(() => {
    if (!showSite || dragging) return
    void api.preview.layout(roomId, previewLayoutRef.current).catch(() => undefined)
  }, [leftPreset, rightPreset, splitEnabled, splitRatio, android, dragging, roomId, showSite])

  useEffect(() => savePreviewPresetId(window.localStorage, roomId, 'left', leftPreset), [leftPreset, roomId])
  useEffect(() => savePreviewPresetId(window.localStorage, roomId, 'right', rightPreset), [rightPreset, roomId])
  useEffect(() => saveSplitEnabled(window.localStorage, roomId, splitEnabled), [splitEnabled, roomId])
  useEffect(() => saveSplitRatio(window.localStorage, roomId, splitRatio), [splitRatio, roomId])

  useEffect(() => {
    if (!showSite) return
    void api.preview.setVisible(roomId, previewVisible).catch(() => undefined)
  }, [previewVisible, roomId, showSite])

  useEffect(() => {
    setDevtoolsOpen(false)
    return api.on(IPC.evPreviewDevTools, (eventRoomId: string, open: boolean) => {
      if (eventRoomId === roomId) setDevtoolsOpen(open)
    })
  }, [roomId])

  if (!room) {
    return (
      <div className="room-view">
        <div className="preview-overlay">
          <span className="plate">{t('room.notFound')}</span>
        </div>
      </div>
    )
  }

  const splitterVisible = showSite && !android && splitEnabled && !devtoolsOpen && hostWidth > 60
  const activeRatio = dragRatio ?? splitRatio
  const splitterLeft = splitLeftWidth(hostWidth, activeRatio)

  return (
    <div className="room-view">
      <BrowserBar
        room={room}
        configOpen={detailsOpen}
        onToggleConfig={() => {
          if (!detailsOpen) void api.preview.setVisible(roomId, false).catch(() => undefined)
          setConfigOpen((open) => !open)
        }}
        onModalChange={setModalOpen}
      />
      <div className="room-body">
        <div className={`preview-workbench${detailsOpen ? ' preview-host-hidden' : ''}`}>
          {showSite && android && (
            <div className="preview-device-strip android-nav-strip" aria-label={t('android.navKeys')}>
              <button className="btn" onClick={() => void api.android.action(roomId, 'back').catch(() => undefined)}>
                <span aria-hidden>◁</span> {t('android.navBack')}
              </button>
              <button className="btn" onClick={() => void api.android.action(roomId, 'home').catch(() => undefined)}>
                <span aria-hidden>○</span> {t('android.navHome')}
              </button>
              <button className="btn" onClick={() => void api.android.action(roomId, 'recents').catch(() => undefined)}>
                <span aria-hidden>▢</span> {t('android.navRecents')}
              </button>
              <button
                className="btn"
                title={t('android.navRotateHint')}
                onClick={() => void api.android.action(roomId, 'rotate').catch(() => undefined)}
              >
                <span aria-hidden>⟳</span> {t('android.navRotate')}
              </button>
            </div>
          )}
          {showSite && !android && (
            <div className="preview-device-strip" aria-label={t('preview.responsiveViews')}>
              <PreviewSelector
                icon="▣"
                label={t('preview.desktopTablet')}
                value={leftPreset}
                presets={DESKTOP_TABLET_PRESETS}
                onChange={setLeftPreset}
              />
              <button
                className="btn split-toggle"
                data-active={splitEnabled || undefined}
                aria-pressed={splitEnabled}
                title={t('preview.splitHint')}
                onClick={() => setSplitEnabled((enabled) => !enabled)}
              >
                <span aria-hidden>⿲</span> {t('preview.split')}
              </button>
              {splitEnabled && (
                <PreviewSelector
                  icon="▯"
                  label={t('preview.mobilePortrait')}
                  value={rightPreset}
                  presets={MOBILE_PRESETS}
                  onChange={setRightPreset}
                />
              )}
            </div>
          )}
          <div className="preview-host" ref={hostRef}>
            {dragging && (
              <div className="preview-drag-panes" aria-hidden>
                <div className="preview-drag-pane" style={{ width: splitterLeft }} />
                <div className="preview-drag-pane" style={{ left: splitterLeft + PREVIEW_SPLIT_GUTTER }} />
              </div>
            )}
            {splitterVisible && (
              <div
                className="preview-splitter"
                role="separator"
                aria-orientation="vertical"
                aria-label={t('preview.splitHint')}
                data-dragging={dragging || undefined}
                style={{ left: splitterLeft }}
                onPointerDown={(event) => {
                  event.preventDefault()
                  event.currentTarget.setPointerCapture(event.pointerId)
                  setDragRatio(splitRatio)
                }}
                onPointerMove={(event) => {
                  if (dragRatio === null) return
                  const rect = hostRef.current?.getBoundingClientRect()
                  if (!rect || rect.width <= PREVIEW_SPLIT_GUTTER + 2) return
                  setDragRatio(clampSplitRatio((event.clientX - rect.x) / (rect.width - PREVIEW_SPLIT_GUTTER)))
                }}
                onPointerUp={() => {
                  if (dragRatio !== null) setSplitRatio(dragRatio)
                  setDragRatio(null)
                }}
                onPointerCancel={() => setDragRatio(null)}
              >
                <span className="preview-splitter-grip" aria-hidden>⋮</span>
              </div>
            )}
            {!showSite && (
              <div className="preview-overlay">
                <span className="plate">№ {room.roomNumber}</span>
                {busy ? (
                  <span>{busy}</span>
                ) : room.status === 'sleeping' ? (
                  <>
                    <span>{t('room.asleepHint')}</span>
                    <button className="btn primary" onClick={() => void roomAction(roomId, 'start')}>
                      {t('room.wakeRoom')}
                    </button>
                  </>
                ) : room.status === 'preparing' ? (
                  <span>{t('room.preparingHint')}</span>
                ) : (
                  <>
                    <span>{t('room.unreachableHint', { status: statusLabel(t, room.status) })}</span>
                    <button
                      className="btn"
                      onClick={() => {
                        void api.preview.setVisible(roomId, false).catch(() => undefined)
                        setConfigTab('health')
                        setConfigOpen(true)
                      }}
                    >
                      {t('room.openDiagnostics')}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
        {detailsOpen && (
          <RoomConfig
            room={room}
            tab={configTab}
            onTabChange={setConfigTab}
            onClose={() => setConfigOpen(false)}
            closable
          />
        )}
      </div>
    </div>
  )
}

function PreviewSelector({
  icon,
  label,
  value,
  presets,
  onChange
}: {
  icon: string
  label: string
  value: string
  presets: readonly { id: string; label: string }[]
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <label className="preview-device-control">
      <span className="preview-device-label">
        <span aria-hidden>{icon}</span>
        <strong>{label}</strong>
      </span>
      <select value={value} aria-label={label} onChange={(event) => onChange(event.target.value)}>
        {presets.map((preset) => (
          <option key={preset.id} value={preset.id}>
            {preset.label}
          </option>
        ))}
      </select>
    </label>
  )
}
