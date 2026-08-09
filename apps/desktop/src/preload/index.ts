import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type IpcApi, type IpcChannel } from '@devhotel/shared'

const api: IpcApi = {
  rooms: {
    list: () => ipcRenderer.invoke(IPC.roomsList),
    plan: (input) => ipcRenderer.invoke(IPC.roomsPlan, input),
    create: (input) => ipcRenderer.invoke(IPC.roomsCreate, input),
    start: (roomId) => ipcRenderer.invoke(IPC.roomsStart, roomId),
    sleep: (roomId) => ipcRenderer.invoke(IPC.roomsSleep, roomId),
    delete: (roomId) => ipcRenderer.invoke(IPC.roomsDelete, roomId),
    restartWeb: (roomId) => ipcRenderer.invoke(IPC.roomsRestartWeb, roomId),
    inspect: (roomId) => ipcRenderer.invoke(IPC.roomsInspect, roomId),
    rename: (roomId, nickname) => ipcRenderer.invoke(IPC.roomsRename, roomId, nickname)
  },
  changes: {
    list: (roomId) => ipcRenderer.invoke(IPC.changesList, roomId),
    apply: (roomId, change, actor) => ipcRenderer.invoke(IPC.changesApply, roomId, change, actor),
    undo: (roomId, changeId) => ipcRenderer.invoke(IPC.changesUndo, roomId, changeId)
  },
  checks: { run: (roomId) => ipcRenderer.invoke(IPC.checksRun, roomId) },
  diag: { copy: (roomId) => ipcRenderer.invoke(IPC.diagCopy, roomId) },
  logs: {
    tailStart: (roomId, kind) => ipcRenderer.invoke(IPC.logsTailStart, roomId, kind),
    tailStop: (roomId, kind) => ipcRenderer.invoke(IPC.logsTailStop, roomId, kind)
  },
  term: {
    open: (roomId) => ipcRenderer.invoke(IPC.termOpen, roomId),
    input: (termId, data) => ipcRenderer.send(IPC.termInput, termId, data),
    resize: (termId, cols, rows) => ipcRenderer.send(IPC.termResize, termId, cols, rows),
    close: (termId) => ipcRenderer.send(IPC.termClose, termId)
  },
  settings: {
    get: (key) => ipcRenderer.invoke(IPC.settingsGet, key),
    set: (key, value) => ipcRenderer.invoke(IPC.settingsSet, key, value)
  },
  gateway: { status: () => ipcRenderer.invoke(IPC.gatewayStatus) },
  ca: {
    status: () => ipcRenderer.invoke(IPC.caStatus),
    trust: () => ipcRenderer.invoke(IPC.caTrust),
    untrust: () => ipcRenderer.invoke(IPC.caUntrust)
  },
  app: {
    version: () => ipcRenderer.invoke(IPC.appVersion),
    openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
    openPath: (path) => ipcRenderer.invoke(IPC.openPath, path),
    pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
    mcpInfo: () => ipcRenderer.invoke(IPC.mcpInfo)
  },
  preview: {
    setBounds: (roomId, bounds) => ipcRenderer.invoke(IPC.previewSetBounds, roomId, bounds),
    detach: () => ipcRenderer.invoke(IPC.previewDetach),
    nav: (roomId, action) => ipcRenderer.invoke(IPC.previewNav, roomId, action),
    devtools: (roomId) => ipcRenderer.invoke(IPC.previewDevTools, roomId),
    viewport: (roomId, size) => ipcRenderer.invoke(IPC.previewViewport, roomId, size)
  },
  on: (channel: IpcChannel, listener: (...args: any[]) => void) => {
    const wrapped = (_e: unknown, ...args: any[]): void => listener(...args)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  }
}

contextBridge.exposeInMainWorld('devhotel', api)
