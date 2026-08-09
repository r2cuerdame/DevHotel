import { useEffect, useState } from 'react'
import type { ComponentInfo, RoomRecord } from '@devhotel/shared'
import { api } from '../../api'
import { useStore, useT } from '../../state/store'

const ANDROID_DEVICES = ['Samsung Galaxy S10', 'Samsung Galaxy S9', 'Nexus 5', 'Nexus 4', 'Nexus One']
const ANDROID_VERSIONS = ['14.0', '13.0', '12.0', '11.0']

export function StackTab({ room }: { room: RoomRecord }): React.JSX.Element {
  const applyChange = useStore((s) => s.applyChange)
  const t = useT()
  const [device, setDevice] = useState(room.android?.device ?? 'Samsung Galaxy S10')
  const [osVersion, setOsVersion] = useState(room.android?.version ?? '14.0')
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
      <>
        <InstalledPrograms room={room} pending={pending} run={run} />
        <div className="panel-section">
          <h3>{t('android.emulator')}</h3>
          <div className="row wrap">
            <select value={device} onChange={(e) => setDevice(e.target.value)} style={{ width: 190 }}>
              {ANDROID_DEVICES.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <select value={osVersion} onChange={(e) => setOsVersion(e.target.value)} style={{ width: 140 }}>
              {ANDROID_VERSIONS.map((v) => (
                <option key={v} value={v}>
                  Android {v}
                </option>
              ))}
            </select>
            <button
              className="btn"
              disabled={pending !== null || (device === (room.android?.device ?? 'Samsung Galaxy S10') && osVersion === (room.android?.version ?? '14.0'))}
              onClick={() => void run('emu', () => applyChange(room.id, { kind: 'emulator-config', device, version: osVersion }))}
            >
              {pending === 'emu' ? t('common.applying') : t('common.apply')}
            </button>
          </div>
          <p className="small muted" style={{ marginTop: 6 }}>
            {t('android.emulatorConfigHint')}
          </p>
        </div>
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
      </>
    )
  }

  return (
    <>
      <InstalledPrograms room={room} pending={pending} run={run} />

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

/** Installed programs with live versions, a version switcher, and per-component undo. */
function InstalledPrograms({
  room,
  pending,
  run
}: {
  room: RoomRecord
  pending: string | null
  run: (kind: string, fn: () => Promise<unknown>) => Promise<void>
}): React.JSX.Element {
  const applyChange = useStore((s) => s.applyChange)
  const undoChange = useStore((s) => s.undoChange)
  const inspection = useStore((s) => s.inspections[room.id])
  const t = useT()
  const [components, setComponents] = useState<ComponentInfo[]>([])
  const [selections, setSelections] = useState<Record<string, string>>({})

  useEffect(() => {
    let active = true
    void api.rooms.components(room.id).then((c) => {
      if (active) setComponents(c)
    })
    return () => {
      active = false
    }
  }, [room.id, inspection, pending])

  const componentEntry = (label: string) =>
    inspection?.recentChanges.find(
      (c) => c.component === label && c.undoable && (c.status === 'verified' || (c.status === 'applied' && c.verify))
    )

  const changeFor = (c: ComponentInfo, value: string) => {
    if (c.changeKind === 'node-version') return { kind: 'node-version', version: value } as const
    if (c.changeKind === 'package-manager') return { kind: 'package-manager', pm: value as 'npm' | 'pnpm' } as const
    return { kind: 'service-version', service: c.id as 'postgres' | 'redis', version: value } as const
  }

  const labelForUndo: Record<string, string> = { node: 'Node.js', pm: 'Package Manager', postgres: 'PostgreSQL', redis: 'Redis' }

  return (
    <div className="panel-section">
      <h3>{t('stack.installed')}</h3>
      {components.map((c) => {
        const current =
          c.id === 'pm' ? c.label : ((c.options ?? []).find((o) => c.version.startsWith(o)) ?? c.version.split('.')[0] ?? c.version)
        const sel = selections[c.id] ?? current
        const undoable = componentEntry(labelForUndo[c.id] ?? c.label)
        return (
          <div key={c.id} className="change-item">
            <span className="status-dot" data-status={c.source === 'live' ? 'ready' : 'sleeping'} title={c.source} />
            <span className="title">
              {c.label}
              <div className="small muted mono">{c.version}</div>
            </span>
            {c.options && c.changeKind && (
              <>
                <select
                  value={sel}
                  onChange={(e) => setSelections({ ...selections, [c.id]: e.target.value })}
                  style={{ width: 96 }}
                >
                  {c.options.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
                <button
                  className="btn"
                  disabled={sel === current || pending !== null}
                  onClick={() => void run(`comp-${c.id}`, () => applyChange(room.id, changeFor(c, sel)))}
                >
                  {pending === `comp-${c.id}` ? t('common.applying') : t('common.apply')}
                </button>
              </>
            )}
            {undoable && (
              <button className="btn" disabled={pending !== null} onClick={() => void undoChange(room.id, undoable.id)}>
                ↶
              </button>
            )}
          </div>
        )
      })}
    </div>
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
