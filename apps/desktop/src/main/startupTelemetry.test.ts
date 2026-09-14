import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sendStartupTelemetry } from './startupTelemetry'

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
  it('persists an anonymous install id and sends only the allowed production fields', async () => {
    const userData = temporaryUserData()
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requests.push({ input, init })
      return new Response(null, { status: 202 })
    }

    await sendStartupTelemetry({
      userData,
      version: '0.5.3',
      os: 'win32',
      now: new Date(2026, 8, 14, 9),
      fetch
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.input).toBe('https://pulse-api.purpleshiphub.workers.dev/api/v1/ping')
    const payload = JSON.parse(requests[0]?.init?.body as string)
    expect(payload).toEqual({
      project_id: 'pp_devhotel_a0d37c00',
      install_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      version: '0.5.3',
      os: 'win32',
      platform: 'electron'
    })
    expect(JSON.parse(readFileSync(join(userData, 'telemetry.json'), 'utf8')).installId).toBe(payload.install_id)
  })

  it('does not post twice on the same calendar day, including after a failed request', async () => {
    const userData = temporaryUserData()
    const requests: RequestInit[] = []
    const fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requests.push(init ?? {})
      throw new Error('offline')
    }
    const options = {
      userData,
      version: '0.5.3',
      os: 'linux',
      environment: 'test' as const,
      now: new Date(2026, 8, 14, 23, 59),
      fetch
    }

    await expect(sendStartupTelemetry(options)).resolves.toBeUndefined()
    await sendStartupTelemetry({ ...options, now: new Date(2026, 8, 14, 23, 59, 59) })

    expect(requests).toHaveLength(1)
    expect(JSON.parse(requests[0]?.body as string).environment).toBe('test')
  })

  it('reuses the install id on the next day', async () => {
    const userData = temporaryUserData()
    const requests: RequestInit[] = []
    const fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requests.push(init ?? {})
      return new Response(null, { status: 200 })
    }

    await sendStartupTelemetry({ userData, version: '0.5.3', os: 'darwin', now: new Date(2026, 8, 14), fetch })
    await sendStartupTelemetry({ userData, version: '0.5.3', os: 'darwin', now: new Date(2026, 8, 15), fetch })

    expect(requests).toHaveLength(2)
    const first = JSON.parse(requests[0]?.body as string)
    const second = JSON.parse(requests[1]?.body as string)
    expect(second.install_id).toBe(first.install_id)
  })
})
