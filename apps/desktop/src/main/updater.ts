import { app, type BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'
import { IPC, type UpdateStatusInfo } from '@devhotel/shared'

const { autoUpdater } = electronUpdater

/**
 * Auto-update from GitHub Releases. Downloads silently, installs only on
 * explicit user action (tray). Never touches room state (goal.md §4.6) —
 * rooms live in Docker volumes and the app database, which the installer
 * does not modify.
 */
export interface UpdaterController {
  status: () => UpdateStatusInfo
  onStatusChange: (listener: () => void) => () => void
  check: () => void
  install: () => void
}

export function setupUpdater(win: BrowserWindow): UpdaterController {
  let currentStatus: UpdateStatusInfo = { state: 'idle' }
  const statusListeners = new Set<() => void>()

  const publish = (info: UpdateStatusInfo): void => {
    const trayChanged = currentStatus.state !== info.state || currentStatus.version !== info.version
    currentStatus = info
    if (!win.isDestroyed()) win.webContents.send(IPC.evUpdate, info)
    if (trayChanged) {
      for (const listener of statusListeners) listener()
    }
  }

  if (!app.isPackaged) {
    return {
      status: () => currentStatus,
      onStatusChange: () => () => undefined,
      check: () => undefined,
      install: () => undefined
    }
  }

  autoUpdater.autoDownload = true
  // Installation is initiated explicitly after the orchestrator has slept
  // every Room and stopped the gateway; a normal app quit must not bypass it.
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.on('checking-for-update', () => publish({ state: 'checking' }))
  autoUpdater.on('update-not-available', () => publish({ state: 'up-to-date' }))
  autoUpdater.on('update-available', (info) => publish({ state: 'available', version: info.version }))
  autoUpdater.on('download-progress', (p) => publish({ state: 'downloading', detail: `${Math.round(p.percent)}%` }))
  autoUpdater.on('update-downloaded', (info) => {
    publish({ state: 'ready', version: info.version })
  })
  autoUpdater.on('error', (err) => publish({ state: 'error', detail: err.message }))

  const check = (): void => {
    if (
      currentStatus.state === 'checking' ||
      currentStatus.state === 'available' ||
      currentStatus.state === 'downloading' ||
      currentStatus.state === 'ready'
    ) {
      return
    }
    publish({ state: 'checking' })
    autoUpdater.checkForUpdates().catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error)
      publish({ state: 'error', detail })
    })
  }
  check()
  setInterval(check, 24 * 60 * 60 * 1000)

  return {
    status: () => currentStatus,
    onStatusChange: (listener) => {
      statusListeners.add(listener)
      queueMicrotask(listener)
      return () => statusListeners.delete(listener)
    },
    check,
    install: () => autoUpdater.quitAndInstall()
  }
}
