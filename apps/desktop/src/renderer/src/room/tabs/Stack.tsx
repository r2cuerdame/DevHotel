import { useEffect, useState } from 'react'
import type { ComponentInfo, RoomRecord } from '@devhotel/shared'
import { api } from '../../api'
import { useStore, useT } from '../../state/store'
import { PackageStoreModal } from '../PackageStoreModal'

export function StackTab({ room }: { room: RoomRecord }): React.JSX.Element {
  const applyChange = useStore((s) => s.applyChange)
  const t = useT()
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
        <div className="panel-section">
          <h3>{t('android.deviceService')}</h3>
          <div className="change-item coming-next-card">
            <span className="status-dot" data-status="sleeping" />
            <span className="title">
              {t('android.deviceService')}
              <div className="small muted">{t('android.deviceServiceComingNext')}</div>
            </span>
            <span className="status-chip">{t('android.comingNext')}</span>
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      <InstalledPrograms room={room} pending={pending} run={run} />
      <DatabasesSection room={room} pending={pending} run={run} />

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

const DB_SERVICES: { id: 'postgres' | 'redis'; label: string; options: string[] }[] = [
  { id: 'postgres', label: 'PostgreSQL', options: ['15', '16', '17'] },
  { id: 'redis', label: 'Redis', options: ['7', '8'] }
]

/** Full database lifecycle: add, version switch (backup→recreate→restore), backup, restart, remove, restore. */
function DatabasesSection({
  room,
  pending,
  run
}: {
  room: RoomRecord
  pending: string | null
  run: (kind: string, fn: () => Promise<unknown>) => Promise<void>
}): React.JSX.Element | null {
  const applyChange = useStore((s) => s.applyChange)
  const inspection = useStore((s) => s.inspections[room.id])
  const t = useT()
  const [versions, setVersions] = useState<Record<string, string>>({})
  const running = room.status === 'running' || room.status === 'ready' || room.status === 'attention'
  const hasInstalledService = DB_SERVICES.some(({ id }) => Boolean(room.services[id]))
  const hasBackups = Boolean(inspection?.backups.length)

  if (!hasInstalledService && !hasBackups) return null

  return (
    <div className="panel-section">
      <h3>{t('services.databases')}</h3>
      {DB_SERVICES.map(({ id, label, options }) => {
        const svc = room.services[id]
        if (!svc) return null
        const sel = versions[id] ?? svc.version
        return (
          <div key={id} className="change-item">
            <span className="status-dot" data-status={running ? 'ready' : 'sleeping'} />
            <span className="title">
              {label} <span className="muted">{svc.version}</span>
            </span>
            <select value={sel} onChange={(e) => setVersions({ ...versions, [id]: e.target.value })} style={{ width: 76 }}>
              {options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            <button
              className="btn"
              disabled={sel === svc.version || pending !== null || !running}
              onClick={() => void run(`${id}-ver`, () => applyChange(room.id, { kind: 'service-version', service: id, version: sel }))}
            >
              {pending === `${id}-ver` ? t('common.applying') : t('common.apply')}
            </button>
            <button
              className="btn"
              disabled={pending !== null}
              onClick={() => void run(`${id}-backup`, () => applyChange(room.id, { kind: 'db-backup', service: id }))}
            >
              {pending === `${id}-backup` ? t('common.applying') : t('services.backup')}
            </button>
            <button
              className="btn"
              disabled={pending !== null}
              onClick={() => void run(`${id}-restart`, () => applyChange(room.id, { kind: 'service-restart', service: id }))}
            >
              {pending === `${id}-restart` ? t('common.applying') : t('common.restart')}
            </button>
            <button
              className="btn danger"
              disabled={pending !== null}
              onClick={() => {
                if (window.confirm(t('services.removeConfirm', { service: label }))) {
                  void run(`${id}-remove`, () => applyChange(room.id, { kind: 'service-remove', service: id }))
                }
              }}
            >
              {pending === `${id}-remove` ? t('common.applying') : t('services.remove')}
            </button>
          </div>
        )
      })}
      {hasInstalledService && <p className="small muted">{t('services.servicesHint')}</p>}
      {inspection && inspection.backups.length > 0 && (
        <>
          <h3 style={{ marginTop: 14 }}>{t('services.backupsTitle')}</h3>
          {inspection.backups.map((b) => (
            <div key={b.id} className="change-item">
              <span className="title">
                <span className="mono small">{b.id}</span>
                <div className="small muted">{new Date(b.createdAt).toLocaleString()}</div>
              </span>
              <button
                className="btn"
                disabled={pending !== null || !running || !room.services[b.service]}
                onClick={() => {
                  if (window.confirm(t('services.restoreConfirm'))) {
                    void run(`restore-${b.id}`, () =>
                      applyChange(room.id, { kind: 'db-restore', service: b.service, backupId: b.id })
                    )
                  }
                }}
              >
                {pending === `restore-${b.id}` ? t('common.applying') : t('services.restore')}
              </button>
            </div>
          ))}
        </>
      )}
    </div>
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
  const [storeOpen, setStoreOpen] = useState(false)

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
      <div className="section-heading-row">
        <h3>{t('stack.installed')}</h3>
        {room.provider === 'web' && (
          <button className="btn" onClick={() => setStoreOpen(true)}>
            {t('packageStore.add')}
          </button>
        )}
      </div>
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
      {storeOpen && <PackageStoreModal room={room} onClose={() => setStoreOpen(false)} />}
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
