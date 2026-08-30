import { useEffect, useReducer, useRef, useState } from 'react'
import {
  IPC,
  type AndroidPairingPromptClosedEvent,
  type AndroidPairingUiCandidate
} from '@devhotel/shared'
import { api } from '../api'
import { useT } from '../state/store'
import {
  INITIAL_ANDROID_PAIRING_FLOW,
  androidPairingFlowReducer,
  clearPairingCodeInput,
  pairingCodeDigits,
  pairingRemainingSeconds,
  takePairingCode
} from './androidPairingFlow'

export function AndroidPairingModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const t = useT()
  const [state, dispatch] = useReducer(androidPairingFlowReducer, INITIAL_ANDROID_PAIRING_FLOW)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [codeReady, setCodeReady] = useState(false)
  const codeInput = useRef<HTMLInputElement | null>(null)
  const activePrompt = useRef<string | null>(null)
  const requestSerial = useRef(0)
  const selected = state.candidates.find((candidate) => candidate.candidateId === state.selectedCandidateId) ?? null
  const trackedExpiry = state.expiresAt ?? selected?.expiresAt ?? null
  const remainingSeconds = pairingRemainingSeconds(trackedExpiry, nowMs)

  function clearCode(): void {
    clearPairingCodeInput(codeInput.current)
    setCodeReady(false)
  }

  function releasePrompt(): Promise<void> {
    const promptId = activePrompt.current
    activePrompt.current = null
    clearCode()
    if (!promptId) return Promise.resolve()
    return api.android.pairing.dismiss({ promptId }).then(() => undefined).catch(() => undefined)
  }

  async function discover(): Promise<void> {
    const serial = ++requestSerial.current
    await releasePrompt()
    if (serial !== requestSerial.current) return
    dispatch({ type: 'discover' })
    try {
      const result = await api.android.pairing.discover()
      if (serial !== requestSerial.current) return
      if (result.ok) dispatch({ type: 'discovered', candidates: result.candidates })
      else dispatch({ type: 'failure', code: result.code })
    } catch {
      if (serial === requestSerial.current) dispatch({ type: 'failure', code: 'pairing-discovery-failed' })
    }
  }

  function close(): void {
    requestSerial.current += 1
    void releasePrompt()
    onClose()
  }

  async function openPrompt(): Promise<void> {
    if (!selected || !state.consentConfirmed || remainingSeconds <= 0) return
    const serial = ++requestSerial.current
    dispatch({ type: 'open' })
    try {
      const result = await api.android.pairing.begin({
        candidateId: selected.candidateId,
        generation: selected.generation
      })
      if (serial !== requestSerial.current) {
        if (result.ok) void api.android.pairing.dismiss({ promptId: result.promptId })
        return
      }
      if (!result.ok) {
        dispatch({ type: 'failure', code: result.code })
        return
      }
      activePrompt.current = result.promptId
      dispatch({ type: 'opened', promptId: result.promptId, expiresAt: result.expiresAt })
    } catch {
      if (serial === requestSerial.current) dispatch({ type: 'failure', code: 'capture-busy' })
    }
  }

  async function submit(): Promise<void> {
    const promptId = activePrompt.current
    if (!promptId || state.phase !== 'prompt' || !codeInput.current) return
    let pairingCode = takePairingCode(codeInput.current)
    setCodeReady(false)
    if (!pairingCode) return

    const serial = ++requestSerial.current
    clearCode()
    dispatch({ type: 'submit' })
    try {
      // ipcRenderer serializes the argument for the main process immediately;
      // discard the renderer-local string before awaiting the operation.
      const pending = api.android.pairing.submit({ promptId, code: pairingCode })
      pairingCode = null
      const result = await pending
      await releasePrompt()
      if (serial !== requestSerial.current) return
      dispatch({ type: 'complete', code: result.ok ? 'paired' : result.code })
    } catch {
      pairingCode = null
      await releasePrompt()
      if (serial === requestSerial.current) dispatch({ type: 'complete', code: 'pairing-failed' })
    }
  }

  useEffect(() => {
    void discover()
    const stop = api.on(IPC.evAndroidPairingPromptClosed, (event: AndroidPairingPromptClosedEvent) => {
      if (!event || activePrompt.current !== event.promptId) return
      activePrompt.current = null
      clearCode()
      requestSerial.current += 1
      if (event.reason === 'expired') dispatch({ type: 'expired' })
      else dispatch({ type: 'failure', code: 'prompt-closed' })
    })
    return () => {
      stop()
      requestSerial.current += 1
      const promptId = activePrompt.current
      activePrompt.current = null
      clearPairingCodeInput(codeInput.current)
      if (promptId) void api.android.pairing.dismiss({ promptId })
    }
  }, [])

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 250)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!trackedExpiry || remainingSeconds > 0) return
    if (!['consent', 'opening', 'prompt'].includes(state.phase)) return
    requestSerial.current += 1
    const promptId = activePrompt.current
    activePrompt.current = null
    clearCode()
    if (promptId) void api.android.pairing.dismiss({ promptId })
    dispatch({ type: 'expired' })
  }, [remainingSeconds, state.phase, trackedExpiry])

  const resultCode = state.resultCode
  const failureCode = resultCode && resultCode !== 'paired' ? resultCode : null

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}>
      <section
        className="modal android-pairing-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="android-pairing-title"
      >
        <header className="android-pairing-head">
          <div>
            <span className="eyebrow">{t('pairing.trustedDesktop')}</span>
            <h2 id="android-pairing-title">{t('pairing.title')}</h2>
          </div>
          <button className="icon-btn" onClick={close} aria-label={t('common.close')}>✕</button>
        </header>
        <p className="muted">{t('pairing.subtitle')}</p>
        <div className="pairing-security-note">{t('pairing.securityNote')}</div>

        {state.phase === 'discovering' && <p className="pairing-centered" aria-live="polite">{t('pairing.discovering')}</p>}

        {state.phase === 'choose' && <>
          <div className="pairing-section-title">
            <b>{t('pairing.choose')}</b>
            <button className="btn" onClick={() => void discover()}>{t('pairing.refresh')}</button>
          </div>
          {state.candidates.length === 0
            ? <p className="pairing-empty">{t('pairing.none')}</p>
            : <div className="pairing-candidates">
                {state.candidates.map((candidate: AndroidPairingUiCandidate) => {
                  const seconds = pairingRemainingSeconds(candidate.expiresAt, nowMs)
                  return <button
                    className="pairing-candidate"
                    key={`${candidate.generation}:${candidate.candidateId}`}
                    disabled={seconds <= 0}
                    onClick={() => dispatch({ type: 'select', candidateId: candidate.candidateId })}
                  >
                    <span><b>{candidate.label}</b><small>{t('pairing.opaqueCandidate')}</small></span>
                    <span className="pairing-expiry">{seconds > 0 ? t('pairing.expiresIn', { seconds }) : t('pairing.expired')}</span>
                  </button>
                })}
              </div>}
        </>}

        {(state.phase === 'consent' || state.phase === 'opening') && selected && <>
          <div className="pairing-consent">
            <h3>{t('pairing.consentTitle')}</h3>
            <p>{t('pairing.consentBody')}</p>
            <p className="pairing-one-shot">{t('pairing.singleUse')}</p>
            <label className="pairing-check">
              <input
                type="checkbox"
                checked={state.consentConfirmed}
                disabled={state.phase === 'opening'}
                onChange={(event) => dispatch({ type: 'consent', confirmed: event.target.checked })}
              />
              <span>{t('pairing.consentCheck')}</span>
            </label>
            <div className="pairing-expiry-block">{t('pairing.expiresIn', { seconds: remainingSeconds })}</div>
          </div>
          <div className="modal-actions">
            <button className="btn" disabled={state.phase === 'opening'} onClick={() => dispatch({ type: 'back' })}>{t('common.back')}</button>
            <button
              className="btn primary"
              disabled={!state.consentConfirmed || state.phase === 'opening' || remainingSeconds <= 0}
              onClick={() => void openPrompt()}
            >
              {state.phase === 'opening' ? t('pairing.opening') : t('pairing.openPrompt')}
            </button>
          </div>
        </>}

        {(state.phase === 'prompt' || state.phase === 'submitting') && <>
          <div className="pairing-code-panel">
            <h3>{t('pairing.codeTitle')}</h3>
            <p>{t('pairing.codeHint')}</p>
            <label htmlFor="android-pairing-code">{t('pairing.codeLabel')}</label>
            <input
              ref={codeInput}
              id="android-pairing-code"
              className="pairing-code-input"
              type="password"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              autoComplete="off"
              spellCheck={false}
              autoFocus
              disabled={state.phase === 'submitting'}
              onInput={(event) => {
                const value = pairingCodeDigits(event.currentTarget.value)
                event.currentTarget.value = value
                setCodeReady(value.length === 6)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && codeReady && state.phase === 'prompt') void submit()
              }}
            />
            <div className="pairing-prompt-meta">
              <span>{t('pairing.expiresIn', { seconds: remainingSeconds })}</span>
              <span>{t('pairing.singleUseShort')}</span>
            </div>
          </div>
          <div className="modal-actions">
            <button className="btn" disabled={state.phase === 'submitting'} onClick={close}>{t('pairing.dismiss')}</button>
            <button className="btn primary" disabled={!codeReady || state.phase === 'submitting'} onClick={() => void submit()}>
              {state.phase === 'submitting' ? t('pairing.pairing') : t('pairing.pair')}
            </button>
          </div>
        </>}

        {state.phase === 'expired' && <div className="pairing-result" data-kind="warning" aria-live="polite">
          <h3>{t('pairing.expiredTitle')}</h3>
          <p>{t('pairing.expiredBody')}</p>
          <button className="btn primary" onClick={() => void discover()}>{t('pairing.discoverAgain')}</button>
        </div>}

        {state.phase === 'complete' && <div className="pairing-result" data-kind={resultCode === 'paired' ? 'success' : 'error'} aria-live="polite">
          <h3>{resultCode === 'paired' ? t('pairing.successTitle') : t('pairing.failureTitle')}</h3>
          <p>{resultCode === 'paired' ? t('pairing.successBody') : t('pairing.failureBody')}</p>
          <p className="small muted">{t('pairing.fixedEvidence')}</p>
          {failureCode && <code className="pairing-result-code">{failureCode}</code>}
          <div className="modal-actions">
            <button className="btn" onClick={close}>{t('common.close')}</button>
            {resultCode !== 'paired' && <button className="btn primary" onClick={() => void discover()}>{t('pairing.discoverAgain')}</button>}
          </div>
        </div>}

        {state.phase === 'error' && <div className="pairing-result" data-kind="error" aria-live="polite">
          <h3>{t('pairing.errorTitle')}</h3>
          <p>{t('pairing.errorBody')}</p>
          {failureCode && <code className="pairing-result-code">{failureCode}</code>}
          <div className="modal-actions">
            <button className="btn" onClick={close}>{t('common.close')}</button>
            <button className="btn primary" onClick={() => void discover()}>{t('pairing.tryAgain')}</button>
          </div>
        </div>}
      </section>
    </div>
  )
}
