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
export function setupUpdater(win: BrowserWindow): { readyVersion: () => string | null; install: () => void } {
  let readyVersion: string | null = null

  const send = (info: UpdateStatusInfo): void => {
    if (!win.isDestroyed()) win.webContents.send(IPC.evUpdate, info)
  }

  if (!app.isPackaged) {
    return { readyVersion: () => null, install: () => undefined }
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => send({ state: 'checking' }))
  autoUpdater.on('update-available', (info) => send({ state: 'available', version: info.version }))
  autoUpdater.on('download-progress', (p) => send({ state: 'downloading', detail: `${Math.round(p.percent)}%` }))
  autoUpdater.on('update-downloaded', (info) => {
    readyVersion = info.version
    send({ state: 'ready', version: info.version })
  })
  autoUpdater.on('error', (err) => send({ state: 'error', detail: err.message }))

  const check = (): void => {
    autoUpdater.checkForUpdates().catch(() => undefined)
  }
  check()
  setInterval(check, 24 * 60 * 60 * 1000)

  return {
    readyVersion: () => readyVersion,
    install: () => autoUpdater.quitAndInstall()
  }
}
