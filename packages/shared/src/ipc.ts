import type { ChangeEntry, QuickChange } from './changes'
import type { CheckReport } from './checks'
import type { Actor, CreateRoomInput, RoomInspection, RoomPlan, RoomRecord, SourceType } from './rooms'

/** IPC channel names. Events (`ev*`) flow main → renderer; the rest are invoke/handle. */
export const IPC = {
  roomsList: 'rooms:list',
  roomsPlan: 'rooms:plan',
  roomsCreate: 'rooms:create',
  roomsStart: 'rooms:start',
  roomsSleep: 'rooms:sleep',
  roomsDelete: 'rooms:delete',
  roomsRestartWeb: 'rooms:restartWeb',
  roomsInspect: 'rooms:inspect',
  roomsRename: 'rooms:rename',
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
  previewSetBounds: 'preview:setBounds',
  previewDetach: 'preview:detach',
  previewNav: 'preview:nav',
  evRoomsChanged: 'ev:roomsChanged',
  evRoomEvent: 'ev:roomEvent',
  evLogLine: 'ev:logLine',
  evTermData: 'ev:termData',
  evTermExit: 'ev:termExit',
  evPreviewState: 'ev:previewState',
  evUpdate: 'ev:update'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

export interface GatewayStatusInfo {
  running: boolean
  httpPort: number | null
  httpsPort: number | null
  routes: { domain: string; roomId: string; https: boolean }[]
}

export type PreviewNavAction = 'back' | 'forward' | 'reload' | 'home'

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
    plan(input: { sourceType: SourceType; sourceRef: string; nickname: string; project?: string }): Promise<RoomPlan>
    create(input: CreateRoomInput): Promise<RoomRecord>
    start(roomId: string): Promise<void>
    sleep(roomId: string): Promise<void>
    delete(roomId: string): Promise<{ reclaimedBytes: number }>
    restartWeb(roomId: string): Promise<void>
    inspect(roomId: string): Promise<RoomInspection>
    rename(roomId: string, nickname: string): Promise<void>
  }
  changes: {
    list(roomId: string): Promise<ChangeEntry[]>
    apply(roomId: string, change: QuickChange, actor: Actor): Promise<ChangeEntry>
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
  }
  preview: {
    setBounds(roomId: string, bounds: { x: number; y: number; width: number; height: number }): Promise<void>
    detach(): Promise<void>
    nav(roomId: string, action: PreviewNavAction): Promise<void>
  }
  on(channel: IpcChannel, listener: (...args: any[]) => void): () => void
}
