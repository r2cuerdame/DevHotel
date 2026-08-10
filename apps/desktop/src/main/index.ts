import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, net, protocol, safeStorage, shell } from 'electron'
import { Gateway, OciCliBackend, hotelServicesRepo, openDb, RoomOrchestrator, roomsRepo } from '@devhotel/core'
import { registerIpc } from './ipc'
import { PreviewManager } from './previewManager'
import { TermManager } from './termManager'
import { createTray } from './tray'
import { setupUpdater } from './updater'
import { startControlApi } from './controlApi'
import { ensureDataOwnership } from './cleanRemoval'
import { CleanRemovalGate, deferShutdownForCleanRemoval } from './cleanRemovalGate'
import { executeShutdownPolicy, type ShutdownAction } from './shutdownPolicy'
import { GITHUB_SERVICE_DEFAULT_ENABLED, GITHUB_SERVICE_MANIFEST, GitHubService, PINNED_GH } from './githubService'

const isDev = !!process.env.ELECTRON_RENDERER_URL

// A development build must never take the installed app's single-instance
// lock or mutate its durable Room state. Keeping a separate Electron profile
// also makes packaged-app smoke tests deterministic while `pnpm dev` is open.
if (isDev) app.setPath('userData', `${app.getPath('userData')}-dev`)

let mainWindow: BrowserWindow | null = null
let quitting = false

protocol.registerSchemesAsPrivileged([{ scheme: 'devhotel-thumb', privileges: { standard: true, secure: true } }])

function createWindow(): BrowserWindow {
  const preloadPath = join(import.meta.dirname, '../preload/index.cjs')
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
      preload: preloadPath,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('preload-error', (_event, path, error) => {
    console.error(`preload failed (${path}):`, error)
  })
  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame) console.error(`renderer failed to load (${code} ${description}): ${url}`)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('renderer process exited unexpectedly:', details)
  })
  win.webContents.on('console-message', (details) => {
    if (details.level === 'error') {
      console.error(`renderer console (${details.sourceId}:${details.lineNumber}): ${details.message}`)
    }
  })

  if (isDev) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL as string).catch((error) => {
      console.error('renderer URL load failed:', error)
    })
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html')).catch((error) => {
      console.error('renderer file load failed:', error)
    })
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
  const dataOwnershipId = ensureDataOwnership(userData)
  const db = openDb(userData)
  const hotelServices = hotelServicesRepo(db)
  hotelServices.register({
    manifest: GITHUB_SERVICE_MANIFEST,
    availability: process.arch === 'x64' ? 'available' : 'unavailable',
    enabled: GITHUB_SERVICE_DEFAULT_ENABLED,
    initialConnectionState: 'disconnected'
  })
  const gateway = new Gateway({ caDir: join(userData, 'ca') })
  const ownershipRooms = roomsRepo(db)
  const backend = new OciCliBackend({
    identityFile: join(userData, 'runtime', 'docker-engine.json'),
    legacyVolumeAdoptionFile: join(userData, 'runtime', 'legacy-volume-adoptions.json'),
    canAdoptLegacyVolume: (roomId) =>
      ownershipRooms.get(roomId) !== null && existsSync(join(userData, 'rooms', roomId, 'manifest.yaml'))
  })
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
  const cleanRemoval = new CleanRemovalGate()
  const updater = setupUpdater(mainWindow)
  const github = new GitHubService(
    userData,
    app.isPackaged ? join(process.resourcesPath, 'github', PINNED_GH.asset) : null,
    fetch,
    undefined,
    {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (value) => safeStorage.encryptString(value),
      decryptString: (value) => safeStorage.decryptString(value)
    },
    undefined,
    (status) => hotelServices.updateState(GITHUB_SERVICE_MANIFEST.id, {
      provisionState: status.provisionState,
      connectionState: status.credentialState,
      statusDetail: status.detail
    })
  )
  // A packaged Hotel provisions its built-in GitHub infrastructure without
  // waiting for the Store UI to be opened. Failure is retryable from there.
  void github.status().catch((error) => console.error('GitHub Service provisioning failed:', error))

  let shutdownAction: ShutdownAction | null = null

  const shutdown = (action: ShutdownAction): void => {
    // First request wins. In particular, quitAndInstall's before-quit event
    // must not start a second orchestrator shutdown or race app.exit().
    if (shutdownAction) return
    shutdownAction = action
    quitting = true
    previews.dispose()
    terms.dispose()
    control?.stop()
    void executeShutdownPolicy(action, {
      shutdown: () => orch.shutdown(),
      installUpdate: updater.install,
      exit: (code) => app.exit(code),
      reportFailure: async (failedAction, error) => {
        const detail = error instanceof Error ? error.message : String(error)
        console.error(`DevHotel ${failedAction} shutdown failed:`, error)
        if (failedAction === 'install-update') {
          await dialog.showMessageBox(mainWindow!, {
            type: 'error',
            title: 'Update not installed',
            message: 'DevHotel could not safely stop every Room.',
            detail: `The update was not installed. DevHotel will exit with the Room data preserved.\n\n${detail}`,
            buttons: ['Exit DevHotel'],
            defaultId: 0,
            noLink: true
          })
        }
      }
    })
  }

  const requestShutdown = (action: ShutdownAction): void => {
    if (deferShutdownForCleanRemoval(cleanRemoval, () => shutdown(action))) return
    shutdown(action)
  }

  const quit = (): void => requestShutdown('quit')

  registerIpc({
    win: mainWindow,
    orch,
    gateway,
    previews,
    terms,
    userData,
    dataOwnershipId,
    github,
    runCleanRemoval: (operation) => cleanRemoval.run(operation),
    // Bypass the removal gate only after the detached coordinator exists. The
    // normal shutdown path still disposes streams/gateway before app.exit.
    finishCleanRemoval: () => setTimeout(() => shutdown('quit'), 500)
  })

  createTray({
    win: mainWindow,
    orch,
    onQuit: quit,
    updateReady: updater.readyVersion,
    onUpdateReady: updater.onReady,
    installUpdate: () => requestShutdown('install-update')
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
