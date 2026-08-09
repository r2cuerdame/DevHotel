import type { RoomRecord } from '@devhotel/shared'
import { STATUS_LABEL, useStore } from '../../state/store'
import { api } from '../../api'

export function OverviewTab({ room }: { room: RoomRecord }): React.JSX.Element {
  const inspection = useStore((s) => s.inspections[room.id])
  const undoChange = useStore((s) => s.undoChange)
  const url = inspection?.urls.app

  return (
    <>
      <dl className="kv">
        <dt>Status</dt>
        <dd>
          <span className="status-dot" data-status={room.status} style={{ display: 'inline-block', marginRight: 6 }} />
          {STATUS_LABEL[room.status]}
        </dd>
        <dt>URL</dt>
        <dd>
          {url ? (
            <a
              href={url}
              className="mono"
              style={{ color: 'var(--brass)' }}
              onClick={(e) => {
                e.preventDefault()
                void api.app.openExternal(url)
              }}
            >
              {url}
            </a>
          ) : (
            <span className="muted">—</span>
          )}
        </dd>
        <dt>Start command</dt>
        <dd className="mono">{room.startCommand}</dd>
        <dt>Runtime</dt>
        <dd>Node {room.runtime.version}</dd>
        <dt>Package manager</dt>
        <dd>
          {room.packageManager.kind}
          {room.packageManager.version ? ` ${room.packageManager.version}` : ''}
        </dd>
        <dt>Source</dt>
        <dd className="mono">{room.sourceType === 'empty' ? 'empty room' : room.sourceRef}</dd>
      </dl>

      {inspection?.lastUndoable && (
        <div className="panel-section">
          <h3>Last change</h3>
          <div className="change-item">
            <span className="title">{inspection.lastUndoable.title}</span>
            <button className="btn" onClick={() => void undoChange(room.id, inspection.lastUndoable!.id)}>
              ↶ Undo
            </button>
          </div>
        </div>
      )}

      {inspection?.latestCheck && inspection.latestCheck.overall !== 'healthy' && (
        <div className="panel-section">
          <h3>Health</h3>
          <div className="row small muted">
            Some checks are failing — see the Diagnostics tab.
          </div>
        </div>
      )}
    </>
  )
}
