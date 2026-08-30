import type {
  AndroidPairingUiCandidate,
  AndroidPairingUiFailure
} from '@devhotel/shared'

export type AndroidPairingFlowPhase =
  | 'discovering'
  | 'choose'
  | 'consent'
  | 'opening'
  | 'prompt'
  | 'submitting'
  | 'complete'
  | 'expired'
  | 'error'

export interface AndroidPairingFlowState {
  phase: AndroidPairingFlowPhase
  candidates: AndroidPairingUiCandidate[]
  selectedCandidateId: string | null
  consentConfirmed: boolean
  promptId: string | null
  expiresAt: string | null
  resultCode: 'paired' | AndroidPairingUiFailure['code'] | null
}

export type AndroidPairingFlowAction =
  | { type: 'discover' }
  | { type: 'discovered'; candidates: AndroidPairingUiCandidate[] }
  | { type: 'select'; candidateId: string }
  | { type: 'consent'; confirmed: boolean }
  | { type: 'open' }
  | { type: 'opened'; promptId: string; expiresAt: string }
  | { type: 'submit' }
  | { type: 'complete'; code: 'paired' | AndroidPairingUiFailure['code'] }
  | { type: 'failure'; code: AndroidPairingUiFailure['code'] }
  | { type: 'expired' }
  | { type: 'back' }

export const INITIAL_ANDROID_PAIRING_FLOW: AndroidPairingFlowState = {
  phase: 'discovering',
  candidates: [],
  selectedCandidateId: null,
  consentConfirmed: false,
  promptId: null,
  expiresAt: null,
  resultCode: null
}

/** No action in this reducer accepts or stores the pairing code. */
export function androidPairingFlowReducer(
  state: AndroidPairingFlowState,
  action: AndroidPairingFlowAction
): AndroidPairingFlowState {
  switch (action.type) {
    case 'discover':
      return { ...INITIAL_ANDROID_PAIRING_FLOW }
    case 'discovered':
      if (state.phase !== 'discovering') return state
      return { ...INITIAL_ANDROID_PAIRING_FLOW, phase: 'choose', candidates: action.candidates }
    case 'select':
      if (state.phase !== 'choose' || !state.candidates.some((candidate) => candidate.candidateId === action.candidateId)) {
        return state
      }
      return {
        ...state,
        phase: 'consent',
        selectedCandidateId: action.candidateId,
        consentConfirmed: false,
        resultCode: null
      }
    case 'consent':
      return state.phase === 'consent' ? { ...state, consentConfirmed: action.confirmed } : state
    case 'open':
      return state.phase === 'consent' && state.consentConfirmed ? { ...state, phase: 'opening' } : state
    case 'opened':
      return state.phase === 'opening'
        ? { ...state, phase: 'prompt', promptId: action.promptId, expiresAt: action.expiresAt, consentConfirmed: false }
        : state
    case 'submit':
      return state.phase === 'prompt' && state.promptId ? { ...state, phase: 'submitting' } : state
    case 'complete':
      return state.phase === 'submitting'
        ? { ...state, phase: 'complete', promptId: null, resultCode: action.code }
        : state
    case 'failure':
      return {
        ...state,
        phase: 'error',
        promptId: null,
        consentConfirmed: false,
        resultCode: action.code
      }
    case 'expired':
      return state.phase === 'complete'
        ? state
        : { ...state, phase: 'expired', promptId: null, consentConfirmed: false, resultCode: 'candidate-expired' }
    case 'back':
      return state.phase === 'consent'
        ? { ...state, phase: 'choose', selectedCandidateId: null, consentConfirmed: false }
        : state
  }
}

export function pairingRemainingSeconds(expiresAt: string | null, nowMs: number): number {
  if (!expiresAt) return 0
  const expiresAtMs = Date.parse(expiresAt)
  if (!Number.isFinite(expiresAtMs)) return 0
  return Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000))
}

export function pairingCodeDigits(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, 6)
}

/** Clear the uncontrolled DOM value while returning one transient local copy. */
export function takePairingCode(input: { value: string } | null): string | null {
  if (!input) return null
  const code = pairingCodeDigits(input.value)
  input.value = ''
  return code.length === 6 ? code : null
}

export function clearPairingCodeInput(input: { value: string } | null): void {
  if (input) input.value = ''
}
