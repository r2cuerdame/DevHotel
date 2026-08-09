import { useState } from 'react'
import type { CheckReport, CheckResult, RoomRecord } from '@devhotel/shared'
import { useStore, useT } from '../../state/store'
import type { Translation } from '../../i18n'

const MARK: Record<string, string> = { healthy: '✓', warning: '△', broken: '✕', unknown: '·' }

const STEP_KEY: Record<string, keyof Translation> = {
  backend: 'diag.stepBackend',
  metadata: 'diag.stepMetadata',
  source: 'label.source',
  runtime: 'label.runtime',
  'package-manager': 'label.packageManager',
  dependencies: 'stack.dependencies',
  env: 'diag.stepEnv',
  services: 'tabs.services',
  'start-command': 'label.startCommand',
  process: 'services.webProcess',
  port: 'label.internalPort',
  gateway: 'diag.stepGateway',
  https: 'diag.stepHttps',
  http: 'diag.stepHttp'
}

export function DiagnosticsTab({ room }: { room: RoomRecord }): React.JSX.Element {
  const runChecks = useStore((s) => s.runChecks)
  const applyChange = useStore((s) => s.applyChange)
  const roomAction = useStore((s) => s.roomAction)
  const copyDiagnostic = useStore((s) => s.copyDiagnostic)
  const latest = useStore((s) => s.inspections[room.id]?.latestCheck ?? null)
  const t = useT()
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
          {running ? t('diag.checking') : t('diag.runChecks')}
        </button>
        <button className="btn" onClick={() => void copyDiagnostic(room.id)}>
          {t('diag.copyDiagnostic')}
        </button>
      </div>

      {!shown && <p className="muted">{t('diag.emptyHint')}</p>}

      {shown && (
        <div className="panel-section">
          {shown.results.map((r) => {
            const stepKey = STEP_KEY[r.step]
            return (
              <div key={r.step} className="check-row" title={r.detail}>
                <span className="check-mark" data-status={r.status}>
                  {MARK[r.status]}
                </span>
                <span className="summary">
                  {stepKey ? t(stepKey) : r.step}
                  <span className="small muted"> — {r.summary}</span>
                </span>
                {r.fix && r.status !== 'healthy' && (
                  <button className="fix-btn" onClick={() => void fix(r)}>
                    {t('diag.fix')}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      <p className="small muted">{t('diag.copyHint')}</p>
    </>
  )
}
