import { useEffect, useState } from 'react'
import type { RoomRecord } from '@devhotel/shared'
import { useStore, useT } from '../../state/store'

const CPU_OPTIONS = [undefined, 1, 2, 4, 8] as const
const MEMORY_OPTIONS = [undefined, 1024, 2048, 4096, 8192] as const

export function SystemTab({ room }: { room: RoomRecord }): React.JSX.Element {
  const applyChange = useStore((s) => s.applyChange)
  const t = useT()
  const [rows, setRows] = useState<{ k: string; v: string }[]>([])
  const [cpus, setCpus] = useState<number | undefined>(room.os.cpus)
  const [memoryMB, setMemoryMB] = useState<number | undefined>(room.os.memoryMB)
  const [timezone, setTimezone] = useState(room.os.timezone ?? '')
  const [pending, setPending] = useState(false)

  useEffect(() => {
    setRows(Object.entries(room.os.env).map(([k, v]) => ({ k, v })))
    setCpus(room.os.cpus)
    setMemoryMB(room.os.memoryMB)
    setTimezone(room.os.timezone ?? '')
  }, [room.id, room.os])

  async function apply(): Promise<void> {
    const env: Record<string, string> = {}
    for (const { k, v } of rows) if (k.trim()) env[k.trim()] = v
    setPending(true)
    try {
      await applyChange(room.id, {
        kind: 'os-settings',
        os: { env, cpus, memoryMB, timezone: timezone.trim() || undefined }
      })
    } finally {
      setPending(false)
    }
  }

  const dirty =
    JSON.stringify({ e: rows.filter((r) => r.k.trim()), c: cpus, m: memoryMB, t: timezone.trim() || undefined }) !==
    JSON.stringify({ e: Object.entries(room.os.env).map(([k, v]) => ({ k, v })), c: room.os.cpus, m: room.os.memoryMB, t: room.os.timezone })

  return (
    <>
      <div className="panel-section">
        <h3>{t('system.envVars')}</h3>
        {rows.map((row, i) => (
          <div key={i} className="row" style={{ marginBottom: 6 }}>
            <input
              className="mono"
              placeholder="NAME"
              value={row.k}
              onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, k: e.target.value } : r)))}
              style={{ width: 180 }}
            />
            <input
              className="mono"
              placeholder="value"
              value={row.v}
              onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, v: e.target.value } : r)))}
              style={{ flex: 1 }}
            />
            <button className="icon-btn" title={t('common.clear')} onClick={() => setRows(rows.filter((_r, j) => j !== i))}>
              ✕
            </button>
          </div>
        ))}
        <button className="btn" onClick={() => setRows([...rows, { k: '', v: '' }])}>
          {t('system.addVar')}
        </button>
      </div>

      <div className="panel-section">
        <h3>{t('system.cpus')}</h3>
        <select value={cpus ?? ''} onChange={(e) => setCpus(e.target.value ? Number(e.target.value) : undefined)} style={{ width: 180 }}>
          {CPU_OPTIONS.map((c) => (
            <option key={c ?? 'none'} value={c ?? ''}>
              {c ? `${c} CPU` : t('system.unlimited')}
            </option>
          ))}
        </select>
      </div>

      <div className="panel-section">
        <h3>{t('system.memory')}</h3>
        <select
          value={memoryMB ?? ''}
          onChange={(e) => setMemoryMB(e.target.value ? Number(e.target.value) : undefined)}
          style={{ width: 180 }}
        >
          {MEMORY_OPTIONS.map((m) => (
            <option key={m ?? 'none'} value={m ?? ''}>
              {m ? `${m / 1024} GB` : t('system.unlimited')}
            </option>
          ))}
        </select>
      </div>

      <div className="panel-section">
        <h3>{t('system.timezone')}</h3>
        <input
          className="mono"
          placeholder="Asia/Seoul"
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          style={{ width: 260 }}
        />
      </div>

      <div className="row">
        <button className="btn primary" disabled={!dirty || pending} onClick={() => void apply()}>
          {pending ? t('common.applying') : t('common.apply')}
        </button>
        <span className="small muted">{t('system.hint')}</span>
      </div>
    </>
  )
}
