import { useState } from 'react'
import type { RoomRecord } from '@devhotel/shared'
import { useStore } from '../../state/store'

const NODE_MAJORS = ['18', '20', '22', '24']

export function StackTab({ room }: { room: RoomRecord }): React.JSX.Element {
  const applyChange = useStore((s) => s.applyChange)
  const [nodeVersion, setNodeVersion] = useState(room.runtime.version)
  const [command, setCommand] = useState(room.startCommand)
  const [domain, setDomain] = useState(room.domain)
  const [port, setPort] = useState(room.internalPort)
  const [pending, setPending] = useState<string | null>(null)

  async function run(kind: string, fn: () => Promise<unknown>): Promise<void> {
    setPending(kind)
    try {
      await fn()
    } finally {
      setPending(null)
    }
  }

  return (
    <>
      <div className="panel-section">
        <h3>Node.js</h3>
        <div className="row">
          <select value={nodeVersion} onChange={(e) => setNodeVersion(e.target.value)}>
            {NODE_MAJORS.map((v) => (
              <option key={v} value={v}>
                Node {v}
              </option>
            ))}
          </select>
          <button
            className="btn"
            disabled={nodeVersion === room.runtime.version || pending !== null}
            onClick={() => void run('node', () => applyChange(room.id, { kind: 'node-version', version: nodeVersion }))}
          >
            {pending === 'node' ? 'Changing…' : `Change ${room.runtime.version} → ${nodeVersion}`}
          </button>
        </div>
      </div>

      <div className="panel-section">
        <h3>Start command</h3>
        <div className="row">
          <input className="mono" value={command} onChange={(e) => setCommand(e.target.value)} style={{ flex: 1 }} />
          <button
            className="btn"
            disabled={command === room.startCommand || !command || pending !== null}
            onClick={() => void run('cmd', () => applyChange(room.id, { kind: 'start-command', command }))}
          >
            {pending === 'cmd' ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>

      <div className="panel-section">
        <h3>Internal port</h3>
        <div className="row">
          <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} style={{ width: 100 }} />
          <button
            className="btn"
            disabled={port === room.internalPort || !port || pending !== null}
            onClick={() => void run('port', () => applyChange(room.id, { kind: 'internal-port', port }))}
          >
            {pending === 'port' ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>

      <div className="panel-section">
        <h3>Domain</h3>
        <div className="row">
          <input className="mono" value={domain} onChange={(e) => setDomain(e.target.value)} style={{ flex: 1 }} />
          <button
            className="btn"
            disabled={domain === room.domain || pending !== null}
            onClick={() => void run('domain', () => applyChange(room.id, { kind: 'domain', domain }))}
          >
            {pending === 'domain' ? 'Applying…' : 'Apply'}
          </button>
        </div>
        <p className="small muted" style={{ marginTop: 6 }}>
          Domains end in <code>.localhost</code> — no hosts file changes needed.
        </p>
      </div>

      <div className="panel-section">
        <h3>HTTPS</h3>
        <button
          className="btn"
          disabled={pending !== null}
          onClick={() => void run('https', () => applyChange(room.id, { kind: 'https', enabled: !room.https }))}
        >
          {pending === 'https' ? 'Applying…' : room.https ? 'Turn HTTPS off' : 'Turn HTTPS on'}
        </button>
        <CaHint />
      </div>

      <div className="panel-section">
        <h3>Dependencies</h3>
        <div className="row wrap">
          <button
            className="btn"
            disabled={pending !== null}
            onClick={() => void run('deps', () => applyChange(room.id, { kind: 'deps-install', clean: false }))}
          >
            {pending === 'deps' ? 'Installing…' : 'Install'}
          </button>
          <button
            className="btn"
            disabled={pending !== null}
            onClick={() => void run('deps-clean', () => applyChange(room.id, { kind: 'deps-install', clean: true }))}
          >
            {pending === 'deps-clean' ? 'Reinstalling…' : 'Clean reinstall'}
          </button>
        </div>
      </div>
    </>
  )
}

function CaHint(): React.JSX.Element | null {
  const caStatus = useStore((s) => s.caStatus)
  const toast = useStore((s) => s.toast)
  if (caStatus === 'trusted') return null
  return (
    <p className="small muted" style={{ marginTop: 6 }}>
      The DevHotel preview trusts room certificates automatically. To avoid warnings in external browsers,{' '}
      <button
        style={{ color: 'var(--brass)' }}
        onClick={() => {
          void window.devhotel.ca
            .trust()
            .then(() => toast('success', 'DevHotel Local CA trusted for your Windows user'))
            .catch((err: unknown) => toast('error', String(err)))
        }}
      >
        trust the DevHotel Local CA
      </button>{' '}
      (you can remove it any time in Windows certificate manager).
    </p>
  )
}
