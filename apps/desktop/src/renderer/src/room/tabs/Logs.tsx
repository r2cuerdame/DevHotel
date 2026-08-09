import { useEffect, useRef, useState } from 'react'
import type { RoomRecord } from '@devhotel/shared'
import { api } from '../../api'
import { useStore } from '../../state/store'

type LogKind = 'web' | 'orchestrator'

export function LogsTab({ room }: { room: RoomRecord }): React.JSX.Element {
  const [kind, setKind] = useState<LogKind>('web')
  const key = `${room.id}:${kind}`
  const lines = useStore((s) => s.logs[key] ?? [])
  const appendLog = useStore((s) => s.appendLog)
  const clearLog = useStore((s) => s.clearLog)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let active = true
    clearLog(key)
    void api.logs.tailStart(room.id, kind).then(({ lines: initial }) => {
      if (active) appendLog(key, initial)
    })
    return () => {
      active = false
      void api.logs.tailStop(room.id, kind)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.id, kind])

  useEffect(() => {
    const el = boxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  return (
    <div className="logs-tab">
      <div className="row">
        <button className="btn" data-active={kind === 'web'} onClick={() => setKind('web')} style={kind === 'web' ? { borderColor: 'var(--brass)' } : undefined}>
          Web
        </button>
        <button
          className="btn"
          onClick={() => setKind('orchestrator')}
          style={kind === 'orchestrator' ? { borderColor: 'var(--brass)' } : undefined}
        >
          DevHotel
        </button>
        <span className="spacer" style={{ flex: 1 }} />
        <button className="btn" onClick={() => clearLog(key)}>
          Clear
        </button>
      </div>
      <div ref={boxRef} className="log-box">
        {lines.length === 0 ? <span className="muted">No output yet.</span> : lines.join('\n')}
      </div>
    </div>
  )
}
