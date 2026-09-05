import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlClient,
  DevHotelAmbiguousMutationError,
  DevHotelNotRunningError,
  loadControlInfo,
  resilientClient
} from '../client'
import { makeTools } from '../tools'
import { z } from 'zod'
import { MCP_METADATA } from '../metadata'

const TOKEN = 'test-token'
const RUN_ID = '11111111-2222-3333-4444-555555555555'
const OPERATION_ID = '2f1c8f5e-0d2b-4f0a-9b9e-7c4c1c3b8a11'
const RESYNC_TOKEN = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const ARTIFACT_ID = '99999999-8888-4777-8666-555555555555'
const OVERSIZED_ARTIFACT_ID = '77777777-6666-4555-8444-333333333333'
const ARTIFACT_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('directly-reviewable-png')
])
const ARTIFACT_SHA256 = createHash('sha256').update(ARTIFACT_PNG).digest('hex')
const ACCEPTANCE_REPORT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const APPLIED_CHANGE = {
  id: '11111111-2222-4333-8444-555555555555',
  roomId: 'abc12345',
  kind: 'node-version',
  status: 'verified'
}
const acceptanceResult = {
  report: {
    id: ACCEPTANCE_REPORT_ID,
    roomId: 'abc12345',
    status: 'pass',
    seal: { algorithm: 'hmac-sha256', keyVersion: 1, domain: 'report', value: 'a'.repeat(64) }
  },
  markdown: `## Android acceptance report \`${ACCEPTANCE_REPORT_ID}\`\n`
}
const artifact = {
  id: ARTIFACT_ID,
  roomId: 'abc12345',
  kind: 'android-screenshot',
  filename: 'login-success.png',
  mediaType: 'image/png',
  sizeBytes: ARTIFACT_PNG.byteLength,
  sha256: ARTIFACT_SHA256,
  actor: 'agent',
  createdAt: '2026-08-31T00:00:00.000Z',
  metadata: { schema: 1 }
}
const runningOperation = {
  id: OPERATION_ID,
  kind: 'room-start',
  roomId: 'abc12345',
  actor: 'agent',
  status: 'running',
  stage: 'container-start',
  stages: [],
  error: null,
  startedAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:00:00.000Z',
  finishedAt: null
}
let server: Server
let port: number
const seen: { method: string; url: string; body: any }[] = []
let partialReadRequests = 0

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end('unauthorized')
      return
    }
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, body: raw ? JSON.parse(raw) : null })
      if (req.url === '/v1/ping') return void res.end(JSON.stringify({ version: '0.4.1' }))
      if (req.url === '/v1/rooms' && req.method === 'GET') {
        return void res.end(JSON.stringify([{ id: 'abc12345', project: 'demo', nickname: 'dev', status: 'ready' }]))
      }
      if (req.url === '/v1/rooms/abc12345/changes' && req.method === 'POST') {
        const body = JSON.parse(raw)
        if (body.change?.kind === 'android-run' && body.waitMs === 0) {
          return void res.end(JSON.stringify({
            operation: {
              ...runningOperation,
              id: body.operationId,
              kind: 'android-run',
              stage: 'preparing'
            }
          }))
        }
        return void res.end(JSON.stringify(APPLIED_CHANGE))
      }
      if (req.url === '/v1/rooms/partial-body/changes' && req.method === 'POST') {
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': 128,
          connection: 'close'
        })
        res.write('{"id":"committed-before-response-ended"')
        setTimeout(() => res.destroy(), 10)
        return
      }
      if (req.url === '/v1/rooms/server-error/changes' && req.method === 'POST') {
        return void res.writeHead(500).end('change failed')
      }
      if (req.url === '/v1/rooms/partial-read' && req.method === 'GET') {
        partialReadRequests++
        if (partialReadRequests === 1) {
          res.writeHead(200, {
            'content-type': 'application/json',
            'content-length': 128,
            connection: 'close'
          })
          res.write('{"id":"partial-read"')
          setTimeout(() => res.destroy(), 10)
          return
        }
        return void res.end(JSON.stringify({ id: 'partial-read', status: 'ready' }))
      }
      if (req.url?.startsWith('/v1/rooms/abc12345/start')) {
        return void res.end(JSON.stringify({ operation: runningOperation }))
      }
      if (req.url === '/v1/rooms/abc12345/sleep') return void res.writeHead(204).end()
      if (req.url?.startsWith(`/v1/operations/${OPERATION_ID}`)) {
        return void res.end(JSON.stringify({ operation: { ...runningOperation, status: 'succeeded', stage: 'complete' } }))
      }
      if (req.url?.startsWith('/v1/rooms/abc12345/operations')) {
        return void res.end(JSON.stringify({ operations: [runningOperation] }))
      }
      if (req.url === '/v1/rooms/abc12345/exec') {
        return void res.end(JSON.stringify({ code: 0, stdout: 'ok', stderr: '' }))
      }
      if (req.url === '/v1/rooms/abc12345/runs') {
        return void res.end(JSON.stringify({ runs: [{ runId: RUN_ID, status: 'running' }] }))
      }
      if (req.url?.startsWith(`/v1/rooms/abc12345/runs/${RUN_ID}/output`)) {
        return void res.end(JSON.stringify({ runId: RUN_ID, stream: 'stderr', text: 'FATAL', eof: true }))
      }
      if (req.url === '/v1/rooms/abc12345/artifacts/screenshots' && req.method === 'POST') {
        return void res.end(JSON.stringify({ ...artifact, filename: JSON.parse(raw).filename }))
      }
      if (req.url === '/v1/rooms/abc12345/android/locale-matrix' && req.method === 'POST') {
        const body = JSON.parse(raw)
        return void res.end(JSON.stringify({
          target: { kind: 'emulator', deviceId: null },
          applicationId: body.applicationId,
          apiLevel: 34,
          scope: 'app',
          entries: body.locales.map((locale: string, index: number) => ({
            locale,
            appliedLocaleTags: [locale, `${locale.split('-')[0]}-x-dh-11111111-2222-3333-4444-55555555-6666`],
            readiness: { consecutiveReadyChecks: 2 },
            process: { beforePids: [100 + index], afterPids: [101 + index], restarted: true },
            artifact: { ...artifact, filename: `${body.filenamePrefix}-${locale.toLowerCase()}.png` }
          })),
          restoration: { localeTags: ['en-US'], readiness: { consecutiveReadyChecks: 2 } }
        }))
      }
      if (req.url === '/v1/rooms/abc12345/android/locale-recovery-abandon' && req.method === 'POST') {
        const body = JSON.parse(raw)
        return void res.end(JSON.stringify({
          abandoned: true,
          applicationId: body.applicationId,
          target: { kind: 'emulator', deviceId: null }
        }))
      }
      if (req.url === '/v1/rooms/abc12345/artifacts?limit=5' && req.method === 'GET') {
        return void res.end(JSON.stringify({ artifacts: [artifact] }))
      }
      if (req.url === `/v1/rooms/abc12345/artifacts/${ARTIFACT_ID}` && req.method === 'GET') {
        return void res.end(JSON.stringify(artifact))
      }
      if (req.url === `/v1/rooms/abc12345/artifacts/${ARTIFACT_ID}/content` && req.method === 'GET') {
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-length': ARTIFACT_PNG.byteLength,
          'x-devhotel-sha256': ARTIFACT_SHA256
        })
        return void res.end(ARTIFACT_PNG)
      }
      if (req.url === `/v1/rooms/abc12345/artifacts/${OVERSIZED_ARTIFACT_ID}/content` && req.method === 'GET') {
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-length': 16 * 1024 * 1024 + 1,
          'x-devhotel-sha256': ARTIFACT_SHA256
        })
        return void res.end()
      }
      if (req.url === `/v1/rooms/abc12345/artifacts/${ARTIFACT_ID}/export` && req.method === 'POST') {
        const relativePath = JSON.parse(raw).relativePath
        return void res.end(JSON.stringify({
          artifactId: ARTIFACT_ID,
          path: `/workspace/${relativePath}`,
          relativePath,
          sizeBytes: ARTIFACT_PNG.byteLength,
          sha256: ARTIFACT_SHA256,
          markdown: `![login-success.png](${relativePath})`
        }))
      }
      if (req.url === '/v1/rooms/abc12345/android/acceptance-reports' && req.method === 'POST') {
        return void res.end(JSON.stringify(acceptanceResult))
      }
      if (req.url === '/v1/rooms/abc12345/android/acceptance-reports?limit=5' && req.method === 'GET') {
        return void res.end(JSON.stringify({ reports: [acceptanceResult.report] }))
      }
      if (
        req.url === `/v1/rooms/abc12345/android/acceptance-reports/${ACCEPTANCE_REPORT_ID}` &&
        req.method === 'GET'
      ) {
        return void res.end(JSON.stringify(acceptanceResult))
      }
      if (req.url === '/v1/rooms/abc12345/diagnostic') {
        return void res.end(JSON.stringify({ text: 'DevHotel Diagnostic Bundle\n...' }))
      }
      if (req.url === '/v1/rooms/abc12345/sync-from-host') {
        res.writeHead(409, { 'content-type': 'application/json' })
        return void res.end(JSON.stringify({
          error: 'workspace_drift',
          conflictReason: 'room-source-modified',
          changedPaths: [{ path: 'app/src/main/java/App.kt', reason: 'modified' }]
        }))
      }
      if (req.url === '/v1/rooms/abc12345/safe-resync-from-host') {
        if (JSON.parse(raw).confirmationToken === RESYNC_TOKEN) {
          return void res.end(JSON.stringify({
            status: 'synced',
            retainedWorkspaceVolumeRevision: 1,
            recoveryGuidance: ['generation r1 retained']
          }))
        }
        res.writeHead(409, { 'content-type': 'application/json' })
        return void res.end(JSON.stringify({
          status: 'confirmation-required',
          drift: {
            status: 'changed',
            changedPaths: [{ path: 'src/app.ts', reason: 'modified' }]
          },
          confirmation: { required: true, provided: false, token: RESYNC_TOKEN },
          recoveryGuidance: ['export or commit first']
        }))
      }
      res.writeHead(404).end('not found')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as { port: number }).port
})

afterAll(() => server.close())

function client(): ControlClient {
  return new ControlClient({ port, token: TOKEN, pid: 0, version: '0.4.1' })
}

async function closedLoopbackPort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const closedPort = (probe.address() as { port: number }).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return closedPort
}

describe('ControlClient', () => {
  it('authenticates and lists rooms', async () => {
    const rooms = await client().listRooms()
    expect(rooms).toHaveLength(1)
  })

  it('rejects with API error detail on failure status', async () => {
    await expect(client().inspectRoom('missing')).rejects.toThrow(/404/)
  })

  it('sends bearer token (401 without)', async () => {
    const bad = new ControlClient({ port, token: 'wrong', pid: 0, version: '0.4.1' })
    await expect(bad.listRooms()).rejects.toThrow(/401/)
  })

  it('maps 204 to undefined', async () => {
    await expect(client().sleepRoom('abc12345')).resolves.toBeUndefined()
  })

  it('answers a start with the wake operation instead of a bare success', async () => {
    await expect(client().startRoom('abc12345')).resolves.toEqual({ operation: runningOperation })
  })

  it('rejects artifact content above the fixed response limit before buffering it', async () => {
    await expect(client().readRoomArtifactContent('abc12345', OVERSIZED_ARTIFACT_ID)).rejects.toThrow(/16MB response limit/)
  })
})

describe('resilientClient', () => {
  it('re-reads control info and retries a read-only request once when DevHotel restarted', async () => {
    let connects = 0
    const stale = new ControlClient({ port: 1, token: 'dead', pid: 0, version: 'x' })
    const wrapped = resilientClient(async () => (connects++ === 0 ? stale : client()))
    const rooms = await wrapped.listRooms()
    expect(rooms).toHaveLength(1)
    expect(connects).toBe(2)
  })

  it('retries a mutation only when ECONNREFUSED proves the first request never connected', async () => {
    let connects = 0
    const closedPort = await closedLoopbackPort()
    const unavailable = new ControlClient({ port: closedPort, token: TOKEN, pid: 0, version: 'x' })
    const before = seen.filter((request) => request.url === '/v1/rooms/abc12345/changes').length
    const wrapped = resilientClient(async () => (connects++ === 0 ? unavailable : client()))

    await expect(wrapped.applyChange('abc12345', { kind: 'node-version', version: '24' })).resolves.toEqual(
      APPLIED_CHANGE
    )
    expect(connects).toBe(2)
    expect(seen.filter((request) => request.url === '/v1/rooms/abc12345/changes')).toHaveLength(before + 1)
  })

  it('does not replay applyChange after a transport timeout with an ambiguous outcome', async () => {
    let calls = 0
    let connects = 0
    const headersTimeout = Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' })
    const stale = {
      async applyChange() {
        calls++
        throw new DevHotelNotRunningError('control API response timed out', {
          cause: new TypeError('fetch failed', { cause: headersTimeout })
        })
      }
    } as unknown as ControlClient
    const wrapped = resilientClient(async () => {
      connects++
      return stale
    })

    let caught: unknown
    try {
      await wrapped.applyChange('abc12345', { kind: 'node-version', version: '24' })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(DevHotelAmbiguousMutationError)
    expect(caught).toMatchObject({ transportCode: 'UND_ERR_HEADERS_TIMEOUT' })
    expect((caught as Error).message).toMatch(/ambiguous outcome.*not retried.*list_changes.*inspect_room.*check_operation/i)
    expect(calls).toBe(1)
    expect(connects).toBe(1)
  })

  it('does not replay a mutation when a 200 response body terminates after the server handled it', async () => {
    let connects = 0
    const before = seen.filter((request) => request.url === '/v1/rooms/partial-body/changes').length
    const wrapped = resilientClient(async () => {
      connects++
      return client()
    })

    await expect(
      wrapped.applyChange('partial-body', { kind: 'node-version', version: '24' })
    ).rejects.toBeInstanceOf(DevHotelAmbiguousMutationError)
    expect(connects).toBe(1)
    expect(seen.filter((request) => request.url === '/v1/rooms/partial-body/changes')).toHaveLength(before + 1)
  })

  it('reconnects and retries a read-only GET after a partial 200 response body', async () => {
    let connects = 0
    partialReadRequests = 0
    const before = seen.filter((request) => request.url === '/v1/rooms/partial-read').length
    const wrapped = resilientClient(async () => {
      connects++
      return client()
    })

    await expect(wrapped.inspectRoom('partial-read')).resolves.toEqual({ id: 'partial-read', status: 'ready' })
    expect(connects).toBe(2)
    expect(seen.filter((request) => request.url === '/v1/rooms/partial-read')).toHaveLength(before + 2)
  })

  it('reconnects and retries a mutation rejected with 401 before routing', async () => {
    let connects = 0
    const before = seen.filter((request) => request.url === '/v1/rooms/abc12345/changes').length
    const unauthorized = new ControlClient({ port, token: 'stale-token', pid: 0, version: 'x' })
    const wrapped = resilientClient(async () => (connects++ === 0 ? unauthorized : client()))

    await expect(wrapped.applyChange('abc12345', { kind: 'node-version', version: '24' })).resolves.toEqual(
      APPLIED_CHANGE
    )
    expect(connects).toBe(2)
    expect(seen.filter((request) => request.url === '/v1/rooms/abc12345/changes')).toHaveLength(before + 1)
  })

  it('reports a transport failure on the safe 401 replay as an ambiguous mutation', async () => {
    let connects = 0
    let replayCalls = 0
    const unauthorized = new ControlClient({ port, token: 'stale-token', pid: 0, version: 'x' })
    const disconnected = {
      async applyChange() {
        replayCalls++
        throw new DevHotelNotRunningError('control API disconnected during the replay')
      }
    } as unknown as ControlClient
    const wrapped = resilientClient(async () => (connects++ === 0 ? unauthorized : disconnected))

    await expect(
      wrapped.applyChange('abc12345', { kind: 'node-version', version: '24' })
    ).rejects.toBeInstanceOf(DevHotelAmbiguousMutationError)
    expect(connects).toBe(2)
    expect(replayCalls).toBe(1)
  })

  it('does not reconnect or replay a mutation after a 5xx response', async () => {
    let connects = 0
    const before = seen.filter((request) => request.url === '/v1/rooms/server-error/changes').length
    const wrapped = resilientClient(async () => {
      connects++
      return client()
    })

    await expect(
      wrapped.applyChange('server-error', { kind: 'node-version', version: '24' })
    ).rejects.toThrow(/control API 500: change failed/)
    expect(connects).toBe(1)
    expect(seen.filter((request) => request.url === '/v1/rooms/server-error/changes')).toHaveLength(before + 1)
  })

  it('is not thenable, so async plumbing cannot call a non-existent .then', async () => {
    const wrapped = resilientClient(async () => client())
    expect((wrapped as unknown as { then?: unknown }).then).toBeUndefined()
    // returning it from an async function must yield the client itself,
    // not attempt to resolve it as a promise (this crashed the stdio server)
    const returned = await (async () => wrapped)()
    expect(returned).toBe(wrapped)
    await expect(returned.ping()).resolves.toEqual({ version: '0.4.1' })
  })

  it('does not mask real API errors with a reconnect', async () => {
    let connects = 0
    const wrapped = resilientClient(async () => {
      connects++
      return client()
    })
    await expect(wrapped.inspectRoom('missing')).rejects.toThrow(/404/)
    expect(connects).toBe(1)
  })
})

describe('loadControlInfo', () => {
  it('throws a friendly not-running error when file is missing', async () => {
    await expect(loadControlInfo('Z:\\definitely\\missing\\control.json')).rejects.toBeInstanceOf(
      DevHotelNotRunningError
    )
  })
})

describe('makeTools', () => {
  const tools = makeTools(async () => client())
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]))

  it('exposes the full room-operations tool set', () => {
    expect(Object.keys(byName).sort()).toEqual(
      [
        'android_create_acceptance_report',
        'android_device_adb',
        'android_devices',
        'android_dump_ui',
        'android_force_stop',
        'android_launch_app',
        'abandon_android_locale_matrix_recovery',
        'android_locale_screenshot_matrix',
        'android_logcat',
        'android_run',
        'android_run_crash_scenario',
        'android_screenshot',
        'android_tap_text',
        'android_wait_for_text',
        'attach_android_device',
        'cancel_android_device_request',
        'apply_quick_change',
        'check_operation',
        'check_room',
        'clone_room',
        'copy_diagnostic',
        'create_room',
        'delete_room',
        'hotel_github_install',
        'hotel_github_status',
        'hotel_status',
        'heartbeat_android_device',
        'inspect_room',
        'get_android_acceptance_report',
        'list_changes',
        'list_android_acceptance_reports',
        'list_room_artifacts',
        'list_rooms',
        'release_android_device',
        'rename_room',
        'reset_room',
        'reset_sync_baseline',
        'restart_web',
        'room_components',
        'room_logs',
        'list_room_runs',
        'read_run_output',
        'read_room_artifact',
        'room_pull_file',
        'room_push_file',
        'run_in_room',
        'safe_resync_from_host',
        'sleep_room',
        'start_room',
        'sync_from_host',
        'undo_change',
        'export_room_artifact'
      ].sort()
    )
  })

  it('reports the package release metadata', () => {
    expect(MCP_METADATA).toEqual({ name: 'devhotel', version: '0.5.1' })
  })

  function firstText(res: { content: ({ type: string } & Record<string, unknown>)[] }): string {
    const first = res.content[0]
    if (!first || first.type !== 'text') throw new Error('expected text content')
    return first.text as string
  }

  it('list_rooms returns JSON content', async () => {
    const res = await byName.list_rooms!.handler({})
    expect(res.isError).toBeUndefined()
    expect(firstText(res)).toContain('abc12345')
  })

  it('run_in_room forwards argv and returns exec result', async () => {
    const res = await byName.run_in_room!.handler({ roomId: 'abc12345', cmd: ['pnpm', 'install'] })
    expect(firstText(res)).toContain('"code": 0')
    const req = seen.find((s) => s.url === '/v1/rooms/abc12345/exec')
    expect(req?.body.cmd).toEqual(['pnpm', 'install'])
  })

  it('captures a named screenshot as a durable artifact and returns a reviewable image', async () => {
    const res = await byName.android_screenshot!.handler({
      roomId: 'abc12345',
      filename: 'login-success.png',
      changeId: '11111111-2222-4333-8444-555555555555'
    })

    expect(res.isError).toBeUndefined()
    expect(res.content[0]).toMatchObject({ type: 'text' })
    expect(res.content[1]).toEqual({ type: 'image', data: ARTIFACT_PNG.toString('base64'), mimeType: 'image/png' })
    expect(seen.find((request) => request.url === '/v1/rooms/abc12345/artifacts/screenshots')).toMatchObject({
      body: {
        filename: 'login-success.png',
        mode: 'auto',
        association: { changeId: '11111111-2222-4333-8444-555555555555' }
      }
    })
  })

  it('runs the locale matrix as a receipts-only composite tool', async () => {
    const result = await byName.android_locale_screenshot_matrix!.handler({
      roomId: 'abc12345',
      applicationId: 'com.example.app',
      locales: ['ko-KR', 'en-US'],
      filenamePrefix: 'release-42',
      changeId: '11111111-2222-4333-8444-555555555555'
    })

    expect(result.isError).toBeUndefined()
    expect(result.content).toHaveLength(1)
    expect(result.content[0]).toMatchObject({ type: 'text' })
    expect(firstText(result)).toContain('release-42-ko-kr.png')
    expect(firstText(result)).toContain('appliedLocaleTags')
    expect(seen.findLast((request) => request.url === '/v1/rooms/abc12345/android/locale-matrix'))
      .toMatchObject({
        body: {
          applicationId: 'com.example.app',
          locales: ['ko-KR', 'en-US'],
          filenamePrefix: 'release-42',
          association: { changeId: '11111111-2222-4333-8444-555555555555' }
        }
      })

    const schema = byName.android_locale_screenshot_matrix!.strictInputSchema!
    expect(schema.parse({
      roomId: 'abc12345', applicationId: 'com.example.app',
      locales: ['ko-kr'], filenamePrefix: 'release'
    }).locales).toEqual(['ko-KR'])
    expect(schema.safeParse({
      roomId: 'abc12345', applicationId: 'com.example.app',
      locales: ['en-US'], filenamePrefix: 'release', serial: 'emulator-5554'
    }).success).toBe(false)
    expect(schema.safeParse({
      roomId: 'abc12345', applicationId: 'com.example.app',
      locales: ['en-US'], filenamePrefix: 'release', target: { kind: 'auto' }
    }).success).toBe(false)
    expect(schema.safeParse({
      roomId: 'abc12345', applicationId: 'com.example.app',
      locales: ['en-US'], filenamePrefix: 'release',
      target: { kind: 'physical', deviceId: `d${'a'.repeat(32)}` }
    }).success).toBe(false)
  })

  it('forwards only a literal explicit locale-recovery acknowledgement', async () => {
    const result = await byName.abandon_android_locale_matrix_recovery!.handler({
      roomId: 'abc12345',
      applicationId: 'com.example.app',
      acknowledgeOutsideLocale: true
    })

    expect(result.isError).toBeUndefined()
    expect(firstText(result)).toContain('"abandoned": true')
    expect(seen.findLast((request) =>
      request.url === '/v1/rooms/abc12345/android/locale-recovery-abandon'
    )).toMatchObject({
      body: {
        applicationId: 'com.example.app',
        acknowledgeOutsideLocale: true
      }
    })

    const schema = byName.abandon_android_locale_matrix_recovery!.strictInputSchema!
    expect(schema.safeParse({
      roomId: 'abc12345',
      applicationId: 'com.example.app',
      acknowledgeOutsideLocale: false
    }).success).toBe(false)
    expect(schema.safeParse({
      roomId: 'abc12345',
      applicationId: 'com.example.app',
      acknowledgeOutsideLocale: true,
      extra: 'not-allowed'
    }).success).toBe(false)
  })

  it('lists, reads and exports Room artifacts through bounded artifact routes', async () => {
    const listed = await byName.list_room_artifacts!.handler({ roomId: 'abc12345', limit: 5 })
    expect(firstText(listed)).toContain(ARTIFACT_ID)

    const read = await byName.read_room_artifact!.handler({ roomId: 'abc12345', artifactId: ARTIFACT_ID })
    expect(read.content[1]).toEqual({ type: 'image', data: ARTIFACT_PNG.toString('base64'), mimeType: 'image/png' })

    const exported = await byName.export_room_artifact!.handler({
      roomId: 'abc12345',
      artifactId: ARTIFACT_ID,
      relativePath: 'docs/login-success.png'
    })
    expect(firstText(exported)).toContain('![login-success.png](docs/login-success.png)')
  })

  it('creates, lists, and reads bounded acceptance receipts as Markdown plus JSON', async () => {
    const created = await byName.android_create_acceptance_report!.handler({
      roomId: 'abc12345',
      applicationId: 'com.example.app',
      steps: [{ id: 'login', status: 'pass', screenshotArtifactIds: [ARTIFACT_ID] }]
    })
    expect(created.isError).toBeUndefined()
    expect(firstText(created)).toContain('Android acceptance report')
    expect(created.content[1]).toMatchObject({ type: 'text' })
    expect((created.content[1] as { text: string }).text).toContain(ACCEPTANCE_REPORT_ID)
    expect(seen.findLast((request) =>
      request.url === '/v1/rooms/abc12345/android/acceptance-reports' && request.method === 'POST'
    )?.body).toMatchObject({ stage: 'development', applicationId: 'com.example.app' })

    const listed = await byName.list_android_acceptance_reports!.handler({ roomId: 'abc12345', limit: 5 })
    expect(firstText(listed)).toContain(ACCEPTANCE_REPORT_ID)
    const fetched = await byName.get_android_acceptance_report!.handler({
      roomId: 'abc12345',
      reportId: ACCEPTANCE_REPORT_ID
    })
    expect(firstText(fetched)).toContain('Android acceptance report')
  })

  it('rejects final-physical acceptance without an explicit physical target', async () => {
    const invalid = await byName.android_create_acceptance_report!.handler({
      roomId: 'abc12345',
      applicationId: 'com.example.app',
      stage: 'final-physical',
      steps: [{ id: 'login', status: 'pass', screenshotArtifactIds: [ARTIFACT_ID] }]
    })
    expect(invalid.isError).toBe(true)
    expect(seen.findLast((request) =>
      request.url === '/v1/rooms/abc12345/android/acceptance-reports' && request.method === 'POST'
    )?.body).not.toMatchObject({ stage: 'final-physical' })
  })

  it('run_in_room forwards the bounded-output selection to the control API', async () => {
    await byName.run_in_room!.handler({
      roomId: 'abc12345',
      cmd: ['pnpm', 'test'],
      maxBytes: 4096,
      mode: 'head',
      include: 'FATAL',
      ignoreCase: true
    })
    const req = [...seen].reverse().find((s) => s.url === '/v1/rooms/abc12345/exec')
    expect(req?.body.output).toEqual({ maxBytes: 4096, mode: 'head', include: 'FATAL', ignoreCase: true })
  })

  it('run_in_room sends no output selection when the caller chose none', async () => {
    seen.length = 0
    await byName.run_in_room!.handler({ roomId: 'abc12345', cmd: ['node', '--version'] })
    const req = seen.find((s) => s.url === '/v1/rooms/abc12345/exec')
    expect(req?.body).toEqual({ cmd: ['node', '--version'] })
  })

  it('read_run_output pages and filters a retained run', async () => {
    const res = await byName.read_run_output!.handler({
      roomId: 'abc12345',
      runId: RUN_ID,
      stream: 'stderr',
      offsetBytes: 4096,
      encoding: 'base64',
      include: 'FATAL'
    })
    expect(firstText(res)).toContain('FATAL')
    const req = seen.find((s) => s.url?.startsWith(`/v1/rooms/abc12345/runs/${RUN_ID}/output`))
    const query = new URLSearchParams(req!.url.split('?')[1])
    expect(query.get('stream')).toBe('stderr')
    expect(query.get('offsetBytes')).toBe('4096')
    expect(query.get('encoding')).toBe('base64')
    expect(query.get('include')).toBe('FATAL')
  })

  it('list_room_runs reports what the Room is running and still holds', async () => {
    const res = await byName.list_room_runs!.handler({ roomId: 'abc12345' })
    expect(firstText(res)).toContain(RUN_ID)
  })

  it('copy_diagnostic returns plain text', async () => {
    const res = await byName.copy_diagnostic!.handler({ roomId: 'abc12345' })
    expect(firstText(res)).toMatch(/^DevHotel Diagnostic Bundle/)
  })

  it('publishes a Web + Android create contract', () => {
    const schema = z.object(byName.create_room!.schema)
    const base = { sourceType: 'empty', sourceRef: '', project: 'demo', nickname: 'dev' }
    expect(schema.safeParse({ ...base, provider: 'web' }).success).toBe(true)
    expect(schema.safeParse({ ...base, provider: 'android' }).success).toBe(true)
    expect(schema.safeParse({ ...base, provider: 'windows' }).success).toBe(false)
  })

  it('room_logs defaults to the web log and forwards the kind', async () => {
    await byName.room_logs!.handler({ roomId: 'abc12345' })
    const req = seen.find((s) => s.url === '/v1/rooms/abc12345/logs?kind=web')
    expect(req?.method).toBe('GET')
  })

  it('errors surface as isError content, not throws', async () => {
    const res = await byName.inspect_room!.handler({ roomId: 'nope' })
    expect(res.isError).toBe(true)
  })

  it('surfaces exact Room drift details from the control API', async () => {
    const res = await byName.sync_from_host!.handler({ roomId: 'abc12345' })
    expect(res.isError).toBe(true)
    expect(firstText(res)).toContain('"conflictReason":"room-source-modified"')
    expect(firstText(res)).toContain('app/src/main/java/App.kt')
  })

  it('start_room hands back the wake operation, not a "started" claim', async () => {
    const res = await byName.start_room!.handler({ roomId: 'abc12345', waitMs: 0 })
    expect(res.isError).toBeUndefined()
    const operation = JSON.parse(firstText(res)) as { id: string; status: string; stage: string }
    expect(operation).toMatchObject({ id: OPERATION_ID, status: 'running', stage: 'container-start' })
    const req = seen.findLast((s) => s.url?.startsWith('/v1/rooms/abc12345/start'))
    expect(req?.body).toEqual({ waitMs: 0 })
  })

  it('check_operation follows an operation id through to its terminal status', async () => {
    const res = await byName.check_operation!.handler({ operationId: OPERATION_ID, waitMs: 1000 })
    const operation = JSON.parse(firstText(res)) as { status: string; stage: string }
    expect(operation).toMatchObject({ status: 'succeeded', stage: 'complete' })
    expect(seen.findLast((s) => s.url?.startsWith('/v1/operations/'))?.url).toContain('waitMs=1000')
  })

  it('check_operation lists a Room’s recent operations', async () => {
    const res = await byName.check_operation!.handler({ roomId: 'abc12345' })
    const operations = JSON.parse(firstText(res)) as { id: string }[]
    expect(operations).toHaveLength(1)
    expect(operations[0]?.id).toBe(OPERATION_ID)
  })

  it('check_operation asks for an id or a Room instead of guessing', async () => {
    const res = await byName.check_operation!.handler({})
    expect(res.isError).toBe(true)
    expect(firstText(res)).toMatch(/operationId|roomId/)
  })

  it('safe_resync_from_host forwards only the opaque token returned by its preview', async () => {
    const preview = await byName.safe_resync_from_host!.handler({ roomId: 'abc12345' })
    expect(preview.isError).toBe(true)
    expect(firstText(preview)).toContain('confirmation-required')
    expect(firstText(preview)).toContain('src/app.ts')

    const confirmed = await byName.safe_resync_from_host!.handler({
      roomId: 'abc12345',
      confirmationToken: RESYNC_TOKEN
    })
    expect(confirmed.isError).toBeUndefined()
    expect(firstText(confirmed)).toContain('"status": "synced"')
    const requests = seen.filter((request) => request.url === '/v1/rooms/abc12345/safe-resync-from-host')
    expect(requests.at(-2)?.body).toEqual({})
    expect(requests.at(-1)?.body).toEqual({ confirmationToken: RESYNC_TOKEN })
  })

  it('android_run passes operationId upfront to enable recoverable acknowledgement', async () => {
    const screenshotsBefore = seen.filter((r) => r.url === '/v1/rooms/abc12345/artifacts/screenshots').length
    const res = await byName.android_run!.handler({ roomId: 'abc12345' })
    expect(res.isError).toBeUndefined()
    expect(firstText(res)).toMatch(/was dispatched.*operation:/)
    const req = seen.findLast((r) => r.url === '/v1/rooms/abc12345/changes')
    expect(req?.body?.change).toEqual({ kind: 'android-run' })
    expect(typeof req?.body?.operationId).toBe('string')
    expect(req?.body?.operationId).toMatch(/^[0-9a-f-]{36}$/)
    expect(req?.body?.waitMs).toBe(0)
    expect(seen.filter((r) => r.url === '/v1/rooms/abc12345/artifacts/screenshots')).toHaveLength(screenshotsBefore)
  })
})
