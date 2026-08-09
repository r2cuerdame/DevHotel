import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, net, protocol, shell } from 'electron'
import { Gateway, OciCliBackend, openDb, RoomOrchestrator } from '@devhotel/core'
import { registerIpc } from './ipc'
import { PreviewManager } from './previewManager'
import { TermManager } from './termManager'
import { createTray } from './tray'
import { setupUpdater } from './updater'
import { startControlApi } from './controlApi'

const isDev = !!process.env.ELECTRON_RENDERER_URL

let mainWindow: BrowserWindow | null = null
let quitting = false

protocol.registerSchemesAsPrivileged([{ scheme: 'devhotel-thumb', privileges: { standard: true, secure: true } }])

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    title: 'DevHotel',
    backgroundColor: '#0f1216',
    autoHideMenuBar: true,
    show: !process.argv.includes('--hidden'),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL as string)
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      win.hide()
    }
  })
  return win
}

async function bootstrap(): Promise<void> {
  const userData = app.getPath('userData')
  const db = openDb(userData)
  const gateway = new Gateway({ caDir: join(userData, 'ca') })
  const backend = new OciCliBackend()
  const orch = new RoomOrchestrator({ userData, backend, gateway, db, appVersion: app.getVersion() })

  protocol.handle('devhotel-thumb', (request) => {
    const url = new URL(request.url)
    const roomId = url.hostname
    if (!/^[a-z0-9]+$/.test(roomId)) return new Response('bad room id', { status: 400 })
    const file = join(userData, 'rooms', roomId, 'thumb.png')
    if (!existsSync(file)) return new Response('no thumbnail', { status: 404 })
    return net.fetch(pathToFileURL(file).toString())
  })

  try {
    await orch.init()
  } catch (err) {
    console.error('orchestrator init failed:', err)
  }

  const control = await startControlApi(orch, userData, app.getVersion()).catch((err) => {
    console.error('control api failed to start:', err)
    return null
  })

  mainWindow = createWindow()
  const previews = new PreviewManager(mainWindow, orch, userData)
  const terms = new TermManager(orch)
  registerIpc({ win: mainWindow, orch, gateway, previews, terms, userData })
  const updater = setupUpdater(mainWindow)

  const quit = (): void => {
    if (quitting) return
    quitting = true
    previews.dispose()
    terms.dispose()
    control?.stop()
    void orch
      .shutdown()
      .catch(() => undefined)
      .finally(() => app.exit(0))
  }

  createTray({
    win: mainWindow,
    orch,
    onQuit: quit,
    updateReady: updater.readyVersion,
    installUpdate: () => {
      quitting = true
      previews.dispose()
      terms.dispose()
      control?.stop()
      updater.install()
    }
  })

  app.on('before-quit', (e) => {
    if (!quitting) {
      e.preventDefault()
      quit()
    }
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(() => bootstrap())

  app.on('window-all-closed', () => {
    // tray app — stay alive until Quit
  })
}
