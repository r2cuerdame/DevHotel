import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RoomOrchestrator } from '@devhotel/core'
import { PreviewManager } from './previewManager'

const electronMocks = vi.hoisted(() => {
  const views: FakeWebContentsView[] = []

  class FakeWebContentsView {
    readonly visibleCalls: boolean[] = []
    readonly boundsCalls: { x: number; y: number; width: number; height: number }[] = []
    private bounds = { x: 0, y: 0, width: 0, height: 0 }
    private url = ''
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
      on: () => undefined,
      once: () => undefined,
      loadURL: async (url: string) => {
        this.url = url
      },
      setWindowOpenHandler: () => undefined,
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

  return { FakeWebContentsView, roomSession, views }
})

vi.mock('electron', () => ({
  WebContentsView: electronMocks.FakeWebContentsView,
  session: { fromPartition: () => electronMocks.roomSession }
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
})
