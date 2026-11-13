import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SimpleCdpClient } from '../browser/cdpClient'
import { ClientBrowserManager } from '../browser/clientBrowserManager'
import type { ClientBrowserLaunchRequest, ClientBrowserRuntime, LaunchedClientBrowser } from '../browser/runtime'
import { RoomOrchestrator } from '../orchestrator'
import { clientBrowserRepo } from '../store/clientBrowserRepo'
import { openDb, type Db } from '../store/db'
import { roomsRepo } from '../store/roomsRepo'
import { settingsRepo } from '../store/settingsRepo'
import { FakeAdbHost, FakeBackend, FakeGateway, listeningPort, makeRoom, tempDir } from './fakes'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

interface CdpRequest {
  id: number
  method: string
  params: Record<string, unknown>
  sessionId?: string
}

type CdpAnswer =
  | { result: unknown }
  | { error: { code?: number; message: string } }
  | 'hang'

interface MockCdpServer {
  port: number
  wsUrl: string
  received: CdpRequest[]
  sockets: Set<Duplex>
  upgradesReceived: number
  stallUpgrade: boolean
  holdCloseHandshake: boolean
  setHandler(handler: (req: CdpRequest, socket: Duplex, server: MockCdpServer) => CdpAnswer | Promise<CdpAnswer>): void
  sendEvent(method: string, params: Record<string, unknown>, sessionId?: string): void
  waitForMethod(method: string, timeoutMs?: number): Promise<CdpRequest>
  waitForUpgrade(timeoutMs?: number): Promise<void>
  close(): Promise<void>
}

function encodeTextFrame(payload: string): Buffer {
  const data = Buffer.from(payload, 'utf8')
  if (data.length < 126) {
    return Buffer.concat([Buffer.from([0x81, data.length]), data])
  }
  if (data.length < 65_536) {
    const header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(data.length, 2)
    return Buffer.concat([header, data])
  }
  const header = Buffer.alloc(10)
  header[0] = 0x81
  header[1] = 127
  header.writeBigUInt64BE(BigInt(data.length), 2)
  return Buffer.concat([header, data])
}

async function startMockCdpServer(initialPath = '/devtools/browser/mock'): Promise<MockCdpServer> {
  const received: CdpRequest[] = []
  const sockets = new Set<Duplex>()
  const methodWaiters = new Map<string, Array<(req: CdpRequest) => void>>()
  const upgradeWaiters: Array<() => void> = []
  let handler: (req: CdpRequest, socket: Duplex, server: MockCdpServer) => CdpAnswer | Promise<CdpAnswer> = () => ({ result: {} })

  const server: Server = createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })

  const mock: MockCdpServer = {
    port: 0,
    wsUrl: '',
    received,
    sockets,
    upgradesReceived: 0,
    stallUpgrade: false,
    holdCloseHandshake: false,
    setHandler(next) {
      handler = next
    },
    sendEvent(method, params, sessionId) {
      const msg: Record<string, unknown> = { method, params }
      if (sessionId !== undefined) msg.sessionId = sessionId
      const frame = encodeTextFrame(JSON.stringify(msg))
      for (const sock of sockets) {
        if (!sock.destroyed) sock.write(frame)
      }
    },
    waitForMethod(method, timeoutMs = 2_000) {
      const existing = received.find((r) => r.method === method)
      if (existing) return Promise.resolve(existing)
      return new Promise<CdpRequest>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for CDP method ${method}`))
        }, timeoutMs)
        const list = methodWaiters.get(method) ?? []
        list.push((req) => {
          clearTimeout(timer)
          resolve(req)
        })
        methodWaiters.set(method, list)
      })
    },
    waitForUpgrade(timeoutMs = 2_000) {
      if (mock.upgradesReceived > 0) return Promise.resolve()
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for WebSocket upgrade')), timeoutMs)
        upgradeWaiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    },
    async close() {
      for (const sock of sockets) sock.destroy()
      sockets.clear()
      await new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
    }
  }

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    mock.upgradesReceived += 1
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    for (const wake of upgradeWaiters.splice(0)) wake()

    if (mock.stallUpgrade) {
      return
    }

    const key = req.headers['sec-websocket-key']
    if (typeof key !== 'string') {
      socket.destroy()
      return
    }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
    )

    let buffer = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0)
    const processFrames = (): void => {
      while (buffer.length >= 2) {
        const byte0 = buffer[0]!
        const byte1 = buffer[1]!
        const opcode = byte0 & 0x0f
        const masked = (byte1 & 0x80) !== 0
        let length = byte1 & 0x7f
        let offset = 2
        if (length === 126) {
          if (buffer.length < 4) return
          length = buffer.readUInt16BE(2)
          offset = 4
        } else if (length === 127) {
          if (buffer.length < 10) return
          length = Number(buffer.readBigUInt64BE(2))
          offset = 10
        }
        const maskOffset = offset
        if (masked) offset += 4
        if (buffer.length < offset + length) return

        const payload = Buffer.from(buffer.subarray(offset, offset + length))
        if (masked) {
          const mask = buffer.subarray(maskOffset, maskOffset + 4)
          for (let i = 0; i < payload.length; i += 1) {
            payload[i] = payload[i]! ^ mask[i % 4]!
          }
        }
        buffer = buffer.subarray(offset + length)

        if (opcode === 0x8) {
          if (!mock.holdCloseHandshake && !socket.destroyed) {
            socket.write(Buffer.from([0x88, 0x00]))
            socket.end()
          }
          continue
        }
        if (opcode === 0x9) {
          if (!socket.destroyed) {
            const pong = Buffer.alloc(2 + payload.length)
            pong[0] = 0x8a
            pong[1] = payload.length
            payload.copy(pong, 2)
            socket.write(pong)
          }
          continue
        }
        if (opcode === 0x1) {
          const parsed = JSON.parse(payload.toString('utf8')) as CdpRequest
          received.push(parsed)
          const waiters = methodWaiters.get(parsed.method)
          if (waiters) {
            methodWaiters.delete(parsed.method)
            for (const wake of waiters) wake(parsed)
          }
          void Promise.resolve(handler(parsed, socket, mock)).then((answer) => {
            if (answer === 'hang' || socket.destroyed) return
            const response =
              'error' in answer
                ? { id: parsed.id, error: answer.error }
                : { id: parsed.id, result: answer.result }
            socket.write(encodeTextFrame(JSON.stringify(response)))
          })
        }
      }
    }

    if (buffer.length > 0) processFrames()
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      processFrames()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  mock.port = (server.address() as { port: number }).port
  mock.wsUrl = `ws://127.0.0.1:${mock.port}${initialPath}`
  return mock
}

async function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

class MockBackedBrowserRuntime implements ClientBrowserRuntime {
  readonly kind = 'mock-cdp'
  readonly stopped: string[] = []
  private readonly portByPid = new Map<number, { sessionId: string; port: number; wsUrl: string }>()
  private nextPid = 8000

  constructor(private readonly getServer: (sessionId: string) => MockCdpServer) {}

  async availability(): Promise<{ available: boolean; detail: string }> {
    return { available: true, detail: 'mock-cdp' }
  }

  async launch(request: ClientBrowserLaunchRequest): Promise<LaunchedClientBrowser> {
    const pid = this.nextPid++
    const server = this.getServer(request.sessionId)
    this.portByPid.set(pid, { sessionId: request.sessionId, port: server.port, wsUrl: server.wsUrl })
    return {
      pid,
      browserKind: 'chromium',
      devtoolsHost: '127.0.0.1',
      devtoolsPort: server.port,
      cdpWsUrl: server.wsUrl,
      stop: async () => {
        this.stopped.push(request.sessionId)
      }
    }
  }

  async probe(record: { pid: number | null }) {
    const entry = record.pid !== null ? this.portByPid.get(record.pid) : undefined
    const alive = entry !== undefined && !this.stopped.includes(entry.sessionId)
    return {
      processAlive: alive,
      cdpReachable: alive,
      cdpWsUrl: alive && entry ? entry.wsUrl : null,
      browserVersion: alive ? 'MockChrome/1.0' : null
    }
  }

  async stopOrphan(): Promise<boolean> {
    return true
  }
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup()
  }
})

describe('SimpleCdpClient bounded timeouts, session recovery, and immediate close', () => {
  it('times out hung CDP commands via options override, per-call override, and cleans up ws.send failures', async () => {
    const server = await startMockCdpServer()
    cleanups.push(() => server.close())

    server.setHandler((req) => {
      if (req.method === 'Target.getTargets') return 'hang'
      return { result: {} }
    })

    const shortClient = await SimpleCdpClient.connect(server.wsUrl, { commandTimeoutMs: 80 })
    cleanups.push(() => shortClient.close())
    await expect(within(shortClient.getTargets(), 600, 'getTargets')).rejects.toMatchObject({
      code: 'CDP_COMMAND_TIMEOUT'
    })

    // Page session setup works, then Page.navigate, Page.captureScreenshot, Runtime.evaluate hang.
    server.setHandler((req) => {
      if (req.method === 'Target.getTargets') {
        return { result: { targetInfos: [{ targetId: 'page-1', type: 'page', title: '', url: 'about:blank', attached: false }] } }
      }
      if (req.method === 'Target.attachToTarget') return { result: { sessionId: 'sess-1' } }
      if (req.method === 'Page.enable' || req.method === 'Runtime.enable') return { result: {} }
      if (req.method === 'Page.navigate' || req.method === 'Page.captureScreenshot' || req.method === 'Runtime.evaluate') {
        return 'hang'
      }
      return { result: {} }
    })

    await expect(within(shortClient.evaluate('1 + 1'), 600, 'evaluate')).rejects.toMatchObject({
      code: 'CDP_COMMAND_TIMEOUT'
    })
    await expect(within(shortClient.captureScreenshot(), 600, 'captureScreenshot')).rejects.toMatchObject({
      code: 'CDP_COMMAND_TIMEOUT'
    })
    await expect(within(shortClient.navigate('http://example.test/stuck'), 600, 'navigate')).rejects.toMatchObject({
      code: 'CDP_COMMAND_TIMEOUT'
    })

    // Per-call timeout overrides a much longer client default.
    const longClient = await SimpleCdpClient.connect(server.wsUrl, { commandTimeoutMs: 10_000 })
    cleanups.push(() => longClient.close())
    await expect(
      within(longClient.send('Runtime.evaluate', { expression: '1' }, undefined, 60), 600, 'per-call send override')
    ).rejects.toMatchObject({ code: 'CDP_COMMAND_TIMEOUT' })

    // Synchronous ws.send error leaves no pending request or timer behind.
    const internalWs = (longClient as unknown as { ws: { send: (data: string) => void } }).ws
    internalWs.send = () => {
      throw new Error('sync send failure')
    }
    await expect(longClient.send('Browser.getVersion')).rejects.toMatchObject({ code: 'CDP_SOCKET_ERROR' })
    expect((longClient as unknown as { pending: Map<number, unknown> }).pending.size).toBe(0)
  })

  it('bounds post-timeout navigation evaluation, preserves slow-normal title/url, clears timers, and keeps CDP_CLOSED', async () => {
    const server = await startMockCdpServer()
    cleanups.push(() => server.close())

    let evalMode: 'respond' | 'hang' | 'close-socket' = 'respond'
    server.setHandler((req, socket) => {
      if (req.method === 'Target.getTargets') {
        return { result: { targetInfos: [{ targetId: 'page-1', type: 'page', title: '', url: 'about:blank', attached: false }] } }
      }
      if (req.method === 'Target.attachToTarget') return { result: { sessionId: 'sess-1' } }
      if (req.method === 'Page.enable' || req.method === 'Runtime.enable') return { result: {} }
      if (req.method === 'Page.navigate') {
        if (req.params.url === 'http://example.test/fast') {
          queueMicrotask(() => server.sendEvent('Page.loadEventFired', {}, 'sess-1'))
        }
        return { result: { frameId: 'frame-1' } }
      }
      if (req.method === 'Runtime.evaluate') {
        if (evalMode === 'respond') {
          return {
            result: {
              result: {
                value: {
                  title: 'Slow Normal Page',
                  href: 'http://example.test/slow-final',
                  readyState: 'interactive'
                }
              }
            }
          }
        }
        if (evalMode === 'close-socket') {
          setTimeout(() => socket.destroy(), 15)
          return 'hang'
        }
        return 'hang'
      }
      return { result: {} }
    })

    const client = await SimpleCdpClient.connect(server.wsUrl)
    cleanups.push(() => client.close())

    // 1. Slow normal page: loadEventFired times out, Runtime.evaluate still answers with title & finalUrl.
    evalMode = 'respond'
    const slowResult = await within(client.navigate('http://example.test/slow', 80), 800, 'slow normal navigate')
    expect(slowResult).toEqual({
      loaded: false,
      title: 'Slow Normal Page',
      finalUrl: 'http://example.test/slow-final'
    })

    // 2. Frozen page after navigate timeout: Runtime.evaluate also hangs, resolves with loaded: false promptly.
    evalMode = 'hang'
    const frozenResult = await within(client.navigate('http://example.test/frozen', 80), 800, 'frozen navigate')
    expect(frozenResult).toEqual({
      loaded: false,
      title: '',
      finalUrl: 'http://example.test/frozen'
    })

    // 3. Fast page clears its load wait timer via clearTimeout instead of leaking a 30s timer.
    evalMode = 'respond'
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    const fastResult = await within(client.navigate('http://example.test/fast', 30_000), 800, 'fast navigate')
    expect(fastResult.loaded).toBe(true)
    const longTimerIdx = setTimeoutSpy.mock.calls.findIndex((call) => call[1] === 30_000)
    expect(longTimerIdx).toBeGreaterThanOrEqual(0)
    const longTimerHandle = setTimeoutSpy.mock.results[longTimerIdx]!.value
    expect(clearTimeoutSpy.mock.calls.some((call) => call[0] === longTimerHandle)).toBe(true)
    setTimeoutSpy.mockRestore()
    clearTimeoutSpy.mockRestore()

    // 4. Connection drop during post-timeout evaluate keeps CDP_CLOSED instead of swallowing it.
    evalMode = 'close-socket'
    await expect(within(client.navigate('http://example.test/drop', 60), 800, 'drop during eval')).rejects.toMatchObject({
      code: 'CDP_CLOSED'
    })
  })

  it('clears half-initialized pageSessionId when Page.enable or Runtime.enable fails and recovers on retry', async () => {
    const server = await startMockCdpServer()
    cleanups.push(() => server.close())

    let attachCount = 0
    let failRuntimeEnable = true
    server.setHandler((req) => {
      if (req.method === 'Target.getTargets') {
        return { result: { targetInfos: [{ targetId: 'page-1', type: 'page', title: '', url: 'about:blank', attached: false }] } }
      }
      if (req.method === 'Target.attachToTarget') {
        attachCount += 1
        return { result: { sessionId: `sess-${attachCount}` } }
      }
      if (req.method === 'Page.enable') return { result: {} }
      if (req.method === 'Runtime.enable') {
        if (failRuntimeEnable) {
          return { error: { code: -32000, message: 'Runtime domain failed' } }
        }
        return { result: {} }
      }
      if (req.method === 'Runtime.evaluate') {
        return { result: { result: { value: `ok:${req.sessionId}` } } }
      }
      return { result: {} }
    })

    const client = await SimpleCdpClient.connect(server.wsUrl, { commandTimeoutMs: 500 })
    cleanups.push(() => client.close())

    await expect(client.evaluate('1+1')).rejects.toMatchObject({ code: 'CDP_COMMAND_ERROR' })

    failRuntimeEnable = false
    const value = await within(client.evaluate<string>('1+1'), 800, 'recovered evaluate')
    expect(value).toBe('ok:sess-2')
    expect(attachCount).toBe(2)
  })

  it('close() rejects pending commands, navigate load waits, and stalled handshakes immediately with CDP_CLOSED', async () => {
    const server = await startMockCdpServer()
    cleanups.push(() => server.close())
    server.holdCloseHandshake = true

    server.setHandler((req) => {
      if (req.method === 'Target.getTargets') {
        return { result: { targetInfos: [{ targetId: 'page-1', type: 'page', title: '', url: 'about:blank', attached: false }] } }
      }
      if (req.method === 'Target.attachToTarget') return { result: { sessionId: 'sess-1' } }
      if (req.method === 'Page.enable' || req.method === 'Runtime.enable') return { result: {} }
      if (req.method === 'Page.navigate') return { result: { frameId: 'frame-1' } }
      if (req.method === 'Runtime.evaluate') return 'hang'
      return { result: {} }
    })

    const cmdClient = await SimpleCdpClient.connect(server.wsUrl)
    cleanups.push(() => cmdClient.close())
    const pendingEval = cmdClient.send('Runtime.evaluate', { expression: 'while(true){}' }, undefined, 30_000)
    await server.waitForMethod('Runtime.evaluate')
    cmdClient.close()
    await expect(within(pendingEval, 400, 'close wakes pending send')).rejects.toMatchObject({ code: 'CDP_CLOSED' })

    const navClient = await SimpleCdpClient.connect(server.wsUrl)
    cleanups.push(() => navClient.close())
    const pendingNav = navClient.navigate('http://example.test/hang-load', 30_000)
    await server.waitForMethod('Page.navigate')
    // Let Page.navigate response arrive so navigateOn is blocked inside the 30s load wait.
    await new Promise((resolve) => setTimeout(resolve, 30))
    navClient.close()
    await expect(within(pendingNav, 400, 'close wakes navigate load wait')).rejects.toMatchObject({ code: 'CDP_CLOSED' })

    const stalledServer = await startMockCdpServer('/devtools/browser/stalled')
    cleanups.push(() => stalledServer.close())
    stalledServer.stallUpgrade = true

    let connectingClient: SimpleCdpClient | null = null
    const pendingConnect = SimpleCdpClient.connect(stalledServer.wsUrl, {
      connectTimeoutMs: 30_000,
      onCreate: (created) => {
        connectingClient = created
      }
    })
    await stalledServer.waitForUpgrade()
    expect(connectingClient).not.toBeNull()
    connectingClient!.close()
    await expect(within(pendingConnect, 400, 'close wakes connecting handshake')).rejects.toMatchObject({
      code: 'CDP_CLOSED'
    })
  })
})

describe('ClientBrowserManager and RoomOrchestrator release/sleep/delete/shutdown during stuck CDP work', () => {
  async function setupOrchestrator(getServer: (sessionId: string) => MockCdpServer) {
    const userData = tempDir()
    const db: Db = openDb(userData)
    const backend = new FakeBackend()
    const listener = await listeningPort()
    backend.hostPort = listener.port
    const runtime = new MockBackedBrowserRuntime(getServer)
    const orch = new RoomOrchestrator({
      userData,
      backend,
      gateway: new FakeGateway().asGateway(),
      db,
      appVersion: 'test',
      adb: new FakeAdbHost([]),
      clientBrowserRuntime: runtime
    })
    await orch.init()
    cleanups.push(async () => {
      await orch.shutdown().catch(() => undefined)
      listener.close()
      db.close()
      rmSync(userData, { recursive: true, force: true })
    })
    return { userData, db, backend, runtime, orch }
  }

  function configureDefaultReadyServer(server: MockCdpServer, hangMethods: Set<string>) {
    server.setHandler((req) => {
      if (hangMethods.has(req.method)) return 'hang'
      if (req.method === 'Target.getTargets') {
        return { result: { targetInfos: [{ targetId: 'page-1', type: 'page', title: 'Test', url: 'about:blank', attached: false }] } }
      }
      if (req.method === 'Target.attachToTarget') return { result: { sessionId: 'sess-1' } }
      if (req.method === 'Page.enable' || req.method === 'Runtime.enable') return { result: {} }
      if (req.method === 'Page.navigate') return { result: { frameId: 'frame-1' } }
      if (req.method === 'Page.captureScreenshot') return { result: { data: 'iVBORw0KGgo=' } }
      if (req.method === 'Runtime.evaluate') return { result: { result: { value: 'ok' } } }
      return { result: {} }
    })
  }

  it('unblocks release immediately when navigate, screenshot, evaluate, inspect, or CDP connect is stuck', async () => {
    const server = await startMockCdpServer()
    cleanups.push(() => server.close())
    server.holdCloseHandshake = true
    const { runtime, orch } = await setupOrchestrator(() => server)

    orch.rooms.create(makeRoom({ id: 'rel00001', nickname: 'rel1', domain: 'rel1.localhost', status: 'ready' }))

    // 1. Stuck in navigate load wait (30s timeout)
    configureDefaultReadyServer(server, new Set())
    const navAlloc = await orch.clientBrowsers.allocate('rel00001')
    const stuckNav = orch.clientBrowsers.navigate(navAlloc.session.id, navAlloc.token, 'http://example.test/stuck', 30_000)
    const stuckNavDone = expect(within(stuckNav, 500, 'stuck navigate settles')).rejects.toThrow()
    await server.waitForMethod('Page.navigate')
    await new Promise((resolve) => setTimeout(resolve, 30))
    const navReleased = await within(orch.clientBrowsers.release(navAlloc.session.id, navAlloc.token), 1_000, 'release during navigate')
    expect(navReleased.released).toBe(true)
    expect(navReleased.processStopped).toBe(true)
    expect(runtime.stopped).toContain(navAlloc.session.id)
    await stuckNavDone

    // 2. Stuck in screenshot
    server.received.length = 0
    configureDefaultReadyServer(server, new Set(['Page.captureScreenshot']))
    const shotAlloc = await orch.clientBrowsers.allocate('rel00001')
    const stuckShot = orch.clientBrowsers.screenshot(shotAlloc.session.id, shotAlloc.token)
    const stuckShotDone = expect(within(stuckShot, 500, 'stuck screenshot settles')).rejects.toThrow()
    await server.waitForMethod('Page.captureScreenshot')
    const shotReleased = await within(orch.clientBrowsers.release(shotAlloc.session.id, shotAlloc.token), 1_000, 'release during screenshot')
    expect(shotReleased.processStopped).toBe(true)
    await stuckShotDone

    // 3. Stuck in evaluate
    server.received.length = 0
    configureDefaultReadyServer(server, new Set(['Runtime.evaluate']))
    const evalAlloc = await orch.clientBrowsers.allocate('rel00001')
    const stuckEval = orch.clientBrowsers.evaluate(evalAlloc.session.id, evalAlloc.token, 'while(true){}')
    const stuckEvalDone = expect(within(stuckEval, 500, 'stuck evaluate settles')).rejects.toThrow()
    await server.waitForMethod('Runtime.evaluate')
    const evalReleased = await within(orch.clientBrowsers.release(evalAlloc.session.id, evalAlloc.token), 1_000, 'release during evaluate')
    expect(evalReleased.processStopped).toBe(true)
    await stuckEvalDone

    // 4. Stuck in inspect (Target.getTargets hangs)
    server.received.length = 0
    configureDefaultReadyServer(server, new Set(['Target.getTargets']))
    const inspAlloc = await orch.clientBrowsers.allocate('rel00001')
    const stuckInspect = orch.clientBrowsers.inspect(inspAlloc.session.id, inspAlloc.token)
    const stuckInspectDone = within(stuckInspect.catch(() => undefined), 500, 'stuck inspect settles')
    await server.waitForMethod('Target.getTargets')
    const inspReleased = await within(orch.clientBrowsers.release(inspAlloc.session.id, inspAlloc.token), 1_000, 'release during inspect')
    expect(inspReleased.processStopped).toBe(true)
    await stuckInspectDone

    // 5. Stuck during SimpleCdpClient.connect (WS upgrade stalls)
    const stalledServer = await startMockCdpServer('/devtools/browser/stalled')
    cleanups.push(() => stalledServer.close())
    stalledServer.stallUpgrade = true
    const { orch: stalledOrch, runtime: stalledRuntime } = await setupOrchestrator(() => stalledServer)
    stalledOrch.rooms.create(makeRoom({ id: 'rel00002', nickname: 'rel2', domain: 'rel2.localhost', status: 'ready' }))
    const connAlloc = await stalledOrch.clientBrowsers.allocate('rel00002')
    const stuckConn = stalledOrch.clientBrowsers.evaluate(connAlloc.session.id, connAlloc.token, '1')
    const stuckConnDone = expect(within(stuckConn, 500, 'stuck connect settles')).rejects.toThrow()
    await stalledServer.waitForUpgrade()
    const connReleased = await within(
      stalledOrch.clientBrowsers.release(connAlloc.session.id, connAlloc.token),
      1_000,
      'release during stalled connect'
    )
    expect(connReleased.processStopped).toBe(true)
    expect(stalledRuntime.stopped).toContain(connAlloc.session.id)
    await stuckConnDone
  })

  it('unblocks sleepRoom, deleteRoom, and shutdown immediately when CDP operations are hung', async () => {
    const server = await startMockCdpServer()
    cleanups.push(() => server.close())
    server.holdCloseHandshake = true
    const { userData, runtime, orch } = await setupOrchestrator(() => server)

    // 1. sleepRoom while navigate is stuck waiting for loadEventFired
    configureDefaultReadyServer(server, new Set())
    orch.rooms.create(makeRoom({ id: 'slp00001', nickname: 'slp', domain: 'slp.localhost', status: 'ready' }))
    const sAlloc = await orch.clientBrowsers.allocate('slp00001')
    const stuckNav = orch.clientBrowsers.navigate(sAlloc.session.id, sAlloc.token, 'http://example.test/sleep', 30_000)
    const stuckNavDone = expect(within(stuckNav, 500, 'sleepRoom interrupted navigate')).rejects.toThrow()
    await server.waitForMethod('Page.navigate')
    await new Promise((resolve) => setTimeout(resolve, 30))

    await within(orch.sleepRoom('slp00001', 'user'), 1_000, 'sleepRoom during stuck navigate')
    expect(runtime.stopped).toContain(sAlloc.session.id)
    expect(orch.rooms.get('slp00001')?.status).toBe('sleeping')
    expect(orch.clientBrowsers.listForRoom('slp00001')).toEqual([])
    await stuckNavDone

    // 2. deleteRoom while screenshot is stuck (and cleans persistent profile)
    server.received.length = 0
    configureDefaultReadyServer(server, new Set(['Page.captureScreenshot']))
    orch.rooms.create(makeRoom({ id: 'del00001', nickname: 'del', domain: 'del.localhost', status: 'ready' }))
    const dAlloc = await orch.clientBrowsers.allocate('del00001', { profileMode: 'persistent' })
    const persistentDir = join(userData, 'client-browsers', 'persistent', 'del00001')
    mkdirSync(persistentDir, { recursive: true })
    writeFileSync(join(persistentDir, 'cookies.db'), 'data')
    const stuckShot = orch.clientBrowsers.screenshot(dAlloc.session.id, dAlloc.token)
    const stuckShotDone = expect(within(stuckShot, 500, 'deleteRoom interrupted screenshot')).rejects.toThrow()
    await server.waitForMethod('Page.captureScreenshot')

    await within(orch.deleteRoom('del00001', 'user'), 1_000, 'deleteRoom during stuck screenshot')
    expect(runtime.stopped).toContain(dAlloc.session.id)
    expect(orch.rooms.get('del00001')).toBeNull()
    expect(existsSync(persistentDir)).toBe(false)
    await stuckShotDone

    // 3. shutdown while evaluate is stuck
    server.received.length = 0
    configureDefaultReadyServer(server, new Set(['Runtime.evaluate']))
    orch.rooms.create(makeRoom({ id: 'sht00001', nickname: 'sht', domain: 'sht.localhost', status: 'ready' }))
    const shAlloc = await orch.clientBrowsers.allocate('sht00001')
    const stuckEval = orch.clientBrowsers.evaluate(shAlloc.session.id, shAlloc.token, 'while(true){}')
    const stuckEvalDone = expect(within(stuckEval, 500, 'shutdown interrupted evaluate')).rejects.toThrow()
    await server.waitForMethod('Runtime.evaluate')

    await within(orch.shutdown(), 1_000, 'shutdown during stuck evaluate')
    expect(runtime.stopped).toContain(shAlloc.session.id)
    expect(orch.clientBrowsers.listAll()).toEqual([])
    await stuckEvalDone
  })

  it('does not call repo.touch when a woken navigate or screenshot was already interrupted by release', async () => {
    const server = await startMockCdpServer()
    cleanups.push(() => server.close())
    const userData = tempDir()
    const db = openDb(userData)
    const repo = clientBrowserRepo(db)
    const touchCalls: string[] = []
    const origTouch = repo.touch.bind(repo)
    repo.touch = (id: string, at: string) => {
      touchCalls.push(`${id}:${at}`)
      origTouch(id, at)
    }

    const runtime = new MockBackedBrowserRuntime(() => server)
    const manager = new ClientBrowserManager({
      userData,
      repo,
      settings: settingsRepo(db),
      runtime,
      generation: 'gen-touch-guard',
      rooms: {
        get: (roomId) => {
          const room = roomsRepo(db).get(roomId)
          return room ? { id: room.id, project: room.project, nickname: room.nickname, status: room.status } : null
        }
      }
    })
    cleanups.push(async () => {
      await manager.shutdown().catch(() => undefined)
      db.close()
      rmSync(userData, { recursive: true, force: true })
    })

    roomsRepo(db).create(makeRoom({ id: 'tch00001', nickname: 'tch', domain: 'tch.localhost', status: 'ready' }))
    await manager.start()

    let resolveLateShot!: (ans: CdpAnswer) => void
    server.setHandler((req) => {
      if (req.method === 'Target.getTargets') {
        return { result: { targetInfos: [{ targetId: 'page-1', type: 'page', title: '', url: 'about:blank', attached: false }] } }
      }
      if (req.method === 'Target.attachToTarget') return { result: { sessionId: 'sess-1' } }
      if (req.method === 'Page.enable' || req.method === 'Runtime.enable') return { result: {} }
      if (req.method === 'Page.captureScreenshot') {
        return new Promise<CdpAnswer>((resolve) => {
          resolveLateShot = resolve
        })
      }
      return { result: {} }
    })

    const alloc = await manager.allocate('tch00001')
    const shotPromise = manager.screenshot(alloc.session.id, alloc.token)
    const shotDone = expect(within(shotPromise, 500, 'late-woken screenshot')).rejects.toMatchObject({
      code: 'CLIENT_BROWSER_NOT_LIVE'
    })
    await server.waitForMethod('Page.captureScreenshot')

    // Simulate the CDP answer hitting the wire right in the same turn as release().
    resolveLateShot({ result: { data: 'iVBORw0KGgo=' } })
    const releasePromise = manager.release(alloc.session.id, alloc.token)

    await shotDone
    await within(releasePromise, 500, 'release after late-woken screenshot')
    expect(touchCalls).toEqual([])

    // Also prove that even if cdp.navigate itself resolves concurrently with release(), repo.touch is never called.
    server.received.length = 0
    const alloc2 = await manager.allocate('tch00001')
    let releaseNav!: (value: { loaded: boolean; title: string; finalUrl: string }) => void
    let navEntered!: () => void
    const navEnteredPromise = new Promise<void>((resolve) => {
      navEntered = resolve
    })
    vi.spyOn(SimpleCdpClient.prototype, 'navigate').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseNav = resolve
          navEntered()
        })
    )
    const navPromise = manager.navigate(alloc2.session.id, alloc2.token, 'http://example.test/late-resolve', 5_000)
    const navDone = expect(within(navPromise, 500, 'post-resolve interrupted navigate')).rejects.toMatchObject({
      code: 'CLIENT_BROWSER_NOT_LIVE'
    })
    await navEnteredPromise
    const releasePromise2 = manager.release(alloc2.session.id, alloc2.token)
    releaseNav({ loaded: true, title: 'Late', finalUrl: 'http://example.test/late-resolve' })

    await navDone
    await within(releasePromise2, 500, 'release after resolved navigate')
    expect(touchCalls).toEqual([])
  })
})
