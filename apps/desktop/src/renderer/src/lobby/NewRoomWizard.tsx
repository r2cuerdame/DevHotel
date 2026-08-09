import { useState } from 'react'
import type { PmKind, RoomPlan, SourceType } from '@devhotel/shared'
import { api } from '../api'
import { useStore } from '../state/store'

const NODE_MAJORS = ['18', '20', '22', '24']

export function NewRoomWizard(): React.JSX.Element {
  const openWizard = useStore((s) => s.openWizard)
  const planRoom = useStore((s) => s.planRoom)
  const createRoom = useStore((s) => s.createRoom)
  const toast = useStore((s) => s.toast)

  const [step, setStep] = useState<'source' | 'plan'>('source')
  const [sourceType, setSourceType] = useState<SourceType>('managed-git')
  const [sourceRef, setSourceRef] = useState('')
  const [project, setProject] = useState('')
  const [nickname, setNickname] = useState('dev')
  const [plan, setPlan] = useState<RoomPlan | null>(null)
  const [loading, setLoading] = useState(false)

  // editable plan fields
  const [runtimeVersion, setRuntimeVersion] = useState('22')
  const [pmKind, setPmKind] = useState<PmKind>('npm')
  const [startCommand, setStartCommand] = useState('')
  const [internalPort, setInternalPort] = useState(3000)
  const [domain, setDomain] = useState('')
  const [https, setHttps] = useState(false)

  const chooseSource = (t: SourceType): void => setSourceType(t)

  async function pickFolder(): Promise<void> {
    const folder = await api.app.pickFolder()
    if (folder) {
      setSourceRef(folder)
      if (!project) setProject(folder.replaceAll('\\', '/').split('/').filter(Boolean).pop() ?? '')
    }
  }

  async function analyze(): Promise<void> {
    const projectName =
      project ||
      (sourceType === 'managed-git'
        ? (sourceRef.split('/').pop() ?? '').replace(/\.git$/, '')
        : sourceRef.replaceAll('\\', '/').split('/').filter(Boolean).pop()) ||
      'project'
    setProject(projectName)
    setLoading(true)
    try {
      const p = await planRoom({ sourceType, sourceRef, nickname, project: projectName })
      setPlan(p)
      setRuntimeVersion(p.runtime.value)
      setPmKind(p.packageManager.value)
      setStartCommand(p.startCommand.value)
      setInternalPort(p.internalPort.value)
      setDomain(p.domain)
      setHttps(p.https)
      setStep('plan')
    } catch (err) {
      toast('error', err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function checkIn(): Promise<void> {
    setLoading(true)
    try {
      await createRoom({
        sourceType,
        sourceRef,
        project,
        nickname,
        actor: 'user',
        planOverrides: { runtimeVersion, pmKind, startCommand, internalPort, domain, https }
      })
    } finally {
      setLoading(false)
    }
  }

  const sourceValid =
    sourceType === 'empty' || (sourceType === 'managed-git' ? /^(https?:\/\/|git@)/.test(sourceRef) : sourceRef.length > 2)

  return (
    <div className="modal-backdrop" onClick={() => !loading && openWizard(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {step === 'source' ? (
          <>
            <h2>New Room</h2>
            <div className="source-choices">
              {(
                [
                  ['managed-git', 'GitHub repository', 'Cloned into the room'],
                  ['linked-folder', 'Local folder', 'Linked — your files stay put'],
                  ['empty', 'Empty room', 'Start from nothing']
                ] as [SourceType, string, string][]
              ).map(([t, label, hint]) => (
                <button key={t} className="source-choice" data-active={sourceType === t} onClick={() => chooseSource(t)}>
                  <b>{label}</b>
                  <small>{hint}</small>
                </button>
              ))}
            </div>

            {sourceType === 'managed-git' && (
              <div className="field">
                <label htmlFor="src-url">Repository URL</label>
                <input
                  id="src-url"
                  placeholder="https://github.com/you/project"
                  value={sourceRef}
                  onChange={(e) => setSourceRef(e.target.value)}
                  autoFocus
                />
              </div>
            )}
            {sourceType === 'linked-folder' && (
              <div className="field">
                <label htmlFor="src-path">Project folder</label>
                <div className="row">
                  <input
                    id="src-path"
                    placeholder="C:\code\my-project"
                    value={sourceRef}
                    onChange={(e) => setSourceRef(e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <button className="btn" onClick={() => void pickFolder()}>
                    Browse…
                  </button>
                </div>
              </div>
            )}

            <div className="field-row">
              <div className="field">
                <label htmlFor="proj">Project name</label>
                <input id="proj" placeholder="auto" value={project} onChange={(e) => setProject(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="nick">Room nickname</label>
                <input id="nick" value={nickname} onChange={(e) => setNickname(e.target.value)} />
              </div>
            </div>

            <div className="modal-actions">
              <button className="btn" onClick={() => openWizard(false)}>
                Cancel
              </button>
              <button className="btn primary" disabled={!sourceValid || !nickname || loading} onClick={() => void analyze()}>
                {loading ? 'Analyzing…' : 'Analyze project'}
              </button>
            </div>
          </>
        ) : (
          <>
            <h2>
              Room plan — {project} / {nickname}
            </h2>
            <table className="plan-table">
              <tbody>
                {plan?.framework && (
                  <tr>
                    <td>Project</td>
                    <td>{plan.framework}</td>
                  </tr>
                )}
                <tr>
                  <td>Runtime</td>
                  <td>
                    <div className="row">
                      <select value={runtimeVersion} onChange={(e) => setRuntimeVersion(e.target.value)} style={{ width: 110 }}>
                        {NODE_MAJORS.map((v) => (
                          <option key={v} value={v}>
                            Node {v}
                          </option>
                        ))}
                      </select>
                      <span className="src">{plan?.runtime.source}</span>
                    </div>
                  </td>
                </tr>
                <tr>
                  <td>Package manager</td>
                  <td>
                    <div className="row">
                      <select value={pmKind} onChange={(e) => setPmKind(e.target.value as PmKind)} style={{ width: 110 }}>
                        <option value="npm">npm</option>
                        <option value="pnpm">pnpm</option>
                      </select>
                      <span className="src">{plan?.packageManager.source}</span>
                    </div>
                  </td>
                </tr>
                <tr>
                  <td>Start command</td>
                  <td>
                    <input className="mono" value={startCommand} onChange={(e) => setStartCommand(e.target.value)} />
                  </td>
                </tr>
                <tr>
                  <td>Internal port</td>
                  <td>
                    <div className="row">
                      <input
                        type="number"
                        value={internalPort}
                        onChange={(e) => setInternalPort(Number(e.target.value))}
                        style={{ width: 110 }}
                      />
                      <span className="src">{plan?.internalPort.source}</span>
                    </div>
                  </td>
                </tr>
                <tr>
                  <td>Domain</td>
                  <td>
                    <input className="mono" value={domain} onChange={(e) => setDomain(e.target.value)} />
                  </td>
                </tr>
                <tr>
                  <td>HTTPS</td>
                  <td>
                    <label className="row" style={{ gap: 6 }}>
                      <input type="checkbox" checked={https} onChange={(e) => setHttps(e.target.checked)} /> Enable
                    </label>
                  </td>
                </tr>
              </tbody>
            </table>

            {plan && plan.warnings.length > 0 && (
              <ul className="plan-warnings">
                {plan.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}

            <div className="modal-actions">
              <button className="btn" onClick={() => setStep('source')} disabled={loading}>
                Back
              </button>
              <button className="btn primary" onClick={() => void checkIn()} disabled={loading || !startCommand || !domain}>
                {loading ? 'Preparing room…' : 'Check in'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
