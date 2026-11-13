import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'

/** What the server needs to know about a session to forward to it. */
export interface EndpointUpstream {
  sessionId: string
  devtoolsHost: string
  devtoolsPort: number
  /** Browser-level ws path (`/devtools/browser/<id>`) the bare endpoint maps to. */
  browserPath: string
}

export interface EndpointServerOptions {
  /**
   * Resolves `(sessionId, token)` to the browser behind it, or null when the
   * pair is unknown or the token is wrong. The server itself never learns a
   * token digest; every decision is the manager's.
   */
  resolve: (sessionId: string, token: string) => EndpointUpstream | null
  /** Port to try first, so endpoints stay put across restarts when the OS allows it. */
  preferredPort?: number | null
  /** Dials a session's DevTools listener; defaults to `net.connect`. Tests hold a dial open with it. */
  connect?: (port: number, host: string) => Socket
}

const SESSION_ID = /^cbr_[a-z0-9]{16}$/
const TOKEN = /^cbt_[a-z0-9]{32}$/

/**
 * Loopback front door for Client Browser sessions. Every path is
 * `/cdp/<sessionId>/<token>[/<rest>]`: the pair is checked on each request,
 * then the request is forwarded verbatim to that session's own DevTools
 * listener. WebSocket upgrades are tunnelled at the TCP level, so any CDP
 * client — Playwright's connectOverCDP, puppeteer, chrome-remote-interface,
 * raw sockets — works unchanged; `/json*` discovery answers are rewritten so
 * the URLs they carry point back through this server rather than at the
 * unlisted upstream port. Browser origins are stripped before forwarding,
 * so Chromium's own origin check keeps rejecting web pages that reach the
 * raw port while still accepting the tunnelled agent.
 */
export class ClientBrowserEndpointServer {
  private server: Server | null = null
  private port: number | null = null
  private readonly clients = new Map<string, Set<Duplex>>()
  /**
   * Tunnels still dialling and discovery requests still waiting on the
   * browser, as abort callbacks. Neither is a tunnelled client yet, but a
   * released session or a stopping server must not leave them behind.
   */
  private readonly inFlight = new Map<string, Set<() => void>>()

  constructor(private readonly options: EndpointServerOptions) {}

  get listeningPort(): number | null {
    return this.port
  }

  async start(): Promise<number> {
    if (this.server) return this.port!
    const server = createServer((req, res) => {
      req.on('error', () => {})
      res.on('error', () => {})
      this.handleHttp(req, res)
    })
    server.on('upgrade', (req, socket, head) => {
      socket.on('error', () => {})
      this.handleUpgrade(req, socket, head)
    })
    server.on('clientError', (_error, socket) => {
      socket.destroy()
    })
    const bind = (port: number): Promise<number> =>
      new Promise((resolve, reject) => {
        const onError = (error: Error): void => {
          server.removeListener('listening', onListening)
          reject(error)
        }
        const onListening = (): void => {
          server.removeListener('error', onError)
          resolve((server.address() as { port: number }).port)
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, '127.0.0.1')
        server.unref()
      })
    let port: number
    try {
      port = await bind(this.options.preferredPort ?? 0)
    } catch {
      port = await bind(0)
    }
    this.server = server
    this.port = port
    return port
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.port = null
    const sockets = [...this.clients.values()].flatMap((set) => [...set])
    const aborts = [...this.inFlight.values()].flatMap((set) => [...set])
    this.clients.clear()
    this.inFlight.clear()
    for (const socket of sockets) socket.destroy()
    for (const abort of aborts) abort()
    if (!server) return
    const closed = new Promise<void>((resolve) => server.close(() => resolve()))
    // Keep-alive and half-answered discovery sockets would otherwise hold close() open.
    server.closeAllConnections()
    await closed
  }

  /** Automation clients currently tunnelled for a session. */
  activeClients(sessionId: string): number {
    return this.clients.get(sessionId)?.size ?? 0
  }

  /**
   * Drop every tunnelled client of a session, along with tunnels still
   * dialling and discovery requests still waiting; used when the session is
   * released.
   */
  disconnect(sessionId: string): void {
    const sockets = this.clients.get(sessionId)
    const aborts = this.inFlight.get(sessionId)
    this.clients.delete(sessionId)
    this.inFlight.delete(sessionId)
    for (const socket of sockets ?? []) socket.destroy()
    for (const abort of aborts ?? []) abort()
  }

  endpointFor(sessionId: string, token: string): { http: string; ws: string } | null {
    if (this.port === null) return null
    const path = `/cdp/${sessionId}/${token}`
    return { http: `http://127.0.0.1:${this.port}${path}`, ws: `ws://127.0.0.1:${this.port}${path}` }
  }

  private route(req: IncomingMessage): { upstream: EndpointUpstream; rest: string; base: string } | null {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const parts = url.pathname.split('/')
    // ['', 'cdp', sessionId, token, ...rest]
    if (parts[1] !== 'cdp' || !parts[2] || !parts[3]) return null
    const sessionId = parts[2]
    const token = parts[3]
    if (!SESSION_ID.test(sessionId) || !TOKEN.test(token)) return null
    const upstream = this.options.resolve(sessionId, token)
    if (!upstream) return null
    const rest = '/' + parts.slice(4).join('/')
    return { upstream, rest: rest === '/' ? '/' : rest, base: `/cdp/${sessionId}/${token}` }
  }

  private upstreamHeaders(req: IncomingMessage, upstream: EndpointUpstream): Record<string, string | string[]> {
    const headers: Record<string, string | string[]> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      // Origin is the browser's own gate against web pages; the tunnel is not one.
      if (name === 'origin' || name === 'host' || name === 'authorization') continue
      headers[name] = value
    }
    headers.host = `${upstream.devtoolsHost}:${upstream.devtoolsPort}`
    return headers
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const routed = this.route(req)
    if (!routed) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unknown Client Browser session or wrong token' }))
      return
    }
    const { upstream, rest, base } = routed
    // stop() clears this.port while an answer may still be on its way.
    const port = this.port
    // Playwright appends `/json/version/`; chrome-remote-interface asks `/json/list`.
    // Only discovery is proxied over HTTP; everything else is the WebSocket.
    if (!rest.startsWith('/json')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'only /json discovery and the CDP WebSocket are served here' }))
      return
    }
    const upstreamReq = httpRequest(
      {
        host: upstream.devtoolsHost,
        port: upstream.devtoolsPort,
        method: req.method,
        path: rest,
        headers: this.upstreamHeaders(req, upstream)
      },
      (upstreamRes) => {
        const chunks: Buffer[] = []
        upstreamRes.on('data', (chunk: Buffer) => chunks.push(chunk))
        upstreamRes.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          const publicOrigin = `127.0.0.1:${port}${base}`
          const rewritten = body
            .split(`${upstream.devtoolsHost}:${upstream.devtoolsPort}`)
            .join(publicOrigin)
            .split(`localhost:${upstream.devtoolsPort}`)
            .join(publicOrigin)
          res.writeHead(upstreamRes.statusCode ?? 502, {
            'content-type': upstreamRes.headers['content-type'] ?? 'application/json; charset=UTF-8'
          })
          res.end(rewritten)
        })
        upstreamRes.on('error', () => {
          if (!res.headersSent) res.writeHead(502)
          res.end()
        })
      }
    )
    upstreamReq.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'the browser behind this session is not answering' }))
    })
    const release = this.add(this.inFlight, upstream.sessionId, () => {
      upstreamReq.destroy()
      res.destroy()
    })
    // Fires once the answer is out or the caller hung up first; only the latter leaves the upstream open.
    res.on('close', () => {
      release()
      if (!res.writableFinished) upstreamReq.destroy()
    })
    req.pipe(upstreamReq)
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const routed = this.route(req)
    if (!routed) {
      socket.end('HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
      return
    }
    const { upstream, rest } = routed
    // The base path is the browser endpoint; anything deeper (/devtools/page/<id>) is forwarded as-is.
    const upstreamPath = rest === '/' ? null : rest
    const upstreamSocket: Socket = (this.options.connect ?? connect)(upstream.devtoolsPort, upstream.devtoolsHost)
    const { sessionId } = upstream
    // Until the dial lands the pair is in flight: the caller, a release or
    // stop() may each end it, and whichever does takes the dial down too.
    const release = this.add(this.inFlight, sessionId, () => {
      socket.destroy()
      upstreamSocket.destroy()
    })
    const untrack = (): void => {
      release()
      this.remove(this.clients, sessionId, socket)
    }
    // Nothing reads an upgraded socket on its own, so a caller hanging up
    // mid-dial would go unnoticed; read it now and hold what arrives early.
    let dialling = true
    const early: Buffer[] = []
    const hold = (chunk: Buffer): void => {
      early.push(chunk)
    }
    socket.on('data', hold)
    socket.on('end', () => {
      if (dialling) socket.destroy()
    })
    upstreamSocket.on('error', () => socket.destroy())
    socket.on('close', () => {
      untrack()
      upstreamSocket.destroy()
    })
    upstreamSocket.on('close', () => {
      untrack()
      socket.destroy()
    })
    upstreamSocket.once('connect', () => {
      // A dial that lands after its caller, session or server is gone must not be forwarded.
      if (socket.destroyed || upstreamSocket.destroyed) return
      release()
      dialling = false
      socket.removeListener('data', hold)
      socket.pause()
      const path = upstreamPath ?? upstream.browserPath
      const headers = this.upstreamHeaders(req, upstream)
      const lines = [`GET ${path} HTTP/1.1`]
      for (const [name, value] of Object.entries(headers)) {
        for (const single of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${single}`)
      }
      upstreamSocket.write(lines.join('\r\n') + '\r\n\r\n')
      if (head.length > 0) upstreamSocket.write(head)
      for (const chunk of early) upstreamSocket.write(chunk)
      // From here on the two sockets are one wire: Chromium's 101 answer and
      // every frame after it pass through untouched.
      socket.pipe(upstreamSocket)
      upstreamSocket.pipe(socket)
      this.add(this.clients, sessionId, socket)
    })
  }

  /** Files `item` under its session; the returned callback takes it back out. */
  private add<T>(map: Map<string, Set<T>>, sessionId: string, item: T): () => void {
    let items = map.get(sessionId)
    if (!items) {
      items = new Set()
      map.set(sessionId, items)
    }
    items.add(item)
    return () => this.remove(map, sessionId, item)
  }

  private remove<T>(map: Map<string, Set<T>>, sessionId: string, item: T): void {
    const items = map.get(sessionId)
    if (!items) return
    items.delete(item)
    if (items.size === 0) map.delete(sessionId)
  }
}
