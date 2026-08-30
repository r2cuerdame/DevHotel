import { create } from 'zustand'
import type {
  ChangeEntry,
  CheckReport,
  CloneServiceMode,
  GatewayStatusInfo,
  PreviewState,
  QuickChange,
  RoomInspection,
  RoomPlan,
  RoomRecord,
  RuntimeRoomRecord,
  RendererCreateRoomInput,
  RendererPlanRoomInput,
  UpdateStatusInfo
} from '@devhotel/shared'
import { IPC } from '@devhotel/shared'
import { api } from '../api'
import { detectLocale, isLocaleId, translate } from '../i18n'
import type { LocaleId, TFunc, Translation } from '../i18n'
import { listRoomsWithRuntimeRetry } from './roomRefresh'

export interface Toast {
  id: number
  kind: 'info' | 'error' | 'success'
  text: string
}

type View = { name: 'lobby' } | { name: 'room'; roomId: string }

interface DhState {
  view: View
  rooms: RuntimeRoomRecord[]
  inspections: Record<string, RoomInspection>
  previews: Record<string, PreviewState>
  logs: Record<string, string[]>
  gateway: GatewayStatusInfo | null
  caStatus: 'trusted' | 'untrusted' | 'missing'
  update: UpdateStatusInfo
  wizardOpen: boolean
  busy: Record<string, string>
  toasts: Toast[]
  lang: LocaleId

  init(): void
  setLang(l: LocaleId): void
  toast(kind: Toast['kind'], text: string): void
  dismissToast(id: number): void
  openRoom(roomId: string): void
  backToLobby(): void
  openWizard(open: boolean): void
  refreshRooms(): Promise<void>
  refreshInspection(roomId: string): Promise<void>
  refreshGateway(): Promise<void>
  planRoom(input: RendererPlanRoomInput): Promise<RoomPlan>
  createRoom(input: RendererCreateRoomInput): Promise<RoomRecord | null>
  cloneRoom(
    roomId: string,
    options: { nickname: string; copyDependencies: boolean; services: CloneServiceMode }
  ): Promise<RoomRecord | null>
  roomAction(roomId: string, action: 'start' | 'sleep' | 'restart' | 'delete'): Promise<void>
  applyChange(roomId: string, change: QuickChange): Promise<ChangeEntry | null>
  undoChange(roomId: string, changeId: string): Promise<void>
  runChecks(roomId: string): Promise<CheckReport | null>
  copyDiagnostic(roomId: string): Promise<void>
  appendLog(key: string, lines: string[]): void
  clearLog(key: string): void
}

let toastSeq = 1
let roomRefreshSequence = 0

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
  lang: detectLocale(),

  init() {
    void api.settings
      .get('lang')
      .then((v) => {
        if (v && isLocaleId(v)) set({ lang: v })
      })
      .catch(() => undefined)
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

  setLang(l) {
    set({ lang: l })
    void api.settings.set('lang', l).catch(() => undefined)
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
    const sequence = ++roomRefreshSequence
    try {
      const rooms = await listRoomsWithRuntimeRetry(() => api.rooms.list())
      if (sequence === roomRefreshSequence) set({ rooms })
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
      get().toast('error', translate(get().lang, 'toast.checkInFailed', { message: err instanceof Error ? err.message : String(err) }))
      return null
    }
  },

  async cloneRoom(roomId, options) {
    set((s) => ({ busy: { ...s.busy, [roomId]: translate(get().lang, 'busy.cloning') } }))
    try {
      const room = await api.rooms.clone(roomId, options)
      await get().refreshRooms()
      get().toast('success', translate(get().lang, 'toast.roomCloned', { nickname: room.nickname }))
      get().openRoom(room.id)
      return room
    } catch (err) {
      get().toast('error', err instanceof Error ? err.message : String(err))
      return null
    } finally {
      set((s) => {
        const busy = { ...s.busy }
        delete busy[roomId]
        return { busy }
      })
    }
  },

  async roomAction(roomId, action) {
    const labels: Record<typeof action, keyof Translation> = {
      start: 'busy.waking',
      sleep: 'busy.sleeping',
      restart: 'busy.restarting',
      delete: 'busy.deleting'
    }
    set((s) => ({ busy: { ...s.busy, [roomId]: translate(get().lang, labels[action]) } }))
    try {
      if (action === 'start') await api.rooms.start(roomId)
      else if (action === 'sleep') await api.rooms.sleep(roomId)
      else if (action === 'restart') await api.rooms.restartWeb(roomId)
      else {
        const { reclaimedBytes } = await api.rooms.delete(roomId)
        get().toast('success', translate(get().lang, 'toast.roomDeleted', { size: formatBytes(reclaimedBytes) }))
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
      const entry = await api.changes.apply(roomId, change)
      get().toast(
        entry.verify?.ok ? 'success' : 'error',
        entry.verify?.ok
          ? `${entry.title} ✓`
          : translate(get().lang, 'toast.changeFailed', {
              title: entry.title,
              detail: entry.verify?.detail ?? translate(get().lang, 'toast.seeDiagnostics')
            })
      )
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
      get().toast('success', translate(get().lang, 'toast.undone', { title: entry.title }))
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
      get().toast('success', translate(get().lang, 'toast.diagCopied'))
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
  if (room.runtime.kind === 'jdk') return `JDK ${room.runtime.version} · ${pm}`
  return `Node ${room.runtime.version} · ${pm}${room.https ? ' · HTTPS' : ''}`
}

const STATUS_KEY: Record<RoomRecord['status'], keyof Translation> = {
  preparing: 'status.preparing',
  running: 'status.running',
  ready: 'status.ready',
  sleeping: 'status.sleeping',
  attention: 'status.attention',
  broken: 'status.broken'
}

export function statusLabel(t: TFunc, status: RoomRecord['status']): string {
  return t(STATUS_KEY[status])
}

export function useT(): TFunc {
  const lang = useStore((s) => s.lang)
  return (key, vars) => translate(lang, key, vars)
}
