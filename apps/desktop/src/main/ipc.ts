import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { IPC, type Actor, type CreateRoomInput, type McpSetupInfo, type QuickChange } from '@devhotel/shared'
import { caTrustStatus, ensureCa, trustCaInWindows, untrustCaInWindows, type RoomOrchestrator, type Gateway } from '@devhotel/core'
import type { PreviewManager } from './previewManager'
import type { TermManager } from './termManager'

export function registerIpc(opts: {
  win: BrowserWindow
  orch: RoomOrchestrator
  gateway: Gateway
  previews: PreviewManager
  terms: TermManager
  userData: string
}): void {
  const { win, orch, gateway, previews, terms, userData } = opts
  const caDir = join(userData, 'ca')
  const activeTails = new Set<string>()

  const send = (channel: string, ...args: unknown[]): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }

  orch.onEvent((e) => {
    send(IPC.evRoomEvent, e)
    if (e.kind === 'created' || e.kind === 'deleted' || e.kind === 'status') send(IPC.evRoomsChanged)
  })
  orch.onLogLine((e) => {
    if (activeTails.has(`${e.roomId}:${e.kind}`)) {
      send(IPC.evLogLine, { roomId: e.roomId, kind: e.kind, line: e.line })
    }
  })

  /* rooms */
  ipcMain.handle(IPC.roomsList, () => orch.listRooms())
  ipcMain.handle(IPC.roomsPlan, (_e, input) => orch.planRoom(input))
  ipcMain.handle(IPC.roomsCreate, (_e, input: CreateRoomInput) => orch.createRoom({ ...input, actor: 'user' }))
  ipcMain.handle(IPC.roomsStart, (_e, roomId: string) => orch.startRoom(roomId, 'user'))
  ipcMain.handle(IPC.roomsSleep, (_e, roomId: string) => orch.sleepRoom(roomId, 'user'))
  ipcMain.handle(IPC.roomsDelete, (_e, roomId: string) => orch.deleteRoom(roomId, 'user'))
  ipcMain.handle(IPC.roomsRestartWeb, (_e, roomId: string) => orch.restartWeb(roomId, 'user'))
  ipcMain.handle(IPC.roomsInspect, (_e, roomId: string) => orch.inspectRoom(roomId))
  ipcMain.handle(IPC.roomsRename, (_e, roomId: string, nickname: string) => orch.renameRoom(roomId, nickname))

  /* changes / checks / diagnostics */
  ipcMain.handle(IPC.changesList, (_e, roomId: string) => orch.listChanges(roomId))
  ipcMain.handle(IPC.changesApply, (_e, roomId: string, change: QuickChange, actor: Actor) =>
    orch.applyChange(roomId, change, actor === 'agent' ? 'agent' : 'user')
  )
  ipcMain.handle(IPC.changesUndo, (_e, roomId: string, changeId: string) => orch.undoChange(roomId, changeId, 'user'))
  ipcMain.handle(IPC.checksRun, (_e, roomId: string) => orch.runChecks(roomId))
  ipcMain.handle(IPC.diagCopy, (_e, roomId: string) => orch.getDiagnostic(roomId))

  /* logs */
  ipcMain.handle(IPC.logsTailStart, (_e, roomId: string, kind: 'web' | 'orchestrator') => {
    activeTails.add(`${roomId}:${kind}`)
    return { lines: orch.logs.tail(roomId, kind) }
  })
  ipcMain.handle(IPC.logsTailStop, (_e, roomId: string, kind: 'web' | 'orchestrator') => {
    activeTails.delete(`${roomId}:${kind}`)
  })

  /* terminal */
  ipcMain.handle(IPC.termOpen, (e, roomId: string) => terms.open(roomId, e.sender))
  ipcMain.on(IPC.termInput, (_e, termId: string, data: string) => terms.input(termId, data))
  ipcMain.on(IPC.termResize, () => terms.resize())
  ipcMain.on(IPC.termClose, (_e, termId: string) => terms.close(termId))

  /* settings / gateway / ca */
  ipcMain.handle(IPC.settingsGet, (_e, key: string) => orch.settings.get(key))
  ipcMain.handle(IPC.settingsSet, (_e, key: string, value: string) => orch.settings.set(key, value))
  ipcMain.handle(IPC.gatewayStatus, () => gateway.status())
  ipcMain.handle(IPC.caStatus, () => caTrustStatus(caDir))
  ipcMain.handle(IPC.caTrust, async () => {
    await ensureCa(caDir)
    await trustCaInWindows(caDir)
  })
  ipcMain.handle(IPC.caUntrust, () => untrustCaInWindows(caDir))

  /* app */
  ipcMain.handle(IPC.appVersion, () => app.getVersion())
  ipcMain.handle(IPC.openExternal, (_e, url: string) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url)
    return Promise.resolve()
  })
  ipcMain.handle(IPC.openPath, async (_e, path: string) => {
    await shell.openPath(path)
  })
  ipcMain.handle(IPC.pickFolder, async () => {
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle(IPC.mcpInfo, (): McpSetupInfo => {
    const serverPath = app.isPackaged
      ? join(process.resourcesPath, 'mcp', 'index.js')
      : resolve(app.getAppPath(), '..', '..', 'packages', 'mcp', 'dist', 'index.js')
    let controlPort: number | null = null
    try {
      const control = JSON.parse(readFileSync(join(userData, 'control.json'), 'utf8')) as { port: number }
      controlPort = control.port
    } catch {
      controlPort = null
    }
    return {
      serverPath,
      available: existsSync(serverPath),
      claudeCommand: `claude mcp add devhotel -- node "${serverPath}"`,
      configJson: JSON.stringify({ mcpServers: { devhotel: { command: 'node', args: [serverPath] } } }, null, 2),
      controlPort
    }
  })

  /* preview */
  ipcMain.handle(IPC.previewSetBounds, (_e, roomId: string, bounds) => previews.attach(roomId, bounds))
  ipcMain.handle(IPC.previewDetach, () => previews.detach())
  ipcMain.handle(IPC.previewNav, (_e, roomId: string, action) => previews.nav(roomId, action))
  ipcMain.handle(IPC.previewDevTools, (_e, roomId: string) => previews.toggleDevTools(roomId))
  ipcMain.handle(IPC.previewViewport, (_e, roomId: string, size: { width: number; height: number } | null) =>
    previews.setViewport(roomId, size)
  )
}
