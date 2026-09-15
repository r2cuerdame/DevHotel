import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeTelemetryOs, sendStartupTelemetry } from './startupTelemetry'

const directories: string[] = []

function temporaryUserData(): string {
  const directory = mkdtempSync(join(tmpdir(), 'devhotel-telemetry-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('startup telemetry', () => {
  it.each([
    ['win32', 'windows'],
    ['darwin', 'macos'],
    ['linux', 'linux'],
    ['FreeBSD', 'freebsd']
  ])('normalizes the OS platform %s to %s', (platform, expected) => {
    expect(normalizeTelemetryOs(platform)).toBe(expected)
  })

  it('persists the install id and sends the v2 production payload', async () => {
    const userData = temporaryUserData()
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requests.push({ input, init })
      return new Response(null, { status: 202 })
    }

    await sendStartupTelemetry({
      userData,
      version: '0.5.4',
      os: 'win32',
      now: new Date('2026-09-14T23:30:00-07:00'),
      fetch
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.input).toBe('https://pulse-api.purpleshiphub.workers.dev/api/v1/ping')
    const payload = JSON.parse(requests[0]?.init?.body as string)
    expect(payload).toEqual({
      project_id: 'pp_devhotel_a0d37c00',
      install_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      version: '0.5.4',
      os: 'windows',
      platform: 'electron',
      schema_version: 2
    })
    const state = JSON.parse(readFileSync(join(userData, 'telemetry.json'), 'utf8'))
    expect(state.installId).toBe(payload.install_id)
    expect(state.lastAttemptDate).toBe('2026-09-15')
    expect(payload).not.toHaveProperty('environment')
  })

  it('uses the UTC date boundary and suppresses duplicate attempts within one UTC day', async () => {
    const userData = temporaryUserData()
    const requests: RequestInit[] = []
    const fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requests.push(init ?? {})
      return new Response(null, { status: 200 })
    }

    const base = {
      userData,
      version: '0.5.4',
      os: 'linux',
      environment: 'test' as const,
      fetch
    }
    await sendStartupTelemetry({ ...base, now: new Date('2026-09-14T23:59:00Z') })
    await sendStartupTelemetry({ ...base, now: new Date('2026-09-14T23:59:59Z') })
    await sendStartupTelemetry({ ...base, now: new Date('2026-09-15T00:00:01Z') })

    expect(requests).toHaveLength(2)
    expect(JSON.parse(requests[0]?.body as string).environment).toBe('test')
    expect(JSON.parse(requests[1]?.body as string).environment).toBe('test')
  })

  it('does not retry again on the same UTC day after a failed request', async () => {
    const userData = temporaryUserData()
    const requests: RequestInit[] = []
    const fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requests.push(init ?? {})
      throw new Error('offline')
    }

    const options = {
      userData,
      version: '0.5.4',
      os: 'linux',
      environment: 'test' as const,
      now: new Date('2026-09-15T12:00:00Z'),
      fetch
    }

    await expect(sendStartupTelemetry(options)).resolves.toBeUndefined()
    await sendStartupTelemetry({ ...options, now: new Date('2026-09-15T23:59:59Z') })
    expect(requests).toHaveLength(1)
  })

  it('reuses v1 install id and stored date when upgrading to v2', async () => {
    const userData = temporaryUserData()
    const statePath = join(userData, 'telemetry.json')
    const installId = '11111111-1111-4111-8111-111111111111'
    writeFileSync(statePath, JSON.stringify({ installId, lastAttemptDate: '2026-09-14' }))
    const requests: RequestInit[] = []
    const fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requests.push(init ?? {})
      return new Response(null, { status: 202 })
    }

    await sendStartupTelemetry({
      userData,
      version: '0.5.4',
      os: 'win32',
      environment: 'test',
      now: new Date('2026-09-15T01:00:00Z'),
      fetch
    })

    const payload = JSON.parse(requests[0]?.body as string)
    expect(payload.install_id).toBe(installId)
    expect(payload.schema_version).toBe(2)
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    expect(state.installId).toBe(installId)
    expect(state.lastAttemptDate).toBe('2026-09-15')
  })
})
