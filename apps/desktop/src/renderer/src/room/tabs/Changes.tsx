import { useEffect, useState } from 'react'
import type { ChangeEntry, RoomRecord } from '@devhotel/shared'
import { api } from '../../api'
import { useStore } from '../../state/store'

function when(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function ChangesTab({ room }: { room: RoomRecord }): React.JSX.Element {
  const [changes, setChanges] = useState<ChangeEntry[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const undoChange = useStore((s) => s.undoChange)
  const inspections = useStore((s) => s.inspections)

  useEffect(() => {
    void api.changes.list(room.id).then(setChanges)
  }, [room.id, inspections])

  if (changes.length === 0) {
    return <p className="muted">No changes yet. Changes made from Stack, fixes, and agent actions appear here.</p>
  }

  return (
    <>
      {changes.map((c) => (
        <div key={c.id}>
          <div className="change-item">
            <span className="title">
              <button style={{ textAlign: 'left' }} onClick={() => setExpanded(expanded === c.id ? null : c.id)}>
                {c.title}
              </button>
              <div className="small muted">
                {when(c.createdAt)}
                {c.status === 'undone' && ' · undone'}
                {c.status === 'rolled-back' && ' · rolled back'}
                {c.status === 'failed' && ' · failed'}
              </div>
            </span>
            {c.actor === 'agent' && <span className="actor-agent">agent</span>}
            {c.undoable && (c.status === 'verified' || (c.status === 'applied' && c.verify)) ? (
              <button className="btn" onClick={() => void undoChange(room.id, c.id)}>
                ↶ Undo
              </button>
            ) : (
              !c.undoable && <span className="small muted">Undo unavailable</span>
            )}
          </div>
          {expanded === c.id && (
            <div className="log-box" style={{ height: 'auto', maxHeight: 180, marginBottom: 8 }}>
              {[
                `component: ${c.component}`,
                `actor: ${c.actor}`,
                `before: ${JSON.stringify(c.before)}`,
                `after: ${JSON.stringify(c.after)}`,
                ...c.steps.map((s) => `• ${s}`),
                c.verify ? `verify: ${c.verify.ok ? 'ok' : 'FAILED'} — ${c.verify.detail}` : 'verify: —',
                `undo strategy: ${c.undoStrategy}`
              ].join('\n')}
            </div>
          )}
        </div>
      ))}
    </>
  )
}
