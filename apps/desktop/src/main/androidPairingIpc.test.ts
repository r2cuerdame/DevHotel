import { afterEach, describe, expect, it, vi } from 'vitest'
import { AdbPairingCoordinator, type AdbHost, type AdbPairingHost } from '@devhotel/core'
import { AndroidPairingIpc, type AndroidPairingBrokerPort } from './androidPairingIpc'

const NOW = Date.parse('2026-08-31T04:00:00.000Z')
const CANDIDATE_ID = '11111111-2222-4333-8444-555555555555'
const PROMPT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const ENDPOINT = '192.0.2.44:38117'
const CODE = '918274'

afterEach(() => {
  vi.useRealTimers()
})

function setup(expiresAt = new Date(NOW + 60_000).toISOString()) {
  type DiscoveryResult = Awaited<ReturnType<AndroidPairingBrokerPort['discoverPairingCandidates']>>
  type PairResult = Awaited<ReturnType<AndroidPairingBrokerPort['pairCandidate']>>
  const discover = vi.fn(async (): Promise<DiscoveryResult> => {
    // Deliberately simulate future/private broker fields crossing a structural
    // boundary; the renderer adapter must copy only its explicit allowlist.
    const untrustedBrokerResult = {
      ok: true as const,
      code: 'candidates-ready' as const,
      generation: 1,
      candidates: [{
        id: CANDIDATE_ID,
        generation: 1,
        label: `private ${ENDPOINT}`,
        expiresAt,
        endpoint: ENDPOINT,
        pairingCode: CODE
      }],
      evidence: {
        kind: 'adb-pairing' as const,
        outcome: 'discovered' as const,
        code: 'candidates-ready' as const,
        at: `private ${ENDPOINT} ${CODE}`,
        candidateCount: 1,
        endpoint: ENDPOINT
      }
    }
    return untrustedBrokerResult as unknown as DiscoveryResult
  })
  const begin = vi.fn(() => ({
    ok: true as const,
    code: 'capture-ready' as const,
    candidateId: CANDIDATE_ID,
    generation: 1,
    evidence: {
      kind: 'adb-pairing' as const,
      outcome: 'capture-ready' as const,
      code: 'capture-ready' as const,
      at: new Date(NOW).toISOString()
    }
  }))
  const cancel = vi.fn(() => ({
    ok: true as const,
    code: 'capture-cancelled' as const,
    candidateId: CANDIDATE_ID,
    generation: 1,
    evidence: {
      kind: 'adb-pairing' as const,
      outcome: 'capture-cancelled' as const,
      code: 'capture-cancelled' as const,
      at: new Date(NOW).toISOString()
    }
  }))
  const pair = vi.fn(async (
    _candidateId: string,
    _generation: number,
    _code: string
  ): Promise<PairResult> => ({
    ok: true as const,
    code: 'paired' as const,
    candidateId: CANDIDATE_ID,
    generation: 1,
    evidence: {
      kind: 'adb-pairing' as const,
      outcome: 'paired' as const,
      code: 'paired' as const,
      at: new Date(NOW).toISOString()
    }
  }))
  const broker: AndroidPairingBrokerPort = {
    discoverPairingCandidates: discover,
    beginPairingCodeCapture: begin,
    cancelPairingCodeCapture: cancel,
    pairCandidate: pair
  }
  const promptClosed = vi.fn()
  const ipc = new AndroidPairingIpc(broker, {
    now: () => Date.now(),
    newPromptId: () => PROMPT_ID,
    onPromptClosed: promptClosed
  })
  return { ipc, discover, begin, cancel, pair, promptClosed }
}

describe('trusted Android pairing IPC', () => {
  it('whitelists opaque discovery fields and regenerates the generic label', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const { ipc } = setup()

    const result = await ipc.discover()

    expect(result).toMatchObject({
      ok: true,
      code: 'candidates-ready',
      candidates: [{ candidateId: CANDIDATE_ID, generation: 1, label: 'Wireless device 1' }]
    })
    expect(JSON.stringify(result)).not.toMatch(/192\.0\.2\.44|38117|918274|endpoint|pairingCode/)
    ipc.dispose()
  })

  it('requires an explicit begin and rejects endpoint or malformed code input before the broker', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const { ipc, begin, pair } = setup()
    await ipc.discover()

    expect(await ipc.submit({ promptId: PROMPT_ID, code: CODE })).toMatchObject({ ok: false, code: 'prompt-closed' })
    expect(ipc.begin({ candidateId: CANDIDATE_ID, generation: 1, endpoint: ENDPOINT })).toMatchObject({
      ok: false,
      code: 'candidate-unknown'
    })
    expect(begin).not.toHaveBeenCalled()

    const prompt = ipc.begin({ candidateId: CANDIDATE_ID, generation: 1 })
    expect(prompt).toMatchObject({ ok: true, code: 'capture-ready', promptId: PROMPT_ID })
    expect(JSON.stringify(prompt)).not.toContain(CANDIDATE_ID)
    expect(await ipc.submit({ promptId: PROMPT_ID, code: CODE, endpoint: ENDPOINT })).toMatchObject({
      ok: false,
      code: 'invalid-pairing-code'
    })
    expect(pair).not.toHaveBeenCalled()
    ipc.dispose()
  })

  it('fences replay and defers dismissal cleanup until an in-flight pair attempt settles', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const { ipc, pair, cancel } = setup()
    let finishPairing!: () => void
    pair.mockImplementation(async (_candidateId, _generation, _code) => {
      await new Promise<void>((resolve) => { finishPairing = resolve })
      return {
        ok: true,
        code: 'paired',
        candidateId: CANDIDATE_ID,
        generation: 1,
        evidence: {
          kind: 'adb-pairing',
          outcome: 'paired',
          code: 'paired',
          at: new Date(NOW).toISOString()
        }
      }
    })
    const discovery = await ipc.discover()
    if (!discovery.ok) throw new Error('unreachable')
    const prompt = ipc.begin({ candidateId: CANDIDATE_ID, generation: discovery.generation })
    if (!prompt.ok) throw new Error('unreachable')

    const first = ipc.submit({ promptId: prompt.promptId, code: CODE })
    await Promise.resolve()
    await expect(ipc.submit({ promptId: prompt.promptId, code: CODE })).resolves.toMatchObject({
      ok: false,
      code: 'candidate-consumed'
    })
    expect(pair).toHaveBeenCalledTimes(1)
    expect(pair).toHaveBeenCalledWith(CANDIDATE_ID, 1, CODE)
    expect(JSON.stringify(ipc)).not.toContain(CODE)
    expect(ipc.dismiss({ promptId: prompt.promptId })).toMatchObject({ ok: true, code: 'capture-cancelled' })
    expect(cancel).not.toHaveBeenCalled()

    finishPairing()
    await expect(first).resolves.toMatchObject({ ok: true, code: 'paired' })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(ipc.dismiss({ promptId: prompt.promptId })).toMatchObject({ ok: false, code: 'prompt-closed' })
  })

  it('dismisses the broker capture at prompt expiry and refuses the closed prompt', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const { ipc, cancel, pair, promptClosed } = setup(new Date(NOW + 1_000).toISOString())
    const discovery = await ipc.discover()
    if (!discovery.ok) throw new Error('unreachable')
    const prompt = ipc.begin({ candidateId: CANDIDATE_ID, generation: discovery.generation })
    if (!prompt.ok) throw new Error('unreachable')

    await vi.advanceTimersByTimeAsync(1_000)

    expect(cancel).toHaveBeenCalledWith(CANDIDATE_ID, 1)
    expect(promptClosed).toHaveBeenCalledWith({ promptId: PROMPT_ID, reason: 'expired' })
    await expect(ipc.submit({ promptId: prompt.promptId, code: CODE })).resolves.toMatchObject({
      ok: false,
      code: 'prompt-closed'
    })
    expect(pair).not.toHaveBeenCalled()
  })

  it('uses fixed failures even if a broker error tries to carry pairing material', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const { ipc, discover } = setup()
    discover.mockResolvedValueOnce({
      ok: false,
      code: 'pairing-discovery-failed',
      message: `failed at ${ENDPOINT} with ${CODE}`,
      generation: 1,
      candidates: [],
      evidence: {
        kind: 'adb-pairing',
        outcome: 'failed',
        code: 'pairing-discovery-failed',
        at: new Date(NOW).toISOString()
      }
    })

    const result = await ipc.discover()

    expect(result).toMatchObject({
      ok: false,
      code: 'pairing-discovery-failed',
      message: 'Secure ADB pairing discovery failed; retry after checking Host diagnostics locally.',
      evidence: { outcome: 'failed', code: 'pairing-discovery-failed', at: new Date(NOW).toISOString() }
    })
    expect(JSON.stringify(result)).not.toMatch(/192\.0\.2\.44|38117|918274/)
  })

  it('integrates the trusted capability with the core guard without returning endpoint or code', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const attempts: Array<{ endpoint: string; code: string }> = []
    const adb = {
      available: async () => ({ ok: true, detail: 'ok' }),
      devices: async () => [],
      exec: async () => ({ code: 0, stdout: '', stderr: '' }),
      execBinary: async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: '', outputLimitExceeded: false }),
      discoverPairingServices: async () => [{
        serviceName: 'adb-private-device._adb-tls-pairing._tcp',
        endpoint: ENDPOINT
      }],
      pairWithCode: async (endpoint: string, code: string) => {
        attempts.push({ endpoint, code })
        return { ok: true }
      }
    } satisfies AdbHost & AdbPairingHost
    const coordinator = new AdbPairingCoordinator({
      adb,
      now: () => Date.now(),
      candidateTtlMs: 60_000
    })
    const broker: AndroidPairingBrokerPort = {
      discoverPairingCandidates: () => coordinator.discover(),
      beginPairingCodeCapture: (candidateId, generation) => coordinator.beginCapture(candidateId, generation),
      cancelPairingCodeCapture: (candidateId, generation) => coordinator.cancelCapture(candidateId, generation),
      pairCandidate: (candidateId, generation, code) => coordinator.pair(candidateId, generation, code)
    }
    const ipc = new AndroidPairingIpc(broker, {
      now: () => Date.now(),
      newPromptId: () => PROMPT_ID
    })

    const discovery = await ipc.discover()
    if (!discovery.ok) throw new Error('unreachable')
    const candidate = discovery.candidates[0]!
    const prompt = ipc.begin({ candidateId: candidate.candidateId, generation: candidate.generation })
    if (!prompt.ok) throw new Error('unreachable')
    expect(coordinator.captureGuard.active).toBe(true)

    const result = await ipc.submit({ promptId: prompt.promptId, code: CODE })

    expect(result).toMatchObject({ ok: true, code: 'paired' })
    expect(attempts).toEqual([{ endpoint: ENDPOINT, code: CODE }])
    expect(JSON.stringify({ discovery, prompt, result })).not.toMatch(/192\.0\.2\.44|38117|918274|private-device/i)
    expect(ipc.dismiss({ promptId: prompt.promptId })).toMatchObject({ ok: true, code: 'capture-cancelled' })
    expect(coordinator.captureGuard.active).toBe(false)
    ipc.dispose()
    coordinator.dispose()
  })
})
