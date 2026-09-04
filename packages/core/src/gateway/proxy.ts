import http from 'node:http'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import type { RouteTable } from './routes'
import { connectRelay, createHttpRelayConnection } from '../relayProtocol'

export interface ProxyRequestOpts {
  tls: boolean
  httpPort: number | null
  httpsPort: number | null
}

export interface ProxyHandlers {
  request: (req: http.IncomingMessage, res: http.ServerResponse, opts: ProxyRequestOpts) => void
  upgrade: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void
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

export function createProxyHandlers(table: RouteTable): ProxyHandlers {
  return {
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

      const forward = (attempt: number): void => {
        let finished = false
        const target = http.request(
          {
            host: '127.0.0.1',
            port: route.targetPort,
            method: req.method,
            path: req.url,
            headers,
            createConnection: (_options, oncreate) =>
              createHttpRelayConnection(route.targetPort, route.relayToken, oncreate)
          },
          (targetRes) => {
            finished = true
            res.writeHead(targetRes.statusCode ?? 502, copyHeaders(targetRes.headers))
            targetRes.pipe(res)
          }
        )
        target.on('error', (err: NodeJS.ErrnoException) => {
          if (finished || res.headersSent) {
            res.destroy()
            return
          }
          // Transparently retry once if an idle keep-alive socket was closed by the upstream dev server
          const isIdempotent = !req.method || ['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase())
          if (attempt === 0 && isIdempotent && (target.reusedSocket || err.code === 'ECONNRESET')) {
            forward(attempt + 1)
            return
          }
          res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' })
          res.end(PAGE_502)
        })
        res.on('close', () => {
          if (!res.writableFinished) target.destroy()
        })
        if (attempt === 0) {
          req.pipe(target)
        } else {
          target.end()
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
      const target = connectRelay(route.targetPort, route.relayToken)
      target.setNoDelay(true)
      target.once('connect', () => {
        const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`]
        for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
          const name = req.rawHeaders[i]
          const value = req.rawHeaders[i + 1]
          if (name === undefined || value === undefined) continue
          lines.push(`${name}: ${value}`)
        }
        target.write(lines.join('\r\n') + '\r\n\r\n')
        if (head.length > 0) target.write(head)
        socket.pipe(target)
        target.pipe(socket)
      })
      target.on('error', () => socket.destroy())
      socket.on('error', () => target.destroy())
    }
  }
}
