import http from 'node:http'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import type { Route, RouteTable } from './routes'
import { connectRelay, createHttpRelayConnection, type RelayDial } from '../relayProtocol'

export interface ProxyRequestOpts {
  tls: boolean
  httpPort: number | null
  httpsPort: number | null
}

export interface ProxyHandlers {
  request: (req: http.IncomingMessage, res: http.ServerResponse, opts: ProxyRequestOpts) => void
  upgrade: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void
  /** Closes every tunnel and in-flight request opened under this domain. */
  closeDomain: (domain: string) => void
  closeAll: () => void
}

function isHopByHop(name: string): boolean {
  const n = name.toLowerCase()
  return n === 'connection' || n === 'keep-alive' || n === 'transfer-encoding' || n.startsWith('proxy-')
}

function copyHeaders(source: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(source)) {
    if (isHopByHop(name) || value === undefined) continue
    out[name] = value
  }
  return out
}

function brandedPage(title: string, detail: string, autoReload = false): string {
  const reloadScript = autoReload
    ? '<meta http-equiv="refresh" content="2"><script>setTimeout(function(){location.reload()},2000)</script>'
    : ''
  return `<!doctype html><html><head><meta charset="utf-8">${reloadScript}<title>${title}</title><style>body{font-family:system-ui,sans-serif;background:#14121f;color:#e8e6f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}main{text-align:center;padding:2rem}h1{font-size:1.4rem;font-weight:600}p{color:#9a95b3}</style></head><body><main><h1>${title}</h1><p>${detail}</p></main></body></html>`
}

const PAGE_404 = brandedPage('DevHotel — no room at this address', 'No running room is registered for this domain.')
const PAGE_502 = brandedPage(
  'DevHotel — room not answering',
  'The room behind this domain did not respond. It may still be starting.<br><small style="color:#6e6987;display:inline-block;margin-top:0.5rem">Retrying automatically…</small>',
  true
)

export interface ProxyHandlerOptions {
  dial?: RelayDial
}

export function createProxyHandlers(table: RouteTable, handlerOpts: ProxyHandlerOptions = {}): ProxyHandlers {
  const { dial } = handlerOpts
  // Every tunnel and in-flight request, by routed domain, so revoking or
  // re-targeting a route can close what was opened under it.
  const live = new Map<string, Set<() => void>>()
  const track = (route: Route, close: () => void): (() => void) => {
    const domain = route.domain.toLowerCase()
    let closers = live.get(domain)
    if (!closers) {
      closers = new Set()
      live.set(domain, closers)
    }
    const owned = closers
    owned.add(close)
    return () => {
      owned.delete(close)
      if (owned.size === 0 && live.get(domain) === owned) live.delete(domain)
    }
  }
  const closeEach = (closers: Iterable<() => void>): void => {
    for (const close of [...closers]) close()
  }

  return {
    closeDomain(domain) {
      const closers = live.get(domain.toLowerCase())
      if (closers) closeEach(closers)
    },

    closeAll() {
      for (const closers of [...live.values()]) closeEach(closers)
    },

    request(req, res, opts) {
      req.socket.setNoDelay(true)
      const route = table.byDomain(req.headers.host)
      if (!route) {
        res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
        res.end(PAGE_404)
        return
      }
      if (route.https && !opts.tls) {
        const port = opts.httpsPort
        const suffix = port === null || port === 443 ? '' : `:${port}`
        res.writeHead(308, { location: `https://${route.domain}${suffix}${req.url ?? '/'}` })
        res.end()
        return
      }
      const headers = copyHeaders(req.headers)
      headers['x-forwarded-proto'] = opts.tls ? 'https' : 'http'
      headers['x-forwarded-host'] = req.headers.host ?? route.domain
      headers['x-forwarded-for'] = req.socket.remoteAddress ?? '127.0.0.1'

      // Aborted when the caller leaves early, the route is revoked or
      // re-targeted, or the gateway stops: the dial, the upstream request and
      // the caller response all close, and nothing is retried.
      const cancelled = new AbortController()
      let target: http.ClientRequest | null = null
      const cancel = (): void => {
        if (cancelled.signal.aborted) return
        cancelled.abort()
        untrack()
        if (target) {
          req.unpipe(target)
          target.destroy()
        }
        if (!res.writableFinished) res.destroy()
      }
      const untrack = track(route, cancel)
      res.once('close', () => {
        if (res.writableFinished) untrack()
        else cancel()
      })

      const forward = (attempt: number): void => {
        if (cancelled.signal.aborted) return
        let finished = false
        const current = http.request(
          {
            host: '127.0.0.1',
            port: route.targetPort,
            method: req.method,
            path: req.url,
            headers,
            createConnection: (_options, oncreate) =>
              createHttpRelayConnection(route.targetPort, route.relayToken, oncreate, {
                signal: cancelled.signal,
                dial
              })
          },
          (targetRes) => {
            finished = true
            res.writeHead(targetRes.statusCode ?? 502, copyHeaders(targetRes.headers))
            targetRes.pipe(res)
          }
        )
        target = current
        current.on('error', (err: NodeJS.ErrnoException) => {
          if (cancelled.signal.aborted) return
          if (finished || res.headersSent) {
            res.destroy()
            return
          }
          // Transparently retry once if an idle keep-alive socket was closed by the upstream dev server
          const isIdempotent = !req.method || ['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase())
          if (attempt === 0 && isIdempotent && (current.reusedSocket || err.code === 'ECONNRESET')) {
            forward(attempt + 1)
            return
          }
          res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' })
          res.end(PAGE_502)
        })
        if (attempt === 0) {
          req.pipe(current)
        } else {
          current.end()
        }
      }
      forward(0)
    },

    upgrade(req, socket, head) {
      if ('setNoDelay' in socket && typeof (socket as net.Socket).setNoDelay === 'function') {
        ;(socket as net.Socket).setNoDelay(true)
      }
      const route = table.byDomain(req.headers.host)
      if (!route) {
        socket.destroy()
        return
      }
      const target = connectRelay(route.targetPort, route.relayToken, dial)
      target.setNoDelay(true)
      let closed = false
      let connected = false
      // Destroying both sides together keeps neither end of the tunnel open
      // after the other goes; a destroyed dial never sends the upgrade.
      const close = (): void => {
        if (closed) return
        closed = true
        untrack()
        socket.destroy()
        target.destroy()
      }
      const untrack = track(route, close)
      // Read the caller while the relay dials, so a caller that leaves early
      // is noticed and its early bytes still reach the Room in order.
      const early: Buffer[] = []
      const keepEarly = (chunk: Buffer): void => {
        early.push(chunk)
      }
      socket.on('data', keepEarly)
      socket.resume()
      target.once('connect', () => {
        if (closed) return
        connected = true
        socket.removeListener('data', keepEarly)
        const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`]
        for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
          const name = req.rawHeaders[i]
          const value = req.rawHeaders[i + 1]
          if (name === undefined || value === undefined) continue
          lines.push(`${name}: ${value}`)
        }
        target.write(lines.join('\r\n') + '\r\n\r\n')
        if (head.length > 0) target.write(head)
        for (const chunk of early.splice(0)) target.write(chunk)
        socket.pipe(target, { end: false })
        target.pipe(socket, { end: false })
      })
      // A normal end on either side flushes what is queued for the other
      // side and then closes the whole tunnel.
      socket.once('end', () => {
        if (connected) target.end(close)
        else close()
      })
      target.once('end', () => socket.end(close))
      socket.once('close', close)
      target.once('close', close)
      socket.on('error', close)
      target.on('error', close)
    }
  }
}
