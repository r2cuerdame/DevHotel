import http from 'node:http'
import https from 'node:https'
import type net from 'node:net'
import tls from 'node:tls'
import type { GatewayStatusInfo } from '@devhotel/shared'
import { ensureCa, issueLeafCert } from './ca'
import { createProxyHandlers } from './proxy'
import { RouteTable, type Route } from './routes'

const DEFAULT_DOMAIN = 'devhotel.localhost'

export function formatUrl(domain: string, useHttps: boolean, port: number | null): string {
  const standard = useHttps ? 443 : 80
  const suffix = port === null || port === standard ? '' : `:${port}`
  return `${useHttps ? 'https' : 'http'}://${domain}${suffix}`
}

export interface GatewayOptions {
  caDir: string
  httpPorts?: number[]
  httpsPorts?: number[]
}

export class Gateway {
  private readonly caDir: string
  private readonly httpCandidates: number[]
  private readonly httpsCandidates: number[]
  private readonly table = new RouteTable()
  private readonly contexts = new Map<string, tls.SecureContext>()
  private httpServer: http.Server | null = null
  private httpsServer: https.Server | null = null
  private httpIpv6Server: http.Server | null = null
  private httpsIpv6Server: https.Server | null = null
  private httpPort: number | null = null
  private httpsPort: number | null = null
  private running = false
  private caCertPem = ''
  private readonly openSockets = new Set<net.Socket>()

  constructor(opts: GatewayOptions) {
    this.caDir = opts.caDir
    this.httpCandidates = opts.httpPorts ?? [80, 8080]
    this.httpsCandidates = opts.httpsPorts ?? [443, 8443]
  }

  async start(): Promise<GatewayStatusInfo> {
    const ca = await ensureCa(this.caDir)
    this.caCertPem = ca.certPem
    const handlers = createProxyHandlers(this.table)
    const requestOpts = () => ({ httpPort: this.httpPort, httpsPort: this.httpsPort })

    this.httpServer = http.createServer((req, res) =>
      handlers.request(req, res, { tls: false, ...requestOpts() })
    )
    this.httpServer.on('upgrade', handlers.upgrade)
    this.trackConnections(this.httpServer)
    this.httpPort = await this.listenOnFirstFree(this.httpServer, this.httpCandidates, 'http')
    if (this.httpPort) {
      this.httpIpv6Server = http.createServer((req, res) =>
        handlers.request(req, res, { tls: false, ...requestOpts() })
      )
      this.httpIpv6Server.on('upgrade', handlers.upgrade)
      this.trackConnections(this.httpIpv6Server)
      await this.tryListen(this.httpIpv6Server, this.httpPort, '::1')
    }

    const defaultLeaf = await this.secureContextFor(DEFAULT_DOMAIN)
    const httpsServerOptions = {
      key: defaultLeaf.keyPem,
      cert: defaultLeaf.certPem + this.caCertPem,
      SNICallback: (servername: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void) => {
        const name = servername.toLowerCase()
        // only mint/serve certificates for routed rooms — an arbitrary
        // client-supplied SNI must not trigger keygen or disk writes
        if (name !== DEFAULT_DOMAIN && !this.table.byDomain(name)) {
          cb(new Error(`no room routed for ${name}`))
          return
        }
        this.secureContextFor(name).then(
          (leaf) => cb(null, leaf.context),
          (err) => cb(err as Error)
        )
      }
    }
    this.httpsServer = https.createServer(
      httpsServerOptions,
      (req, res) => handlers.request(req, res, { tls: true, ...requestOpts() })
    )
    this.httpsServer.on('upgrade', handlers.upgrade)
    this.trackConnections(this.httpsServer)
    this.httpsPort = await this.listenOnFirstFree(this.httpsServer, this.httpsCandidates, 'https')
    if (this.httpsPort) {
      this.httpsIpv6Server = https.createServer(
        httpsServerOptions,
        (req, res) => handlers.request(req, res, { tls: true, ...requestOpts() })
      )
      this.httpsIpv6Server.on('upgrade', handlers.upgrade)
      this.trackConnections(this.httpsIpv6Server)
      await this.tryListen(this.httpsIpv6Server, this.httpsPort, '::1')
    }

    this.running = true
    return this.status()
  }

  private async secureContextFor(
    domain: string
  ): Promise<{ context: tls.SecureContext; keyPem: string; certPem: string }> {
    const leaf = await issueLeafCert(this.caDir, domain)
    let context = this.contexts.get(domain)
    if (!context) {
      context = tls.createSecureContext({
        key: leaf.keyPem,
        cert: leaf.certPem + this.caCertPem
      })
      this.contexts.set(domain, context)
    }
    return { context, keyPem: leaf.keyPem, certPem: leaf.certPem }
  }

  private async listenOnFirstFree(
    server: http.Server | https.Server,
    candidates: number[],
    proto: string
  ): Promise<number | null> {
    for (const candidate of candidates) {
      const port = await new Promise<number | null>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          server.removeListener('listening', onListening)
          if (err.code === 'EADDRINUSE' || err.code === 'EACCES') resolve(null)
          else reject(err)
        }
        const onListening = () => {
          server.removeListener('error', onError)
          const addr = server.address()
          resolve(addr !== null && typeof addr === 'object' ? addr.port : candidate)
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(candidate, '127.0.0.1')
      })
      if (port !== null) return port
    }
    console.warn(`[devhotel] gateway: no free ${proto} port among [${candidates.join(', ')}]`)
    return null
  }

  // upgraded (WebSocket) sockets are not covered by closeAllConnections, so track them ourselves
  private trackConnections(server: http.Server | https.Server): void {
    server.on('connection', (socket: net.Socket) => {
      this.openSockets.add(socket)
      socket.on('close', () => this.openSockets.delete(socket))
    })
  }

  private tryListen(server: http.Server | https.Server, port: number, host: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const onListening = () => {
        server.removeListener('error', onError)
        resolve()
      }
      const onError = () => {
        server.removeListener('listening', onListening)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      try {
        server.listen(port, host)
      } catch {
        resolve()
      }
    })
  }

  async stop(): Promise<void> {
    const close = (server: http.Server | https.Server | null) =>
      new Promise<void>((resolve) => {
        if (!server || !server.listening) {
          resolve()
          return
        }
        server.close(() => resolve())
        server.closeAllConnections()
      })
    const closing = [
      close(this.httpServer),
      close(this.httpsServer),
      close(this.httpIpv6Server),
      close(this.httpsIpv6Server)
    ]
    for (const socket of this.openSockets) socket.destroy()
    this.openSockets.clear()
    await Promise.all(closing)
    this.httpServer = null
    this.httpsServer = null
    this.httpIpv6Server = null
    this.httpsIpv6Server = null
    this.httpPort = null
    this.httpsPort = null
    this.running = false
  }

  async setRoute(route: Route): Promise<void> {
    if (route.https) await this.secureContextFor(route.domain.toLowerCase())
    this.table.set(route)
  }

  removeRoute(domain: string): void {
    this.table.remove(domain)
    this.contexts.delete(domain.toLowerCase())
  }

  status(): GatewayStatusInfo {
    return {
      running: this.running,
      httpPort: this.httpPort,
      httpsPort: this.httpsPort,
      routes: this.table.list().map(({ domain, roomId, https: routeHttps }) => ({
        domain,
        roomId,
        https: routeHttps
      }))
    }
  }

  urlFor(domain: string, useHttps: boolean): string {
    return formatUrl(domain, useHttps, useHttps ? this.httpsPort : this.httpPort)
  }
}
