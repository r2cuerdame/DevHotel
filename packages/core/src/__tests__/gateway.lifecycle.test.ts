import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { Writable } from 'node:stream'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Gateway } from '../gateway/gateway'
import { createProxyHandlers } from '../gateway/proxy'
import { RouteTable, type Route } from '../gateway/routes'
import { RELAY_PREAMBLE_PREFIX } from '../relayProtocol'

/**
 * A Room relay stand-in: strips an optional DevHotel preamble, then serves
 * HTTP. `/wait` never answers, `/stream` sends headers and one chunk, and
 * upgrades echo bytes. Upstream sockets stay half-open on FIN on purpose, so
 * only the gateway can close its side of a finished tunnel.
 */
class Relay {
  readonly accepted: net.Socket[] = []
  readonly tokens: string[] = []
  readonly uploadChunks: string[] = []
  private readonly http = http.createServer({ requestTimeout: 0 }, (req, res) => {
    if (req.url === '/wait') return
    if (req.url === '/stream') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('first-chunk')
      return
    }
    if (req.url === '/stream-length') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '64' })
      res.write('first-chunk')
      return
    }
    if (req.url === '/upload') {
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => this.uploadChunks.push(chunk))
      req.on('error', () => {})
      return
    }
    res.end(`relay:${this.port}`)
  })
  private readonly net = net.createServer({ allowHalfOpen: true }, (socket) => this.accept(socket))
  port = 0

  constructor() {
    this.http.on('upgrade', (_req, socket, head) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
      if (head.length > 0) socket.write(head)
      socket.on('data', (d: Buffer) => socket.write(d))
      socket.on('error', () => {})
    })
  }

  async listen(): Promise<this> {
    this.port = await listen(this.net)
    return this
  }

  private accept(socket: net.Socket): void {
    this.accepted.push(socket)
    socket.on('error', () => {})
    let buffer = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      socket.removeListener('data', onData)
      socket.pause()
      const line = buffer.subarray(0, newline).toString('utf8')
      if (line.startsWith(RELAY_PREAMBLE_PREFIX)) {
        this.tokens.push(line.slice(RELAY_PREAMBLE_PREFIX.length))
        buffer = buffer.subarray(newline + 1)
      }
      if (buffer.length > 0) socket.unshift(buffer)
      this.http.emit('connection', socket)
      socket.resume()
    }
    socket.on('data', onData)
  }

  async close(): Promise<void> {
    for (const socket of this.accepted) socket.destroy()
    this.http.closeAllConnections()
    await new Promise<void>((resolve) => this.net.close(() => resolve()))
  }
}

/** Dialer that records every relay socket and can stall the dial in DNS lookup. */
class Dialer {
  readonly sockets: net.Socket[] = []
  stall = false
  private readonly stalled: Array<() => void> = []

  readonly dial = (port: number, host: string): net.Socket => {
    const socket = this.stall
      ? net.connect({
          port,
          host: 'stalled-relay.invalid',
          lookup: (_hostname, options, cb) => {
            this.stalled.push(() => {
              if ((options as { all?: boolean }).all) {
                ;(cb as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [
                  { address: host, family: 4 }
                ])
              } else cb(null, host, 4)
            })
          }
        })
      : net.connect(port, host)
    this.sockets.push(socket)
    return socket
  }

  get stalledCount(): number {
    return this.stalled.length
  }

  release(): void {
    for (const resume of this.stalled.splice(0)) resume()
  }
}

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port))
  })
}

async function waitUntil(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150))

interface Tunnel {
  socket: net.Socket
  closed: () => boolean
  echo: (text: string) => Promise<void>
}

function upgradeRequest(host: string): string {
  return `GET /ws HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`
}

async function connectClient(port: number): Promise<{ socket: net.Socket; text: () => string; closed: () => boolean }> {
  const socket = net.connect(port, '127.0.0.1')
  socket.on('error', () => {})
  let buffer = ''
  let isClosed = false
  socket.on('data', (d: Buffer) => (buffer += d.toString('utf8')))
  socket.on('close', () => (isClosed = true))
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  return { socket, text: () => buffer, closed: () => isClosed }
}

async function openTunnel(port: number, host: string): Promise<Tunnel> {
  const client = await connectClient(port)
  client.socket.write(upgradeRequest(host))
  await waitUntil(() => client.text().includes('101 Switching Protocols'), `${host} upgrade`)
  return {
    socket: client.socket,
    closed: client.closed,
    echo: async (text: string) => {
      client.socket.write(text)
      await waitUntil(() => client.text().includes(text), `${host} echo ${text}`)
    }
  }
}

interface PendingRequest {
  req: http.ClientRequest
  outcome: () => 'pending' | 'response' | 'error'
  status: () => number | null
  body: () => string
  responseEnded: () => boolean
  responseClosed: () => boolean
}

function startRequest(port: number, host: string, reqPath: string): PendingRequest {
  let outcome: 'pending' | 'response' | 'error' = 'pending'
  let status: number | null = null
  let body = ''
  let responseEnded = false
  let responseClosed = false
  const req = http.request({ host: '127.0.0.1', port, path: reqPath, headers: { host }, agent: false }, (res) => {
    outcome = 'response'
    status = res.statusCode ?? null
    res.setEncoding('utf8')
    res.on('data', (c: string) => (body += c))
    res.on('end', () => (responseEnded = true))
    res.on('error', () => {})
    res.on('close', () => (responseClosed = true))
  })
  req.on('error', () => {
    if (outcome === 'pending') outcome = 'error'
  })
  req.end()
  return {
    req,
    outcome: () => outcome,
    status: () => status,
    body: () => body,
    responseEnded: () => responseEnded,
    responseClosed: () => responseClosed
  }
}

let caDir: string
let relayA: Relay
let relayB: Relay
let gateway: Gateway
let dialer: Dialer
let port: number
const clients: net.Socket[] = []

function routeA(overrides: Partial<Route> = {}): Route {
  return { domain: 'a.localhost', roomId: 'room-a', targetPort: relayA.port, https: false, ...overrides }
}

beforeAll(async () => {
  caDir = await mkdtemp(path.join(os.tmpdir(), 'devhotel-gw-life-'))
  relayA = await new Relay().listen()
  relayB = await new Relay().listen()
}, 120000)

afterAll(async () => {
  await relayA.close()
  await relayB.close()
  await rm(caDir, { recursive: true, force: true })
}, 30000)

beforeEach(async () => {
  dialer = new Dialer()
  gateway = new Gateway({ caDir, httpPorts: [0], httpsPorts: [0], relayDial: dialer.dial })
  port = (await gateway.start()).httpPort!
  await gateway.setRoute(routeA())
  await gateway.setRoute({ domain: 'b.localhost', roomId: 'room-b', targetPort: relayB.port, https: false })
}, 60000)

afterEach(async () => {
  dialer.release()
  for (const socket of clients.splice(0)) socket.destroy()
  await gateway.stop()
})

const tunnel = async (host: string): Promise<Tunnel> => {
  const t = await openTunnel(port, host)
  clients.push(t.socket)
  return t
}

describe('gateway connection lifecycle', () => {
  it('closes live tunnels and their relay sockets when a route is removed, leaving other rooms alone', async () => {
    const a = await tunnel('a.localhost')
    const b = await tunnel('b.localhost')
    const relaySocket = dialer.sockets[0]!

    gateway.removeRoute('a.localhost')

    await waitUntil(() => a.closed(), 'caller socket closed')
    await waitUntil(() => relaySocket.destroyed, 'relay socket closed')
    await b.echo('b-still-alive')
  }, 30000)

  it('closes live tunnels and relay sockets when the gateway stops', async () => {
    await tunnel('a.localhost')
    const relaySocket = dialer.sockets[0]!

    await gateway.stop()

    await waitUntil(() => relaySocket.destroyed, 'relay socket closed')
  }, 30000)

  it('closes the relay side when the caller ends a tunnel normally', async () => {
    const a = await tunnel('a.localhost')
    const relaySocket = dialer.sockets[0]!

    a.socket.end()

    await waitUntil(() => relaySocket.destroyed, 'relay socket closed after caller FIN')
  }, 30000)

  it('closes the caller when the relay side of a tunnel closes', async () => {
    const a = await tunnel('a.localhost')
    await waitUntil(() => relayA.accepted.length > 0, 'relay accepted')
    relayA.accepted.at(-1)!.destroy()

    await waitUntil(() => a.closed(), 'caller closed after relay close')
  }, 30000)

  it('keeps bytes sent before the relay connects', async () => {
    dialer.stall = true
    const client = await connectClient(port)
    clients.push(client.socket)
    client.socket.write(upgradeRequest('a.localhost') + 'early-bytes')
    await waitUntil(() => dialer.stalledCount === 1, 'dial started')
    client.socket.write('-and-more')
    await settle()
    dialer.release()

    await waitUntil(() => client.text().includes('early-bytes-and-more'), 'early bytes echoed')
  }, 30000)

  const cancellations: Array<[string, (caller: net.Socket) => void]> = [
    ['the caller disconnects', (caller) => caller.destroy()],
    ['the route is removed', () => gateway.removeRoute('a.localhost')],
    ['the gateway stops', () => void gateway.stop()]
  ]
  for (const [label, cancel] of cancellations) {
    it(`never reaches the relay for an upgrade still dialing when ${label}`, async () => {
      dialer.stall = true
      const client = await connectClient(port)
      clients.push(client.socket)
      client.socket.write(upgradeRequest('a.localhost'))
      await waitUntil(() => dialer.stalledCount === 1, 'dial started')
      const accepted = relayA.accepted.length

      cancel(client.socket)
      await waitUntil(() => dialer.sockets[0]!.destroyed, 'dialing relay socket destroyed')
      dialer.release()
      await settle()

      expect(relayA.accepted.length).toBe(accepted)
    }, 30000)

    it(`cancels an HTTP request still dialing without retrying when ${label}`, async () => {
      dialer.stall = true
      const pending = startRequest(port, 'a.localhost', '/')
      await waitUntil(() => dialer.stalledCount === 1, 'dial started')
      const accepted = relayA.accepted.length

      if (label === 'the caller disconnects') pending.req.destroy()
      else cancel(pending.req.socket!)
      await waitUntil(() => dialer.sockets[0]!.destroyed, 'dialing relay socket destroyed')
      dialer.release()
      await settle()

      expect(relayA.accepted.length).toBe(accepted)
      expect(dialer.sockets).toHaveLength(1)
      expect(pending.outcome()).not.toBe('response')
    }, 30000)
  }

  it('aborts a waiting HTTP request and its relay socket when the route is removed', async () => {
    const pending = startRequest(port, 'a.localhost', '/wait')
    await waitUntil(() => dialer.sockets.length === 1 && relayA.accepted.length > 0, 'request reached relay')
    const relaySocket = dialer.sockets[0]!

    gateway.removeRoute('a.localhost')

    await waitUntil(() => pending.outcome() === 'error', 'caller request failed')
    await waitUntil(() => relaySocket.destroyed, 'relay socket closed')
    await settle()
    expect(dialer.sockets).toHaveLength(1)
  }, 30000)

  it('aborts a streaming HTTP response when the route is removed', async () => {
    const pending = startRequest(port, 'a.localhost', '/stream')
    await waitUntil(() => pending.body().includes('first-chunk'), 'first chunk streamed')
    const relaySocket = dialer.sockets[0]!

    gateway.removeRoute('a.localhost')

    await waitUntil(() => pending.responseClosed(), 'caller response closed')
    await waitUntil(() => relaySocket.destroyed, 'relay socket closed')
  }, 30000)

  it('keeps live tunnels when the same route is registered again', async () => {
    const a = await tunnel('a.localhost')

    await gateway.setRoute(routeA())
    await settle()

    expect(a.closed()).toBe(false)
    await a.echo('same-route')
  }, 30000)

  for (const [label, change] of [
    ['target port', () => ({ targetPort: relayB.port })],
    ['relay token', () => ({ relayToken: 'f'.repeat(64) })],
    ['https setting', () => ({ https: true })],
    ['room', () => ({ roomId: 'room-a2' })]
  ] as const) {
    it(`closes tunnels opened under the old ${label} when the route changes`, async () => {
      await gateway.setRoute(routeA({ relayToken: 'e'.repeat(64) }))
      const a = await tunnel('a.localhost')
      const b = await tunnel('b.localhost')
      const relaySocket = dialer.sockets[0]!

      await gateway.setRoute(routeA({ relayToken: 'e'.repeat(64), ...change() }))

      await waitUntil(() => a.closed(), 'old tunnel closed')
      await waitUntil(() => relaySocket.destroyed, 'old relay socket closed')
      await b.echo(`b-after-${label}`)
    }, 30000)
  }

  for (const [label, reqPath, reset] of [
    ['content-length', '/stream-length', false],
    ['content-length (RST)', '/stream-length', true],
    ['chunked', '/stream', false],
    ['chunked (RST)', '/stream', true]
  ] as const) {
    it(`closes the caller response without unhandled errors when upstream drops mid-${label} body`, async () => {
      const pending = startRequest(port, 'a.localhost', reqPath)
      await waitUntil(() => pending.body().includes('first-chunk'), `first chunk streamed (${label})`)
      const upstreamSocket = relayA.accepted.at(-1)!

      if (reset) upstreamSocket.resetAndDestroy()
      else upstreamSocket.destroy()

      await waitUntil(() => pending.responseClosed(), `caller response closed (${label})`)
      expect(pending.outcome()).toBe('response')
      expect(pending.responseEnded()).toBe(false)

      const followUp = startRequest(port, 'a.localhost', '/')
      await waitUntil(() => followUp.responseClosed(), 'follow-up response closed')
      expect(followUp.status()).toBe(200)
      expect(followUp.body()).toBe(`relay:${relayA.port}`)
    }, 30000)
  }

  it('closes the upstream connection without unhandled errors when caller aborts mid-POST body', async () => {
    const uploadsBefore = relayA.uploadChunks.length
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/upload',
      headers: { host: 'a.localhost', 'content-length': '100' },
      agent: false
    })
    req.on('error', () => {})
    req.write('first-part')

    await waitUntil(
      () => relayA.uploadChunks.slice(uploadsBefore).join('').includes('first-part'),
      'upstream received partial POST body'
    )
    const relaySocket = dialer.sockets[0]!

    req.destroy()

    await waitUntil(() => relaySocket.destroyed, 'relay socket closed after caller mid-POST abort')

    const followUp = startRequest(port, 'a.localhost', '/')
    await waitUntil(() => followUp.responseClosed(), 'follow-up response closed')
    expect(followUp.status()).toBe(200)
    expect(followUp.body()).toBe(`relay:${relayA.port}`)
  }, 30000)

  it('closes the upstream connection without unhandled errors when caller disconnects mid-response', async () => {
    const pending = startRequest(port, 'a.localhost', '/stream')
    await waitUntil(() => pending.body().includes('first-chunk'), 'first chunk streamed')
    const relaySocket = dialer.sockets[0]!

    pending.req.destroy()

    await waitUntil(() => relaySocket.destroyed, 'relay socket closed after caller mid-response abort')

    const followUp = startRequest(port, 'a.localhost', '/')
    await waitUntil(() => followUp.responseClosed(), 'follow-up response closed')
    expect(followUp.status()).toBe(200)
    expect(followUp.body()).toBe(`relay:${relayA.port}`)
  }, 30000)

  it('unpipes and destroys the failed first request before retrying once on ECONNRESET', async () => {
    let connections = 0
    const flakeyUpstream = net.createServer((socket) => {
      connections++
      socket.on('error', () => {})
      if (connections === 1) {
        socket.once('data', () => socket.destroy())
        return
      }
      socket.once('data', () => {
        const body = 'retried-ok'
        socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`)
      })
    })
    const flakeyPort = await listen(flakeyUpstream)
    const table = new RouteTable()
    table.set({ domain: 'retry.localhost', roomId: 'room-retry', targetPort: flakeyPort, https: false })
    const piped: Writable[] = []
    const unpiped: Writable[] = []
    let dialAttempts = 0
    let stateAtRetryDial: { unpipedFirst: boolean; destroyedFirst: boolean } | null = null
    const handlers = createProxyHandlers(table, {
      dial: (targetPort, host) => {
        dialAttempts++
        if (dialAttempts === 2 && piped[0]) {
          stateAtRetryDial = {
            unpipedFirst: unpiped.includes(piped[0]),
            destroyedFirst: piped[0].destroyed
          }
        }
        return dialer.dial(targetPort, host)
      }
    })

    const server = http.createServer((req, res) => {
      const origPipe = req.pipe.bind(req)
      const origUnpipe = req.unpipe.bind(req)
      req.pipe = ((dest: NodeJS.WritableStream, opts?: { end?: boolean }) => {
        piped.push(dest as Writable)
        return origPipe(dest, opts)
      }) as typeof req.pipe
      req.unpipe = ((dest?: NodeJS.WritableStream) => {
        if (dest) unpiped.push(dest as Writable)
        return origUnpipe(dest)
      }) as typeof req.unpipe
      handlers.request(req, res, { tls: false, httpPort: null, httpsPort: null })
    })
    const serverPort = await listen(server)
    try {
      const pending = startRequest(serverPort, 'retry.localhost', '/')
      await waitUntil(() => pending.responseClosed(), 'retried response closed')
      expect(pending.status()).toBe(200)
      expect(pending.body()).toBe('retried-ok')
      expect(connections).toBe(2)
      expect(dialer.sockets).toHaveLength(2)
      expect(piped).toHaveLength(1)
      expect(stateAtRetryDial).toEqual({ unpipedFirst: true, destroyedFirst: true })
    } finally {
      handlers.closeAll()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await new Promise<void>((resolve) => flakeyUpstream.close(() => resolve()))
    }
  }, 30000)

  it('handles req and res stream error events without uncaught exceptions and tears down the upstream socket', async () => {
    const table = new RouteTable()
    table.set(routeA())
    const handlers = createProxyHandlers(table, { dial: dialer.dial })
    const captured: Array<{ req: http.IncomingMessage; res: http.ServerResponse }> = []
    const server = http.createServer((req, res) => {
      captured.push({ req, res })
      handlers.request(req, res, { tls: false, httpPort: null, httpsPort: null })
    })
    const serverPort = await listen(server)
    try {
      const first = startRequest(serverPort, 'a.localhost', '/wait')
      await waitUntil(() => dialer.sockets.length === 1 && captured.length === 1, 'first /wait reached relay')
      const err1 = Object.assign(new Error('aborted'), { code: 'ECONNRESET' })
      expect(() => captured[0]!.req.emit('error', err1)).not.toThrow()
      await waitUntil(() => dialer.sockets[0]!.destroyed, 'first upstream closed after req error')
      await waitUntil(() => first.outcome() === 'error' || first.responseClosed(), 'first caller closed')

      const second = startRequest(serverPort, 'a.localhost', '/stream')
      await waitUntil(() => second.body().includes('first-chunk') && captured.length === 2, 'second /stream started')
      const err2 = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
      expect(() => captured[1]!.res.emit('error', err2)).not.toThrow()
      await waitUntil(() => dialer.sockets[1]!.destroyed, 'second upstream closed after res error')
      await waitUntil(() => second.responseClosed(), 'second caller response closed')
    } finally {
      handlers.closeAll()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 30000)

  it('serves 502 after at most one retry when ECONNRESET persists, and does not retry POST', async () => {
    let connections = 0
    const resetUpstream = net.createServer((socket) => {
      connections++
      socket.on('error', () => {})
      socket.once('data', () => socket.destroy())
    })
    const resetPort = await listen(resetUpstream)
    try {
      await gateway.setRoute({ domain: 'reset.localhost', roomId: 'room-reset', targetPort: resetPort, https: false })

      const getRes = startRequest(port, 'reset.localhost', '/')
      await waitUntil(() => getRes.responseClosed(), '502 GET response closed')
      expect(getRes.status()).toBe(502)
      expect(connections).toBe(2)
      expect(dialer.sockets).toHaveLength(2)

      const postStatus = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: '/',
            headers: { host: 'reset.localhost', 'content-length': '4' },
            agent: false
          },
          (res) => {
            res.resume()
            res.on('end', () => resolve(res.statusCode ?? 0))
          }
        )
        req.on('error', reject)
        req.end('body')
      })
      expect(postStatus).toBe(502)
      expect(connections).toBe(3)
      expect(dialer.sockets).toHaveLength(3)
    } finally {
      await new Promise<void>((resolve) => resetUpstream.close(() => resolve()))
    }
  }, 30000)
})
