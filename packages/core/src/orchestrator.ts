import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { customAlphabet } from 'nanoid'
import type {
  Actor,
  ChangeEntry,
  CheckReport,
  CreateRoomInput,
  QuickChange,
  RoomInspection,
  RoomPlan,
  RoomRecord,
  SourceType
} from '@devhotel/shared'
import { runDocker } from './backend/cli'
import type { ExecResult, IsolationBackend, WebSpec } from './backend/types'
import { ChangeEngine } from './changes/engine'
import { registerQuickChanges, depsVolumeForGen } from './changes/definitions/index'
import type { ChangeCtx } from './changes/types'
import { verifyWebUp } from './changes/types'
import { runChecks as runCheckPipeline } from './checks/engine'
import { detectProject, slugify } from './detect/detector'
import type { SourceReader } from './detect/sourceReader'
import { fsSourceReader } from './detect/sourceReader'
import { buildDiagnostic } from './diagnostics/bundle'
import type { Gateway } from './gateway/gateway'
import { LogHub, type LogKind } from './logs'
import { writeManifest } from './manifest'
import { reconcile, type ReconcileResult } from './reconcile'
import type { Db } from './store/db'
import { changesRepo, type ChangesRepo } from './store/changesRepo'
import { checksRepo, type ChecksRepo } from './store/checksRepo'
import { roomsRepo, type RoomsRepo } from './store/roomsRepo'
import { settingsRepo, type SettingsRepo } from './store/settingsRepo'

const newRoomId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 8)

export interface OrchestratorEvent {
  roomId: string
  kind: 'status' | 'change' | 'check' | 'deleted' | 'created'
  detail?: string
}

export interface OrchestratorOptions {
  userData: string
  backend: IsolationBackend
  gateway: Gateway
  db: Db
  appVersion: string
}

const EMPTY_READER: SourceReader = {
  readFile: async () => null,
  exists: async () => false
}

export class RoomOrchestrator {
  readonly rooms: RoomsRepo
  readonly changes: ChangesRepo
  readonly checks: ChecksRepo
  readonly settings: SettingsRepo
  readonly logs: LogHub
  private readonly engine = new ChangeEngine()
  private readonly emitter = new EventEmitter()
  private readonly userData: string
  private readonly backend: IsolationBackend
  private readonly gateway: Gateway
  private readonly appVersion: string

  constructor(opts: OrchestratorOptions) {
    this.userData = opts.userData
    this.backend = opts.backend
    this.gateway = opts.gateway
    this.appVersion = opts.appVersion
    this.rooms = roomsRepo(opts.db)
    this.changes = changesRepo(opts.db)
    this.checks = checksRepo(opts.db)
    this.settings = settingsRepo(opts.db)
    this.logs = new LogHub(opts.userData)
    registerQuickChanges(this.engine)
  }

  async init(): Promise<{ backendOk: boolean; reconciled: ReconcileResult | null }> {
    await this.gateway.start()
    const health = await this.backend.health()
    let reconciled: ReconcileResult | null = null
    if (health.ok) {
      reconciled = await reconcile(this.backend, this.rooms, (l) => this.olog('system', l))
    }
    return { backendOk: health.ok, reconciled }
  }

  async shutdown(): Promise<void> {
    for (const room of this.rooms.list()) {
      if (room.status !== 'sleeping' && room.status !== 'broken') {
        try {
          await this.sleepRoom(room.id, 'devhotel')
        } catch {
          // best effort on quit
        }
      }
    }
    this.logs.dispose()
    await this.gateway.stop()
  }

  onEvent(cb: (e: OrchestratorEvent) => void): () => void {
    this.emitter.on('event', cb)
    return () => this.emitter.off('event', cb)
  }

  onLogLine(cb: (e: { roomId: string; kind: LogKind; line: string }) => void): () => void {
    this.logs.on('line', cb)
    return () => this.logs.off('line', cb)
  }

  listRooms(): RoomRecord[] {
    return this.rooms.list()
  }

  backendHealth(): Promise<{ ok: boolean; detail: string }> {
    return this.backend.health()
  }

  async planRoom(input: { sourceType: SourceType; sourceRef: string; nickname: string; project?: string }): Promise<RoomPlan> {
    const project = input.project ?? deriveProjectName(input.sourceType, input.sourceRef)
    const { reader, cleanup } = await this.sourceReaderFor(input.sourceType, input.sourceRef)
    try {
      return await detectProject(reader, { project, nickname: input.nickname })
    } finally {
      cleanup()
    }
  }

  async createRoom(input: CreateRoomInput): Promise<RoomRecord> {
    const { reader, cleanup } = await this.sourceReaderFor(input.sourceType, input.sourceRef)
    let plan: RoomPlan
    try {
      plan = await detectProject(reader, {
        project: input.project,
        nickname: input.nickname,
        overrides: {
          runtimeVersion: input.planOverrides?.runtimeVersion,
          pmKind: input.planOverrides?.pmKind,
          startCommand: input.planOverrides?.startCommand,
          internalPort: input.planOverrides?.internalPort
        }
      })
    } finally {
      cleanup()
    }

    const id = newRoomId()
    const now = new Date().toISOString()
    const domain = this.uniqueDomain(input.planOverrides?.domain ?? plan.domain)
    const record: RoomRecord = {
      id,
      project: input.project,
      nickname: input.nickname,
      roomNumber: this.rooms.nextRoomNumber(),
      provider: 'web',
      sourceType: input.sourceType,
      sourceRef: input.sourceRef,
      runtime: { kind: 'node', version: plan.runtime.value },
      packageManager: { kind: plan.packageManager.value, version: plan.packageManager.version },
      startCommand: plan.startCommand.value,
      internalPort: plan.internalPort.value,
      domain,
      https: input.planOverrides?.https ?? false,
      status: 'preparing',
      hostPort: null,
      createdAt: now,
      lastUsedAt: now,
      thumbPath: null
    }
    this.rooms.create(record)
    mkdirSync(join(this.userData, 'rooms', id, 'logs'), { recursive: true })
    this.appendJournal(id, 'create-room', `Room created — ${record.project} / ${record.nickname}`, input.actor, 'Room', null, {
      runtime: `node ${record.runtime.version}`,
      packageManager: record.packageManager.kind,
      domain: record.domain
    })
    this.emit(id, 'created')
    this.olog(id, `create room ${record.project}/${record.nickname} (node ${record.runtime.version}, ${record.packageManager.kind})`)

    try {
      const { hostPort } = await this.backend.createRoomPod(this.webSpecFor(record))
      this.rooms.update(id, { hostPort, status: 'running' })
      this.logs.attach(id)

      if (record.sourceType !== 'empty') {
        await this.engine.execute(this.ctxFor(id), 'deps-install', { clean: false }, 'devhotel')
      }
      await this.syncRouteFor(id)
      const verify = await verifyWebUp(this.ctxFor(id), { timeoutMs: 90_000 })
      this.rooms.update(id, { status: verify.ok ? 'ready' : 'attention', lastUsedAt: new Date().toISOString() })
      this.olog(id, `room up: ${verify.detail}`)
    } catch (err) {
      this.olog(id, `create failed: ${err instanceof Error ? err.message : String(err)}`)
      this.rooms.update(id, { status: 'broken' })
    }

    const room = this.rooms.get(id)!
    await writeManifest(this.userData, room)
    this.emit(id, 'status')
    return room
  }

  async startRoom(roomId: string, _actor: Actor): Promise<void> {
    const room = this.mustGet(roomId)
    if (room.status === 'running' || room.status === 'ready') return
    this.rooms.update(roomId, { status: 'preparing' })
    this.emit(roomId, 'status')
    this.olog(roomId, 'wake room')
    try {
      // Recreate both containers from the current record so changes made while
      // asleep (node version, command, port) are materialized on wake.
      const { hostPort } = await this.backend.recreateAnchor({ roomId, internalPort: room.internalPort })
      this.rooms.update(roomId, { hostPort, status: 'running' })
      await this.backend.recreateWeb(this.webSpecFor(this.mustGet(roomId)))
      this.logs.attach(roomId)
      await this.syncRouteFor(roomId)
      const verify = await verifyWebUp(this.ctxFor(roomId), { timeoutMs: 90_000 })
      this.rooms.update(roomId, {
        status: verify.ok ? 'ready' : 'attention',
        lastUsedAt: new Date().toISOString()
      })
      this.olog(roomId, `wake: ${verify.detail}`)
    } catch (err) {
      this.olog(roomId, `wake failed: ${err instanceof Error ? err.message : String(err)}`)
      this.rooms.update(roomId, { status: 'broken' })
    }
    this.emit(roomId, 'status')
  }

  async sleepRoom(roomId: string, _actor: Actor): Promise<void> {
    const room = this.mustGet(roomId)
    this.olog(roomId, 'sleep room')
    this.logs.detach(roomId)
    this.gateway.removeRoute(room.domain)
    await this.backend.stopRoomPod(roomId)
    this.rooms.update(roomId, { status: 'sleeping', hostPort: null, lastUsedAt: new Date().toISOString() })
    await writeManifest(this.userData, this.mustGet(roomId))
    this.emit(roomId, 'status')
  }

  async restartWeb(roomId: string, actor: Actor): Promise<ChangeEntry> {
    const entry = await this.engine.execute(this.ctxFor(roomId), 'restart-web', {}, actor)
    this.emit(roomId, 'change')
    return entry
  }

  async deleteRoom(roomId: string, _actor: Actor): Promise<{ reclaimedBytes: number }> {
    const room = this.mustGet(roomId)
    this.olog(roomId, 'delete room')
    this.logs.detach(roomId)
    this.gateway.removeRoute(room.domain)
    const { reclaimedBytes } = await this.backend.deleteRoomPod(roomId, { volumes: true })
    this.rooms.delete(roomId)
    rmSync(join(this.userData, 'rooms', roomId), { recursive: true, force: true })
    this.emit(roomId, 'deleted')
    return { reclaimedBytes }
  }

  inspectRoom(roomId: string): RoomInspection {
    const room = this.mustGet(roomId)
    const recent = this.changes.list(roomId).slice(0, 15)
    return {
      room,
      urls: { app: this.gateway.urlFor(room.domain, room.https) },
      dataDir: join(this.userData, 'rooms', room.id),
      stackLine: `Node ${room.runtime.version} · ${room.packageManager.kind}`,
      latestCheck: this.checks.latest(roomId),
      recentChanges: recent,
      lastUndoable: this.changes.lastUndoable(roomId),
      storage: null
    }
  }

  listChanges(roomId: string): ChangeEntry[] {
    return this.changes.list(roomId)
  }

  async applyChange(roomId: string, change: QuickChange, actor: Actor): Promise<ChangeEntry> {
    const entry = await this.engine.execute(this.ctxFor(roomId), change.kind, change, actor)
    const room = this.mustGet(roomId)
    if (entry.verify && room.status !== 'sleeping' && room.status !== 'preparing') {
      this.rooms.update(roomId, { status: entry.verify.ok ? 'ready' : 'attention' })
    }
    await writeManifest(this.userData, this.mustGet(roomId))
    this.emit(roomId, 'change', entry.title)
    this.emit(roomId, 'status')
    return entry
  }

  async undoChange(roomId: string, changeId: string, actor: Actor): Promise<ChangeEntry> {
    const entry = await this.engine.undo(this.ctxFor(roomId), changeId, actor)
    await writeManifest(this.userData, this.mustGet(roomId))
    this.emit(roomId, 'change', entry.title)
    this.emit(roomId, 'status')
    return entry
  }

  async runChecks(roomId: string): Promise<CheckReport> {
    const room = this.mustGet(roomId)
    const report = await runCheckPipeline({
      room,
      backend: this.backend,
      gateway: this.gateway,
      userData: this.userData,
      depsGen: this.depsGen(roomId),
      syncRoute: () => this.syncRouteFor(roomId)
    })
    this.checks.saveReport(report)
    if (room.status !== 'sleeping' && room.status !== 'preparing') {
      const coreBroken = report.results.some(
        (r) => (r.step === 'process' || r.step === 'port' || r.step === 'http') && r.status === 'broken'
      )
      const anyBad = report.results.some((r) => r.status === 'broken' || r.status === 'warning')
      this.rooms.update(roomId, { status: coreBroken ? 'broken' : anyBad ? 'attention' : 'ready' })
    }
    this.emit(roomId, 'check', report.overall)
    return report
  }

  execInRoom(roomId: string, cmd: string[], opts?: { timeoutMs?: number }): Promise<ExecResult> {
    this.mustGet(roomId)
    return this.backend.execInRoom(roomId, cmd, opts)
  }

  async getDiagnostic(roomId: string): Promise<string> {
    const room = this.mustGet(roomId)
    const report = await this.runChecks(roomId)
    let customPatterns: string[] = []
    try {
      customPatterns = JSON.parse(this.settings.get('redactPatterns') ?? '[]') as string[]
    } catch {
      customPatterns = []
    }
    return buildDiagnostic({
      room,
      appVersion: this.appVersion,
      report,
      recentChanges: this.changes.list(roomId).slice(0, 6),
      gateway: this.gateway.status(),
      webLogTail: this.logs.tail(roomId, 'web', 60),
      customPatterns
    })
  }

  renameRoom(roomId: string, nickname: string): void {
    if (!nickname.trim()) throw new Error('Nickname cannot be empty')
    this.rooms.update(roomId, { nickname: nickname.trim() })
    this.emit(roomId, 'status')
  }

  setThumbnail(roomId: string, thumbPath: string): void {
    if (this.rooms.get(roomId)) this.rooms.update(roomId, { thumbPath })
  }

  /* ------------------------------------------------------------------ */

  private ctxFor(roomId: string): ChangeCtx {
    return {
      roomId,
      backend: this.backend,
      gateway: this.gateway,
      rooms: this.rooms,
      changes: this.changes,
      settings: this.settings,
      userData: this.userData,
      log: (line) => this.olog(roomId, line),
      room: () => this.mustGet(roomId),
      webSpec: (overrides) => this.webSpecFor(this.mustGet(roomId), overrides),
      isAwake: () => {
        const s = this.mustGet(roomId).status
        return s === 'running' || s === 'ready' || s === 'attention'
      },
      syncRoute: () => this.syncRouteFor(roomId)
    }
  }

  private webSpecFor(room: RoomRecord, overrides?: Partial<WebSpec>): WebSpec {
    const gen = this.depsGen(room.id)
    return {
      roomId: room.id,
      internalPort: room.internalPort,
      nodeMajor: room.runtime.version,
      sourceType: room.sourceType,
      sourceRef: room.sourceRef,
      startCommand: room.startCommand,
      env: {},
      depsVolumeOverride: gen > 0 ? depsVolumeForGen(room.id, room.runtime.version, gen) : undefined,
      ...overrides
    }
  }

  private depsGen(roomId: string): number {
    const raw = this.settings.get(`depsGen:${roomId}`)
    return raw ? Number.parseInt(raw, 10) : 0
  }

  private async syncRouteFor(roomId: string): Promise<void> {
    const room = this.mustGet(roomId)
    if (room.hostPort != null) {
      await this.gateway.setRoute({
        domain: room.domain,
        roomId: room.id,
        targetPort: room.hostPort,
        https: room.https
      })
    }
  }

  private uniqueDomain(domain: string): string {
    const taken = new Set(this.rooms.list().map((r) => r.domain))
    if (!taken.has(domain)) return domain
    const base = domain.replace(/\.localhost$/, '')
    for (let i = 2; i < 100; i++) {
      const candidate = `${base}-${i}.localhost`
      if (!taken.has(candidate)) return candidate
    }
    throw new Error(`No free domain variant for ${domain}`)
  }

  private async sourceReaderFor(
    sourceType: SourceType,
    sourceRef: string
  ): Promise<{ reader: SourceReader; cleanup: () => void }> {
    if (sourceType === 'linked-folder') return { reader: fsSourceReader(sourceRef), cleanup: () => undefined }
    if (sourceType === 'empty') return { reader: EMPTY_READER, cleanup: () => undefined }
    // managed-git: shallow clone into a temp dir through docker so the host
    // never needs git installed
    const tmp = join(this.userData, 'tmp', `plan-${newRoomId()}`)
    mkdirSync(tmp, { recursive: true })
    const result = await runDocker(
      ['run', '--rm', '-v', `${tmp}:/workspace`, '-w', '/workspace', 'alpine/git', 'clone', '--depth', '1', sourceRef, '.'],
      { timeoutMs: 180_000 }
    )
    if (result.code !== 0) {
      rmSync(tmp, { recursive: true, force: true })
      throw new Error(`Could not read repository ${sourceRef}: ${result.stderr.slice(-300)}`)
    }
    return { reader: fsSourceReader(tmp), cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
  }

  private appendJournal(
    roomId: string,
    kind: string,
    title: string,
    actor: Actor,
    component: string,
    before: unknown,
    after: unknown
  ): void {
    this.changes.append({
      id: crypto.randomUUID(),
      roomId,
      kind,
      title,
      actor,
      component,
      before,
      after,
      captured: null,
      steps: [],
      verify: { ok: true, detail: 'recorded' },
      undoable: false,
      undoStrategy: 'none',
      status: 'verified',
      rawLogPath: null,
      createdAt: new Date().toISOString(),
      undoneAt: null
    })
  }

  private mustGet(roomId: string): RoomRecord {
    const room = this.rooms.get(roomId)
    if (!room) throw new Error(`Room not found: ${roomId}`)
    return room
  }

  private olog(roomId: string, line: string): void {
    if (roomId !== 'system') this.logs.orchestrator(roomId, line)
  }

  private emit(roomId: string, kind: OrchestratorEvent['kind'], detail?: string): void {
    this.emitter.emit('event', { roomId, kind, detail } satisfies OrchestratorEvent)
  }
}

function deriveProjectName(sourceType: SourceType, sourceRef: string): string {
  if (sourceType === 'managed-git') {
    return slugify((sourceRef.split('/').pop() ?? 'project').replace(/\.git$/, '')) || 'project'
  }
  if (sourceType === 'linked-folder') {
    return slugify(sourceRef.replaceAll('\\', '/').split('/').filter(Boolean).pop() ?? 'project') || 'project'
  }
  return 'project'
}
