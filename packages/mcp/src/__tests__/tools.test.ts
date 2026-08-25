import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ControlClient, DevHotelNotRunningError, loadControlInfo, resilientClient } from '../client'
import { makeTools } from '../tools'
import { z } from 'zod'
import { MCP_METADATA } from '../metadata'

const TOKEN = 'test-token'
const RUN_ID = '11111111-2222-3333-4444-555555555555'
let server: Server
let port: number
const seen: { method: string; url: string; body: any }[] = []

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
      if (req.url === '/v1/rooms/abc12345/start') return void res.writeHead(204).end()
      if (req.url === '/v1/rooms/abc12345/exec') {
        return void res.end(JSON.stringify({ code: 0, stdout: 'ok', stderr: '' }))
      }
      if (req.url === '/v1/rooms/abc12345/runs') {
        return void res.end(JSON.stringify({ runs: [{ runId: RUN_ID, status: 'running' }] }))
      }
      if (req.url?.startsWith(`/v1/rooms/abc12345/runs/${RUN_ID}/output`)) {
        return void res.end(JSON.stringify({ runId: RUN_ID, stream: 'stderr', text: 'FATAL', eof: true }))
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
    await expect(client().startRoom('abc12345')).resolves.toBeUndefined()
  })
})

describe('resilientClient', () => {
  it('re-reads control info and retries once when DevHotel restarted', async () => {
    let connects = 0
    const stale = new ControlClient({ port: 1, token: 'dead', pid: 0, version: 'x' })
    const wrapped = resilientClient(async () => (connects++ === 0 ? stale : client()))
    const rooms = await wrapped.listRooms()
    expect(rooms).toHaveLength(1)
    expect(connects).toBe(2)
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
        'android_run',
        'android_screenshot',
        'apply_quick_change',
        'check_room',
        'clone_room',
        'copy_diagnostic',
        'create_room',
        'delete_room',
        'hotel_github_install',
        'hotel_github_status',
        'hotel_status',
        'inspect_room',
        'list_changes',
        'list_rooms',
        'rename_room',
        'reset_room',
        'reset_sync_baseline',
        'restart_web',
        'room_components',
        'room_logs',
        'list_room_runs',
        'read_run_output',
        'room_pull_file',
        'room_push_file',
        'run_in_room',
        'sleep_room',
        'start_room',
        'sync_from_host',
        'undo_change'
      ].sort()
    )
  })

  it('reports the package release metadata', () => {
    expect(MCP_METADATA).toEqual({ name: 'devhotel', version: '0.4.3' })
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

  it('run_in_room forwards the bounded-output selection to the control API', async () => {
    await byName.run_in_room!.handler({
      roomId: 'abc12345',
      cmd: ['adb', 'logcat', '-d'],
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
      include: 'FATAL'
    })
    expect(firstText(res)).toContain('FATAL')
    const req = seen.find((s) => s.url?.startsWith(`/v1/rooms/abc12345/runs/${RUN_ID}/output`))
    const query = new URLSearchParams(req!.url.split('?')[1])
    expect(query.get('stream')).toBe('stderr')
    expect(query.get('offsetBytes')).toBe('4096')
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
})
