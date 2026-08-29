import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { session, WebContentsView, type BrowserWindow, type WebContents } from 'electron'
import forge from 'node-forge'
import {
  IPC,
  type PreviewLayout,
  type PreviewNavAction,
  type PreviewState,
  type PreviewTarget,
  type PreviewViewport
} from '@devhotel/shared'
import type { RoomOrchestrator } from '@devhotel/core'
import { calculatePreviewBounds, previewScale } from './previewLayout'
import {
  isAllowedRoomNavigation,
  isAllowedPreviewRequest,
  isPreviewableRoom,
  mobilePreviewUserAgent,
  roomPreviewPartition
} from './previewSecurity'
import { PreviewSyncGuard } from './previewSync'
import { hardenRoomSession } from './roomSessionPolicy'

const THUMB_INTERVAL_MS = 30_000

/**
 * The Android preview is a phone screen, not a VNC client: noVNC's own control
 * bar, its pull-out handle and its status toasts are chrome the Room never
 * needs — DevHotel's own strip drives the device. Injected per load because
 * Chromium drops inserted CSS on navigation.
 */
const NOVNC_CHROME_CSS = `
  #noVNC_control_bar_anchor,
  #noVNC_hint_anchor,
  #noVNC_control_bar_hint,
  #noVNC_status { display: none !important; }
  html, body, #noVNC_container { background: #000 !important; }
`
// The split is manual (renderer button); until the renderer sends its stored
// layout the preview stays a single full pane.
const DEFAULT_LAYOUT: PreviewLayout = {
  mode: 'single',
  leftViewport: null,
  rightViewport: { width: 390, height: 844 }
}

export class PreviewManager {
  private view: WebContentsView | null = null
  private rightView: WebContentsView | null = null
  private devtools: WebContentsView | null = null
  private roomId: string | null = null
  private thumbTimer: NodeJS.Timeout | null = null
  private configuredPartitions = new Set<string>()
  private lastBounds: { x: number; y: number; width: number; height: number } | null = null
  private previewLayout: PreviewLayout = { ...DEFAULT_LAYOUT, rightViewport: { ...DEFAULT_LAYOUT.rightViewport } }
  private pendingRightLoads = new PreviewSyncGuard()
  private visible = true

  constructor(
    private readonly win: BrowserWindow,
    private readonly orch: RoomOrchestrator,
    private readonly userData: string
  ) {
    orch.onEvent((e) => {
      if (e.kind === 'deleted') {
        if (this.roomId === e.roomId) this.detach()
        void this.clearRoomData(e.roomId)
      }
      if (e.kind === 'status' && this.roomId === e.roomId) {
        const room = orch.rooms.get(e.roomId)
        if (!isPreviewableRoom(room)) this.detach()
      }
    })
  }

  attach(roomId: string, bounds: { x: number; y: number; width: number; height: number }): void {
    const room = this.orch.rooms.get(roomId)
    if (!isPreviewableRoom(room)) {
      // A forged/stale renderer attach must never leave another Room visible.
      if (this.roomId) this.detach()
      return
    }
    if (this.roomId !== roomId) {
      this.detach()
      const partition = roomPreviewPartition(roomId)
      this.configurePartition(partition, roomId)
      const view = this.createPreviewView(roomId, partition, 'left')
      this.view = view
      this.roomId = roomId
      this.win.contentView.addChildView(view)
      view.setVisible(this.visible)
      const wc = view.webContents
      const pushState = (): void => {
        if (this.win.isDestroyed() || wc.isDestroyed()) return
        const state: PreviewState = {
          roomId,
          url: wc.getURL(),
          canGoBack: wc.navigationHistory.canGoBack(),
          canGoForward: wc.navigationHistory.canGoForward(),
          loading: wc.isLoading()
        }
        this.win.webContents.send(IPC.evPreviewState, state)
      }
      const leftNavigated = (_event: Electron.Event, url: string): void => {
        pushState()
        this.syncRightFromLeft(url)
      }
      wc.on('did-navigate', leftNavigated)
      wc.on('did-navigate-in-page', leftNavigated)
      wc.on('did-start-loading', pushState)
      wc.on('did-stop-loading', pushState)
      const url = this.safeHomeUrl(roomId)
      if (url) void wc.loadURL(url).catch(() => undefined)
      if (this.previewLayout.mode === 'split') this.ensureRightView()
      this.thumbTimer = setInterval(() => void this.capture(), THUMB_INTERVAL_MS)
    }
    this.lastBounds = bounds
    this.layout()
  }

  /** Lays out two responsive panes; docked DevTools temporarily takes the mobile pane's place. */
  private layout(): void {
    if (!this.view || !this.lastBounds) return
    const effectiveMode = this.devtools ? 'single' : this.previewLayout.mode
    const bounds = calculatePreviewBounds(
      this.lastBounds,
      effectiveMode,
      this.devtools !== null,
      this.previewLayout.splitRatio
    )
    this.view.setBounds(bounds.left)
    if (bounds.right && this.rightView) this.rightView.setBounds(bounds.right)
    if (bounds.devtools && this.devtools) this.devtools.setBounds(bounds.devtools)
    this.updateVisibility()
    this.applyViewport(this.view, this.previewLayout.leftViewport, 'desktop')
    if (this.rightView) this.applyViewport(this.rightView, this.previewLayout.rightViewport, 'mobile')
  }

  private applyViewport(view: WebContentsView, size: PreviewViewport | null, kind: 'desktop' | 'mobile'): void {
    const wc = view.webContents
    if (wc.isDestroyed()) return
    if (!size) {
      wc.disableDeviceEmulation()
      return
    }
    const siteBounds = view.getBounds()
    wc.enableDeviceEmulation({
      screenPosition: kind,
      screenSize: size,
      viewPosition: { x: 0, y: 0 },
      viewSize: size,
      deviceScaleFactor: kind === 'mobile' ? 2 : 1,
      scale: previewScale(siteBounds, size)
    })
  }

  setViewport(roomId: string, size: { width: number; height: number } | null): void {
    if (this.roomId !== roomId) return
    this.previewLayout = { ...this.previewLayout, leftViewport: size }
    this.layout()
  }

  setLayout(roomId: string, nextLayout: PreviewLayout): void {
    if (this.roomId !== roomId) return
    const wasSingle = this.previewLayout.mode === 'single'
    this.previewLayout = {
      mode: nextLayout.mode,
      leftViewport: nextLayout.leftViewport ? { ...nextLayout.leftViewport } : null,
      rightViewport: { ...nextLayout.rightViewport },
      splitRatio: nextLayout.splitRatio
    }
    if (nextLayout.mode === 'split') {
      this.ensureRightView()
      if (wasSingle) this.syncRightToLeft()
    }
    this.layout()
  }

  /** Keeps the Room's browser alive while another renderer surface covers it. */
  setVisible(roomId: string, visible: boolean): void {
    if (this.roomId !== roomId || !this.view) return
    this.visible = visible
    this.updateVisibility()
    if (visible) this.layout()
  }

  toggleDevTools(roomId: string): boolean {
    if (this.roomId !== roomId || !this.view) return false
    const wc = this.view.webContents
    if (this.devtools) {
      this.closeDevTools(roomId, true)
      return false
    } else {
      const tools = new WebContentsView({ webPreferences: { sandbox: true } })
      this.devtools = tools
      this.win.contentView.addChildView(tools)
      tools.setVisible(this.visible)
      tools.webContents.once('render-process-gone', () => this.handleDevToolsGone(tools, roomId))
      tools.webContents.once('destroyed', () => this.handleDevToolsGone(tools, roomId))
      wc.setDevToolsWebContents(tools.webContents)
      wc.openDevTools({ mode: 'detach' })
    }
    this.layout()
    if (!this.win.isDestroyed()) this.win.webContents.send(IPC.evPreviewDevTools, roomId, true)
    return true
  }

  detach(): void {
    const detachedRoomId = this.roomId
    if (this.thumbTimer) {
      clearInterval(this.thumbTimer)
      this.thumbTimer = null
    }
    if (this.devtools) {
      this.closeDevTools(null, false)
    }
    if (this.view) {
      void this.capture()
      this.win.contentView.removeChildView(this.view)
      this.view.webContents.close()
      this.view = null
    }
    if (this.rightView) {
      this.win.contentView.removeChildView(this.rightView)
      this.rightView.webContents.close()
      this.rightView = null
    }
    this.roomId = null
    this.pendingRightLoads.clear()
    this.previewLayout = { ...DEFAULT_LAYOUT, rightViewport: { ...DEFAULT_LAYOUT.rightViewport } }
    this.lastBounds = null
    this.visible = true
    if (detachedRoomId && !this.win.isDestroyed()) {
      this.win.webContents.send(IPC.evPreviewDevTools, detachedRoomId, false)
    }
  }

  nav(roomId: string, action: PreviewNavAction, target: PreviewTarget = 'both'): void {
    if (this.roomId !== roomId || !this.view) return
    // The left pane owns toolbar history. Its resulting URL is mirrored into
    // the mobile pane, avoiding two racing history stacks.
    if (target === 'right' && this.previewLayout.mode === 'split' && this.rightView) {
      this.navigateWebContents(this.rightView.webContents, roomId, action)
      return
    }
    this.navigateWebContents(this.view.webContents, roomId, action)
    if (action === 'reload' && target === 'both' && this.previewLayout.mode === 'split' && this.rightView) {
      this.rightView.webContents.reload()
    }
  }

  private navigateWebContents(wc: WebContents, roomId: string, action: PreviewNavAction): void {
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
    else if (action === 'reload') wc.reload()
    else if (action === 'home') {
      const url = this.safeHomeUrl(roomId)
      if (url) void wc.loadURL(url).catch(() => undefined)
    }
  }

  private createPreviewView(roomId: string, partition: string, side: 'left' | 'right'): WebContentsView {
    const view = new WebContentsView({
      webPreferences: { partition, sandbox: true, nodeIntegration: false, contextIsolation: true }
    })
    // black letterboxing around emulated viewports, matching the renderer backdrop
    view.setBackgroundColor('#000000')
    const wc = view.webContents
    if (side === 'right') wc.setUserAgent(mobilePreviewUserAgent(process.versions.chrome))
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.on('will-attach-webview', (event) => event.preventDefault())
    const denyOutsideRoom = (event: Electron.Event, url: string): void => {
      const home = this.safeHomeUrl(roomId)
      if (!home || !isAllowedRoomNavigation(url, home)) {
        event.preventDefault()
        return
      }
      if (side === 'right') {
        // Mobile is a responsive projection of the authoritative left route.
        event.preventDefault()
        this.loadLeftFromRight(url)
      }
    }
    wc.on('will-navigate', denyOutsideRoom)
    wc.on('will-redirect', denyOutsideRoom)
    if (this.orch.rooms.get(roomId)?.provider === 'android') {
      wc.on('dom-ready', () => {
        void wc.insertCSS(NOVNC_CHROME_CSS).catch(() => undefined)
      })
    }
    if (side === 'left') {
      wc.on('devtools-closed', () => {
        if (this.devtools) this.handleDevToolsGone(this.devtools, roomId)
      })
    }
    wc.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        event.preventDefault()
        this.toggleDevTools(roomId)
      }
    })
    return view
  }

  private ensureRightView(): void {
    if (this.rightView || !this.roomId || !this.view) return
    const partition = roomPreviewPartition(this.roomId)
    const right = this.createPreviewView(this.roomId, partition, 'right')
    this.rightView = right
    this.win.contentView.addChildView(right)
    right.setVisible(false)
    right.webContents.setAudioMuted(true)
    const rightNavigated = (_event: Electron.Event, url: string): void => {
      if (this.pendingRightLoads.consume(url)) return
      // A redirect from a guarded mirror load, an explicit target:right call,
      // or a mobile SPA transition is promoted to the authoritative pane.
      this.pendingRightLoads.clear()
      this.loadLeftFromRight(url)
    }
    right.webContents.on('did-navigate', rightNavigated)
    right.webContents.on('did-navigate-in-page', rightNavigated)
    right.webContents.on('did-fail-load', (_event, _code, _description, url) => {
      this.pendingRightLoads.fail(url)
    })
    const url = this.view.webContents.getURL() || this.safeHomeUrl(this.roomId)
    if (url) this.syncRightFromLeft(url)
  }

  private syncRightToLeft(): void {
    if (!this.view || !this.rightView) return
    const url = this.view.webContents.getURL()
    if (url) this.syncRightFromLeft(url)
  }

  private syncRightFromLeft(url: string): void {
    if (!this.rightView || !this.roomId || this.previewLayout.mode !== 'split') return
    const home = this.safeHomeUrl(this.roomId)
    if (!home || !isAllowedRoomNavigation(url, home) || url === this.rightView.webContents.getURL()) return
    this.pendingRightLoads.mark(url)
    void this.rightView.webContents.loadURL(url).catch(() => this.pendingRightLoads.fail(url))
  }

  private loadLeftFromRight(url: string): void {
    if (!this.view || !this.roomId) return
    const home = this.safeHomeUrl(this.roomId)
    if (!home || !isAllowedRoomNavigation(url, home) || url === this.view.webContents.getURL()) return
    void this.view.webContents.loadURL(url).catch(() => undefined)
  }

  private updateVisibility(): void {
    this.view?.setVisible(this.visible)
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.setAudioMuted(!this.visible)
    const rightVisible = this.visible && this.previewLayout.mode === 'split' && !this.devtools
    this.rightView?.setVisible(rightVisible)
    // Mobile is a visual comparison pane; only the authoritative left pane may play audio.
    if (this.rightView && !this.rightView.webContents.isDestroyed()) this.rightView.webContents.setAudioMuted(true)
    this.devtools?.setVisible(this.visible)
  }

  private closeDevTools(roomId: string | null, relayout: boolean): void {
    const tools = this.devtools
    if (!tools) return
    this.devtools = null
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.closeDevTools()
    try {
      this.win.contentView.removeChildView(tools)
    } catch {
      // The native child may already have been removed after a renderer crash.
    }
    if (!tools.webContents.isDestroyed()) tools.webContents.close()
    if (relayout) this.layout()
    if (roomId && !this.win.isDestroyed()) this.win.webContents.send(IPC.evPreviewDevTools, roomId, false)
  }

  private handleDevToolsGone(tools: WebContentsView, roomId: string): void {
    if (this.devtools !== tools) return
    this.devtools = null
    try {
      this.win.contentView.removeChildView(tools)
    } catch {
      // best effort after render-process-gone/destroyed
    }
    if (!tools.webContents.isDestroyed()) tools.webContents.close()
    this.layout()
    if (!this.win.isDestroyed()) this.win.webContents.send(IPC.evPreviewDevTools, roomId, false)
  }

  private homeUrl(roomId: string): string | null {
    const room = this.orch.rooms.get(roomId)
    if (!room) return null
    return this.orch.inspectRoom(roomId).urls.app
  }

  private safeHomeUrl(roomId: string): string | null {
    try {
      return this.homeUrl(roomId)
    } catch {
      return null
    }
  }

  private async capture(): Promise<void> {
    if (!this.view || !this.roomId || this.view.webContents.isDestroyed()) return
    try {
      const image = await this.view.webContents.capturePage()
      if (image.isEmpty()) return
      const resized = image.resize({ width: 640 })
      const dir = join(this.userData, 'rooms', this.roomId)
      mkdirSync(dir, { recursive: true })
      const file = join(dir, 'thumb.png')
      writeFileSync(file, resized.toPNG())
      this.orch.setThumbnail(this.roomId, file)
    } catch {
      // thumbnails are best-effort
    }
  }

  /** Configure one persistent Room session exactly once, with fail-closed Host capabilities. */
  private configurePartition(partition: string, roomId: string): void {
    if (this.configuredPartitions.has(partition)) return
    this.configuredPartitions.add(partition)
    const caPath = join(this.userData, 'ca', 'rootCA.pem')
    const roomSession = session.fromPartition(partition)
    // Closes the Host-input surface (Pointer Lock, Keyboard Lock, fullscreen)
    // along with every other Host capability. See roomSessionPolicy.ts.
    hardenRoomSession(roomSession)
    roomSession.webRequest.onBeforeRequest((details, callback) => {
      const home = this.safeHomeUrl(roomId)
      callback({
        cancel:
          !home ||
          !isAllowedPreviewRequest(details.url, home, details.resourceType === 'mainFrame')
      })
    })
    roomSession.setCertificateVerifyProc((request, callback) => {
      const home = this.safeHomeUrl(roomId)
      const roomHostname = home ? new URL(home).hostname : null
      if (request.hostname !== roomHostname || !existsSync(caPath)) {
        callback(-3) // fall back to Chromium's verdict
        return
      }
      try {
        const caStore = forge.pki.createCaStore([readFileSync(caPath, 'utf8')])
        const leaf = forge.pki.certificateFromPem(request.certificate.data)
        forge.pki.verifyCertificateChain(caStore, [leaf])
        callback(0)
      } catch {
        callback(-3)
      }
    })
  }

  private async clearRoomData(roomId: string): Promise<void> {
    try {
      await session.fromPartition(roomPreviewPartition(roomId)).clearStorageData()
    } catch {
      // best effort
    }
  }

  dispose(): void {
    this.detach()
  }
}
