import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { statusLabel, useStore, useT } from '../state/store'
import { BrowserBar } from './BrowserBar'
import { RoomConfig, type ConfigTab } from './DetailPanel'
import {
  createSplitPreviewLayout,
  DEFAULT_DESKTOP_TABLET_PRESET,
  DEFAULT_MOBILE_PRESET,
  DESKTOP_TABLET_PRESETS,
  loadPreviewPresetId,
  MOBILE_PRESETS,
  savePreviewPresetId
} from './previewLayout'

export function RoomView({ roomId }: { roomId: string }): React.JSX.Element {
  const room = useStore((s) => s.rooms.find((r) => r.id === roomId))
  const busy = useStore((s) => s.busy[roomId])
  const roomAction = useStore((s) => s.roomAction)
  const t = useT()
  const running = !!room && (room.status === 'running' || room.status === 'ready' || room.status === 'attention')
  const [configOpen, setConfigOpen] = useState(false)
  const [configTab, setConfigTab] = useState<ConfigTab>('overview')
  const [modalOpen, setModalOpen] = useState(false)
  const [leftPreset, setLeftPreset] = useState(() =>
    loadPreviewPresetId(window.localStorage, roomId, 'left', DESKTOP_TABLET_PRESETS, DEFAULT_DESKTOP_TABLET_PRESET)
  )
  const [rightPreset, setRightPreset] = useState(() =>
    loadPreviewPresetId(window.localStorage, roomId, 'right', MOBILE_PRESETS, DEFAULT_MOBILE_PRESET)
  )
  const hostRef = useRef<HTMLDivElement>(null)
  const previewLayout = createSplitPreviewLayout(leftPreset, rightPreset)
  const previewLayoutRef = useRef(previewLayout)
  previewLayoutRef.current = previewLayout

  const android = room?.provider === 'android'
  const detailsOpen = android || configOpen
  const showSite = running && !android
  const previewVisible = showSite && !modalOpen && !detailsOpen

  useEffect(() => {
    const el = hostRef.current
    if (!el || !showSite) {
      void api.preview.detach().catch(() => undefined)
      return
    }
    const report = (): void => {
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) return
      const bounds = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
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
  }, [roomId, showSite])

  useEffect(() => {
    if (!showSite) return
    void api.preview.layout(roomId, previewLayout).catch(() => undefined)
  }, [leftPreset, rightPreset, roomId, showSite])

  useEffect(() => savePreviewPresetId(window.localStorage, roomId, 'left', leftPreset), [leftPreset, roomId])
  useEffect(() => savePreviewPresetId(window.localStorage, roomId, 'right', rightPreset), [rightPreset, roomId])

  useEffect(() => {
    if (!showSite) return
    void api.preview.setVisible(roomId, previewVisible).catch(() => undefined)
  }, [previewVisible, roomId, showSite])

  if (!room) {
    return (
      <div className="room-view">
        <div className="preview-overlay">
          <span className="plate">{t('room.notFound')}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="room-view">
      <BrowserBar
        room={room}
        configOpen={detailsOpen}
        onToggleConfig={() => {
          if (android) return
          if (!detailsOpen) void api.preview.setVisible(roomId, false).catch(() => undefined)
          setConfigOpen((open) => !open)
        }}
        onModalChange={setModalOpen}
      />
      <div className="room-body">
        <div className={`preview-workbench${detailsOpen ? ' preview-host-hidden' : ''}`}>
          {showSite && (
            <div className="preview-device-strip" aria-label={t('preview.responsiveViews')}>
              <PreviewSelector
                icon="▣"
                label={t('preview.desktopTablet')}
                value={leftPreset}
                presets={DESKTOP_TABLET_PRESETS}
                onChange={setLeftPreset}
              />
              <PreviewSelector
                icon="▯"
                label={t('preview.mobilePortrait')}
                value={rightPreset}
                presets={MOBILE_PRESETS}
                onChange={setRightPreset}
              />
            </div>
          )}
          <div className="preview-host" ref={hostRef}>
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
            closable={!android}
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
