import { app, Menu, nativeImage, Tray, type BrowserWindow } from 'electron'
import type { RoomOrchestrator } from '@devhotel/core'
import type { UpdateStatusInfo } from '@devhotel/shared'
import { updateTrayMenuItem } from './updateTrayMenu'

/** 16×16 brass key-plate tray icon, generated in code (no asset pipeline needed). */
function trayIcon(): Electron.NativeImage {
  const size = 16
  const buf = Buffer.alloc(size * size * 4)
  const brass = { r: 201, g: 163, b: 92 }
  const ink = { r: 17, g: 20, b: 24 }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const border = x === 0 || y === 0 || x === size - 1 || y === size - 1
      const inner = x >= 3 && x <= 12 && y >= 6 && y <= 9
      const c = border || inner ? brass : ink
      // BGRA on Windows
      buf[i] = c.b
      buf[i + 1] = c.g
      buf[i + 2] = c.r
      buf[i + 3] = 255
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size })
}

export function createTray(opts: {
  win: BrowserWindow
  orch: RoomOrchestrator
  onQuit: () => void
  updateStatus: () => UpdateStatusInfo
  onUpdateStatusChange: (listener: () => void) => () => void
  checkForUpdates: () => void
  installUpdate: () => void
}): Tray {
  const { win, orch, onQuit } = opts
  const tray = new Tray(trayIcon())
  tray.setToolTip('DevHotel')

  const show = (): void => {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  const rebuild = async (): Promise<void> => {
    const rooms = orch.listRooms()
    const running = rooms.filter((r) => r.status === 'running' || r.status === 'ready' || r.status === 'attention')
    const health = await orch.backendHealth().catch(() => ({ ok: false, detail: 'unreachable' }))

    const menu = Menu.buildFromTemplate([
      { label: 'Open DevHotel', click: show },
      { type: 'separator' },
      ...(running.length > 0
        ? running.map((r) => ({
            label: `№ ${r.roomNumber} · ${r.project} / ${r.nickname}`,
            click: show
          }))
        : [{ label: 'No rooms running', enabled: false }]),
      {
        label: 'Sleep all rooms',
        enabled: running.length > 0,
        click: () => {
          for (const r of running) void orch.sleepRoom(r.id, 'user')
        }
      },
      { type: 'separator' },
      { label: health.ok ? 'Backend: healthy' : 'Backend: not available', enabled: false },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => {
          app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] })
        }
      },
      updateTrayMenuItem(opts.updateStatus(), opts.checkForUpdates, opts.installUpdate),
      { type: 'separator' },
      { label: 'Quit DevHotel', click: onQuit }
    ])
    tray.setContextMenu(menu)
  }

  void rebuild()
  orch.onEvent(() => void rebuild())
  opts.onUpdateStatusChange(() => void rebuild())
  tray.on('click', show)
  return tray
}
