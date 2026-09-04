import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrchestratorEvent, RoomOrchestrator } from '@devhotel/core'
import { PreviewManager } from './previewManager'

const electronMocks = vi.hoisted(() => {
  const views: FakeWebContentsView[] = []
  const openExternalMock = vi.fn()

  class FakeWebContentsView {
    readonly visibleCalls: boolean[] = []
    readonly boundsCalls: { x: number; y: number; width: number; height: number }[] = []
    private bounds = { x: 0, y: 0, width: 0, height: 0 }
    private url = ''
    readonly eventListeners = new Map<string, ((...args: unknown[]) => void)[]>()
    windowOpenHandler: ((details: { url: string }) => { action: 'deny' }) | null = null

    readonly webContents = {
      navigationHistory: {
        canGoBack: () => false,
        canGoForward: () => false,
        goBack: () => undefined,
        goForward: () => undefined
      },
      isDestroyed: () => false,
      isLoading: () => false,
      getURL: () => this.url,
      on: (event: string, handler: (...args: unknown[]) => void) => {
        const list = this.eventListeners.get(event) ?? []
        list.push(handler)
        this.eventListeners.set(event, list)
      },
      once: (event: string, handler: (...args: unknown[]) => void) => {
        const list = this.eventListeners.get(event) ?? []
        list.push(handler)
        this.eventListeners.set(event, list)
      },
      emit: (event: string, ...args: unknown[]) => {
        for (const handler of this.eventListeners.get(event) ?? []) {
          handler(...args)
        }
      },
      loadURL: async (url: string) => {
        this.url = url
      },
      setWindowOpenHandler: (handler: (details: { url: string }) => { action: 'deny' }) => {
        this.windowOpenHandler = handler
      },
      setAudioMuted: () => undefined,
      disableDeviceEmulation: () => undefined,
      enableDeviceEmulation: () => undefined,
      setUserAgent: () => undefined,
      insertCSS: async () => '',
      setDevToolsWebContents: () => undefined,
      openDevTools: () => undefined,
      closeDevTools: () => undefined,
      reload: () => undefined,
      close: () => undefined,
      capturePage: async () => ({ isEmpty: () => true })
    }

    constructor() {
      views.push(this)
    }

    setBackgroundColor(): void {}
    setVisible(visible: boolean): void {
      this.visibleCalls.push(visible)
    }
    setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
      this.bounds = bounds
      this.boundsCalls.push(bounds)
    }
    getBounds(): { x: number; y: number; width: number; height: number } {
      return this.bounds
    }
  }

  const roomSession = {
    setPermissionRequestHandler: () => undefined,
    setPermissionCheckHandler: () => undefined,
    setDevicePermissionHandler: () => undefined,
    on: () => undefined,
    webRequest: { onBeforeRequest: () => undefined },
    setCertificateVerifyProc: () => undefined,
    clearStorageData: async () => undefined
  }

  return { FakeWebContentsView, openExternalMock, roomSession, views }
})

vi.mock('electron', () => ({
  WebContentsView: electronMocks.FakeWebContentsView,
  session: { fromPartition: () => electronMocks.roomSession },
  shell: { openExternal: electronMocks.openExternalMock }
}))

describe('PreviewManager runtime attachment', () => {
  beforeEach(() => {
    electronMocks.views.length = 0
  })

  it('coalesces pending bounds, preserves visibility, and probes only the first attachment', async () => {
    let finishInspection: ((value: unknown) => void) | undefined
    const inspection = new Promise((resolve) => {
      finishInspection = resolve
    })
    const inspectRoomRuntime = vi.fn(() => inspection)
    const room = { id: 'room1abc', provider: 'web', status: 'ready' }
    const orch = {
      onEvent: () => () => undefined,
      rooms: { get: () => room },
      inspectRoomRuntime,
      inspectRoom: () => ({ urls: { app: 'https://demo-dev.localhost/' } }),
      setThumbnail: () => undefined
    } as unknown as RoomOrchestrator
    const win = {
      contentView: { addChildView: () => undefined, removeChildView: () => undefined },
      isDestroyed: () => false,
      webContents: { send: () => undefined }
    }
    const manager = new PreviewManager(win as never, orch, 'C:\\devhotel-test')
    const firstBounds = { x: 10, y: 20, width: 800, height: 600 }
    const latestBounds = { x: 15, y: 25, width: 900, height: 650 }

    const firstAttach = manager.attach(room.id, firstBounds)
    const resizeWhilePending = manager.attach(room.id, latestBounds)
    manager.setVisible(room.id, false)

    expect(inspectRoomRuntime).toHaveBeenCalledTimes(1)
    finishInspection?.({
      room,
      runtimeStatus: { state: 'running' },
      urls: { app: 'https://demo-dev.localhost/' }
    })
    await Promise.all([firstAttach, resizeWhilePending])

    expect(electronMocks.views).toHaveLength(1)
    expect(electronMocks.views[0]!.boundsCalls.at(-1)).toEqual(latestBounds)
    expect(electronMocks.views[0]!.visibleCalls.at(-1)).toBe(false)

    const resizeAfterAttach = { x: 20, y: 30, width: 1000, height: 700 }
    await manager.attach(room.id, resizeAfterAttach)
    expect(inspectRoomRuntime).toHaveBeenCalledTimes(1)
    expect(electronMocks.views[0]!.boundsCalls.at(-1)).toEqual(resizeAfterAttach)

    manager.detach()
  })

  it('cancels a pending attachment when the Room stops before inspection resolves', async () => {
    let finishInspection: ((value: unknown) => void) | undefined
    const inspection = new Promise((resolve) => {
      finishInspection = resolve
    })
    let emitEvent: ((event: OrchestratorEvent) => void) | undefined
    const room = { id: 'room1abc', provider: 'web', status: 'ready' }
    const orch = {
      onEvent: (listener: (event: OrchestratorEvent) => void) => {
        emitEvent = listener
        return () => undefined
      },
      rooms: { get: () => room },
      inspectRoomRuntime: () => inspection,
      inspectRoom: () => ({ urls: { app: 'https://demo-dev.localhost/' } }),
      setThumbnail: () => undefined
    } as unknown as RoomOrchestrator
    const win = {
      contentView: { addChildView: () => undefined, removeChildView: () => undefined },
      isDestroyed: () => false,
      webContents: { send: () => undefined }
    }
    const manager = new PreviewManager(win as never, orch, 'C:\\devhotel-test')
    const pendingAttach = manager.attach(room.id, { x: 10, y: 20, width: 800, height: 600 })

    room.status = 'sleeping'
    emitEvent?.({ roomId: room.id, kind: 'status' })
    finishInspection?.({
      room: { ...room, status: 'ready' },
      runtimeStatus: { state: 'running' },
      urls: { app: 'https://demo-dev.localhost/' }
    })
    await pendingAttach

    expect(electronMocks.views).toHaveLength(0)
    manager.detach()
  })

  it('retries one transient unknown observation while the recorded Room remains open', async () => {
    const room = { id: 'room1abc', provider: 'web', status: 'ready' }
    const inspectRoomRuntime = vi
      .fn()
      .mockResolvedValueOnce({
        room,
        runtimeStatus: { state: 'unknown' },
        urls: { app: null }
      })
      .mockResolvedValueOnce({
        room,
        runtimeStatus: { state: 'running' },
        urls: { app: 'https://demo-dev.localhost/' }
      })
    const orch = {
      onEvent: () => () => undefined,
      rooms: { get: () => room },
      inspectRoomRuntime,
      inspectRoom: () => ({ urls: { app: 'https://demo-dev.localhost/' } }),
      setThumbnail: () => undefined
    } as unknown as RoomOrchestrator
    const win = {
      contentView: { addChildView: () => undefined, removeChildView: () => undefined },
      isDestroyed: () => false,
      webContents: { send: () => undefined }
    }
    const manager = new PreviewManager(win as never, orch, 'C:\\devhotel-test')

    await manager.attach(room.id, { x: 10, y: 20, width: 800, height: 600 })

    expect(inspectRoomRuntime).toHaveBeenCalledTimes(2)
    expect(electronMocks.views).toHaveLength(1)
    manager.detach()
  })

  it('opens external URLs in default browser when requested via window.open or will-navigate', async () => {
    electronMocks.openExternalMock.mockClear()
    const room = { id: 'room1abc', provider: 'web', status: 'ready' }
    const orch = {
      onEvent: () => () => undefined,
      rooms: { get: () => room },
      inspectRoomRuntime: vi.fn().mockResolvedValue({
        room,
        runtimeStatus: { state: 'running' },
        urls: { app: 'https://demo-dev.localhost/' }
      }),
      inspectRoom: () => ({ urls: { app: 'https://demo-dev.localhost/' } }),
      setThumbnail: () => undefined
    } as unknown as RoomOrchestrator
    const win = {
      contentView: { addChildView: () => undefined, removeChildView: () => undefined },
      isDestroyed: () => false,
      webContents: { send: () => undefined }
    }
    const manager = new PreviewManager(win as never, orch, 'C:\\devhotel-test')
    await manager.attach(room.id, { x: 10, y: 20, width: 800, height: 600 })

    const view = electronMocks.views[0]!
    expect(view).toBeDefined()

    // Test window.open external handler
    const result = view.windowOpenHandler?.({ url: 'https://github.com/login' })
    expect(result).toEqual({ action: 'deny' })
    expect(electronMocks.openExternalMock).toHaveBeenCalledWith('https://github.com/login')

    // Test will-navigate external URL
    const event = { preventDefault: vi.fn() }
    view.webContents.emit('will-navigate', event, 'https://example.com/docs')
    expect(event.preventDefault).toHaveBeenCalled()
    expect(electronMocks.openExternalMock).toHaveBeenCalledWith('https://example.com/docs')

    // Test in-room navigation
    const inRoomEvent = { preventDefault: vi.fn() }
    view.webContents.emit('will-navigate', inRoomEvent, 'https://demo-dev.localhost/settings')
    expect(inRoomEvent.preventDefault).not.toHaveBeenCalled()

    manager.detach()
  })

  it('retries loadURL upon transient did-fail-load errors', async () => {
    vi.useFakeTimers()
    try {
      const room = { id: 'room1abc', provider: 'web', status: 'ready' }
      const orch = {
        onEvent: () => () => undefined,
        rooms: { get: () => room },
        inspectRoomRuntime: vi.fn().mockResolvedValue({
          room,
          runtimeStatus: { state: 'running' },
          urls: { app: 'https://demo-dev.localhost/' }
        }),
        inspectRoom: () => ({ urls: { app: 'https://demo-dev.localhost/' } }),
        setThumbnail: () => undefined
      } as unknown as RoomOrchestrator
      const win = {
        contentView: { addChildView: () => undefined, removeChildView: () => undefined },
        isDestroyed: () => false,
        webContents: { send: () => undefined }
      }
      const manager = new PreviewManager(win as never, orch, 'C:\\devhotel-test')
      await manager.attach(room.id, { x: 10, y: 20, width: 800, height: 600 })

      const view = electronMocks.views[0]!
      const loadSpy = vi.spyOn(view.webContents, 'loadURL')

      // Emit transient ERR_CONNECTION_REFUSED (-102) for mainFrame
      view.webContents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'https://demo-dev.localhost/', true)
      expect(loadSpy).not.toHaveBeenCalled()

      // Advance timers by 1500ms retry interval
      vi.advanceTimersByTime(1500)
      expect(loadSpy).toHaveBeenCalledWith('https://demo-dev.localhost/')

      manager.detach()
    } finally {
      vi.useRealTimers()
    }
  })
})
