import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AdbHost } from '../devices/adbHost'
import { AndroidDeviceBroker } from '../devices/broker'
import { AdbPairingCoordinator } from '../devices/pairing'
import { redactSecrets } from '../diagnostics/redact'
import { androidDevicesRepo } from '../store/androidDevicesRepo'
import { openDb } from '../store/db'
import { FakeAdbHost } from './fakes'

const dirs: string[] = []
const dbs: { close(): void }[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const db of dbs.splice(0)) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const SERVICE = 'adb-private-device-Qx9._adb-tls-pairing._tcp'
const ENDPOINT = '192.0.2.44:38117'
const CODE = '918274'

function pairingAdb(): FakeAdbHost {
  const adb = new FakeAdbHost()
  adb.pairingServices = [{ serviceName: SERVICE, endpoint: ENDPOINT }]
  return adb
}

describe('opaque, process-local pairing candidates', () => {
  it('returns only a UUID, generation, expiry and generic label', async () => {
    const coordinator = new AdbPairingCoordinator({
      adb: pairingAdb(),
      now: () => Date.parse('2026-08-31T02:00:00.000Z'),
      candidateTtlMs: 60_000
    })

    const result = await coordinator.discover()

    expect(result).toMatchObject({
      ok: true,
      code: 'candidates-ready',
      generation: 1,
      candidates: [{ generation: 1, label: 'Wireless device 1', expiresAt: '2026-08-31T02:01:00.000Z' }],
      evidence: { kind: 'adb-pairing', outcome: 'discovered', candidateCount: 1 }
    })
    if (!result.ok) throw new Error('unreachable')
    expect(result.candidates[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(JSON.stringify(result)).not.toMatch(/192\.0\.2\.44|38117|private-device|_adb-tls-pairing/i)
    coordinator.dispose()
  })

  it('expires captures, invalidates old generations, and never accepts an endpoint from the caller', async () => {
    const now = { value: Date.parse('2026-08-31T02:00:00.000Z') }
    const adb = pairingAdb()
    const coordinator = new AdbPairingCoordinator({ adb, now: () => now.value, candidateTtlMs: 1_000 })
    const first = await coordinator.discover()
    if (!first.ok) throw new Error('unreachable')
    const candidate = first.candidates[0]!

    expect(coordinator.beginCapture(candidate.id, first.generation).code).toBe('capture-ready')
    expect(coordinator.captureActive).toBe(true)
    now.value += 1_000
    expect(coordinator.captureActive).toBe(false)
    expect((await coordinator.pair(candidate.id, first.generation, CODE)).code).toBe('candidate-expired')
    expect(adb.pairingAttempts).toEqual([])

    const second = await coordinator.discover()
    expect(second.generation).toBe(2)
    expect(coordinator.beginCapture(candidate.id, first.generation).code).toBe('candidate-stale')
    expect((await coordinator.pair(ENDPOINT, second.generation, CODE)).code).toBe('candidate-unknown')
    if (!second.ok) throw new Error('unreachable')
    const replacement = second.candidates[0]!
    expect(coordinator.beginCapture(replacement.id, second.generation).code).toBe('capture-ready')
    expect(coordinator.cancelCapture(replacement.id, second.generation).code).toBe('capture-cancelled')
    expect(coordinator.beginCapture(replacement.id, second.generation).code).toBe('candidate-consumed')
    expect(adb.pairingAttempts).toEqual([])
    coordinator.dispose()
  })

  it('releases the sensitive-capture guard and exact secrets on the TTL timer without another call', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-31T02:00:00.000Z'))
    const coordinator = new AdbPairingCoordinator({ adb: pairingAdb(), candidateTtlMs: 1_000 })
    const discovery = await coordinator.discover()
    if (!discovery.ok) throw new Error('unreachable')
    const candidate = discovery.candidates[0]!
    coordinator.beginCapture(candidate.id, discovery.generation)
    expect(coordinator.captureGuard.active).toBe(true)
    expect(redactSecrets(`trace ${ENDPOINT}`)).toBe('trace •••')

    await vi.advanceTimersByTimeAsync(1_000)

    expect(coordinator.captureGuard.active).toBe(false)
    expect(redactSecrets(`trace ${ENDPOINT}`)).toBe(`trace ${ENDPOINT}`)
    coordinator.dispose()
  })

  it('does not let an untrusted service name suppress ordinary diagnostics', async () => {
    const adb = pairingAdb()
    adb.pairingServices = [{ serviceName: 'failed', endpoint: ENDPOINT }]
    const coordinator = new AdbPairingCoordinator({ adb })

    await coordinator.discover()

    expect(redactSecrets(`build failed while probing ${ENDPOINT}`)).toBe('build failed while probing •••')
    coordinator.dispose()
  })

  it('does not let a pairing prompt race an already-started screenshot permit', async () => {
    const coordinator = new AdbPairingCoordinator({ adb: pairingAdb() })
    const discovery = await coordinator.discover()
    if (!discovery.ok) throw new Error('unreachable')
    const candidate = discovery.candidates[0]!
    const releaseScreenshot = coordinator.beginOrdinaryCapture()

    expect(coordinator.beginCapture(candidate.id, discovery.generation)).toMatchObject({
      ok: false,
      code: 'capture-busy'
    })
    expect(coordinator.captureGuard.active).toBe(false)

    releaseScreenshot()
    expect(coordinator.beginCapture(candidate.id, discovery.generation).code).toBe('capture-ready')
    coordinator.cancelCapture(candidate.id, discovery.generation)
    coordinator.dispose()
  })

  it('does not let rediscovery release a visible prompt capture guard or its secrets', async () => {
    const adb = pairingAdb()
    const coordinator = new AdbPairingCoordinator({ adb })
    const discovery = await coordinator.discover()
    if (!discovery.ok) throw new Error('unreachable')
    const candidate = discovery.candidates[0]!
    coordinator.beginCapture(candidate.id, discovery.generation)

    await expect(coordinator.discover()).resolves.toMatchObject({
      ok: false,
      code: 'capture-busy',
      generation: discovery.generation,
      candidates: []
    })
    expect(coordinator.captureGuard.active).toBe(true)
    expect(redactSecrets(`trace ${SERVICE} at ${ENDPOINT}`)).toBe(`trace ${SERVICE} at •••`)
    await expect(coordinator.pair(candidate.id, discovery.generation, CODE)).resolves.toMatchObject({
      ok: true,
      code: 'paired'
    })
    expect(coordinator.cancelCapture(candidate.id, discovery.generation).code).toBe('capture-cancelled')
    coordinator.dispose()
  })

  it('consumes a candidate before awaiting adb so a concurrent replay cannot race', async () => {
    const adb = pairingAdb()
    let finishPairing!: () => void
    const pairingFinished = new Promise<void>((resolve) => {
      finishPairing = resolve
    })
    adb.pairWithCode = async (endpoint, pairingCode) => {
      adb.pairingAttempts.push({ endpoint, pairingCode })
      await pairingFinished
      return { ok: true }
    }
    const coordinator = new AdbPairingCoordinator({ adb })
    const discovery = await coordinator.discover()
    if (!discovery.ok) throw new Error('unreachable')
    const candidate = discovery.candidates[0]!
    coordinator.beginCapture(candidate.id, discovery.generation)

    const first = coordinator.pair(candidate.id, discovery.generation, CODE)
    const replay = await coordinator.pair(candidate.id, discovery.generation, CODE)
    expect(replay.code).toBe('candidate-consumed')
    expect(adb.pairingAttempts).toEqual([{ endpoint: ENDPOINT, pairingCode: CODE }])

    finishPairing()
    await expect(first).resolves.toMatchObject({ ok: true, code: 'paired' })
    expect(coordinator.captureGuard.active).toBe(true)
    expect((await coordinator.pair(candidate.id, discovery.generation, CODE)).code).toBe('candidate-consumed')
    expect(coordinator.cancelCapture(candidate.id, discovery.generation).code).toBe('capture-cancelled')
    expect(coordinator.captureGuard.active).toBe(false)
    coordinator.dispose()
  })

  it('fails closed with fixed contracts when the Host has no pairing primitive or emits private errors', async () => {
    const unavailable = new AdbPairingCoordinator({
      adb: {
        available: async () => ({ ok: true, detail: 'ok' }),
        devices: async () => [],
        exec: async () => ({ code: 0, stdout: '', stderr: '' }),
        execBinary: async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: '', outputLimitExceeded: false })
      } satisfies AdbHost
    })
    await expect(unavailable.discover()).resolves.toMatchObject({
      ok: false,
      code: 'pairing-unavailable',
      message: 'Secure ADB pairing is unavailable on this Host.'
    })
    unavailable.dispose()

    const adb = pairingAdb()
    adb.pairingDiscoveryError = new Error(`failed at ${ENDPOINT} with ${CODE}`)
    const failedCoordinator = new AdbPairingCoordinator({ adb })
    const failed = await failedCoordinator.discover()
    expect(failed).toMatchObject({ ok: false, code: 'pairing-discovery-failed' })
    expect(JSON.stringify(failed)).not.toMatch(/192\.0\.2\.44|38117|918274/)
    failedCoordinator.dispose()
  })
})

describe('pairing evidence does not retain pairing material', () => {
  it('persists only fixed success evidence and central redaction protects live sinks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devhotel-pairing-db-'))
    dirs.push(dir)
    const db = openDb(dir)
    dbs.push(db)
    const adb = pairingAdb()
    const broker = new AndroidDeviceBroker({ repo: androidDevicesRepo(db), adb })
    const discovery = await broker.discoverPairingCandidates()
    if (!discovery.ok) throw new Error('unreachable')
    const candidate = discovery.candidates[0]!

    // Exact candidate material is centrally protected for the whole lifetime.
    expect(redactSecrets(`probe endpoint ${ENDPOINT}`)).toBe('probe endpoint •••')
    expect(broker.beginPairingCodeCapture(candidate.id, discovery.generation).code).toBe('capture-ready')
    const result = await broker.pairCandidate(candidate.id, discovery.generation, CODE)

    expect(result).toMatchObject({ ok: true, code: 'paired', evidence: { outcome: 'paired' } })
    expect(JSON.stringify(result)).not.toMatch(/192\.0\.2\.44|38117|918274|private-device/i)
    expect(broker.sensitivePairingCaptureActive).toBe(true)
    expect(redactSecrets(`raw ${CODE}`)).toBe('raw •••')
    expect(broker.cancelPairingCodeCapture(candidate.id, discovery.generation).code).toBe('capture-cancelled')
    expect(broker.sensitivePairingCaptureActive).toBe(false)
    expect(redactSecrets(`raw ${CODE}`)).toBe(`raw ${CODE}`)
    expect(broker.status().recentEvents[0]).toMatchObject({
      deviceId: null,
      roomId: null,
      kind: 'pairing-succeeded',
      detail: 'Secure wireless Android pairing succeeded'
    })

    db.close()
    dbs.splice(dbs.indexOf(db), 1)
    const persisted = readdirSync(dir)
      .map((name) => readFileSync(join(dir, name)))
      .map((bytes) => bytes.toString('utf8'))
      .join('\n')
    expect(persisted).not.toContain(SERVICE)
    expect(persisted).not.toContain(ENDPOINT)
    expect(persisted).not.toContain(CODE)
  })
})
