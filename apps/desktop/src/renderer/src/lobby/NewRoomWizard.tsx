import { useEffect, useRef, useState } from 'react'
import type { ProviderInfo, RoomPlan, SourceType, VmwareSetupStatusInfo } from '@devhotel/shared'
import { api } from '../api'
import { useStore, useT } from '../state/store'
import { describeError } from '../errorText'
import type { Translation } from '../i18n'
import {
  isNewRoomPlanReady,
  isNewRoomSourceReady,
  parseInternalPort,
  validateDomain,
  validateInternalPort,
  validateNickname,
  validateProjectName,
  validateRepoUrl
} from './newRoomValidation'
import type { CreatableProvider } from './newRoomValidation'

const NODE_MAJORS = ['18', '20', '22', '24']
type WebPmKind = 'npm' | 'pnpm'
type VmwareTemplate = { grantId: string; label: string; snapshots: string[] }

// Never render unavailableReason; it is English agent-facing API copy.
function windowsUnavailableKey(info: ProviderInfo | undefined): keyof Translation {
  switch (info?.unavailableCode) {
    case 'host-not-windows':
      return 'windows.unsupported'
    case 'vmware-missing':
      return 'windows.notDetected'
    default:
      return 'windows.setupRequiredCard'
  }
}

export function NewRoomWizard(): React.JSX.Element {
  const openWizard = useStore((s) => s.openWizard)
  const planRoom = useStore((s) => s.planRoom)
  const createRoom = useStore((s) => s.createRoom)
  const toast = useStore((s) => s.toast)
  const t = useT()

  const [step, setStep] = useState<'source' | 'plan'>('source')
  const [provider, setProvider] = useState<CreatableProvider>('web')
  const [sourceType, setSourceType] = useState<SourceType>('managed-git')
  const [sourceRef, setSourceRef] = useState('')
  const [project, setProject] = useState('')
  const [nickname, setNickname] = useState('dev')
  const [plan, setPlan] = useState<RoomPlan | null>(null)
  const [loading, setLoading] = useState(false)
  const [providerInfos, setProviderInfos] = useState<ProviderInfo[]>([])
  const [githubAccount, setGithubAccount] = useState<string | null>(null)
  const [vmwareTemplate, setVmwareTemplate] = useState<VmwareTemplate | null>(null)
  const [snapshot, setSnapshot] = useState('')
  const [vmwareStatus, setVmwareStatus] = useState<VmwareSetupStatusInfo | null>(null)
  const [vmwareAction, setVmwareAction] = useState<'checking' | 'download' | 'relaunch' | null>(null)
  const vmwareActionRef = useRef<typeof vmwareAction>(null)
  const [vmwareDownloadOpened, setVmwareDownloadOpened] = useState(false)

  useEffect(() => {
    let active = true
    void api.rooms
      .providers()
      .then((list) => {
        if (active) setProviderInfos(list)
      })
      .catch(() => undefined)
    void api.hotel
      .githubStatus()
      .then((status) => {
        if (active) setGithubAccount(status.credentialState === 'connected' ? status.account : null)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  const [runtimeVersion, setRuntimeVersion] = useState('22')
  const [pmKind, setPmKind] = useState<WebPmKind>('npm')
  const [startCommand, setStartCommand] = useState('')
  const [internalPortInput, setInternalPortInput] = useState('3000')
  const [domain, setDomain] = useState('')
  const [https, setHttps] = useState(false)

  const windowsInfo = providerInfos.find((info) => info.kind === 'windows')
  const vmwareReady = vmwareStatus?.state === 'ready'

  const chooseProvider = (kind: CreatableProvider): void => {
    const enteringWindows = kind === 'windows' && provider !== 'windows'
    setProvider(kind)
    setPlan(null)
    setStep('source')
    if (kind === 'windows') {
      setSourceType('empty')
      setSourceRef('')
      if (enteringWindows || vmwareStatus === null) {
        setVmwareStatus(null)
        void checkVmwareStatus()
      }
    }
  }

  const chooseSource = (type: SourceType): void => {
    setSourceType(type)
  }

  async function pickFolder(): Promise<void> {
    const folder = await api.app.pickFolder()
    if (folder) {
      setSourceRef(folder)
      if (!project) setProject(folder.replaceAll('\\', '/').split('/').filter(Boolean).pop() ?? '')
    }
  }

  async function pickVmwareTemplate(): Promise<void> {
    setLoading(true)
    try {
      const selected = await api.rooms.pickVmwareTemplate()
      if (!selected) return
      setVmwareTemplate(selected)
      setSnapshot(selected.snapshots[0] ?? '')
      if (!project) setProject(selected.label.replace(/\.vmx$/i, ''))
    } catch (err) {
      toast('error', describeError(err, t))
    } finally {
      setLoading(false)
    }
  }

  async function checkVmwareStatus(): Promise<void> {
    if (vmwareActionRef.current !== null) return
    vmwareActionRef.current = 'checking'
    setVmwareAction('checking')
    try {
      const status = await api.app.vmwareStatus()
      setVmwareStatus(status)
      if (status.ready) {
        const list = await api.rooms.providers()
        setProviderInfos(list)
      }
    } catch (err) {
      toast('error', describeError(err, t))
    } finally {
      vmwareActionRef.current = null
      setVmwareAction(null)
    }
  }

  async function openVmwareDownload(): Promise<void> {
    if (vmwareActionRef.current !== null) return
    vmwareActionRef.current = 'download'
    setVmwareAction('download')
    try {
      await api.app.openVmwareDownload()
      setVmwareDownloadOpened(true)
    } catch (err) {
      toast('error', describeError(err, t))
    } finally {
      vmwareActionRef.current = null
      setVmwareAction(null)
    }
  }

  async function relaunchForVmware(): Promise<void> {
    if (vmwareActionRef.current !== null) return
    vmwareActionRef.current = 'relaunch'
    setVmwareAction('relaunch')
    try {
      await api.app.relaunch()
    } catch (err) {
      toast('error', describeError(err, t))
      vmwareActionRef.current = null
      setVmwareAction(null)
    }
  }

  const repoUrlError =
    provider !== 'windows' && sourceType === 'managed-git' && sourceRef.length > 0 ? validateRepoUrl(sourceRef) : null
  const projectError = validateProjectName(project)
  const nicknameError = validateNickname(nickname)
  const parsedPort = parseInternalPort(internalPortInput)
  const portError = provider === 'web' ? validateInternalPort(internalPortInput) : null
  const domainError = provider === 'web' ? validateDomain(domain) : null

  const sourceValid = isNewRoomSourceReady({
    provider,
    sourceType,
    sourceRef,
    project,
    nickname,
    vmwareReady,
    hasVmwareTemplate: Boolean(vmwareTemplate),
    snapshot
  })

  const planValid = isNewRoomPlanReady({
    provider,
    startCommand,
    internalPort: internalPortInput,
    domain,
    hasVmwareTemplate: Boolean(vmwareTemplate),
    snapshot
  })

  async function analyze(): Promise<void> {
    if (!sourceValid) return
    const effectiveSourceType: SourceType = provider === 'windows' ? 'empty' : sourceType
    const effectiveSourceRef = provider === 'windows' ? '' : sourceRef
    const projectName =
      project.trim() ||
      (effectiveSourceType === 'managed-git'
        ? (effectiveSourceRef.split('/').pop() ?? '').replace(/\.git$/, '')
        : effectiveSourceRef.replaceAll('\\', '/').split('/').filter(Boolean).pop()) ||
      'project'
    setProject(projectName)
    setLoading(true)
    try {
      const p = await planRoom({
        sourceType: effectiveSourceType,
        sourceRef: effectiveSourceRef,
        nickname,
        project: projectName,
        provider
      })
      setPlan(p)
      if (provider !== 'windows') {
        setRuntimeVersion(p.runtime.value)
        if (provider === 'web' && (p.packageManager.value === 'npm' || p.packageManager.value === 'pnpm')) {
          setPmKind(p.packageManager.value)
        }
        setStartCommand(p.startCommand.value)
        setInternalPortInput(String(p.internalPort.value))
        setDomain(p.domain)
        setHttps(p.https)
      }
      setStep('plan')
    } catch (err) {
      toast('error', describeError(err, t))
    } finally {
      setLoading(false)
    }
  }

  async function checkIn(): Promise<void> {
    if (!planValid) return
    let planOverrides:
      | { startCommand: string }
      | { runtimeVersion: string; pmKind: WebPmKind; startCommand: string; internalPort: number; domain: string; https: boolean }
      | undefined
    if (provider === 'android') {
      planOverrides = { startCommand }
    } else if (provider === 'web') {
      if (parsedPort === null) return
      planOverrides = { runtimeVersion, pmKind, startCommand, internalPort: parsedPort, domain, https }
    }
    setLoading(true)
    try {
      await createRoom({
        sourceType: provider === 'windows' ? 'empty' : sourceType,
        sourceRef: provider === 'windows' ? '' : sourceRef,
        project,
        nickname,
        provider,
        ...(planOverrides ? { planOverrides } : {}),
        ...(provider === 'windows' && vmwareTemplate
          ? { windows: { templateGrantId: vmwareTemplate.grantId, snapshot } }
          : {})
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => !loading && openWizard(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {step === 'source' ? (
          <>
            <h2>{t('lobby.newRoom')}</h2>
            <div className="field">
              <label>{t('wizard.roomType')}</label>
              <div className="provider-choices">
                <button className="source-choice" data-active={provider === 'web'} onClick={() => chooseProvider('web')}>
                  <b>{t('wizard.webRoom')}</b>
                  <small>{t('wizard.webRoomHint')}</small>
                </button>
                <button className="source-choice" data-active={provider === 'android'} onClick={() => chooseProvider('android')}>
                  <b>{t('android.buildRoom')}</b>
                  <small>{t('wizard.sourceAndroidHint')}</small>
                </button>
                <button
                  className="source-choice"
                  data-active={provider === 'windows'}
                  onClick={() => chooseProvider('windows')}
                >
                  <b>{windowsInfo?.label ?? t('windows.vmwareRoom')}</b>
                  <small>
                    {windowsInfo?.available ? t('windows.roomHint') : t(windowsUnavailableKey(windowsInfo))}
                  </small>
                </button>
              </div>
            </div>
            {provider !== 'windows' && (
              <div className="source-choices">
                {(
                  [
                    ['managed-git', 'wizard.sourceGit', 'wizard.sourceGitHint'],
                    ['linked-folder', 'wizard.sourceFolder', 'wizard.sourceFolderHint'],
                    ['empty', 'wizard.sourceEmpty', 'wizard.sourceEmptyHint']
                  ] as [SourceType, keyof Translation, keyof Translation][]
                ).map(([type, label, hint]) => (
                  <button
                    key={type}
                    className="source-choice"
                    data-active={sourceType === type}
                    onClick={() => chooseSource(type)}
                  >
                    <b>{t(label)}</b>
                    <small>{t(hint)}</small>
                  </button>
                ))}
              </div>
            )}

            {provider !== 'windows' && sourceType === 'managed-git' && (
              <div className="field">
                <label htmlFor="src-url">{t('wizard.repoUrl')}</label>
                <input
                  id="src-url"
                  placeholder="https://github.com/you/project"
                  value={sourceRef}
                  aria-invalid={!!repoUrlError}
                  aria-describedby={repoUrlError ? 'src-url-error' : undefined}
                  onChange={(e) => setSourceRef(e.target.value)}
                  autoFocus
                />
                {repoUrlError && (
                  <small id="src-url-error" className="field-hint field-error" role="alert">
                    {t(repoUrlError.key, repoUrlError.vars)}
                  </small>
                )}
                <small className="field-hint">
                  {githubAccount
                    ? t('wizard.repoPrivateConnected', { account: githubAccount })
                    : t('wizard.repoPrivateHint')}
                </small>
              </div>
            )}
            {provider !== 'windows' && sourceType === 'linked-folder' && (
              <div className="field">
                <label htmlFor="src-path">{t('wizard.projectFolder')}</label>
                <div className="row">
                  <input
                    id="src-path"
                    placeholder="C:\code\my-project"
                    value={sourceRef}
                    readOnly
                    style={{ flex: 1 }}
                  />
                  <button className="btn" onClick={() => void pickFolder()}>
                    {t('wizard.browse')}
                  </button>
                </div>
              </div>
            )}

            {provider === 'windows' && (
              <>
                {!vmwareReady ? (
                  <div
                    className="field"
                    style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 14 }}
                    aria-live="polite"
                  >
                    <b>{t('windows.setupTitle')}</b>
                    <span className="small muted">
                      {vmwareAction === 'checking' || vmwareStatus === null
                        ? t('windows.detecting')
                        : vmwareStatus.state === 'unsupported'
                          ? t('windows.unsupported')
                          : vmwareStatus.state === 'relaunch-required'
                            ? t('windows.relaunchRequired')
                            : vmwareStatus.state === 'unavailable'
                              ? t('windows.unavailable')
                              : t('windows.notDetected')}
                    </span>
                    {vmwareStatus?.state === 'unavailable' && vmwareStatus.detail && (
                      <span className="small muted">{vmwareStatus.detail}</span>
                    )}
                    {vmwareDownloadOpened &&
                      (vmwareStatus?.state === 'missing' || vmwareStatus?.state === 'unavailable') && (
                        <span className="small muted">{t('windows.downloadOpened')}</span>
                      )}
                    <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                      {(vmwareStatus?.state === 'missing' || vmwareStatus?.state === 'unavailable') && (
                        <button
                          className="btn primary"
                          disabled={vmwareAction !== null}
                          onClick={() => void openVmwareDownload()}
                        >
                          {vmwareAction === 'download'
                            ? t('windows.openingDownload')
                            : vmwareStatus.state === 'unavailable'
                              ? t('windows.repairVmware')
                              : t('windows.installVmware')}
                        </button>
                      )}
                      {vmwareStatus?.state === 'relaunch-required' && (
                        <button
                          className="btn primary"
                          disabled={vmwareAction !== null}
                          onClick={() => void relaunchForVmware()}
                        >
                          {vmwareAction === 'relaunch' ? t('windows.relaunching') : t('windows.relaunch')}
                        </button>
                      )}
                      {vmwareStatus?.state !== 'unsupported' && (
                        <button
                          className="btn"
                          disabled={vmwareAction !== null}
                          onClick={() => void checkVmwareStatus()}
                        >
                          {vmwareAction === 'checking' ? t('windows.detecting') : t('windows.checkAgain')}
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="field">
                      <small className="muted">{t('windows.detectedReady')}</small>
                      <label>{t('windows.template')}</label>
                      <div className="row">
                        <input
                          className="mono"
                          value={vmwareTemplate?.label ?? ''}
                          placeholder={t('windows.noTemplate')}
                          readOnly
                          style={{ flex: 1 }}
                        />
                        <button className="btn" disabled={loading} onClick={() => void pickVmwareTemplate()}>
                          {vmwareTemplate ? t('windows.changeTemplate') : t('windows.chooseTemplate')}
                        </button>
                      </div>
                    </div>
                    <div className="field">
                      <label htmlFor="vmware-snapshot">{t('windows.snapshot')}</label>
                      <select
                        id="vmware-snapshot"
                        value={snapshot}
                        disabled={!vmwareTemplate || vmwareTemplate.snapshots.length === 0}
                        onChange={(event) => setSnapshot(event.target.value)}
                      >
                        {vmwareTemplate?.snapshots.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                      {vmwareTemplate && vmwareTemplate.snapshots.length === 0 && (
                        <small className="muted">{t('windows.noSnapshots')}</small>
                      )}
                    </div>
                    <ul className="plan-warnings">
                      <li>{t('windows.linkedCloneHint')}</li>
                      <li>{t('windows.offlineHint')}</li>
                      <li>{t('windows.guestAgentLater')}</li>
                    </ul>
                  </>
                )}
              </>
            )}

            <div className="field-row">
              <div className="field">
                <label htmlFor="proj">{t('wizard.projectName')}</label>
                <input
                  id="proj"
                  placeholder={provider === 'windows' ? t('windows.projectPlaceholder') : t('wizard.auto')}
                  value={project}
                  aria-invalid={!!projectError}
                  aria-describedby={projectError ? 'proj-error' : undefined}
                  onChange={(e) => setProject(e.target.value)}
                />
                {projectError && (
                  <small id="proj-error" className="field-hint field-error" role="alert">
                    {t(projectError.key, projectError.vars)}
                  </small>
                )}
              </div>
              <div className="field">
                <label htmlFor="nick">{t('wizard.nickname')}</label>
                <input
                  id="nick"
                  value={nickname}
                  aria-invalid={!!nicknameError}
                  aria-describedby={nicknameError ? 'nick-error' : undefined}
                  onChange={(e) => setNickname(e.target.value)}
                />
                {nicknameError && (
                  <small id="nick-error" className="field-hint field-error" role="alert">
                    {t(nicknameError.key, nicknameError.vars)}
                  </small>
                )}
              </div>
            </div>

            <div className="modal-actions">
              <button className="btn" onClick={() => openWizard(false)}>
                {t('common.cancel')}
              </button>
              <button className="btn primary" disabled={!sourceValid || loading} onClick={() => void analyze()}>
                {loading ? t('wizard.analyzing') : provider === 'windows' ? t('windows.review') : t('wizard.analyze')}
              </button>
            </div>
          </>
        ) : (
          <>
            <h2>{t('wizard.planTitle', { project, nickname })}</h2>
            <table className="plan-table">
              <tbody>
                {provider === 'windows' ? (
                  <>
                    <tr>
                      <td>{t('windows.template')}</td>
                      <td className="mono">{vmwareTemplate?.label}</td>
                    </tr>
                    <tr>
                      <td>{t('windows.snapshot')}</td>
                      <td className="mono">{snapshot}</td>
                    </tr>
                    <tr>
                      <td>{t('windows.isolation')}</td>
                      <td>{t('windows.linkedCloneOffline')}</td>
                    </tr>
                  </>
                ) : (
                  <>
                    {plan?.framework && (
                      <tr>
                        <td>{t('label.project')}</td>
                        <td>{plan.framework}</td>
                      </tr>
                    )}
                    <tr>
                      <td>{t('label.runtime')}</td>
                      <td>
                        <div className="row">
                          {provider === 'android' ? (
                            <span>JDK {runtimeVersion}</span>
                          ) : (
                            <select value={runtimeVersion} onChange={(e) => setRuntimeVersion(e.target.value)} style={{ width: 110 }}>
                              {NODE_MAJORS.map((v) => (
                                <option key={v} value={v}>
                                  Node {v}
                                </option>
                              ))}
                            </select>
                          )}
                          <span className="src">{plan?.runtime.source}</span>
                        </div>
                      </td>
                    </tr>
                    <tr>
                      <td>{t('label.packageManager')}</td>
                      <td>
                        <div className="row">
                          {provider === 'android' ? (
                            <span>Gradle</span>
                          ) : (
                            <select value={pmKind} onChange={(e) => setPmKind(e.target.value as WebPmKind)} style={{ width: 110 }}>
                              <option value="npm">npm</option>
                              <option value="pnpm">pnpm</option>
                            </select>
                          )}
                          <span className="src">{plan?.packageManager.source}</span>
                        </div>
                      </td>
                    </tr>
                    <tr>
                      <td>{t('label.startCommand')}</td>
                      <td>
                        <input className="mono" value={startCommand} onChange={(e) => setStartCommand(e.target.value)} />
                      </td>
                    </tr>
                    {provider === 'web' && (
                      <>
                        <tr>
                          <td>{t('label.internalPort')}</td>
                          <td>
                            <div className="row">
                              <input
                                type="number"
                                min={1}
                                max={65535}
                                step={1}
                                value={internalPortInput}
                                aria-invalid={!!portError}
                                aria-describedby={portError ? 'plan-port-error' : undefined}
                                onChange={(e) => setInternalPortInput(e.target.value)}
                                style={{ width: 110 }}
                              />
                              <span className="src">{plan?.internalPort.source}</span>
                            </div>
                            {portError && (
                              <small
                                id="plan-port-error"
                                className="field-hint field-error"
                                role="alert"
                                style={{ display: 'block', marginTop: 4 }}
                              >
                                {t(portError.key, portError.vars)}
                              </small>
                            )}
                          </td>
                        </tr>
                        <tr>
                          <td>{t('label.domain')}</td>
                          <td>
                            <input
                              className="mono"
                              value={domain}
                              aria-invalid={!!domainError}
                              aria-describedby={domainError ? 'plan-domain-error' : undefined}
                              onChange={(e) => setDomain(e.target.value)}
                            />
                            {domainError && (
                              <small
                                id="plan-domain-error"
                                className="field-hint field-error"
                                role="alert"
                                style={{ display: 'block', marginTop: 4 }}
                              >
                                {t(domainError.key, domainError.vars)}
                              </small>
                            )}
                          </td>
                        </tr>
                        <tr>
                          <td>HTTPS</td>
                          <td>
                            <label className="row" style={{ gap: 6 }}>
                              <input type="checkbox" checked={https} onChange={(e) => setHttps(e.target.checked)} />{' '}
                              {t('wizard.enable')}
                            </label>
                          </td>
                        </tr>
                      </>
                    )}
                  </>
                )}
              </tbody>
            </table>

            {provider === 'android' && <p className="small muted">{t('android.buildOnlyHint')}</p>}
            {provider === 'windows' && <p className="small muted">{t('windows.guestAgentLater')}</p>}

            {plan && plan.warnings.length > 0 && (
              <ul className="plan-warnings">
                {plan.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}

            <div className="modal-actions">
              <button className="btn" onClick={() => setStep('source')} disabled={loading}>
                {t('common.back')}
              </button>
              <button className="btn primary" onClick={() => void checkIn()} disabled={loading || !planValid}>
                {loading ? t('wizard.preparingRoom') : t('wizard.checkIn')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
