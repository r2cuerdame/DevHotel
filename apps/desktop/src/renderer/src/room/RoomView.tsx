import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useStore, useT } from '../state/store'
import { BrowserBar } from './BrowserBar'
import { RoomPages, type RoomPage } from './RoomPages'

export function RoomView({ roomId }: { roomId: string }): React.JSX.Element {
  const room = useStore((s) => s.rooms.find((r) => r.id === roomId))
  const t = useT()
  const running = !!room && (room.status === 'running' || room.status === 'ready' || room.status === 'attention')
  const [page, setPage] = useState<RoomPage>(running ? 'site' : 'overview')
  const prevRunning = useRef(running)
  const hostRef = useRef<HTMLDivElement>(null)

  const showSite = running && page === 'site'

  // a room that cannot show its site homes on Overview; when it wakes while
  // the user is still on Overview, "navigate" to the site like a browser would
  useEffect(() => {
    if (!running && page === 'site') setPage('overview')
    if (running && !prevRunning.current && page === 'overview') setPage('site')
    prevRunning.current = running
  }, [running, page])

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
  }, [roomId, showSite])

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
      <BrowserBar room={room} page={page} onNavigate={setPage} />
      <div className="room-body">
        {showSite ? (
          <div className="preview-host" ref={hostRef} />
        ) : (
          <RoomPages room={room} page={page === 'site' ? 'overview' : page} onNavigate={setPage} />
        )}
      </div>
    </div>
  )
}
