import { create } from 'zustand'
import type {
  ChangeEntry,
  CheckReport,
  CreateRoomInput,
  GatewayStatusInfo,
  PreviewState,
  QuickChange,
  RoomInspection,
  RoomPlan,
  RoomRecord,
  UpdateStatusInfo
} from '@devhotel/shared'
import { IPC } from '@devhotel/shared'
import { api } from '../api'

export interface Toast {
  id: number
  kind: 'info' | 'error' | 'success'
  text: string
}

type View = { name: 'lobby' } | { name: 'room'; roomId: string }

interface DhState {
  view: View
  rooms: RoomRecord[]
  inspections: Record<string, RoomInspection>
  previews: Record<string, PreviewState>
  logs: Record<string, string[]>
  gateway: GatewayStatusInfo | null
  caStatus: 'trusted' | 'untrusted' | 'missing'
  update: UpdateStatusInfo
  wizardOpen: boolean
  busy: Record<string, string>
  toasts: Toast[]

  init(): void
  toast(kind: Toast['kind'], text: string): void
  dismissToast(id: number): void
  openRoom(roomId: string): void
  backToLobby(): void
  openWizard(open: boolean): void
  refreshRooms(): Promise<void>
  refreshInspection(roomId: string): Promise<void>
  refreshGateway(): Promise<void>
  planRoom(input: { sourceType: CreateRoomInput['sourceType']; sourceRef: string; nickname: string; project?: string }): Promise<RoomPlan>
  createRoom(input: CreateRoomInput): Promise<RoomRecord | null>
  roomAction(roomId: string, action: 'start' | 'sleep' | 'restart' | 'delete'): Promise<void>
  applyChange(roomId: string, change: QuickChange): Promise<ChangeEntry | null>
  undoChange(roomId: string, changeId: string): Promise<void>
  runChecks(roomId: string): Promise<CheckReport | null>
  copyDiagnostic(roomId: string): Promise<void>
  appendLog(key: string, lines: string[]): void
  clearLog(key: string): void
}

let toastSeq = 1

export const useStore = create<DhState>((set, get) => ({
  view: { name: 'lobby' },
  rooms: [],
  inspections: {},
  previews: {},
  logs: {},
  gateway: null,
  caStatus: 'missing',
  update: { state: 'idle' },
  wizardOpen: false,
  busy: {},
  toasts: [],

  init() {
    void get().refreshRooms()
    void get().refreshGateway()
    void api.ca.status().then((caStatus) => set({ caStatus })).catch(() => undefined)
    api.on(IPC.evRoomsChanged, () => {
      void get().refreshRooms()
      const v = get().view
      if (v.name === 'room') void get().refreshInspection(v.roomId)
    })
    api.on(IPC.evRoomEvent, (ev: { roomId: string }) => {
      void get().refreshRooms()
      void get().refreshInspection(ev.roomId)
    })
    api.on(IPC.evLogLine, (p: { roomId: string; kind: string; line: string }) => {
      get().appendLog(`${p.roomId}:${p.kind}`, [p.line])
    })
    api.on(IPC.evPreviewState, (p: PreviewState) => {
      set((s) => ({ previews: { ...s.previews, [p.roomId]: p } }))
    })
    api.on(IPC.evUpdate, (u: UpdateStatusInfo) => set({ update: u }))
  },

  toast(kind, text) {
    const id = toastSeq++
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }))
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 8000 : 4000)
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },

  openRoom(roomId) {
    set({ view: { name: 'room', roomId } })
    void get().refreshInspection(roomId)
  },
  backToLobby() {
    void api.preview.detach().catch(() => undefined)
    set({ view: { name: 'lobby' } })
    void get().refreshRooms()
  },
  openWizard(open) {
    set({ wizardOpen: open })
  },

  async refreshRooms() {
    try {
      set({ rooms: await api.rooms.list() })
    } catch {
      // main not ready yet
    }
  },
  async refreshInspection(roomId) {
    try {
      const ins = await api.rooms.inspect(roomId)
      set((s) => ({ inspections: { ...s.inspections, [roomId]: ins } }))
    } catch {
      // room may have been deleted
    }
  },
  async refreshGateway() {
    try {
      set({ gateway: await api.gateway.status() })
    } catch {
      // main not ready yet
    }
  },

  async planRoom(input) {
    return api.rooms.plan(input)
  },

  async createRoom(input) {
    try {
      const room = await api.rooms.create(input)
      set({ wizardOpen: false })
      await get().refreshRooms()
      get().openRoom(room.id)
      return room
    } catch (err) {
      get().toast('error', `Check-in failed: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  },

  async roomAction(roomId, action) {
    const labels = { start: 'Waking room…', sleep: 'Putting room to sleep…', restart: 'Restarting…', delete: 'Checking out…' }
    set((s) => ({ busy: { ...s.busy, [roomId]: labels[action] } }))
    try {
      if (action === 'start') await api.rooms.start(roomId)
      else if (action === 'sleep') await api.rooms.sleep(roomId)
      else if (action === 'restart') await api.rooms.restartWeb(roomId)
      else {
        const { reclaimedBytes } = await api.rooms.delete(roomId)
        get().toast('success', `Room deleted — ${formatBytes(reclaimedBytes)} reclaimed`)
        get().backToLobby()
      }
    } catch (err) {
      get().toast('error', err instanceof Error ? err.message : String(err))
    } finally {
      set((s) => {
        const busy = { ...s.busy }
        delete busy[roomId]
        return { busy }
      })
      await get().refreshRooms()
      if (action !== 'delete') await get().refreshInspection(roomId)
    }
  },

  async applyChange(roomId, change) {
    try {
      const entry = await api.changes.apply(roomId, change, 'user')
      get().toast(entry.verify?.ok ? 'success' : 'error', entry.verify?.ok ? `${entry.title} ✓` : `${entry.title} failed — ${entry.verify?.detail ?? 'see diagnostics'}`)
      await get().refreshInspection(roomId)
      return entry
    } catch (err) {
      get().toast('error', err instanceof Error ? err.message : String(err))
      return null
    }
  },

  async undoChange(roomId, changeId) {
    try {
      const entry = await api.changes.undo(roomId, changeId)
      get().toast('success', `Undone: ${entry.title}`)
      await get().refreshInspection(roomId)
    } catch (err) {
      get().toast('error', err instanceof Error ? err.message : String(err))
    }
  },

  async runChecks(roomId) {
    try {
      const report = await api.checks.run(roomId)
      await get().refreshInspection(roomId)
      return report
    } catch (err) {
      get().toast('error', err instanceof Error ? err.message : String(err))
      return null
    }
  },

  async copyDiagnostic(roomId) {
    try {
      const text = await api.diag.copy(roomId)
      await navigator.clipboard.writeText(text)
      get().toast('success', 'Diagnostic copied — secrets redacted')
    } catch (err) {
      get().toast('error', err instanceof Error ? err.message : String(err))
    }
  },

  appendLog(key, lines) {
    set((s) => {
      const cur = s.logs[key] ?? []
      const next = [...cur, ...lines]
      return { logs: { ...s.logs, [key]: next.length > 2000 ? next.slice(-2000) : next } }
    })
  },
  clearLog(key) {
    set((s) => ({ logs: { ...s.logs, [key]: [] } }))
  }
}))

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

export function stackLine(room: RoomRecord): string {
  const pm = room.packageManager.kind + (room.packageManager.version ? ` ${room.packageManager.version.split('.')[0]}` : '')
  return `Node ${room.runtime.version} · ${pm}${room.https ? ' · HTTPS' : ''}`
}

export const STATUS_LABEL: Record<RoomRecord['status'], string> = {
  preparing: 'Preparing',
  running: 'Running',
  ready: 'Ready',
  sleeping: 'Sleeping',
  attention: 'Needs attention',
  broken: 'Broken'
}
