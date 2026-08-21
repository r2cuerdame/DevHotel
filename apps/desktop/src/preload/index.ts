import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type IpcApi, type IpcChannel } from '@devhotel/shared'

const api: IpcApi = {
  rooms: {
    list: () => ipcRenderer.invoke(IPC.roomsList),
    plan: (input) => ipcRenderer.invoke(IPC.roomsPlan, input),
    create: (input) => ipcRenderer.invoke(IPC.roomsCreate, input),
    clone: (sourceRoomId, options) => ipcRenderer.invoke(IPC.roomsClone, sourceRoomId, options),
    start: (roomId) => ipcRenderer.invoke(IPC.roomsStart, roomId),
    sleep: (roomId) => ipcRenderer.invoke(IPC.roomsSleep, roomId),
    delete: (roomId) => ipcRenderer.invoke(IPC.roomsDelete, roomId),
    restartWeb: (roomId) => ipcRenderer.invoke(IPC.roomsRestartWeb, roomId),
    inspect: (roomId) => ipcRenderer.invoke(IPC.roomsInspect, roomId),
    rename: (roomId, nickname) => ipcRenderer.invoke(IPC.roomsRename, roomId, nickname),
    components: (roomId) => ipcRenderer.invoke(IPC.roomsComponents, roomId),
    syncFromHost: (roomId, approvedHostPath) => ipcRenderer.invoke(IPC.roomsSyncFromHost, roomId, approvedHostPath),
    moveIntoHotel: (roomId, approvedHostPath) => ipcRenderer.invoke(IPC.roomsMoveIntoHotel, roomId, approvedHostPath),
    resetSyncBaseline: (roomId) => ipcRenderer.invoke(IPC.roomsResetSyncBaseline, roomId),
    setAgentHostSync: (roomId, allowed) => ipcRenderer.invoke(IPC.roomsSetAgentHostSync, roomId, allowed),
    providers: () => ipcRenderer.invoke(IPC.roomsProviders),
    pickVmwareTemplate: () => ipcRenderer.invoke(IPC.roomsPickVmwareTemplate),
    openWindows: (roomId) => ipcRenderer.invoke(IPC.roomsOpenWindows, roomId),
    resetWindows: (roomId) => ipcRenderer.invoke(IPC.roomsResetWindows, roomId)
  },
  packages: {
    search: (query, offset) => ipcRenderer.invoke(IPC.packagesSearch, query, offset)
  },
  hotel: {
    githubStatus: () => ipcRenderer.invoke(IPC.hotelGithubStatus),
    githubInstall: () => ipcRenderer.invoke(IPC.hotelGithubInstall),
    githubConnect: (token) => ipcRenderer.invoke(IPC.hotelGithubConnect, token),
    githubDisconnect: () => ipcRenderer.invoke(IPC.hotelGithubDisconnect),
    mcpBrowse: (search, cursor) => ipcRenderer.invoke(IPC.hotelMcpBrowse, search, cursor)
  },
  changes: {
    list: (roomId) => ipcRenderer.invoke(IPC.changesList, roomId),
    apply: (roomId, change) => ipcRenderer.invoke(IPC.changesApply, roomId, change),
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
    vmwareStatus: () => ipcRenderer.invoke(IPC.vmwareStatus),
    openVmwareDownload: () => ipcRenderer.invoke(IPC.openVmwareDownload),
    relaunch: () => ipcRenderer.invoke(IPC.relaunch),
    openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
    openPath: (path) => ipcRenderer.invoke(IPC.openPath, path),
    pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
    mcpInfo: () => ipcRenderer.invoke(IPC.mcpInfo),
    footprint: () => ipcRenderer.invoke(IPC.footprint),
    setAutostart: (enabled) => ipcRenderer.invoke(IPC.autostartSet, enabled),
    cleanUninstall: () => ipcRenderer.invoke(IPC.cleanUninstall)
  },
  android: {
    action: (roomId, action) => ipcRenderer.invoke(IPC.androidAction, roomId, action)
  },
  preview: {
    setBounds: (roomId, bounds) => ipcRenderer.invoke(IPC.previewSetBounds, roomId, bounds),
    setVisible: (roomId, visible) => ipcRenderer.invoke(IPC.previewSetVisible, roomId, visible),
    detach: () => ipcRenderer.invoke(IPC.previewDetach),
    nav: (roomId, action, target) => ipcRenderer.invoke(IPC.previewNav, roomId, action, target),
    devtools: (roomId) => ipcRenderer.invoke(IPC.previewDevTools, roomId),
    viewport: (roomId, size) => ipcRenderer.invoke(IPC.previewViewport, roomId, size),
    layout: (roomId, layout) => ipcRenderer.invoke(IPC.previewLayout, roomId, layout)
  },
  on: (channel: IpcChannel, listener: (...args: any[]) => void) => {
    const wrapped = (_e: unknown, ...args: any[]): void => listener(...args)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  }
}

contextBridge.exposeInMainWorld('devhotel', api)
