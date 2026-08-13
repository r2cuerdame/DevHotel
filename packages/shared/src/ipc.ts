import type { ChangeEntry, QuickChange } from './changes'
import type { CheckReport } from './checks'
import type { RendererCreateRoomInput, RendererPlanRoomInput } from './control'
import type { CloneRoomInput, RoomInspection, RoomPlan, RoomRecord } from './rooms'
import type { GitHubServiceStatus, McpRegistryPage } from './hotelServices'

/** IPC channel names. Events (`ev*`) flow main → renderer; the rest are invoke/handle. */
export const IPC = {
  roomsList: 'rooms:list',
  roomsPlan: 'rooms:plan',
  roomsCreate: 'rooms:create',
  roomsClone: 'rooms:clone',
  roomsStart: 'rooms:start',
  roomsSleep: 'rooms:sleep',
  roomsDelete: 'rooms:delete',
  roomsRestartWeb: 'rooms:restartWeb',
  roomsInspect: 'rooms:inspect',
  roomsRename: 'rooms:rename',
  roomsComponents: 'rooms:components',
  roomsSyncFromHost: 'rooms:syncFromHost',
  roomsMoveIntoHotel: 'rooms:moveIntoHotel',
  roomsResetSyncBaseline: 'rooms:resetSyncBaseline',
  roomsSetAgentHostSync: 'rooms:setAgentHostSync',
  packagesSearch: 'packages:search',
  hotelGithubStatus: 'hotel:github:status',
  hotelGithubInstall: 'hotel:github:install',
  hotelGithubConnect: 'hotel:github:connect',
  hotelGithubDisconnect: 'hotel:github:disconnect',
  hotelMcpBrowse: 'hotel:mcp:browse',
  changesList: 'changes:list',
  changesApply: 'changes:apply',
  changesUndo: 'changes:undo',
  checksRun: 'checks:run',
  diagCopy: 'diag:copy',
  logsTailStart: 'logs:tailStart',
  logsTailStop: 'logs:tailStop',
  termOpen: 'term:open',
  termInput: 'term:input',
  termResize: 'term:resize',
  termClose: 'term:close',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  gatewayStatus: 'gateway:status',
  caStatus: 'ca:status',
  caTrust: 'ca:trust',
  caUntrust: 'ca:untrust',
  appVersion: 'app:version',
  openExternal: 'app:openExternal',
  openPath: 'app:openPath',
  pickFolder: 'app:pickFolder',
  mcpInfo: 'app:mcpInfo',
  footprint: 'app:footprint',
  autostartSet: 'app:autostartSet',
  cleanUninstall: 'app:cleanUninstall',
  androidKey: 'android:key',
  previewSetBounds: 'preview:setBounds',
  previewSetVisible: 'preview:setVisible',
  previewDetach: 'preview:detach',
  previewNav: 'preview:nav',
  previewDevTools: 'preview:devtools',
  previewViewport: 'preview:viewport',
  previewLayout: 'preview:layout',
  evRoomsChanged: 'ev:roomsChanged',
  evRoomEvent: 'ev:roomEvent',
  evLogLine: 'ev:logLine',
  evTermData: 'ev:termData',
  evTermExit: 'ev:termExit',
  evPreviewState: 'ev:previewState',
  evPreviewDevTools: 'ev:previewDevTools',
  evUpdate: 'ev:update'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/** One installed program/component of a room, with its live version when the room is awake. */
export interface ComponentInfo {
  id: string
  label: string
  version: string
  /** 'live' = read from inside the room just now; 'recorded' = from the room record */
  source: 'live' | 'recorded'
  /** the change kind that switches this component's version, when switchable */
  changeKind?: string
  options?: string[]
}

export interface RegistryPackageInfo {
  name: string
  version: string
  description: string
  publisher: string
  updatedAt: string
}

export interface GatewayStatusInfo {
  running: boolean
  httpPort: number | null
  httpsPort: number | null
  routes: { domain: string; roomId: string; https: boolean }[]
}

export type PreviewNavAction = 'back' | 'forward' | 'reload' | 'home'
export type PreviewTarget = 'left' | 'right' | 'both'

export interface PreviewViewport {
  width: number
  height: number
}

export interface PreviewLayout {
  mode: 'single' | 'split'
  /** null means fill the left pane instead of emulating a fixed desktop viewport */
  leftViewport: PreviewViewport | null
  rightViewport: PreviewViewport
  /** left pane share of the split (0.15–0.85); the user drags the splitter to change it */
  splitRatio?: number
}

export interface PreviewState {
  roomId: string
  url: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}

export interface RoomEvent {
  roomId: string
  kind: 'status' | 'change' | 'check' | 'log'
  detail?: string
}

export interface McpSetupInfo {
  /** absolute path to the bundled devhotel-mcp entry script */
  serverPath: string
  /** whether the script exists on disk */
  available: boolean
  /** one-liner for Claude Code */
  claudeCommand: string
  /** mcpServers JSON snippet for generic MCP clients */
  configJson: string
  /** control API port currently serving MCP requests */
  controlPort: number | null
}

export interface UpdateStatusInfo {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'
  version?: string
  detail?: string
}

/** The API surface exposed to the renderer as `window.devhotel`. */
export interface IpcApi {
  rooms: {
    list(): Promise<RoomRecord[]>
    plan(input: RendererPlanRoomInput): Promise<RoomPlan>
    create(input: RendererCreateRoomInput): Promise<RoomRecord>
    clone(
      sourceRoomId: string,
      options: Omit<CloneRoomInput, 'sourceRoomId' | 'actor'>
    ): Promise<RoomRecord>
    start(roomId: string): Promise<void>
    sleep(roomId: string): Promise<void>
    delete(roomId: string): Promise<{ reclaimedBytes: number }>
    restartWeb(roomId: string): Promise<void>
    inspect(roomId: string): Promise<RoomInspection>
    rename(roomId: string, nickname: string): Promise<void>
    components(roomId: string): Promise<import('./ipc').ComponentInfo[]>
    syncFromHost(roomId: string, approvedHostPath: string): Promise<RoomRecord>
    moveIntoHotel(roomId: string, approvedHostPath: string): Promise<RoomRecord>
    /** accept the Room's current files as the Host sync baseline */
    resetSyncBaseline(roomId: string): Promise<RoomRecord>
    /** allow or revoke agent-initiated inbound Host sync for this Room */
    setAgentHostSync(roomId: string, allowed: boolean): Promise<RoomRecord>
  }
  packages: {
    search(query: string, offset?: number): Promise<RegistryPackageInfo[]>
  }
  hotel: {
    githubStatus(): Promise<GitHubServiceStatus>
    githubInstall(): Promise<GitHubServiceStatus>
    githubConnect(token: string): Promise<GitHubServiceStatus>
    githubDisconnect(): Promise<GitHubServiceStatus>
    mcpBrowse(search?: string, cursor?: string): Promise<McpRegistryPage>
  }
  changes: {
    list(roomId: string): Promise<ChangeEntry[]>
    apply(roomId: string, change: QuickChange): Promise<ChangeEntry>
    undo(roomId: string, changeId: string): Promise<ChangeEntry>
  }
  checks: { run(roomId: string): Promise<CheckReport> }
  diag: { copy(roomId: string): Promise<string> }
  logs: {
    tailStart(roomId: string, kind: 'web' | 'orchestrator'): Promise<{ lines: string[] }>
    tailStop(roomId: string, kind: 'web' | 'orchestrator'): Promise<void>
  }
  term: {
    open(roomId: string): Promise<{ termId: string }>
    input(termId: string, data: string): void
    resize(termId: string, cols: number, rows: number): void
    close(termId: string): void
  }
  settings: {
    get(key: string): Promise<string | null>
    set(key: string, value: string): Promise<void>
  }
  gateway: { status(): Promise<GatewayStatusInfo> }
  ca: {
    status(): Promise<'trusted' | 'untrusted' | 'missing'>
    trust(): Promise<void>
    untrust(): Promise<void>
  }
  app: {
    version(): Promise<string>
    openExternal(url: string): Promise<void>
    openPath(path: string): Promise<void>
    pickFolder(): Promise<string | null>
    mcpInfo(): Promise<McpSetupInfo>
    footprint(): Promise<{ dataDir: string; installDir: string; autostart: boolean }>
    setAutostart(enabled: boolean): Promise<void>
    /** deletes every room, removes CA trust and autostart, erases app data, launches the uninstaller */
    /** true once cleanup/uninstaller helpers are scheduled; false when native confirmation is cancelled */
    cleanUninstall(): Promise<boolean>
  }
  android: {
    /** press a phone navigation key on the room's emulator */
    key(roomId: string, key: import('./control').AndroidNavKey): Promise<void>
  }
  preview: {
    setBounds(roomId: string, bounds: { x: number; y: number; width: number; height: number }): Promise<void>
    /** hide or reveal the native preview without destroying its browsing state */
    setVisible(roomId: string, visible: boolean): Promise<void>
    detach(): Promise<void>
    /** navigate both responsive panes by default */
    nav(roomId: string, action: PreviewNavAction, target?: PreviewTarget): Promise<void>
    /** toggle a docked Chrome DevTools panel; resolves to the new open state */
    devtools(roomId: string): Promise<boolean>
    /** emulate a viewport size (null = fill the area) */
    viewport(roomId: string, size: { width: number; height: number } | null): Promise<void>
    /** select one or two independent responsive previews sharing the Room browser session */
    layout(roomId: string, layout: PreviewLayout): Promise<void>
  }
  on(channel: IpcChannel, listener: (...args: any[]) => void): () => void
}
