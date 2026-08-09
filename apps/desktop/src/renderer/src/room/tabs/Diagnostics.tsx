import { useState } from 'react'
import type { CheckReport, CheckResult, RoomRecord } from '@devhotel/shared'
import { useStore } from '../../state/store'

const MARK: Record<string, string> = { healthy: '✓', warning: '△', broken: '✕', unknown: '·' }

const STEP_LABEL: Record<string, string> = {
  backend: 'Isolation backend',
  metadata: 'Room metadata',
  source: 'Source',
  runtime: 'Runtime',
  'package-manager': 'Package manager',
  dependencies: 'Dependencies',
  env: 'Environment variables',
  services: 'Services',
  'start-command': 'Start command',
  process: 'Web process',
  port: 'Internal port',
  gateway: 'Gateway route',
  https: 'DNS / HTTPS',
  http: 'HTTP response'
}

export function DiagnosticsTab({ room }: { room: RoomRecord }): React.JSX.Element {
  const runChecks = useStore((s) => s.runChecks)
  const applyChange = useStore((s) => s.applyChange)
  const roomAction = useStore((s) => s.roomAction)
  const copyDiagnostic = useStore((s) => s.copyDiagnostic)
  const latest = useStore((s) => s.inspections[room.id]?.latestCheck ?? null)
  const [report, setReport] = useState<CheckReport | null>(null)
  const [running, setRunning] = useState(false)
  const shown = report ?? latest

  async function run(): Promise<void> {
    setRunning(true)
    try {
      setReport(await runChecks(room.id))
    } finally {
      setRunning(false)
    }
  }

  async function fix(r: CheckResult): Promise<void> {
    if (!r.fix) return
    if (r.fix.kind === 'restart-web') await roomAction(room.id, 'restart')
    else if (r.fix.kind === 'start-services') await roomAction(room.id, 'start')
    else await applyChange(room.id, r.fix)
    await run()
  }

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="btn primary" disabled={running} onClick={() => void run()}>
          {running ? 'Checking…' : 'Run checks'}
        </button>
        <button className="btn" onClick={() => void copyDiagnostic(room.id)}>
          Copy diagnostic
        </button>
      </div>

      {!shown && <p className="muted">Run checks to inspect this room from backend to HTTP response.</p>}

      {shown && (
        <div className="panel-section">
          {shown.results.map((r) => (
            <div key={r.step} className="check-row" title={r.detail}>
              <span className="check-mark" data-status={r.status}>
                {MARK[r.status]}
              </span>
              <span className="summary">
                {STEP_LABEL[r.step] ?? r.step}
                <span className="small muted"> — {r.summary}</span>
              </span>
              {r.fix && r.status !== 'healthy' && (
                <button className="fix-btn" onClick={() => void fix(r)}>
                  Fix
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <p className="small muted">
        Copy diagnostic produces a redacted bundle — passwords, tokens and .env values are masked — ready to paste into an
        issue or an LLM.
      </p>
    </>
  )
}
