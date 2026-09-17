import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DevHotelError, type RoomOrchestrator } from '@devhotel/core'
import { startControlApi } from './controlApi'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const SESSION = 'cbr_0123456789abcdef'
const TOKEN = 'cbt_0123456789abcdef0123456789abcdef'
const OTHER_TOKEN = 'cbt_ffffffffffffffffffffffffffffffff'

async function withApi(
  clientBrowsers: Record<string, unknown>,
  run: (call: (path: string, init?: RequestInit) => Promise<{ status: number; body: any }>) => Promise<void>
): Promise<void> {
  const userData = mkdtempSync(join(tmpdir(), 'devhotel-control-browsers-'))
  roots.push(userData)
  const control = await startControlApi({ clientBrowsers } as unknown as RoomOrchestrator, userData, 'test')
  try {
    await run(async (path, init = {}) => {
      const response = await fetch(`http://127.0.0.1:${control.info.port}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${control.info.token}`,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...(init.headers ?? {})
        }
      })
      const text = await response.text()
      return { status: response.status, body: text ? JSON.parse(text) : null }
    })
  } finally {
    control.stop()
  }
}

const allocation = {
  session: { id: SESSION, roomId: 'room1abc', status: 'ready', pid: 4242, browserKind: 'chrome', headless: true, profileMode: 'ephemeral', createdAt: 't', lastActiveAt: 't' },
  token: TOKEN,
  endpoint: { http: `http://127.0.0.1:5555/cdp/${SESSION}/${TOKEN}`, ws: `ws://127.0.0.1:5555/cdp/${SESSION}/${TOKEN}` }
}

describe('Client Browser routes hand out one secret and demand it back', () => {
  it('allocates for the Room in the path and returns token and endpoints unredacted', async () => {
    const allocate = vi.fn(async () => allocation)
    await withApi({ allocate }, async (call) => {
      const result = await call('/v1/rooms/room1abc/browsers', { method: 'POST', body: JSON.stringify({ headless: false }) })
      expect(result.status).toBe(200)
      expect(allocate).toHaveBeenCalledWith('room1abc', { headless: false })
      expect(result.body.token).toBe(TOKEN)
      expect(result.body.endpoint.ws).toBe(allocation.endpoint.ws)
      expect(result.body.session.id).toBe(SESSION)

      const empty = await call('/v1/rooms/room1abc/browsers', { method: 'POST' })
      expect(empty.status).toBe(200)
      expect(allocate).toHaveBeenLastCalledWith('room1abc', {})

      const unknownField = await call('/v1/rooms/room1abc/browsers', { method: 'POST', body: JSON.stringify({ profile: 'x' }) })
      expect(unknownField.status).toBe(400)
      expect(unknownField.body.code).toBe('INVALID_CLIENT_BROWSER_REQUEST')
    })
  })

  it('lists sessions per Room and Hotel-wide without a token in sight', async () => {
    const listForRoom = vi.fn(() => [allocation.session])
    const listAll = vi.fn(() => [allocation.session])
    await withApi({ listForRoom, listAll, runtimeKind: 'host-chromium' }, async (call) => {
      const room = await call('/v1/rooms/room1abc/browsers')
      expect(room.status).toBe(200)
      expect(JSON.stringify(room.body)).not.toContain('cbt_')
      expect(room.body[0].id).toBe(SESSION)

      const all = await call('/v1/browsers')
      expect(all.status).toBe(200)
      expect(all.body).toEqual({ runtime: 'host-chromium', sessions: [allocation.session] })
    })
  })

  it('routes attach, inspect, navigate, screenshot and release by session with the token from the body', async () => {
    const attach = vi.fn(() => allocation)
    const inspect = vi.fn(async () => ({ session: allocation.session, owner: { roomId: 'room1abc', project: 'demo', nickname: 'dev' }, liveness: { processAlive: true, cdpReachable: true, browserVersion: 'Chrome/1' }, connection: { endpoint: allocation.endpoint, activeClients: 1 }, targets: [] }))
    const navigate = vi.fn(async () => ({ sessionId: SESSION, url: 'http://a', finalUrl: 'http://a/', title: 'A', loaded: true }))
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]).toString('base64')
    const screenshot = vi.fn(async () => ({ sessionId: SESSION, mimeType: 'image/png', contentBase64: png, sizeBytes: 8 }))
    const release = vi.fn(async () => ({ sessionId: SESSION, roomId: 'room1abc', released: true, processStopped: true, profileRemoved: true }))
    await withApi({ attach, inspect, navigate, screenshot, release }, async (call) => {
      const auth = JSON.stringify({ token: TOKEN })
      expect((await call(`/v1/browsers/${SESSION}/attach`, { method: 'POST', body: auth })).body.endpoint).toEqual(allocation.endpoint)
      expect(attach).toHaveBeenCalledWith(SESSION, TOKEN)

      const inspected = await call(`/v1/browsers/${SESSION}/inspect`, { method: 'POST', body: auth })
      expect(inspected.status).toBe(200)
      expect(inspected.body.liveness).toEqual({ processAlive: true, cdpReachable: true, browserVersion: 'Chrome/1' })
      expect(inspected.body.connection.activeClients).toBe(1)

      const navigated = await call(`/v1/browsers/${SESSION}/navigate`, { method: 'POST', body: JSON.stringify({ token: TOKEN, url: 'http://a', timeoutMs: 5000 }) })
      expect(navigated.status).toBe(200)
      expect(navigate).toHaveBeenCalledWith(SESSION, TOKEN, 'http://a', 5000)

      const shot = await call(`/v1/browsers/${SESSION}/screenshot`, { method: 'POST', body: JSON.stringify({ token: TOKEN, format: 'png' }) })
      expect(shot.status).toBe(200)
      expect(shot.body.contentBase64).toBe(png)
      expect(screenshot).toHaveBeenCalledWith(SESSION, TOKEN, { format: 'png', fullPage: undefined })

      const released = await call(`/v1/browsers/${SESSION}/release`, { method: 'POST', body: auth })
      expect(released.status).toBe(200)
      expect(released.body.processStopped).toBe(true)
    })
  })

  it('turns Core ownership refusals into 403/404 and rejects malformed session IDs and tokens before Core', async () => {
    const inspect = vi.fn(async (_id: string, token: string) => {
      if (token !== TOKEN) throw new DevHotelError('CLIENT_BROWSER_FORBIDDEN', 'not yours', { httpStatus: 403 })
      throw new DevHotelError('CLIENT_BROWSER_NOT_FOUND', 'gone', { httpStatus: 404 })
    })
    await withApi({ inspect }, async (call) => {
      const wrong = await call(`/v1/browsers/${SESSION}/inspect`, { method: 'POST', body: JSON.stringify({ token: OTHER_TOKEN }) })
      expect(wrong.status).toBe(403)
      expect(wrong.body.code).toBe('CLIENT_BROWSER_FORBIDDEN')

      const gone = await call(`/v1/browsers/${SESSION}/inspect`, { method: 'POST', body: JSON.stringify({ token: TOKEN }) })
      expect(gone.status).toBe(404)

      const badId = await call('/v1/browsers/not-a-session/inspect', { method: 'POST', body: JSON.stringify({ token: TOKEN }) })
      expect(badId.status).toBe(400)
      expect(badId.body.code).toBe('INVALID_CLIENT_BROWSER_REQUEST')

      const badToken = await call(`/v1/browsers/${SESSION}/inspect`, { method: 'POST', body: JSON.stringify({ token: 'nope' }) })
      expect(badToken.status).toBe(400)

      const noToken = await call(`/v1/browsers/${SESSION}/release`, { method: 'POST', body: JSON.stringify({}) })
      expect(noToken.status).toBe(400)
      expect(inspect).toHaveBeenCalledTimes(2)
    })
  })
})
