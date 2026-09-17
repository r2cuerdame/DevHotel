import { DevHotelError } from '../errors'

export interface CdpTarget {
  targetId: string
  type: string
  title: string
  url: string
  attached: boolean
  browserContextId?: string
}

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void }

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
  private pageSessionId: string | null = null

  private constructor(private readonly wsUrl: string) {}

  static async connect(wsUrl: string, timeoutMs = 10_000): Promise<SimpleCdpClient> {
    const client = new SimpleCdpClient(wsUrl)
    await client.open(timeoutMs)
    return client
  }

  get isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  private open(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        this.close()
        reject(new DevHotelError('CDP_CONNECT_TIMEOUT', `Timed out connecting to CDP at ${this.wsUrl}`))
      }, timeoutMs)

      let ws: WebSocket
      try {
        ws = new WebSocket(this.wsUrl)
      } catch (error) {
        clearTimeout(timer)
        reject(new DevHotelError('CDP_SOCKET_ERROR', `CDP WebSocket could not be created: ${error instanceof Error ? error.message : String(error)}`))
        return
      }
      this.ws = ws

      ws.addEventListener('open', () => {
        clearTimeout(timer)
        if (settled) return
        settled = true
        resolve()
      })
      ws.addEventListener('error', () => {
        clearTimeout(timer)
        if (settled) return
        settled = true
        reject(new DevHotelError('CDP_SOCKET_ERROR', `CDP WebSocket connection to ${this.wsUrl} failed`))
      })
      ws.addEventListener('close', () => {
        clearTimeout(timer)
        for (const { reject: rejectPending } of this.pending.values()) {
          rejectPending(new DevHotelError('CDP_CLOSED', 'CDP connection closed'))
        }
        this.pending.clear()
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
          const { resolve: resolvePending, reject: rejectPending } = this.pending.get(data.id)!
          this.pending.delete(data.id)
          if (data.error) {
            rejectPending(new DevHotelError('CDP_COMMAND_ERROR', data.error.message ?? 'Unknown CDP error', { evidence: data.error }))
          } else {
            resolvePending(data.result)
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

  async send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new DevHotelError('CDP_NOT_CONNECTED', 'CDP WebSocket is not open')
    }
    const id = this.nextId++
    const payload: Record<string, unknown> = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws!.send(JSON.stringify(payload))
    })
  }

  async getVersion(): Promise<{ product: string; protocolVersion: string; userAgent: string }> {
    const result = await this.send('Browser.getVersion')
    return {
      product: result?.product ?? 'unknown',
      protocolVersion: result?.protocolVersion ?? 'unknown',
      userAgent: result?.userAgent ?? 'unknown'
    }
  }

  async getTargets(): Promise<CdpTarget[]> {
    const result = await this.send<{ targetInfos: CdpTarget[] }>('Target.getTargets')
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
    this.pageSessionId = attached.sessionId
    await this.send('Page.enable', {}, this.pageSessionId)
    await this.send('Runtime.enable', {}, this.pageSessionId)
    return this.pageSessionId
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
    let loadedResolve!: () => void
    const loaded = new Promise<void>((resolve) => {
      loadedResolve = resolve
    })
    const off = this.on('Page.loadEventFired', (_params, eventSession) => {
      if (eventSession === sessionId) loadedResolve()
    })
    try {
      const result = await this.send<{ errorText?: string }>('Page.navigate', { url }, sessionId)
      if (result?.errorText) {
        throw new DevHotelError('CLIENT_BROWSER_NAVIGATION_FAILED', `Navigation to ${url} failed: ${result.errorText}`)
      }
      const timer = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs))
      const outcome = await Promise.race([loaded.then(() => 'loaded' as const), timer])
      const state = await this.evaluateOn<{ title: string; href: string; readyState: string }>(
        sessionId,
        '({ title: document.title, href: location.href, readyState: document.readyState })'
      )
      return {
        loaded: outcome === 'loaded' || state.readyState === 'complete',
        title: state.title ?? '',
        finalUrl: state.href ?? url
      }
    } finally {
      off()
    }
  }

  captureScreenshot(
    format: 'png' | 'jpeg' = 'png',
    fullPage = false
  ): Promise<{ data: string; mimeType: 'image/png' | 'image/jpeg' }> {
    return this.withPage(async (sessionId) => {
      const result = await this.send<{ data: string }>(
        'Page.captureScreenshot',
        { format, captureBeyondViewport: fullPage },
        sessionId
      )
      return { data: result.data, mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png' }
    })
  }

  evaluate<T = any>(expression: string): Promise<T> {
    return this.withPage((sessionId) => this.evaluateOn<T>(sessionId, expression))
  }

  private async evaluateOn<T>(sessionId: string, expression: string): Promise<T> {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId)
    if (result?.exceptionDetails) {
      throw new DevHotelError('CLIENT_BROWSER_EVAL_FAILED', result.exceptionDetails.text ?? 'JavaScript evaluation failed')
    }
    return result?.result?.value
  }

  close(): void {
    const ws = this.ws
    this.ws = null
    this.pageSessionId = null
    if (!ws) return
    try {
      ws.close()
    } catch {
      // already closed
    }
  }
}
