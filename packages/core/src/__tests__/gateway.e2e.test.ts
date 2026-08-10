import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Gateway } from '../gateway/gateway'
import { relayPreamble } from '../relayProtocol'

interface SimpleResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

function request(
  kind: 'http' | 'https',
  port: number,
  hostHeader: string,
  reqPath = '/'
): Promise<SimpleResponse> {
  return new Promise((resolve, reject) => {
    const options: https.RequestOptions = {
      host: '127.0.0.1',
      port,
      path: reqPath,
      headers: { host: hostHeader },
      agent: false
    }
    if (kind === 'https') {
      options.servername = hostHeader
      options.rejectUnauthorized = false
    }
    const onRes = (res: http.IncomingMessage) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    }
    const req = kind === 'https' ? https.request(options, onRes) : http.request(options, onRes)
    req.on('error', reject)
    req.end()
  })
}

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr === null || typeof addr !== 'object') reject(new Error('no address'))
      else resolve(addr.port)
    })
  })
}

let caDir: string
let gateway: Gateway
let httpPort: number
let httpsPort: number
let targetA: http.Server
let targetB: http.Server
let gatedTarget: net.Server
const GATED_TOKEN = 'd'.repeat(64)
const upgradeSockets = new Set<Duplex>()

beforeAll(async () => {
  caDir = await mkdtemp(path.join(os.tmpdir(), 'devhotel-gw-'))

  targetA = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/plain')
    res.end('room-a')
  })
  targetA.on('upgrade', (_req, socket) => {
    upgradeSockets.add(socket)
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.on('data', (d: Buffer) => socket.write(d))
  })
  const portA = await listen(targetA)

  targetB = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/plain')
    res.end('room-b')
  })
  const portB = await listen(targetB)

  gatedTarget = net.createServer((socket) => {
    let buffer = ''
    let authenticated = false
    let upgraded = false
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (!authenticated) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        if (buffer.slice(0, newline + 1) !== relayPreamble(GATED_TOKEN)) {
          socket.destroy()
          return
        }
        authenticated = true
        buffer = buffer.slice(newline + 1)
      }
      if (upgraded) {
        socket.write(buffer)
        buffer = ''
        return
      }
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const headers = buffer.slice(0, headerEnd + 4)
      const remainder = buffer.slice(headerEnd + 4)
      buffer = ''
      if (/\r\nupgrade:\s*websocket\r\n/i.test(headers)) {
        upgraded = true
        upgradeSockets.add(socket)
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
        if (remainder) socket.write(remainder)
        return
      }
      const body = 'gated-room'
      socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`)
    })
  })
  const gatedPort = await listen(gatedTarget)

  gateway = new Gateway({ caDir, httpPorts: [0], httpsPorts: [0] })
  const status = await gateway.start()
  expect(status.running).toBe(true)
  expect(status.httpPort).not.toBeNull()
  expect(status.httpsPort).not.toBeNull()
  httpPort = status.httpPort!
  httpsPort = status.httpsPort!

  await gateway.setRoute({ domain: 'a.localhost', roomId: 'room-a', targetPort: portA, https: false })
  await gateway.setRoute({ domain: 'b.localhost', roomId: 'room-b', targetPort: portB, https: true })
  await gateway.setRoute({
    domain: 'gated.localhost',
    roomId: 'room-gated',
    targetPort: gatedPort,
    https: false,
    relayToken: GATED_TOKEN
  })
}, 120000)

afterAll(async () => {
  await gateway.stop()
  for (const socket of upgradeSockets) socket.destroy()
  targetA.closeAllConnections()
  targetB.closeAllConnections()
  await new Promise((r) => targetA.close(r))
  await new Promise((r) => targetB.close(r))
  await new Promise<void>((resolve) => gatedTarget.close(() => resolve()))
  await rm(caDir, { recursive: true, force: true })
}, 30000)

describe('gateway e2e', () => {
  it('proxies http by Host header', async () => {
    const res = await request('http', httpPort, 'a.localhost')
    expect(res.status).toBe(200)
    expect(res.body).toBe('room-a')
  }, 30000)

  it('serves the branded 404 for unknown hosts', async () => {
    const res = await request('http', httpPort, 'nobody.localhost')
    expect(res.status).toBe(404)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toContain('DevHotel — no room at this address')
  }, 30000)

  it('308-redirects plain http to https for https routes', async () => {
    const res = await request('http', httpPort, 'b.localhost', '/some/path?q=1')
    expect(res.status).toBe(308)
    expect(res.headers.location).toBe(`https://b.localhost:${httpsPort}/some/path?q=1`)
  }, 30000)

  it('proxies https requests via SNI leaf certs', async () => {
    const res = await request('https', httpsPort, 'b.localhost')
    expect(res.status).toBe(200)
    expect(res.body).toBe('room-b')
  }, 30000)

  it('reports routes and urls in status', () => {
    const status = gateway.status()
    expect(status.routes).toContainEqual({ domain: 'a.localhost', roomId: 'room-a', https: false })
    expect(status.routes).toContainEqual({ domain: 'b.localhost', roomId: 'room-b', https: true })
    expect(gateway.urlFor('a.localhost', false)).toBe(`http://a.localhost:${httpPort}`)
    expect(gateway.urlFor('b.localhost', true)).toBe(`https://b.localhost:${httpsPort}`)
  })

  it('passes WebSocket upgrades through and echoes bytes', async () => {
    const sock = net.connect(httpPort, '127.0.0.1')
    await new Promise<void>((resolve, reject) => {
      sock.once('connect', () => resolve())
      sock.once('error', reject)
    })

    let buffer = ''
    const waitFor = (predicate: () => boolean) =>
      new Promise<void>((resolve, reject) => {
        const check = () => {
          if (predicate()) {
            sock.removeListener('data', onData)
            resolve()
          }
        }
        const onData = (d: Buffer) => {
          buffer += d.toString('utf8')
          check()
        }
        sock.on('data', onData)
        sock.once('error', reject)
        sock.once('close', () => reject(new Error('socket closed early')))
        check()
      })

    sock.write(
      'GET /ws HTTP/1.1\r\nHost: a.localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'
    )
    await waitFor(() => buffer.includes('\r\n\r\n'))
    expect(buffer).toContain('101 Switching Protocols')

    buffer = ''
    sock.write('ping-echo-42')
    await waitFor(() => buffer.includes('ping-echo-42'))
    sock.destroy()
  }, 30000)

  it('sends the relay capability before a gated WebSocket handshake and preserves upgraded bytes', async () => {
    const sock = net.connect(httpPort, '127.0.0.1')
    await new Promise<void>((resolve, reject) => {
      sock.once('connect', resolve)
      sock.once('error', reject)
    })

    let buffer = ''
    const waitFor = (needle: string) =>
      new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${needle}`)), 5000)
        const onData = (data: Buffer) => {
          buffer += data.toString('utf8')
          if (!buffer.includes(needle)) return
          clearTimeout(timeout)
          sock.removeListener('data', onData)
          resolve()
        }
        sock.on('data', onData)
        sock.once('error', reject)
      })

    sock.write(
      'GET /gated-ws HTTP/1.1\r\nHost: gated.localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'
    )
    await waitFor('101 Switching Protocols')
    buffer = ''
    sock.write('gated-ping-42')
    await waitFor('gated-ping-42')
    sock.destroy()
  }, 30000)

  it('authenticates gated relays and retains their host-only capability across a gateway restart', async () => {
    const first = await request('http', httpPort, 'gated.localhost')
    expect(first).toMatchObject({ status: 200, body: 'gated-room' })
    expect(gateway.status().routes.find((route) => route.roomId === 'room-gated')).toEqual({
      domain: 'gated.localhost',
      roomId: 'room-gated',
      https: false
    })

    await gateway.stop()
    const restarted = await gateway.start()
    httpPort = restarted.httpPort!
    httpsPort = restarted.httpsPort!
    const second = await request('http', httpPort, 'gated.localhost')
    expect(second).toMatchObject({ status: 200, body: 'gated-room' })
  }, 30000)
})
