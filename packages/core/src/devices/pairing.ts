import { randomUUID } from 'node:crypto'
import type { AdbHost, AdbPairingHost, AdbPairingService } from './adbHost'
import { registerSensitiveSecrets } from '../diagnostics/redact'

export const DEFAULT_PAIRING_CANDIDATE_TTL_MS = 2 * 60 * 1000
const MAX_PAIRING_CANDIDATES = 16

export type PairingResultCode =
  | 'candidates-ready'
  | 'pairing-unavailable'
  | 'pairing-discovery-failed'
  | 'candidate-unknown'
  | 'candidate-stale'
  | 'candidate-expired'
  | 'candidate-consumed'
  | 'capture-busy'
  | 'capture-required'
  | 'capture-ready'
  | 'capture-cancelled'
  | 'invalid-pairing-code'
  | 'paired'
  | 'pairing-failed'

export interface PairingEvidence {
  kind: 'adb-pairing'
  outcome: 'discovered' | 'capture-ready' | 'capture-cancelled' | 'paired' | 'failed'
  code: PairingResultCode
  at: string
  candidateCount?: number
}

export interface OpaquePairingCandidate {
  /** Random process-local handle. It contains no service, address, port or device identity. */
  id: string
  generation: number
  label: string
  expiresAt: string
}

export type PairingDiscoveryResult =
  | {
      ok: true
      code: 'candidates-ready'
      generation: number
      candidates: OpaquePairingCandidate[]
      evidence: PairingEvidence
    }
  | {
      ok: false
      code: 'pairing-unavailable' | 'pairing-discovery-failed' | 'capture-busy'
      message: string
      generation: number
      candidates: []
      evidence: PairingEvidence
    }

export type PairingActionResult =
  | {
      ok: true
      code: 'capture-ready' | 'capture-cancelled' | 'paired'
      candidateId: string
      generation: number
      evidence: PairingEvidence
    }
  | {
      ok: false
      code: Exclude<PairingResultCode, 'candidates-ready' | 'capture-ready' | 'capture-cancelled' | 'paired'>
      message: string
      evidence: PairingEvidence
    }

const FIXED_FAILURES: Record<Extract<PairingActionResult, { ok: false }>['code'] | 'pairing-unavailable' | 'pairing-discovery-failed', string> = {
  'pairing-unavailable': 'Secure ADB pairing is unavailable on this Host.',
  'pairing-discovery-failed': 'Secure ADB pairing discovery failed; retry after checking Host diagnostics locally.',
  'candidate-unknown': 'The pairing candidate is not available.',
  'candidate-stale': 'The pairing candidate belongs to an older discovery generation.',
  'candidate-expired': 'The pairing candidate expired. Discover candidates again.',
  'candidate-consumed': 'The pairing candidate was already used. Discover candidates again.',
  'capture-busy': 'Another capture is already in progress. Try again after it finishes.',
  'capture-required': 'Open the trusted pairing code prompt before submitting a pairing code.',
  'invalid-pairing-code': 'The pairing code must contain exactly six digits.',
  'pairing-failed': 'Secure ADB pairing failed. Reopen the device pairing prompt and try again.'
}

type CandidateState = 'available' | 'capturing' | 'consumed' | 'expired'

interface InternalCandidate {
  id: string
  generation: number
  ordinal: number
  expiresAtMs: number
  state: CandidateState
  endpoint: string | null
  releaseSecrets: (() => void) | null
  releasePairingCode: (() => void) | null
  releaseCapture: (() => void) | null
}

/** Blocks pixel/binary capture while a short-lived pairing secret is visible. */
export class SensitiveCaptureGuard {
  private readonly sensitivePermits = new Set<symbol>()
  private readonly ordinaryPermits = new Set<symbol>()

  beginSensitive(): (() => void) | null {
    if (this.ordinaryPermits.size > 0 || this.sensitivePermits.size > 0) return null
    const permit = Symbol('sensitive-pairing-capture')
    this.sensitivePermits.add(permit)
    let released = false
    return () => {
      if (released) return
      released = true
      this.sensitivePermits.delete(permit)
    }
  }

  beginOrdinaryCapture(): () => void {
    this.assertCaptureAllowed()
    const permit = Symbol('ordinary-capture')
    this.ordinaryPermits.add(permit)
    let released = false
    return () => {
      if (released) return
      released = true
      this.ordinaryPermits.delete(permit)
    }
  }

  get active(): boolean {
    return this.sensitivePermits.size > 0
  }

  assertCaptureAllowed(): void {
    if (this.active) {
      throw new Error('Capture is temporarily disabled while an ADB pairing code is visible.')
    }
  }
}

export interface AdbPairingCoordinatorOptions {
  adb: AdbHost
  now?: () => number
  candidateTtlMs?: number
  captureGuard?: SensitiveCaptureGuard
}

/**
 * Process-local wireless-pairing state. Endpoints and service names never
 * leave this object, and every candidate is tied to one discovery generation.
 */
export class AdbPairingCoordinator {
  private readonly pairingAdb: Partial<AdbPairingHost>
  private readonly now: () => number
  private readonly candidateTtlMs: number
  readonly captureGuard: SensitiveCaptureGuard
  private generation = 0
  private readonly candidates = new Map<string, InternalCandidate>()
  private discoveryInFlight: Promise<PairingDiscoveryResult> | null = null
  private expiryTimer: NodeJS.Timeout | null = null

  constructor(opts: AdbPairingCoordinatorOptions) {
    this.pairingAdb = opts.adb as AdbHost & Partial<AdbPairingHost>
    this.now = opts.now ?? (() => Date.now())
    this.candidateTtlMs = opts.candidateTtlMs ?? DEFAULT_PAIRING_CANDIDATE_TTL_MS
    if (!Number.isFinite(this.candidateTtlMs) || this.candidateTtlMs <= 0 || this.candidateTtlMs > 10 * 60 * 1000) {
      throw new Error('pairing candidate TTL must be between 1ms and 10min')
    }
    this.captureGuard = opts.captureGuard ?? new SensitiveCaptureGuard()
  }

  discover(): Promise<PairingDiscoveryResult> {
    this.expireCandidates()
    // A rediscovery must not invalidate the candidate that owns a visible
    // pairing prompt: doing so would release both its capture guard and exact
    // secret registrations before the trusted UI has cleared the code field.
    if (this.captureGuard.active) {
      return Promise.resolve(this.discoveryFailure('capture-busy', this.generation, this.at()))
    }
    if (this.discoveryInFlight) return this.discoveryInFlight
    const pending = this.discoverOnce()
    this.discoveryInFlight = pending
    return pending.finally(() => {
      if (this.discoveryInFlight === pending) this.discoveryInFlight = null
    })
  }

  private async discoverOnce(): Promise<PairingDiscoveryResult> {
    this.invalidateCandidates()
    const generation = ++this.generation
    const at = this.at()
    if (!this.pairingAdb.discoverPairingServices || !this.pairingAdb.pairWithCode) {
      return this.discoveryFailure('pairing-unavailable', generation, at)
    }

    let services: AdbPairingService[]
    try {
      services = await this.pairingAdb.discoverPairingServices()
    } catch {
      return this.discoveryFailure('pairing-discovery-failed', generation, at)
    }

    const expiresAtMs = this.now() + this.candidateTtlMs
    for (const [index, service] of services.slice(0, MAX_PAIRING_CANDIDATES).entries()) {
      const id = randomUUID()
      this.candidates.set(id, {
        id,
        generation,
        ordinal: index + 1,
        expiresAtMs,
        state: 'available',
        endpoint: service.endpoint,
        // The service name is untrusted LAN input and is not needed after
        // discovery. Registering it globally could let an advertiser suppress
        // common diagnostic words. The endpoint has a strict IPv4:port shape;
        // raw mDNS rows are separately protected by contextual redaction.
        releaseSecrets: registerSensitiveSecrets([service.endpoint]),
        releasePairingCode: null,
        releaseCapture: null
      })
    }
    this.armExpiryTimer()
    const candidates = [...this.candidates.values()].map((candidate) => this.publicCandidate(candidate))
    return {
      ok: true,
      code: 'candidates-ready',
      generation,
      candidates,
      evidence: { kind: 'adb-pairing', outcome: 'discovered', code: 'candidates-ready', at, candidateCount: candidates.length }
    }
  }

  beginCapture(candidateId: string, generation: number): PairingActionResult {
    this.expireCandidates()
    const candidate = this.candidate(candidateId, generation)
    if (!candidate.ok) return candidate.result
    if (candidate.value.state === 'capturing') {
      return this.success('capture-ready', candidate.value, 'capture-ready')
    }
    if (this.captureGuard.active) return this.failure('capture-busy')
    const releaseCapture = this.captureGuard.beginSensitive()
    if (!releaseCapture) return this.failure('capture-busy')
    candidate.value.state = 'capturing'
    candidate.value.releaseCapture = releaseCapture
    return this.success('capture-ready', candidate.value, 'capture-ready')
  }

  cancelCapture(candidateId: string, generation: number): PairingActionResult {
    this.expireCandidates()
    if (generation !== this.generation) return this.failure('candidate-stale')
    const candidate = this.candidates.get(candidateId)
    if (!candidate) return this.failure('candidate-unknown')
    if (candidate.state === 'expired') return this.failure('candidate-expired')
    this.releaseCapture(candidate)
    candidate.state = 'consumed'
    this.clearCandidateSecrets(candidate)
    this.armExpiryTimer()
    return this.success('capture-cancelled', candidate, 'capture-cancelled')
  }

  async pair(candidateId: string, generation: number, pairingCode: string): Promise<PairingActionResult> {
    this.expireCandidates()
    const found = this.candidate(candidateId, generation)
    if (!found.ok) return found.result
    const candidate = found.value
    if (candidate.state !== 'capturing') return this.failure('capture-required')
    if (!/^\d{6}$/.test(pairingCode)) return this.failure('invalid-pairing-code')
    const endpoint = candidate.endpoint
    if (!endpoint || !this.pairingAdb.pairWithCode) return this.failure('pairing-failed')

    // Consume before the await so two trusted UI events cannot race one code.
    candidate.state = 'consumed'
    candidate.expiresAtMs = this.now() + this.candidateTtlMs
    this.armExpiryTimer()
    candidate.releasePairingCode = registerSensitiveSecrets([pairingCode])
    let paired = false
    try {
      paired = (await this.pairingAdb.pairWithCode(endpoint, pairingCode)).ok
    } catch {
      paired = false
    } finally {
      this.clearCandidateSecrets(candidate, false)
      // Keep the pixel-capture guard until the trusted UI explicitly clears
      // and dismisses its code field. TTL/dispose remains the crash fallback.
      this.armExpiryTimer()
    }
    return paired
      ? this.success('paired', candidate, 'paired')
      : this.failure('pairing-failed')
  }

  get captureActive(): boolean {
    this.expireCandidates()
    return this.captureGuard.active
  }

  assertCaptureAllowed(): void {
    this.expireCandidates()
    this.captureGuard.assertCaptureAllowed()
  }

  beginOrdinaryCapture(): () => void {
    this.expireCandidates()
    return this.captureGuard.beginOrdinaryCapture()
  }

  dispose(): void {
    this.invalidateCandidates()
  }

  private candidate(
    candidateId: string,
    generation: number
  ): { ok: true; value: InternalCandidate } | { ok: false; result: PairingActionResult } {
    if (generation !== this.generation) return { ok: false, result: this.failure('candidate-stale') }
    const candidate = this.candidates.get(candidateId)
    if (!candidate) return { ok: false, result: this.failure('candidate-unknown') }
    if (candidate.state === 'expired') return { ok: false, result: this.failure('candidate-expired') }
    if (candidate.state === 'consumed') return { ok: false, result: this.failure('candidate-consumed') }
    return { ok: true, value: candidate }
  }

  private expireCandidates(): void {
    const now = this.now()
    for (const candidate of this.candidates.values()) {
      if (candidate.state !== 'expired' && now >= candidate.expiresAtMs) {
        candidate.state = 'expired'
        this.releaseCapture(candidate)
        this.clearCandidateSecrets(candidate)
      }
    }
    this.armExpiryTimer()
  }

  private invalidateCandidates(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer)
    this.expiryTimer = null
    for (const candidate of this.candidates.values()) {
      this.releaseCapture(candidate)
      this.clearCandidateSecrets(candidate)
    }
    this.candidates.clear()
  }

  private armExpiryTimer(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer)
    this.expiryTimer = null
    const active = [...this.candidates.values()].filter(
      (candidate) => candidate.state === 'available' || candidate.state === 'capturing' || candidate.releaseCapture !== null
    )
    if (active.length === 0) return
    const nextExpiry = Math.min(...active.map((candidate) => candidate.expiresAtMs))
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null
      this.expireCandidates()
    }, Math.max(1, nextExpiry - this.now()))
    this.expiryTimer.unref?.()
  }

  private releaseCapture(candidate: InternalCandidate): void {
    candidate.releaseCapture?.()
    candidate.releaseCapture = null
  }

  private clearCandidateSecrets(candidate: InternalCandidate, includePairingCode = true): void {
    candidate.releaseSecrets?.()
    candidate.releaseSecrets = null
    if (includePairingCode) {
      candidate.releasePairingCode?.()
      candidate.releasePairingCode = null
    }
    candidate.endpoint = null
  }

  private publicCandidate(candidate: InternalCandidate): OpaquePairingCandidate {
    return {
      id: candidate.id,
      generation: candidate.generation,
      label: `Wireless device ${candidate.ordinal}`,
      expiresAt: new Date(candidate.expiresAtMs).toISOString()
    }
  }

  private discoveryFailure(
    code: 'pairing-unavailable' | 'pairing-discovery-failed' | 'capture-busy',
    generation: number,
    at: string
  ): PairingDiscoveryResult {
    return {
      ok: false,
      code,
      message: FIXED_FAILURES[code],
      generation,
      candidates: [],
      evidence: { kind: 'adb-pairing', outcome: 'failed', code, at }
    }
  }

  private success(
    code: 'capture-ready' | 'capture-cancelled' | 'paired',
    candidate: InternalCandidate,
    outcome: 'capture-ready' | 'capture-cancelled' | 'paired'
  ): PairingActionResult {
    return {
      ok: true,
      code,
      candidateId: candidate.id,
      generation: candidate.generation,
      evidence: { kind: 'adb-pairing', outcome, code, at: this.at() }
    }
  }

  private failure(
    code: Extract<PairingActionResult, { ok: false }>['code']
  ): PairingActionResult {
    return {
      ok: false,
      code,
      message: FIXED_FAILURES[code],
      evidence: { kind: 'adb-pairing', outcome: 'failed', code, at: this.at() }
    }
  }

  private at(): string {
    return new Date(this.now()).toISOString()
  }
}
