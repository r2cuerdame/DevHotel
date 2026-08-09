import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { statusLabel, useStore, useT } from '../state/store'
import { BrowserBar } from './BrowserBar'
import { DetailPanel } from './DetailPanel'

export function RoomView({ roomId }: { roomId: string }): React.JSX.Element {
  const room = useStore((s) => s.rooms.find((r) => r.id === roomId))
  const busy = useStore((s) => s.busy[roomId])
  const roomAction = useStore((s) => s.roomAction)
  const t = useT()
  const [panelOpen, setPanelOpen] = useState(false)
  const hostRef = useRef<HTMLDivElement>(null)

  const showSite = room && (room.status === 'running' || room.status === 'ready' || room.status === 'attention')

  useEffect(() => {
    const el = hostRef.current
    if (!el || !showSite) {
      void api.preview.detach().catch(() => undefined)
      return
    }
    const report = (): void => {
      const r = el.getBoundingClientRect()
      void api.preview
        .setBounds(roomId, { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) })
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
  }, [roomId, showSite, panelOpen])

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
      <BrowserBar room={room} panelOpen={panelOpen} onTogglePanel={() => setPanelOpen((v) => !v)} />
      <div className="room-body">
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
                  <button className="btn" onClick={() => setPanelOpen(true)}>
                    {t('room.openDiagnostics')}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        {panelOpen && <DetailPanel room={room} />}
      </div>
    </div>
  )
}
