import { useState } from 'react'
import type { RoomRecord } from '@devhotel/shared'
import { useStore, useT } from '../../state/store'

const NODE_MAJORS = ['18', '20', '22', '24']

export function StackTab({ room }: { room: RoomRecord }): React.JSX.Element {
  const applyChange = useStore((s) => s.applyChange)
  const t = useT()
  const [nodeVersion, setNodeVersion] = useState(room.runtime.version)
  const [pm, setPm] = useState<'npm' | 'pnpm'>(room.packageManager.kind === 'pnpm' ? 'pnpm' : 'npm')
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

  if (room.provider === 'android') {
    return (
      <div className="panel-section">
        <h3>{t('android.buildCommand')}</h3>
        <div className="row">
          <input className="mono" value={command} onChange={(e) => setCommand(e.target.value)} style={{ flex: 1 }} />
          <button
            className="btn"
            disabled={command === room.startCommand || !command || pending !== null}
            onClick={() => void run('cmd', () => applyChange(room.id, { kind: 'start-command', command }))}
          >
            {pending === 'cmd' ? t('common.applying') : t('common.apply')}
          </button>
        </div>
        <p className="small muted" style={{ marginTop: 6 }}>
          {t('android.apkHint')}
        </p>
      </div>
    )
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
            {pending === 'node' ? t('stack.changing') : t('stack.changeNode', { from: room.runtime.version, to: nodeVersion })}
          </button>
        </div>
      </div>

      <div className="panel-section">
        <h3>{t('label.packageManager')}</h3>
        <div className="row">
          <select value={pm} onChange={(e) => setPm(e.target.value as 'npm' | 'pnpm')} style={{ width: 110 }}>
            <option value="npm">npm</option>
            <option value="pnpm">pnpm</option>
          </select>
          <button
            className="btn"
            disabled={pm === room.packageManager.kind || pending !== null}
            onClick={() => void run('pm', () => applyChange(room.id, { kind: 'package-manager', pm }))}
          >
            {pending === 'pm' ? t('common.applying') : t('common.apply')}
          </button>
        </div>
      </div>

      <div className="panel-section">
        <h3>{t('label.startCommand')}</h3>
        <div className="row">
          <input className="mono" value={command} onChange={(e) => setCommand(e.target.value)} style={{ flex: 1 }} />
          <button
            className="btn"
            disabled={command === room.startCommand || !command || pending !== null}
            onClick={() => void run('cmd', () => applyChange(room.id, { kind: 'start-command', command }))}
          >
            {pending === 'cmd' ? t('common.applying') : t('common.apply')}
          </button>
        </div>
      </div>

      <div className="panel-section">
        <h3>{t('label.internalPort')}</h3>
        <div className="row">
          <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} style={{ width: 100 }} />
          <button
            className="btn"
            disabled={port === room.internalPort || !port || pending !== null}
            onClick={() => void run('port', () => applyChange(room.id, { kind: 'internal-port', port }))}
          >
            {pending === 'port' ? t('common.applying') : t('common.apply')}
          </button>
        </div>
      </div>

      <div className="panel-section">
        <h3>{t('label.domain')}</h3>
        <div className="row">
          <input className="mono" value={domain} onChange={(e) => setDomain(e.target.value)} style={{ flex: 1 }} />
          <button
            className="btn"
            disabled={domain === room.domain || pending !== null}
            onClick={() => void run('domain', () => applyChange(room.id, { kind: 'domain', domain }))}
          >
            {pending === 'domain' ? t('common.applying') : t('common.apply')}
          </button>
        </div>
        <p className="small muted" style={{ marginTop: 6 }}>
          {t('stack.domainHintPre')} <code>.localhost</code> {t('stack.domainHintPost')}
        </p>
      </div>

      <div className="panel-section">
        <h3>HTTPS</h3>
        <button
          className="btn"
          disabled={pending !== null}
          onClick={() => void run('https', () => applyChange(room.id, { kind: 'https', enabled: !room.https }))}
        >
          {pending === 'https' ? t('common.applying') : room.https ? t('stack.httpsOff') : t('stack.httpsOn')}
        </button>
        <CaHint />
      </div>

      <div className="panel-section">
        <h3>{t('stack.dependencies')}</h3>
        <div className="row wrap">
          <button
            className="btn"
            disabled={pending !== null}
            onClick={() => void run('deps', () => applyChange(room.id, { kind: 'deps-install', clean: false }))}
          >
            {pending === 'deps' ? t('stack.installing') : t('stack.install')}
          </button>
          <button
            className="btn"
            disabled={pending !== null}
            onClick={() => void run('deps-clean', () => applyChange(room.id, { kind: 'deps-install', clean: true }))}
          >
            {pending === 'deps-clean' ? t('stack.reinstalling') : t('stack.cleanReinstall')}
          </button>
        </div>
      </div>
    </>
  )
}

function CaHint(): React.JSX.Element | null {
  const caStatus = useStore((s) => s.caStatus)
  const toast = useStore((s) => s.toast)
  const t = useT()
  if (caStatus === 'trusted') return null
  return (
    <p className="small muted" style={{ marginTop: 6 }}>
      {t('stack.caHintPre')}{' '}
      <button
        style={{ color: 'var(--brass)' }}
        onClick={() => {
          void window.devhotel.ca
            .trust()
            .then(() => toast('success', t('toast.caTrusted')))
            .catch((err: unknown) => toast('error', String(err)))
        }}
      >
        {t('stack.caHintLink')}
      </button>{' '}
      {t('stack.caHintPost')}
    </p>
  )
}
