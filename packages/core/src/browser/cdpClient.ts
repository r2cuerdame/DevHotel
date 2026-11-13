import { DevHotelError } from '../errors'

export interface CdpTarget {
  targetId: string
  type: string
  title: string
  url: string
  attached: boolean
  browserContextId?: string
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000
const POST_NAVIGATE_TIMEOUT_MAX_EVAL_MS = 2_000
const POST_NAVIGATE_TIMEOUT_MIN_EVAL_MS = 100

export interface SimpleCdpClientOptions {
  connectTimeoutMs?: number
  commandTimeoutMs?: number
  /** Invoked synchronously before WebSocket creation so owners can call close() mid-handshake. */
  onCreate?: (client: SimpleCdpClient) => void
}

type Pending = {
  resolve: (value: any) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

function normalizeTimeoutMs(timeoutMs: number | undefined, fallback: number): number {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) return fallback
  return Math.max(1, Math.floor(timeoutMs))
}

function isStaleSessionError(error: unknown): boolean {
  if (!(error instanceof DevHotelError) || error.code !== 'CDP_COMMAND_ERROR') return false
  return /session with given id not found|target closed|no target with given id/i.test(error.message)
}
type EventHandler = (params: any, sessionId: string | undefined) => void

/**
 * The smallest CDP client DevHotel needs for its own operations: one
 * browser-level socket, flat sessions, request/response matching and event
 * subscription. Agents bring their own client (Playwright, puppeteer, raw
 * CDP) through the session endpoint; this one only serves navigate,
 * screenshot, inspect and the graceful close.
 */
export class SimpleCdpClient {
  private ws: WebSocket | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly handlers = new Map<string, Set<EventHandler>>()
  private readonly closeWaiters = new Set<() => void>()
  private pageSessionId: string | null = null
  private closed = false

  private constructor(
    private readonly wsUrl: string,
    private readonly commandTimeoutMs: number,
    private readonly hasCustomCommandTimeout: boolean
  ) {}

  static async connect(
    wsUrl: string,
    timeoutMsOrOptions: number | SimpleCdpClientOptions = DEFAULT_CONNECT_TIMEOUT_MS
  ): Promise<SimpleCdpClient> {
    const options: SimpleCdpClientOptions =
      typeof timeoutMsOrOptions === 'number' ? { connectTimeoutMs: timeoutMsOrOptions } : timeoutMsOrOptions
    const hasCustomCommandTimeout =
      typeof options.commandTimeoutMs === 'number' && Number.isFinite(options.commandTimeoutMs)
    const connectTimeoutMs = normalizeTimeoutMs(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS)
    const commandTimeoutMs = normalizeTimeoutMs(options.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS)
    const client = new SimpleCdpClient(wsUrl, commandTimeoutMs, hasCustomCommandTimeout)
    options.onCreate?.(client)
    await client.open(connectTimeoutMs)
    return client
  }

  get isOpen(): boolean {
    return !this.closed && this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  private onClose(listener: () => void): () => void {
    if (this.closed) {
      queueMicrotask(listener)
      return () => {}
    }
    this.closeWaiters.add(listener)
    return () => {
      this.closeWaiters.delete(listener)
    }
  }

  private rejectAllPending(error: Error): void {
    const entries = Array.from(this.pending.values())
    this.pending.clear()
    for (const entry of entries) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
  }

  private markClosed(expectedWs: WebSocket | null, error: Error): void {
    if (this.closed) return
    if (expectedWs && this.ws && this.ws !== expectedWs) return
    this.closed = true
    this.ws = null
    this.pageSessionId = null
    this.rejectAllPending(error)
    const waiters = Array.from(this.closeWaiters)
    this.closeWaiters.clear()
    for (const waiter of waiters) {
      waiter()
    }
  }

  private open(timeoutMs: number): Promise<void> {
    if (this.closed) {
      return Promise.reject(new DevHotelError('CDP_CLOSED', 'CDP connection closed before it opened'))
    }
    return new Promise((resolve, reject) => {
      let settled = false
      let offClose: (() => void) | null = null
      const finishReject = (error: Error): void => {
        clearTimeout(timer)
        offClose?.()
        offClose = null
        if (settled) return
        settled = true
        reject(error)
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        offClose?.()
        offClose = null
        this.close()
        reject(new DevHotelError('CDP_CONNECT_TIMEOUT', `Timed out connecting to CDP at ${this.wsUrl}`))
      }, timeoutMs)

      offClose = this.onClose(() => {
        finishReject(new DevHotelError('CDP_CLOSED', 'CDP connection closed before it opened'))
      })

      let ws: WebSocket
      try {
        ws = new WebSocket(this.wsUrl)
      } catch (error) {
        finishReject(
          new DevHotelError(
            'CDP_SOCKET_ERROR',
            `CDP WebSocket could not be created: ${error instanceof Error ? error.message : String(error)}`
          )
        )
        return
      }
      this.ws = ws

      ws.addEventListener('open', () => {
        clearTimeout(timer)
        offClose?.()
        offClose = null
        if (settled || this.closed) {
          if (!settled) {
            settled = true
            reject(new DevHotelError('CDP_CLOSED', 'CDP connection closed before it opened'))
          }
          try {
            ws.close()
          } catch {
            // already closed
          }
          return
        }
        settled = true
        resolve()
      })
      ws.addEventListener('error', () => {
        finishReject(new DevHotelError('CDP_SOCKET_ERROR', `CDP WebSocket connection to ${this.wsUrl} failed`))
      })
      ws.addEventListener('close', () => {
        if (this.ws !== null && this.ws !== ws) return
        clearTimeout(timer)
        offClose?.()
        offClose = null
        this.markClosed(ws, new DevHotelError('CDP_CLOSED', 'CDP connection closed'))
        if (!settled) {
          settled = true
          reject(new DevHotelError('CDP_CLOSED', 'CDP connection closed before it opened'))
        }
      })
      ws.addEventListener('message', (event) => {
        let data: any
        try {
          data = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
        } catch {
          return
        }
        if (typeof data.id === 'number' && this.pending.has(data.id)) {
          const entry = this.pending.get(data.id)!
          this.pending.delete(data.id)
          clearTimeout(entry.timer)
          if (data.error) {
            entry.reject(new DevHotelError('CDP_COMMAND_ERROR', data.error.message ?? 'Unknown CDP error', { evidence: data.error }))
          } else {
            entry.resolve(data.result)
          }
          return
        }
        if (typeof data.method === 'string') {
          // An agent on the endpoint may close the page we attached to; the
          // next operation then attaches to (or creates) another one.
          if (data.method === 'Target.detachedFromTarget' && data.params?.sessionId === this.pageSessionId) {
            this.pageSessionId = null
          }
          const handlers = this.handlers.get(data.method)
          if (handlers) for (const handler of handlers) handler(data.params, data.sessionId)
        }
      })
    })
  }

  on(method: string, handler: EventHandler): () => void {
    let handlers = this.handlers.get(method)
    if (!handlers) {
      handlers = new Set()
      this.handlers.set(method, handlers)
    }
    handlers.add(handler)
    return () => {
      handlers.delete(handler)
    }
  }

  async send<T = any>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs?: number
  ): Promise<T> {
    if (this.closed) {
      throw new DevHotelError('CDP_CLOSED', 'CDP connection closed')
    }
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new DevHotelError('CDP_NOT_CONNECTED', 'CDP WebSocket is not open')
    }
    const id = this.nextId++
    const payload: Record<string, unknown> = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    const serialized = JSON.stringify(payload)
    const effectiveTimeoutMs = normalizeTimeoutMs(timeoutMs, this.commandTimeoutMs)
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return
        reject(
          new DevHotelError('CDP_COMMAND_TIMEOUT', `Timed out waiting for CDP ${method} after ${effectiveTimeoutMs}ms`, {
            httpStatus: 504,
            recoveryHint: 'The target page or browser did not respond in time; retry or release the session.'
          })
        )
      }, effectiveTimeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        ws.send(serialized)
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(
          new DevHotelError(
            'CDP_SOCKET_ERROR',
            `CDP WebSocket send failed: ${error instanceof Error ? error.message : String(error)}`
          )
        )
      }
    })
  }

  async getVersion(timeoutMs?: number): Promise<{ product: string; protocolVersion: string; userAgent: string }> {
    const result = await this.send('Browser.getVersion', {}, undefined, timeoutMs)
    return {
      product: result?.product ?? 'unknown',
      protocolVersion: result?.protocolVersion ?? 'unknown',
      userAgent: result?.userAgent ?? 'unknown'
    }
  }

  async getTargets(timeoutMs?: number): Promise<CdpTarget[]> {
    const result = await this.send<{ targetInfos: CdpTarget[] }>('Target.getTargets', {}, undefined, timeoutMs)
    return result?.targetInfos ?? []
  }

  /** Attach to the first page (creating one if the browser has none) and enable the domains navigate/screenshot need. */
  async ensurePageSession(): Promise<string> {
    if (this.pageSessionId) return this.pageSessionId
    const targets = await this.getTargets()
    let page = targets.find((target) => target.type === 'page')
    if (!page) {
      const created = await this.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })
      page = { targetId: created.targetId, type: 'page', title: '', url: 'about:blank', attached: false }
    }
    const attached = await this.send<{ sessionId: string }>('Target.attachToTarget', { targetId: page.targetId, flatten: true })
    const sessionId = attached.sessionId
    let detachedDuringSetup = false
    const offDetach = this.on('Target.detachedFromTarget', (params) => {
      if (params?.sessionId === sessionId) {
        detachedDuringSetup = true
      }
    })
    try {
      await this.send('Page.enable', {}, sessionId)
      await this.send('Runtime.enable', {}, sessionId)
      if (this.closed || detachedDuringSetup) {
        throw new DevHotelError(
          this.closed ? 'CDP_CLOSED' : 'CDP_COMMAND_ERROR',
          this.closed ? 'CDP connection closed' : 'Target closed while initializing page session'
        )
      }
      this.pageSessionId = sessionId
      return sessionId
    } catch (error) {
      if (this.pageSessionId === sessionId) {
        this.pageSessionId = null
      }
      throw error
    } finally {
      offDetach()
    }
  }

  /**
   * Runs page work, once more on a fresh page if the attached one vanished
   * meanwhile: an agent on the endpoint can close it between two of our
   * commands, and the detach event may arrive after our next send.
   */
  private async withPage<T>(work: (sessionId: string) => Promise<T>): Promise<T> {
    const first = await this.ensurePageSession()
    try {
      return await work(first)
    } catch (error) {
      if (!isStaleSessionError(error)) throw error
      if (this.pageSessionId === first) this.pageSessionId = null
      return await work(await this.ensurePageSession())
    }
  }

  navigate(url: string, timeoutMs = 15_000): Promise<{ loaded: boolean; title: string; finalUrl: string }> {
    return this.withPage((sessionId) => this.navigateOn(sessionId, url, timeoutMs))
  }

  private async navigateOn(sessionId: string, url: string, timeoutMs: number): Promise<{ loaded: boolean; title: string; finalUrl: string }> {
    const effectiveTimeoutMs = normalizeTimeoutMs(timeoutMs, this.commandTimeoutMs)
    const navigateCommandTimeoutMs = this.hasCustomCommandTimeout
      ? Math.min(this.commandTimeoutMs, effectiveTimeoutMs)
      : effectiveTimeoutMs
    let loadTimer: ReturnType<typeof setTimeout> | null = null
    let settled = false
    let settleOutcome!: (outcome: 'loaded' | 'timeout' | 'closed') => void
    const loadOrTimeout = new Promise<'loaded' | 'timeout' | 'closed'>((resolve) => {
      settleOutcome = (outcome) => {
        if (settled) return
        settled = true
        if (loadTimer !== null) {
          clearTimeout(loadTimer)
          loadTimer = null
        }
        resolve(outcome)
      }
    })
    const offLoad = this.on('Page.loadEventFired', (_params, eventSession) => {
      if (eventSession === sessionId) settleOutcome('loaded')
    })
    const offClose = this.onClose(() => {
      settleOutcome('closed')
    })
    try {
      const result = await this.send<{ errorText?: string }>('Page.navigate', { url }, sessionId, navigateCommandTimeoutMs)
      if (result?.errorText) {
        throw new DevHotelError('CLIENT_BROWSER_NAVIGATION_FAILED', `Navigation to ${url} failed: ${result.errorText}`)
      }
      if (!settled) {
        loadTimer = setTimeout(() => settleOutcome('timeout'), effectiveTimeoutMs)
      }
      const outcome = await loadOrTimeout
      if (outcome === 'closed') {
        throw new DevHotelError('CDP_CLOSED', 'CDP connection closed')
      }
      const postEvalTimeoutMs =
        outcome === 'timeout'
          ? Math.min(
              this.commandTimeoutMs,
              Math.max(
                Math.min(effectiveTimeoutMs, POST_NAVIGATE_TIMEOUT_MAX_EVAL_MS),
                Math.min(this.commandTimeoutMs, POST_NAVIGATE_TIMEOUT_MIN_EVAL_MS)
              )
            )
          : Math.min(this.commandTimeoutMs, effectiveTimeoutMs)
      try {
        const state = await this.evaluateOn<{ title?: string; href?: string; readyState?: string }>(
          sessionId,
          '({ title: document.title, href: location.href, readyState: document.readyState })',
          postEvalTimeoutMs
        )
        return {
          loaded: outcome === 'loaded' || state?.readyState === 'complete',
          title: state?.title ?? '',
          finalUrl: state?.href ?? url
        }
      } catch (error) {
        if (error instanceof DevHotelError && error.code === 'CDP_COMMAND_TIMEOUT') {
          return {
            loaded: outcome === 'loaded',
            title: '',
            finalUrl: url
          }
        }
        throw error
      }
    } finally {
      if (loadTimer !== null) {
        clearTimeout(loadTimer)
        loadTimer = null
      }
      offLoad()
      offClose()
    }
  }

  captureScreenshot(
    format: 'png' | 'jpeg' = 'png',
    fullPage = false,
    timeoutMs?: number
  ): Promise<{ data: string; mimeType: 'image/png' | 'image/jpeg' }> {
    return this.withPage(async (sessionId) => {
      const result = await this.send<{ data: string }>(
        'Page.captureScreenshot',
        { format, captureBeyondViewport: fullPage },
        sessionId,
        timeoutMs
      )
      return { data: result.data, mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png' }
    })
  }

  evaluate<T = any>(expression: string, timeoutMs?: number): Promise<T> {
    return this.withPage((sessionId) => this.evaluateOn<T>(sessionId, expression, timeoutMs))
  }

  private async evaluateOn<T>(sessionId: string, expression: string, timeoutMs?: number): Promise<T> {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId, timeoutMs)
    if (result?.exceptionDetails) {
      throw new DevHotelError('CLIENT_BROWSER_EVAL_FAILED', result.exceptionDetails.text ?? 'JavaScript evaluation failed')
    }
    return result?.result?.value
  }

  close(): void {
    const ws = this.ws
    this.markClosed(ws, new DevHotelError('CDP_CLOSED', 'CDP connection closed'))
    if (!ws) return
    try {
      ws.close()
    } catch {
      // already closed
    }
  }
}
