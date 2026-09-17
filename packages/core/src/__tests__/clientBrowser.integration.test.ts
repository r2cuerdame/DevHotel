import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ClientBrowserManager } from '../browser/clientBrowserManager'
import { HostChromiumRuntime } from '../browser/hostChromiumRuntime'
import { findBrowserExecutable } from '../browser/browserLauncher'
import { clientBrowserRepo } from '../store/clientBrowserRepo'
import { openDb, type Db } from '../store/db'
import { roomsRepo } from '../store/roomsRepo'
import { settingsRepo } from '../store/settingsRepo'
import { makeRoom, tempDir } from './fakes'

/**
 * Real Chromium, real profiles, real CDP: the isolation this capability
 * promises is only worth anything if a browser actually enforces it. Skipped
 * where no Chromium is installed; CI's Windows runner ships Chrome and Edge.
 */
const browserAvailable = ((): boolean => {
  try {
    findBrowserExecutable()
    return true
  } catch {
    return false
  }
})()

function processAlive(pid: number | null): boolean {
  if (pid === null) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return check()
}

/** A page that logs the visitor in with a cookie and remembers them in localStorage. */
function startLoginSite(): Promise<{ server: Server; origin: string; seenCookies: string[] }> {
  const seenCookies: string[] = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/login') {
      const user = url.searchParams.get('user') ?? 'nobody'
      res.writeHead(200, {
        'content-type': 'text/html',
        'set-cookie': `session=${user}; Path=/; SameSite=Lax`
      })
      res.end(`<!doctype html><title>login ${user}</title><script>localStorage.setItem('who', ${JSON.stringify(user)}); sessionStorage.setItem('tab', ${JSON.stringify(user + '-tab')})</script><h1>${user}</h1>`)
      return
    }
    if (url.pathname === '/whoami') seenCookies.push(req.headers.cookie ?? '')
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<!doctype html><title>whoami</title><p id="cookie">${req.headers.cookie ?? ''}</p>`)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      resolve({ server, origin: `http://127.0.0.1:${port}`, seenCookies })
    })
  })
}

/** One CDP command over a raw WebSocket — what any external client does with the endpoint. */
function cdpCall(wsUrl: string, method: string, params: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`CDP ${method} timed out`))
    }, 5_000)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method, params })))
    ws.addEventListener('message', (event) => {
      const data = JSON.parse(String(event.data))
      if (data.id !== 1) return
      clearTimeout(timer)
      ws.close()
      if (data.error) reject(new Error(data.error.message))
      else resolve(data.result)
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('CDP socket error'))
    })
  })
}

async function cdpRoundTrip(wsUrl: string): Promise<{ ok: boolean; product: string | null }> {
  return await new Promise((resolve) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => {
      ws.close()
      resolve({ ok: false, product: null })
    }, 5_000)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' })))
    ws.addEventListener('message', (event) => {
      clearTimeout(timer)
      const data = JSON.parse(String(event.data))
      ws.close()
      resolve({ ok: data.id === 1 && !data.error, product: data.result?.product ?? null })
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      resolve({ ok: false, product: null })
    })
  })
}

describe.skipIf(!browserAvailable)('Client Browser sessions on real Chromium', () => {
  let userData: string
  let db: Db
  let site: Awaited<ReturnType<typeof startLoginSite>>
  const managers: ClientBrowserManager[] = []

  function makeManager(generation: string): ClientBrowserManager {
    const manager = new ClientBrowserManager({
      userData,
      repo: clientBrowserRepo(db),
      settings: settingsRepo(db),
      runtime: new HostChromiumRuntime(),
      generation,
      rooms: {
        get: (roomId) => {
          const room = roomsRepo(db).get(roomId)
          return room ? { id: room.id, project: room.project, nickname: room.nickname, status: room.status } : null
        }
      }
    })
    managers.push(manager)
    return manager
  }

  beforeAll(async () => {
    site = await startLoginSite()
  })

  afterAll(() => {
    site.server.close()
  })

  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.shutdown()
    db.close()
    try {
      rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    } catch (error) {
      const leftovers = readdirSync(userData, { recursive: true }) as string[]
      throw new Error(`${(error as Error).message}; leftovers: ${leftovers.slice(0, 40).join(', ')}`)
    }
  })

  it('gives two Rooms fully separate cookies, storage and tabs behind token-gated endpoints, and releases one without touching the other', async () => {
    userData = tempDir()
    db = openDb(userData)
    roomsRepo(db).create(makeRoom({ id: 'roomaaaa', nickname: 'a', domain: 'a.localhost' }))
    roomsRepo(db).create(makeRoom({ id: 'roombbbb', nickname: 'b', domain: 'b.localhost' }))
    const manager = makeManager('gen-1')
    await manager.start()

    // Concurrent allocation: two Rooms, two processes, two profiles.
    const [a, b] = await Promise.all([manager.allocate('roomaaaa'), manager.allocate('roombbbb')])
    expect(a.session.id).not.toBe(b.session.id)
    expect(a.session.pid).not.toBe(b.session.pid)
    expect(a.token).toMatch(/^cbt_[a-z0-9]{32}$/)
    expect(a.endpoint.http).toContain(`/cdp/${a.session.id}/${a.token}`)
    expect(JSON.stringify(a.session)).not.toContain(a.token)

    // Ownership: the wrong token, or another session's token, opens nothing.
    expect(() => manager.attach(a.session.id, b.token)).toThrowError(/does not own/)
    expect(() => manager.attach(a.session.id, 'cbt_00000000000000000000000000000000')).toThrowError(/does not own/)
    await expect(manager.navigate(b.session.id, a.token, `${site.origin}/login?user=mallory`)).rejects.toThrowError(/does not own/)
    const forbidden = await fetch(`http://127.0.0.1:${new URL(a.endpoint.http).port}/cdp/${a.session.id}/cbt_00000000000000000000000000000000/json/version`)
    expect(forbidden.status).toBe(404)

    // Independent login state.
    await Promise.all([
      manager.navigate(a.session.id, a.token, `${site.origin}/login?user=alice`),
      manager.navigate(b.session.id, b.token, `${site.origin}/login?user=bob`)
    ])
    const stateExpression = "({ cookie: document.cookie, who: localStorage.getItem('who'), tab: sessionStorage.getItem('tab') })"
    const aState = await manager.evaluate<{ cookie: string; who: string; tab: string }>(a.session.id, a.token, stateExpression)
    const bState = await manager.evaluate<{ cookie: string; who: string; tab: string }>(b.session.id, b.token, stateExpression)
    expect(aState).toEqual({ cookie: 'session=alice', who: 'alice', tab: 'alice-tab' })
    expect(bState).toEqual({ cookie: 'session=bob', who: 'bob', tab: 'bob-tab' })

    // The server sees each browser send only its own cookie.
    await manager.navigate(a.session.id, a.token, `${site.origin}/whoami`)
    await manager.navigate(b.session.id, b.token, `${site.origin}/whoami`)
    expect(site.seenCookies.slice(-2).sort()).toEqual(['session=alice', 'session=bob'])

    // Tabs are per session too: one opened through A's endpoint never shows up in B.
    const opened = await cdpCall(a.endpoint.ws, 'Target.createTarget', { url: 'about:blank' })
    expect(opened.targetId).toBeTruthy()
    const aInspect = await manager.inspect(a.session.id, a.token)
    const bInspect = await manager.inspect(b.session.id, b.token)
    expect(aInspect.targets.length).toBeGreaterThanOrEqual(2)
    expect(bInspect.targets.length).toBe(1)
    expect(aInspect.owner).toEqual({ roomId: 'roomaaaa', project: 'demo', nickname: 'a' })
    expect(aInspect.liveness).toMatchObject({ processAlive: true, cdpReachable: true })
    expect(aInspect.liveness.browserVersion).toBeTruthy()
    expect(aInspect.connection.endpoint).toEqual(a.endpoint)

    // The endpoint is a real CDP target: Playwright-style discovery, then a raw socket.
    const version = await (await fetch(`${a.endpoint.http}/json/version`)).json() as { webSocketDebuggerUrl: string }
    expect(version.webSocketDebuggerUrl.startsWith(`${a.endpoint.ws}/devtools/browser/`)).toBe(true)
    for (const target of [a.endpoint.ws, version.webSocketDebuggerUrl]) {
      const roundTrip = await cdpRoundTrip(target)
      expect(roundTrip.ok).toBe(true)
      expect(roundTrip.product).toMatch(/Chrome|Edg|Chromium|HeadlessChrome/)
    }

    // Screenshot comes back as opaque PNG bytes.
    const shot = await manager.screenshot(a.session.id, a.token)
    expect(shot.mimeType).toBe('image/png')
    expect(Buffer.from(shot.contentBase64, 'base64').subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect(shot.sizeBytes).toBeGreaterThan(100)

    // Non-web schemes are refused before the browser sees them.
    await expect(manager.navigate(a.session.id, a.token, 'file:///C:/Windows/win.ini')).rejects.toThrowError(/refused/)

    // Release A: process gone, profile gone, row gone; B untouched.
    const aPid = a.session.pid
    const aProfile = join(userData, 'client-browsers', a.session.id)
    expect(existsSync(aProfile)).toBe(true)
    const released = await manager.release(a.session.id, a.token)
    expect(released).toMatchObject({ sessionId: a.session.id, released: true, processStopped: true, profileRemoved: true })
    expect(await waitFor(() => !processAlive(aPid))).toBe(true)
    expect(existsSync(aProfile)).toBe(false)
    expect(manager.listForRoom('roomaaaa')).toEqual([])
    await expect(manager.inspect(a.session.id, a.token)).rejects.toThrowError(/does not exist/)

    const bAfter = await manager.evaluate<string>(b.session.id, b.token, 'document.cookie')
    expect(bAfter).toBe('session=bob')
    expect(processAlive(b.session.pid)).toBe(true)

    // Releasing the Room takes the rest.
    const bPid = b.session.pid
    const roomRelease = await manager.releaseRoom('roombbbb', 'Room went to sleep')
    expect(roomRelease.map((r) => r.sessionId)).toEqual([b.session.id])
    expect(await waitFor(() => !processAlive(bPid))).toBe(true)
    expect(manager.listAll()).toEqual([])
  }, 90_000)

  it('reconciles browsers and profiles left behind by an earlier DevHotel process', async () => {
    userData = tempDir()
    db = openDb(userData)
    roomsRepo(db).create(makeRoom({ id: 'roomcccc', nickname: 'c', domain: 'c.localhost' }))
    const first = makeManager('gen-1')
    await first.start()
    const orphan = await first.allocate('roomcccc')
    const orphanPid = orphan.session.pid
    const orphanProfile = join(userData, 'client-browsers', orphan.session.id)
    expect(processAlive(orphanPid)).toBe(true)
    // A stray profile with no row: an allocation that died between mkdir and insert.
    const stray = join(userData, 'client-browsers', 'cbr_zzzzzzzzzzzzzzzz')
    mkdirSync(stray, { recursive: true })

    // "Restart": a new generation over the same database and folder.
    const second = makeManager('gen-2')
    const report = await second.reconcile()
    await second.start()

    expect(report).toEqual({ orphanedSessions: 1, stoppedProcesses: 1, removedProfiles: 2, unverified: [] })
    expect(await waitFor(() => !processAlive(orphanPid))).toBe(true)
    expect(existsSync(orphanProfile)).toBe(false)
    expect(existsSync(stray)).toBe(false)
    expect(second.listAll()).toEqual([])
    await expect(second.inspect(orphan.session.id, orphan.token)).rejects.toThrowError(/does not exist/)

    // The new generation allocates cleanly afterwards.
    const fresh = await second.allocate('roomcccc')
    expect(fresh.session.status).toBe('ready')
    await second.release(fresh.session.id, fresh.token)
  }, 90_000)
})
