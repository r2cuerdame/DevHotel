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
    for (const sockets of this.clients.values()) for (const socket of sockets) socket.destroy()
    this.clients.clear()
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /** Automation clients currently tunnelled for a session. */
  activeClients(sessionId: string): number {
    return this.clients.get(sessionId)?.size ?? 0
  }

  /** Drop every tunnelled client of a session; used when the session is released. */
  disconnect(sessionId: string): void {
    const sockets = this.clients.get(sessionId)
    if (!sockets) return
    for (const socket of sockets) socket.destroy()
    this.clients.delete(sessionId)
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
          const publicOrigin = `127.0.0.1:${this.port}${base}`
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
    const upstreamSocket: Socket = connect(upstream.devtoolsPort, upstream.devtoolsHost)
    upstreamSocket.on('error', () => socket.destroy())
    upstreamSocket.once('connect', () => {
      const path = upstreamPath ?? upstream.browserPath
      const headers = this.upstreamHeaders(req, upstream)
      const lines = [`GET ${path} HTTP/1.1`]
      for (const [name, value] of Object.entries(headers)) {
        for (const single of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${single}`)
      }
      upstreamSocket.write(lines.join('\r\n') + '\r\n\r\n')
      if (head.length > 0) upstreamSocket.write(head)
      // From here on the two sockets are one wire: Chromium's 101 answer and
      // every frame after it pass through untouched.
      socket.pipe(upstreamSocket)
      upstreamSocket.pipe(socket)
      this.track(upstream.sessionId, socket)
      const untrack = (): void => this.untrack(upstream.sessionId, socket)
      socket.on('close', () => {
        untrack()
        upstreamSocket.destroy()
      })
      upstreamSocket.on('close', () => {
        untrack()
        socket.destroy()
      })
    })
  }

  private track(sessionId: string, socket: Duplex): void {
    let sockets = this.clients.get(sessionId)
    if (!sockets) {
      sockets = new Set()
      this.clients.set(sessionId, sockets)
    }
    sockets.add(socket)
  }

  private untrack(sessionId: string, socket: Duplex): void {
    const sockets = this.clients.get(sessionId)
    if (!sockets) return
    sockets.delete(socket)
    if (sockets.size === 0) this.clients.delete(sessionId)
  }
}
