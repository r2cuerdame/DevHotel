import { randomUUID } from 'node:crypto'
import type {
  AndroidDeviceBroker,
  PairingActionResult,
  PairingDiscoveryResult
} from '@devhotel/core'
import {
  zAndroidPairingCandidateRef,
  zAndroidPairingCodeSubmission,
  zAndroidPairingPromptRef,
  type AndroidPairingUiCompletionResult,
  type AndroidPairingUiDiscoveryResult,
  type AndroidPairingUiDismissResult,
  type AndroidPairingUiEvidence,
  type AndroidPairingUiFailure,
  type AndroidPairingPromptClosedEvent,
  type AndroidPairingUiPromptResult
} from '@devhotel/shared'

export type AndroidPairingBrokerPort = Pick<
  AndroidDeviceBroker,
  | 'discoverPairingCandidates'
  | 'beginPairingCodeCapture'
  | 'cancelPairingCodeCapture'
  | 'pairCandidate'
>

interface KnownCandidate {
  candidateId: string
  generation: number
  expiresAt: string
  expiresAtMs: number
}

interface PromptSession extends KnownCandidate {
  promptId: string
  submitted: boolean
  settled: boolean
  closeRequested: boolean
  timer: NodeJS.Timeout
}

export interface AndroidPairingIpcOptions {
  now?: () => number
  newPromptId?: () => string
  onPromptClosed?: (event: AndroidPairingPromptClosedEvent) => void
}

const FIXED_UI_FAILURES: Record<AndroidPairingUiFailure['code'], string> = {
  'pairing-unavailable': 'Secure ADB pairing is unavailable on this Host.',
  'pairing-discovery-failed': 'Secure ADB pairing discovery failed; retry after checking Host diagnostics locally.',
  'candidate-unknown': 'The pairing candidate is not available.',
  'candidate-stale': 'The pairing candidate belongs to an older discovery generation.',
  'candidate-expired': 'The pairing candidate expired. Discover candidates again.',
  'candidate-consumed': 'The pairing candidate was already used. Discover candidates again.',
  'capture-busy': 'Another capture is already in progress. Try again after it finishes.',
  'capture-required': 'Open the trusted pairing code prompt before submitting a pairing code.',
  'invalid-pairing-code': 'The pairing code must contain exactly six digits.',
  'pairing-failed': 'Secure ADB pairing failed. Reopen the device pairing prompt and try again.',
  'prompt-closed': 'The secure pairing prompt is no longer active.'
}

function evidenceForRenderer(
  code: AndroidPairingUiEvidence['code'],
  outcome: AndroidPairingUiEvidence['outcome'],
  now: () => number,
  candidateCount?: number
): AndroidPairingUiEvidence {
  const nowMs = now()
  return {
    kind: 'adb-pairing',
    outcome,
    code,
    at: new Date(Number.isFinite(nowMs) ? nowMs : 0).toISOString(),
    ...(candidateCount === undefined ? {} : { candidateCount })
  }
}

function failureForRenderer(
  result: Extract<PairingActionResult, { ok: false }> | Extract<PairingDiscoveryResult, { ok: false }>,
  now: () => number
): AndroidPairingUiFailure {
  const code = Object.prototype.hasOwnProperty.call(FIXED_UI_FAILURES, result.code)
    ? result.code
    : 'pairing-failed'
  return {
    ok: false,
    code,
    message: FIXED_UI_FAILURES[code],
    evidence: evidenceForRenderer(code, 'failed', now)
  }
}

/**
 * Trusted main-frame adapter for the renderer consent prompt.
 *
 * The adapter creates a second opaque, prompt-scoped capability and explicitly
 * copies every outbound field. That prevents a future private broker field
 * from accidentally crossing IPC. It stores candidate/prompt UUIDs and expiry
 * only; endpoints and pairing codes are never retained here.
 */
export class AndroidPairingIpc {
  private readonly now: () => number
  private readonly newPromptId: () => string
  private readonly onPromptClosed: (event: AndroidPairingPromptClosedEvent) => void
  private readonly knownCandidates = new Map<string, KnownCandidate>()
  private prompt: PromptSession | null = null

  constructor(
    private readonly broker: AndroidPairingBrokerPort,
    opts: AndroidPairingIpcOptions = {}
  ) {
    this.now = opts.now ?? (() => Date.now())
    this.newPromptId = opts.newPromptId ?? randomUUID
    this.onPromptClosed = opts.onPromptClosed ?? (() => undefined)
  }

  async discover(): Promise<AndroidPairingUiDiscoveryResult> {
    try {
      const result = await this.broker.discoverPairingCandidates()
      if (!result.ok) {
        // capture-busy deliberately preserves the current prompt generation.
        if (result.code !== 'capture-busy') this.knownCandidates.clear()
        return failureForRenderer(result, this.now)
      }

      this.knownCandidates.clear()
      const candidates = result.candidates.flatMap((candidate, index) => {
        const parsedRef = zAndroidPairingCandidateRef.safeParse({
          candidateId: candidate.id,
          generation: candidate.generation
        })
        const expiresAtMs = Date.parse(candidate.expiresAt)
        if (!parsedRef.success || !Number.isFinite(expiresAtMs)) return []
        const expiresAt = new Date(expiresAtMs).toISOString()
        const safe = {
          candidateId: candidate.id,
          generation: candidate.generation,
          label: `Wireless device ${index + 1}`,
          expiresAt
        }
        this.knownCandidates.set(candidate.id, {
          ...safe,
          expiresAtMs
        })
        return [safe]
      })
      return {
        ok: true,
        code: 'candidates-ready',
        generation: result.generation,
        candidates,
        evidence: evidenceForRenderer('candidates-ready', 'discovered', this.now, candidates.length)
      }
    } catch {
      this.knownCandidates.clear()
      return this.failure('pairing-discovery-failed')
    }
  }

  begin(raw: unknown): AndroidPairingUiPromptResult {
    const parsed = zAndroidPairingCandidateRef.safeParse(raw)
    if (!parsed.success) return this.failure('candidate-unknown')
    this.expirePromptIfNeeded()
    if (this.prompt) return this.failure('capture-busy')

    const candidate = this.knownCandidates.get(parsed.data.candidateId)
    if (!candidate) return this.failure('candidate-unknown')
    if (candidate.generation !== parsed.data.generation) return this.failure('candidate-stale')
    if (!Number.isFinite(candidate.expiresAtMs) || this.now() >= candidate.expiresAtMs) {
      return this.failure('candidate-expired')
    }

    let result: PairingActionResult
    try {
      result = this.broker.beginPairingCodeCapture(candidate.candidateId, candidate.generation)
    } catch {
      return this.failure('capture-busy')
    }
    if (!result.ok) return failureForRenderer(result, this.now)
    if (result.code !== 'capture-ready') return this.failure('capture-busy')

    let promptId: string
    try {
      const parsedPrompt = zAndroidPairingPromptRef.safeParse({ promptId: this.newPromptId() })
      if (!parsedPrompt.success) throw new Error('invalid prompt capability')
      promptId = parsedPrompt.data.promptId
    } catch {
      try {
        this.broker.cancelPairingCodeCapture(candidate.candidateId, candidate.generation)
      } catch {
        // The core TTL remains the final fail-closed cleanup path.
      }
      return this.failure('capture-busy')
    }
    const delayMs = Math.max(1, candidate.expiresAtMs - this.now())
    const timer = setTimeout(() => this.timeoutPrompt(promptId, 'expired'), delayMs)
    timer.unref?.()
    this.prompt = {
      ...candidate,
      promptId,
      submitted: false,
      settled: false,
      closeRequested: false,
      timer
    }
    return {
      ok: true,
      code: 'capture-ready',
      promptId,
      expiresAt: candidate.expiresAt,
      evidence: evidenceForRenderer('capture-ready', 'capture-ready', this.now)
    }
  }

  async submit(raw: unknown): Promise<AndroidPairingUiCompletionResult> {
    const parsed = zAndroidPairingCodeSubmission.safeParse(raw)
    if (!parsed.success) {
      const candidatePrompt = zAndroidPairingPromptRef.safeParse({
        promptId: typeof raw === 'object' && raw !== null ? (raw as { promptId?: unknown }).promptId : undefined
      })
      return this.failure(candidatePrompt.success ? 'invalid-pairing-code' : 'prompt-closed')
    }

    this.expirePromptIfNeeded()
    const prompt = this.prompt
    if (!prompt || prompt.promptId !== parsed.data.promptId) return this.failure('prompt-closed')
    if (prompt.submitted) return this.failure('candidate-consumed')
    // Fence replay before the await, independently of the broker's own
    // consume-before-await guarantee.
    prompt.submitted = true

    try {
      const result = await this.broker.pairCandidate(prompt.candidateId, prompt.generation, parsed.data.code)
      if (!result.ok) return failureForRenderer(result, this.now)
      if (result.code !== 'paired') return this.failure('pairing-failed')
      return { ok: true, code: 'paired', evidence: evidenceForRenderer('paired', 'paired', this.now) }
    } catch {
      return this.failure('pairing-failed')
    } finally {
      prompt.settled = true
      if (prompt.closeRequested && this.prompt === prompt) this.cancelAndTakePrompt(prompt.promptId)
    }
  }

  dismiss(raw: unknown): AndroidPairingUiDismissResult {
    const parsed = zAndroidPairingPromptRef.safeParse(raw)
    if (!parsed.success) return this.failure('prompt-closed')
    const active = this.prompt
    if (!active || active.promptId !== parsed.data.promptId) return this.failure('prompt-closed')
    if (active.submitted && !active.settled) {
      // The renderer clears/unmounts immediately, but do not drop the core
      // capture/redaction guard while `adb pair` can still be running. Its
      // completion (or the core TTL fallback) performs the actual release.
      active.closeRequested = true
      this.knownCandidates.delete(active.candidateId)
      return {
        ok: true,
        code: 'capture-cancelled',
        evidence: evidenceForRenderer('capture-cancelled', 'capture-cancelled', this.now)
      }
    }
    const prompt = this.takePrompt(parsed.data.promptId)
    if (!prompt) return this.failure('prompt-closed')

    try {
      const result = this.broker.cancelPairingCodeCapture(prompt.candidateId, prompt.generation)
      if (!result.ok) return failureForRenderer(result, this.now)
      if (result.code !== 'capture-cancelled') return this.failure('prompt-closed')
      return {
        ok: true,
        code: 'capture-cancelled',
        evidence: evidenceForRenderer('capture-cancelled', 'capture-cancelled', this.now)
      }
    } catch {
      return this.failure('prompt-closed')
    }
  }

  dispose(): void {
    this.knownCandidates.clear()
    const active = this.prompt
    if (active?.submitted && !active.settled) {
      const shouldNotify = !active.closeRequested
      active.closeRequested = true
      if (shouldNotify) this.onPromptClosed({ promptId: active.promptId, reason: 'dismissed' })
      return
    }
    const prompt = this.takePrompt()
    if (!prompt) return
    try {
      this.broker.cancelPairingCodeCapture(prompt.candidateId, prompt.generation)
    } catch {
      // The broker TTL is the final fail-closed cleanup path.
    }
    this.onPromptClosed({ promptId: prompt.promptId, reason: 'dismissed' })
  }

  private expirePromptIfNeeded(): void {
    if (this.prompt && this.now() >= this.prompt.expiresAtMs) this.timeoutPrompt(this.prompt.promptId, 'expired')
  }

  private timeoutPrompt(promptId: string, reason: AndroidPairingPromptClosedEvent['reason']): void {
    const active = this.prompt
    if (active?.promptId === promptId && active.submitted && !active.settled) {
      const shouldNotify = !active.closeRequested
      active.closeRequested = true
      this.knownCandidates.delete(active.candidateId)
      if (shouldNotify) this.onPromptClosed({ promptId, reason })
      return
    }
    const prompt = this.takePrompt(promptId)
    if (!prompt) return
    try {
      this.broker.cancelPairingCodeCapture(prompt.candidateId, prompt.generation)
    } catch {
      // The coordinator independently releases capture and redaction on TTL.
    }
    this.onPromptClosed({ promptId, reason })
  }

  private cancelAndTakePrompt(promptId: string): void {
    const prompt = this.takePrompt(promptId)
    if (!prompt) return
    try {
      this.broker.cancelPairingCodeCapture(prompt.candidateId, prompt.generation)
    } catch {
      // The coordinator's independent TTL still clears capture and redaction.
    }
  }

  private takePrompt(promptId?: string): PromptSession | null {
    const prompt = this.prompt
    if (!prompt || (promptId !== undefined && prompt.promptId !== promptId)) return null
    this.prompt = null
    clearTimeout(prompt.timer)
    this.knownCandidates.delete(prompt.candidateId)
    return prompt
  }

  private failure(code: AndroidPairingUiFailure['code']): AndroidPairingUiFailure {
    return {
      ok: false,
      code,
      message: FIXED_UI_FAILURES[code],
      evidence: evidenceForRenderer(code, 'failed', this.now)
    }
  }
}
