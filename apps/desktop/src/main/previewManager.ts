import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { session, WebContentsView, type BrowserWindow } from 'electron'
import forge from 'node-forge'
import { readFileSync, existsSync } from 'node:fs'
import { IPC, type PreviewNavAction, type PreviewState } from '@devhotel/shared'
import type { RoomOrchestrator } from '@devhotel/core'

const THUMB_INTERVAL_MS = 30_000

export class PreviewManager {
  private view: WebContentsView | null = null
  private roomId: string | null = null
  private thumbTimer: NodeJS.Timeout | null = null
  private verifiedPartitions = new Set<string>()

  constructor(
    private readonly win: BrowserWindow,
    private readonly orch: RoomOrchestrator,
    private readonly userData: string
  ) {
    orch.onEvent((e) => {
      if (e.kind === 'deleted') {
        void this.clearRoomData(e.roomId)
        if (this.roomId === e.roomId) this.detach()
      }
      if (e.kind === 'status' && this.roomId === e.roomId) {
        const room = orch.rooms.get(e.roomId)
        if (room && (room.status === 'sleeping' || room.status === 'broken')) this.detach()
      }
    })
  }

  attach(roomId: string, bounds: { x: number; y: number; width: number; height: number }): void {
    const room = this.orch.rooms.get(roomId)
    if (!room) return
    if (this.roomId !== roomId) {
      this.detach()
      const partition = `persist:room-${roomId}`
      this.trustRoomCertificates(partition)
      const view = new WebContentsView({
        webPreferences: { partition, sandbox: true, nodeIntegration: false, contextIsolation: true }
      })
      this.view = view
      this.roomId = roomId
      this.win.contentView.addChildView(view)
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
      wc.on('did-navigate', pushState)
      wc.on('did-navigate-in-page', pushState)
      wc.on('did-start-loading', pushState)
      wc.on('did-stop-loading', pushState)
      const url = this.homeUrl(roomId)
      if (url) void wc.loadURL(url).catch(() => undefined)
      this.thumbTimer = setInterval(() => void this.capture(), THUMB_INTERVAL_MS)
    }
    this.view?.setBounds(bounds)
  }

  detach(): void {
    if (this.thumbTimer) {
      clearInterval(this.thumbTimer)
      this.thumbTimer = null
    }
    if (this.view) {
      void this.capture()
      this.win.contentView.removeChildView(this.view)
      this.view.webContents.close()
      this.view = null
    }
    this.roomId = null
  }

  nav(roomId: string, action: PreviewNavAction): void {
    if (this.roomId !== roomId || !this.view) return
    const wc = this.view.webContents
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
    else if (action === 'reload') wc.reload()
    else if (action === 'home') {
      const url = this.homeUrl(roomId)
      if (url) void wc.loadURL(url).catch(() => undefined)
    }
  }

  private homeUrl(roomId: string): string | null {
    const room = this.orch.rooms.get(roomId)
    if (!room) return null
    return this.orch.inspectRoom(roomId).urls.app
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

  /** Trust leaf certificates signed by the DevHotel Local CA inside room previews only. */
  private trustRoomCertificates(partition: string): void {
    if (this.verifiedPartitions.has(partition)) return
    this.verifiedPartitions.add(partition)
    const caPath = join(this.userData, 'ca', 'rootCA.pem')
    session.fromPartition(partition).setCertificateVerifyProc((request, callback) => {
      if (!request.hostname.endsWith('.localhost') || !existsSync(caPath)) {
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
      await session.fromPartition(`persist:room-${roomId}`).clearStorageData()
    } catch {
      // best effort
    }
  }

  dispose(): void {
    this.detach()
  }
}
