import { createServer, request as httpRequest, Agent, type IncomingMessage, type Server } from 'node:http'
import { Socket, connect as netConnect } from 'node:net'
import type { Duplex } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { ClientBrowserEndpointServer, type EndpointUpstream } from '../browser/endpointServer'

/**
 * The endpoint server on its own, against a loopback stand-in for Chromium's
 * DevTools listener. No browser is launched: what is under test is that the
 * front door lets go of every socket it holds — answered keep-alive sockets,
 * discovery requests still waiting on the browser, and tunnels that have not
 * finished connecting — when a session is released or the server stops.
 */

const SESSION_A = 'cbr_aaaaaaaaaaaaaaaa'
const SESSION_B = 'cbr_bbbbbbbbbbbbbbbb'
const TOKEN_A = 'cbt_' + 'a'.repeat(32)
const TOKEN_B = 'cbt_' + 'b'.repeat(32)

interface FakeDevtools {
  server: Server
  port: number
  /** Requests the stand-in never answers, so the caller stays waiting. */
  held: IncomingMessage[]
  upgrades: string[]
}

async function startDevtools(): Promise<FakeDevtools> {
  const held: IncomingMessage[] = []
  const upgrades: string[] = []
  let port = 0
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/json/hang')) {
      held.push(req)
      return
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=UTF-8' })
    res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/abc` }))
  })
  server.on('upgrade', (req, socket) => {
    upgrades.push(req.url ?? '')
    socket.on('error', () => {})
    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n')
    socket.pipe(socket)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
  return { server, port, held, upgrades }
}

function upstreamFor(devtools: FakeDevtools, sessionId: string): EndpointUpstream {
  return { sessionId, devtoolsHost: '127.0.0.1', devtoolsPort: devtools.port, browserPath: '/devtools/browser/abc' }
}

function resolverFor(devtools: FakeDevtools, released: Set<string> = new Set()) {
  return (sessionId: string, token: string): EndpointUpstream | null => {
    if (released.has(sessionId)) return null
    if (sessionId === SESSION_A && token === TOKEN_A) return upstreamFor(devtools, SESSION_A)
    if (sessionId === SESSION_B && token === TOKEN_B) return upstreamFor(devtools, SESSION_B)
    return null
  }
}

/** A connect() whose TCP dials wait until the test opens the gate. */
function gatedConnect(): {
  connect: (port: number, host: string) => Socket
  sockets: Socket[]
  open: () => void
  close: () => void
} {
  const sockets: Socket[] = []
  const pending: Array<() => void> = []
  let opened = false
  return {
    sockets,
    connect: (port, host) => {
      const socket = new Socket()
      sockets.push(socket)
      const dial = (): void => {
        // A destroyed net.Socket can be dialled again; the endpoint must not rely on that.
        if (!socket.destroyed) socket.connect(port, host)
      }
      if (opened) dial()
      else pending.push(dial)
      return socket
    },
    open: () => {
      opened = true
      for (const dial of pending.splice(0)) dial()
    },
    close: () => {
      opened = false
    }
  }
}

function getJson(port: number, path: string, agent?: Agent): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, agent }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

/** Starts a request that will not be answered; resolves when the caller's side closes. */
function hangingJson(port: number, path: string): { closed: Promise<void>; isClosed: () => boolean } {
  let closed = false
  const req = httpRequest({ host: '127.0.0.1', port, path, agent: false })
  req.on('error', () => {})
  const done = new Promise<void>((resolve) => {
    req.on('close', () => {
      closed = true
      resolve()
    })
  })
  req.end()
  return { closed: done, isClosed: () => closed }
}

/** Raw upgrade request; the socket is returned before any answer arrives. */
function rawUpgrade(port: number, sessionId: string, token: string): Socket {
  const socket = netConnect(port, '127.0.0.1')
  socket.on('error', () => {})
  socket.write(
    `GET /cdp/${sessionId}/${token} HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n`
  )
  return socket
}

function waitClosed(socket: Duplex): Promise<void> {
  if (socket.destroyed) return Promise.resolve()
  return new Promise((resolve) => socket.once('close', () => resolve()))
}

async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms}ms`)), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function until(check: () => boolean, ms = 2_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return check()
}

/** Opens a working tunnel and returns the client side once the 101 is read. */
async function openTunnel(port: number, sessionId: string, token: string): Promise<Socket> {
  const socket = rawUpgrade(port, sessionId, token)
  await new Promise<void>((resolve, reject) => {
    let seen = ''
    const onData = (chunk: Buffer): void => {
      seen += chunk.toString('latin1')
      if (seen.includes('\r\n\r\n')) {
        socket.removeListener('data', onData)
        if (seen.startsWith('HTTP/1.1 101')) resolve()
        else reject(new Error(seen))
      }
    }
    socket.on('data', onData)
  })
  return socket
}

async function echo(socket: Socket, text: string): Promise<string> {
  return new Promise((resolve) => {
    socket.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')))
    socket.write(text)
  })
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(options: { connect?: (port: number, host: string) => Socket; released?: Set<string> } = {}) {
  const devtools = await startDevtools()
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        devtools.server.closeAllConnections()
        devtools.server.close(() => resolve())
      })
  )
  const endpoint = new ClientBrowserEndpointServer({
    resolve: resolverFor(devtools, options.released),
    connect: options.connect
  })
  const port = await endpoint.start()
  cleanups.push(() => endpoint.stop())
  return { devtools, endpoint, port }
}

describe('ClientBrowserEndpointServer', () => {
  it('rewrites discovery to point back through itself and tunnels the WebSocket', async () => {
    const { devtools, endpoint, port } = await setup()
    const answer = await getJson(port, `/cdp/${SESSION_A}/${TOKEN_A}/json/version`)
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.body).webSocketDebuggerUrl).toBe(
      `ws://127.0.0.1:${port}/cdp/${SESSION_A}/${TOKEN_A}/devtools/browser/abc`
    )
    expect(answer.body).not.toContain(`:${devtools.port}`)

    const tunnel = await openTunnel(port, SESSION_A, TOKEN_A)
    expect(await echo(tunnel, 'frame')).toBe('frame')
    expect(devtools.upgrades).toEqual(['/devtools/browser/abc'])
    expect(endpoint.activeClients(SESSION_A)).toBe(1)
    tunnel.destroy()
    expect(await until(() => endpoint.activeClients(SESSION_A) === 0)).toBe(true)
  })

  it('stops at once with an idle keep-alive socket and a discovery request still waiting', async () => {
    const { devtools, endpoint, port } = await setup()
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })
    cleanups.push(() => agent.destroy())
    await getJson(port, `/cdp/${SESSION_A}/${TOKEN_A}/json/version`, agent)
    const waiting = hangingJson(port, `/cdp/${SESSION_A}/${TOKEN_A}/json/hang`)
    expect(await until(() => devtools.held.length === 1)).toBe(true)

    await within(endpoint.stop(), 1_000, 'stop()')
    await within(waiting.closed, 1_000, 'the waiting discovery request')
    expect(endpoint.listeningPort).toBeNull()
    expect(await until(() => devtools.held[0]!.destroyed)).toBe(true)
  })

  it('stop() closes a tunnel that is still connecting and never forwards it afterwards', async () => {
    const gate = gatedConnect()
    const { devtools, endpoint, port } = await setup({ connect: gate.connect })
    const client = rawUpgrade(port, SESSION_A, TOKEN_A)
    expect(await until(() => gate.sockets.length === 1)).toBe(true)

    await within(endpoint.stop(), 1_000, 'stop()')
    await within(waitClosed(client), 1_000, 'the connecting client')
    expect(gate.sockets[0]!.destroyed).toBe(true)
    gate.open()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(devtools.upgrades).toEqual([])
    expect(endpoint.activeClients(SESSION_A)).toBe(0)
  })

  it('releasing a session closes its connecting tunnels and waiting requests, and only its own', async () => {
    const gate = gatedConnect()
    const released = new Set<string>()
    const { devtools, endpoint, port } = await setup({ connect: gate.connect, released })

    // Session B is healthy: a live tunnel and a discovery answer that still works afterwards.
    gate.open()
    const tunnelB = await openTunnel(port, SESSION_B, TOKEN_B)
    expect(endpoint.activeClients(SESSION_B)).toBe(1)
    const waitingB = hangingJson(port, `/cdp/${SESSION_B}/${TOKEN_B}/json/hang`)
    expect(await until(() => devtools.held.length === 1)).toBe(true)

    // Session A: a tunnel stuck dialling and a discovery request still waiting.
    gate.close()
    const clientA = rawUpgrade(port, SESSION_A, TOKEN_A)
    expect(await until(() => gate.sockets.length === 2)).toBe(true)
    const waitingA = hangingJson(port, `/cdp/${SESSION_A}/${TOKEN_A}/json/hang`)
    expect(await until(() => devtools.held.length === 2)).toBe(true)

    released.add(SESSION_A)
    endpoint.disconnect(SESSION_A)
    await within(waitClosed(clientA), 1_000, 'the connecting session A client')
    await within(waitingA.closed, 1_000, 'the waiting session A request')
    expect(gate.sockets[1]!.destroyed).toBe(true)
    gate.open()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(endpoint.activeClients(SESSION_A)).toBe(0)
    expect(devtools.upgrades).toEqual(['/devtools/browser/abc'])

    // Session B is untouched.
    expect(waitingB.isClosed()).toBe(false)
    expect(endpoint.activeClients(SESSION_B)).toBe(1)
    expect(await echo(tunnelB, 'still here')).toBe('still here')
    const answerB = await getJson(port, `/cdp/${SESSION_B}/${TOKEN_B}/json/version`)
    expect(JSON.parse(answerB.body).webSocketDebuggerUrl).toBe(
      `ws://127.0.0.1:${port}/cdp/${SESSION_B}/${TOKEN_B}/devtools/browser/abc`
    )
    tunnelB.destroy()
  })

  it('drops the upstream dial when the caller hangs up before it connects', async () => {
    const gate = gatedConnect()
    const { devtools, endpoint, port } = await setup({ connect: gate.connect })
    const client = rawUpgrade(port, SESSION_A, TOKEN_A)
    expect(await until(() => gate.sockets.length === 1)).toBe(true)

    client.destroy()
    expect(await until(() => gate.sockets[0]!.destroyed, 1_000)).toBe(true)
    gate.open()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(devtools.upgrades).toEqual([])
    expect(endpoint.activeClients(SESSION_A)).toBe(0)
  })

  it('aborts the upstream discovery request when the caller hangs up', async () => {
    const { devtools, port } = await setup()
    const req = httpRequest({ host: '127.0.0.1', port, path: `/cdp/${SESSION_A}/${TOKEN_A}/json/hang`, agent: false })
    req.on('error', () => {})
    req.end()
    expect(await until(() => devtools.held.length === 1)).toBe(true)
    req.destroy()
    expect(await until(() => devtools.held[0]!.destroyed, 1_000)).toBe(true)
  })
})
