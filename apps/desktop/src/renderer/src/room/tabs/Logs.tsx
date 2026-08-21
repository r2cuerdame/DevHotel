import { useEffect, useRef, useState } from 'react'
import type { RoomRecord } from '@devhotel/shared'
import { api } from '../../api'
import { useStore, useT } from '../../state/store'

type LogKind = 'web' | 'orchestrator'

export function LogsTab({ room }: { room: RoomRecord }): React.JSX.Element {
  const windows = room.provider === 'windows'
  const [kind, setKind] = useState<LogKind>(windows ? 'orchestrator' : 'web')
  const key = `${room.id}:${kind}`
  const lines = useStore((s) => s.logs[key] ?? [])
  const appendLog = useStore((s) => s.appendLog)
  const clearLog = useStore((s) => s.clearLog)
  const t = useT()
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (windows && kind !== 'orchestrator') setKind('orchestrator')
  }, [kind, windows])

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
  }, [room.id, kind])

  useEffect(() => {
    const el = boxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  return (
    <div className="logs-tab">
      <div className="row">
        {!windows && (
          <button className="btn" data-active={kind === 'web'} onClick={() => setKind('web')} style={kind === 'web' ? { borderColor: 'var(--brass)' } : undefined}>
            {t('logs.web')}
          </button>
        )}
        <button
          className="btn"
          onClick={() => setKind('orchestrator')}
          style={kind === 'orchestrator' ? { borderColor: 'var(--brass)' } : undefined}
        >
          DevHotel
        </button>
        <span className="spacer" style={{ flex: 1 }} />
        <button className="btn" onClick={() => clearLog(key)}>
          {t('common.clear')}
        </button>
      </div>
      <div ref={boxRef} className="log-box">
        {lines.length === 0 ? <span className="muted">{t('logs.empty')}</span> : lines.join('\n')}
      </div>
    </div>
  )
}
