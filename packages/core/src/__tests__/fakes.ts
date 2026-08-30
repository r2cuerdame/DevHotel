import { mkdtempSync } from 'node:fs'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RoomRecord } from '@devhotel/shared'
import type { ExecOpts, ExecResult, ExportedArtifact, IsolationBackend, WebSpec } from '../backend/types'
import type { Gateway } from '../gateway/gateway'
import type { Route } from '../gateway/routes'
import type { AdbBinaryResult, AdbDeviceLine, AdbHost, AdbHostAvailability } from '../devices/adbHost'
import type { WindowsVmLifecycle } from '../orchestrator'
import { openDb, type Db } from '../store/db'

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dh-test-'))
}

export function testDb(): Db {
  return openDb(tempDir())
}

export function makeRoom(overrides: Partial<RoomRecord> = {}): RoomRecord {
  return {
    id: 'room1abc',
    project: 'demo',
    nickname: 'dev',
    roomNumber: 201,
    provider: 'web',
    sourceType: 'linked-folder',
    sourceRef: 'C:\\code\\demo',
    workspaceMode: 'legacy-host-bind',
    stateRevision: 0,
    workspaceVolumeRevision: 0,
    syncStatus: 'legacy',
    lastSyncedAt: null,
    hostSyncEnabled: true,
    workspaceFingerprint: null,
    runtime: { kind: 'node', version: '22' },
    packageManager: { kind: 'pnpm', version: '10' },
    startCommand: 'pnpm dev',
    internalPort: 3000,
    domain: 'demo-dev.localhost',
    https: false,
    status: 'ready',
    services: {},
    os: { env: {} },
    hostPort: null,
    createdAt: '2026-08-10T10:00:00.000Z',
    lastUsedAt: '2026-08-10T10:00:00.000Z',
    thumbPath: null,
    ...overrides
  }
}

const ok: ExecResult = { code: 0, stdout: '', stderr: '' }

export class FakeBackend implements IsolationBackend {
  calls: string[] = []
  execInRoomCalls: { roomId: string; cmd: string[] }[] = []
  managedContainers: { roomId: string; role: string; state: string; name: string }[] = []
  managedNetworks: { roomId: string; name: string }[] = []
  webStateValue: 'running' | 'exited' | 'missing' = 'running'
  oneShotResult: ExecResult = ok
  exportedArtifacts: ExportedArtifact[] = [
    { relativePath: 'app/build/outputs/apk/debug/app-debug.apk', size: 8, sha256: 'a'.repeat(64) }
  ]
  execResult: ExecResult = ok
  /** per-command answers for tests that drive several different in-room probes */
  execHandler: ((cmd: string[]) => ExecResult) | null = null
  oneShotHandler: ((spec: WebSpec, cmd: string) => ExecResult) | null = null
  execInRoomHandler: ((roomId: string, cmd: string[], opts?: ExecOpts) => Promise<ExecResult> | ExecResult) | null = null
  copyFromRoomHook: ((roomId: string, containerPath: string, hostPath: string) => Promise<void> | void) | null = null
  hostPort = 45000
  relayTokenValue = ''
  lastWebSpec: WebSpec | null = null

  async health() {
    return { ok: true, detail: 'fake docker' }
  }
  async createRoomPod(spec: WebSpec, opts?: { initializeManagedSource?: boolean; startWeb?: boolean }) {
    this.calls.push(`createRoomPod:${spec.roomId}`)
    if (opts?.initializeManagedSource === false) this.calls.push(`createRoomPod:source-ready:${spec.roomId}`)
    if (opts?.startWeb === false) this.calls.push(`createRoomPod:web-stopped:${spec.roomId}`)
    this.lastWebSpec = spec
    return { hostPort: spec.standalone ? null : this.hostPort }
  }
  async relayToken(_roomId: string) {
    return this.relayTokenValue
  }
  async startRoomPod(roomId: string, opts?: { standalone?: boolean }) {
    this.calls.push(`startRoomPod:${roomId}`)
    return { hostPort: opts?.standalone ? null : this.hostPort }
  }
  async startWeb(roomId: string) {
    this.calls.push(`startWeb:${roomId}`)
  }
  async stopRoomPod(roomId: string) {
    this.calls.push(`stopRoomPod:${roomId}`)
  }
  async pauseWeb(roomId: string) {
    this.calls.push(`pauseWeb:${roomId}`)
  }
  async unpauseWeb(roomId: string) {
    this.calls.push(`unpauseWeb:${roomId}`)
  }
  async restartWeb(roomId: string) {
    this.calls.push(`restartWeb:${roomId}`)
  }
  async recreateWeb(spec: WebSpec) {
    this.calls.push(`recreateWeb:${spec.roomId}:node${spec.nodeMajor}:${spec.depsVolumeOverride ?? 'default'}`)
    this.lastWebSpec = spec
  }
  async recreateAnchor(spec: { roomId: string; internalPort: number }) {
    this.calls.push(`recreateAnchor:${spec.roomId}:${spec.internalPort}`)
    return { hostPort: this.hostPort }
  }
  async deleteRoomPod(roomId: string) {
    this.calls.push(`deleteRoomPod:${roomId}`)
    return { reclaimedBytes: 1024 }
  }
  /** Chunks to emit instead of `execResult`, so streaming callers can be tested. */
  execChunks: { stdout?: string[]; stderr?: string[] } | null = null
  async execInRoom(roomId: string, cmd: string[], opts?: ExecOpts): Promise<ExecResult> {
    this.execInRoomCalls.push({ roomId, cmd })
    const result = this.execInRoomHandler
      ? await this.execInRoomHandler(roomId, cmd, opts)
      : (this.execHandler?.(cmd) ?? this.execResult)
    if (!opts?.onStdout && !opts?.onStderr) return result
    const stdout = this.execChunks?.stdout ?? (result.stdout ? [result.stdout] : [])
    const stderr = this.execChunks?.stderr ?? (result.stderr ? [result.stderr] : [])
    for (const chunk of stdout) opts.onStdout?.(chunk)
    for (const chunk of stderr) opts.onStderr?.(chunk)
    return { code: result.code, stdout: '', stderr: '' }
  }
  async spawnInteractiveExec(): Promise<ChildProcessWithoutNullStreams> {
    throw new Error('interactive process streaming is not available in FakeBackend')
  }
  async followRoomLogs(): Promise<ChildProcessWithoutNullStreams> {
    throw new Error('log streaming is not available in FakeBackend')
  }
  async runOneShot(spec: WebSpec, cmd: string): Promise<ExecResult> {
    this.calls.push(`runOneShot:${spec.workspaceVolumeOverride ?? spec.depsVolumeOverride ?? 'default'}:${cmd}`)
    this.lastWebSpec = spec
    return this.oneShotHandler?.(spec, cmd) ?? this.oneShotResult
  }
  async exportAndroidArtifacts(roomId: string, workspaceVolume: string, artifactsRoot: string, operationId: string) {
    const hostDir = join(artifactsRoot, operationId)
    this.calls.push(`exportAndroidArtifacts:${workspaceVolume}:${hostDir}`)
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    const { createHash } = await import('node:crypto')
    const exported: ExportedArtifact[] = []
    for (const artifact of this.exportedArtifacts) {
      const path = join(hostDir, artifact.relativePath)
      const content = Buffer.from(`fake-apk:${artifact.relativePath}`)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
      exported.push({
        relativePath: artifact.relativePath,
        size: content.byteLength,
        sha256: createHash('sha256').update(content).digest('hex')
      })
    }
    return exported
  }
  async webState() {
    return this.webStateValue
  }
  async listManagedContainers() {
    return this.managedContainers
  }
  async removeManagedContainer(name: string) {
    this.calls.push(`removeManagedContainer:${name}`)
    this.managedContainers = this.managedContainers.filter((container) => container.name !== name)
  }
  async listManagedNetworks() {
    return this.managedNetworks
  }
  async removeManagedNetwork(name: string) {
    this.calls.push(`removeManagedNetwork:${name}`)
    this.managedNetworks = this.managedNetworks.filter((network) => network.name !== name)
  }
  async cloneIntoVolume() {}
  async importHostFolder(_roomId: string, hostPath: string, revision: number) {
    this.calls.push(`importHostFolder:${hostPath}:r${revision}`)
  }
  workspaceFingerprintValue = 'fake-workspace-fingerprint'
  async fingerprintWorkspace() {
    return this.workspaceFingerprintValue
  }
  workspaceSnapshotEntries: import('../workspaceDrift').WorkspaceSnapshotEntry[] = []
  async snapshotWorkspace(_roomId: string, _workspaceVolumeRevision: number) {
    return { fingerprint: this.workspaceFingerprintValue, entries: this.workspaceSnapshotEntries }
  }
  legacyWorkspaceFingerprintValue: string | null = null
  async fingerprintWorkspaceLegacy() {
    return this.legacyWorkspaceFingerprintValue ?? this.workspaceFingerprintValue
  }
  legacyCurrentExclusionsFingerprintValue: string | null = null
  async fingerprintWorkspaceLegacyCurrentExclusions() {
    return this.legacyCurrentExclusionsFingerprintValue ?? this.workspaceFingerprintValue
  }
  async fingerprintBuildInput(_roomId: string, workspaceVolume: string) {
    this.calls.push(`fingerprintBuildInput:${workspaceVolume}`)
    return this.workspaceFingerprintValue
  }
  async removeWorkspaceVolume(_roomId: string, revision: number) {
    this.calls.push(`removeWorkspaceVolume:r${revision}`)
  }
  async removeWorkspaceSnapshot(_roomId: string, operationId: string) {
    this.calls.push(`removeWorkspaceSnapshot:${operationId}`)
  }
  async removeDependencyVolume(_roomId: string, nodeMajor: string, generation: number) {
    this.calls.push(`removeDependencyVolume:node${nodeMajor}:g${generation}`)
  }
  async copyVolume(_sourceRoomId: string, source: string, _targetRoomId: string, target: string) {
    this.calls.push(`copyVolume:${source}:${target}`)
  }
  async volumeSizes() {
    return {}
  }
  async imageExists() {
    return true
  }
  async pullImage() {}
  async resetVolume(_roomId: string, name: string) {
    this.calls.push(`resetVolume:${name}`)
  }
  async clearVolumeContents(_roomId: string, name: string) {
    this.calls.push(`clearVolumeContents:${name}`)
  }
  serviceStates = new Map<string, 'running' | 'exited' | 'missing'>()
  svcExecResult: ExecResult = ok
  async createService(roomId: string, svc: 'postgres' | 'redis', version: string) {
    this.calls.push(`createService:${svc}:${version}`)
    this.serviceStates.set(svc, 'running')
  }
  async startService(_roomId: string, svc: 'postgres' | 'redis') {
    this.calls.push(`startService:${svc}`)
    this.serviceStates.set(svc, 'running')
  }
  async stopService(_roomId: string, svc: 'postgres' | 'redis') {
    this.calls.push(`stopService:${svc}`)
    this.serviceStates.set(svc, 'exited')
  }
  async removeService(_roomId: string, svc: 'postgres' | 'redis', opts: { volume: boolean }) {
    this.calls.push(`removeService:${svc}:${opts.volume ? 'with-volume' : 'keep-volume'}`)
    this.serviceStates.set(svc, 'missing')
  }
  async serviceState(_roomId: string, svc: 'postgres' | 'redis') {
    return this.serviceStates.get(svc) ?? 'missing'
  }
  async execInService(_roomId: string, svc: 'postgres' | 'redis', cmd: string[]): Promise<ExecResult> {
    this.calls.push(`execInService:${svc}:${cmd[0]}`)
    if (cmd[0] === 'redis-cli' && cmd[1] === 'ping') return { code: 0, stdout: 'PONG', stderr: '' }
    if (cmd[0] === 'pg_dump') return { code: 0, stdout: '-- fake dump\nCREATE TABLE t();', stderr: '' }
    return this.svcExecResult
  }
  async execInServiceToFile(
    _roomId: string,
    svc: 'postgres' | 'redis',
    cmd: string[],
    hostPath: string
  ): Promise<ExecResult> {
    this.calls.push(`execInServiceToFile:${svc}:${cmd[0]}`)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(hostPath, '-- fake streamed dump\nCREATE TABLE t();')
    return this.svcExecResult
  }
  async execInServiceFromFile(
    _roomId: string,
    svc: 'postgres' | 'redis',
    cmd: string[]
  ): Promise<ExecResult> {
    this.calls.push(`execInServiceFromFile:${svc}:${cmd[0]}`)
    return this.svcExecResult
  }
  async copyFromService(_roomId: string, svc: 'postgres' | 'redis', containerPath: string, hostPath: string) {
    this.calls.push(`copyFromService:${svc}:${containerPath}`)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(hostPath, 'fake-rdb')
  }
  async copyToService(_roomId: string, svc: 'postgres' | 'redis', _hostPath: string, containerPath: string) {
    this.calls.push(`copyToService:${svc}:${containerPath}`)
  }
  async copyIntoRoom(_roomId: string, _hostPath: string, containerPath: string) {
    this.calls.push(`copyIntoRoom:${containerPath}`)
  }
  async copyFromRoom(roomId: string, containerPath: string, hostPath: string) {
    this.calls.push(`copyFromRoom:${containerPath}`)
    await this.copyFromRoomHook?.(roomId, containerPath, hostPath)
    const { existsSync, writeFileSync } = await import('node:fs')
    if (!existsSync(hostPath)) writeFileSync(hostPath, 'fake-room-file')
  }
  emulatorStateValue: 'running' | 'exited' | 'missing' = 'missing'
  async createEmulator(
    roomId: string,
    opts?: { device: string; version: string; resolution?: 'native' | 'balanced' | 'fast'; orientation?: 'portrait' | 'landscape' }
  ) {
    this.calls.push(`createEmulator:${roomId}:${opts?.device ?? 'default'}:${opts?.version ?? 'default'}`)
    this.emulatorStateValue = 'running'
  }
  async captureEmulatorScreen(roomId: string) {
    this.calls.push(`captureEmulatorScreen:${roomId}`)
    return 'ZmFrZS1lbXVsYXRvci1zY3JlZW4tcG5nLWJ5dGVzLWZvci10ZXN0cw=='
  }
  async removeEmulator(roomId: string) {
    this.calls.push(`removeEmulator:${roomId}`)
    this.emulatorStateValue = 'missing'
  }
  async emulatorState() {
    return this.emulatorStateValue
  }
}

export class FakeWindowsVm implements WindowsVmLifecycle {
  calls: string[] = []
  stateValue: 'running' | 'stopped' | 'missing' = 'stopped'
  healthValue = { ok: true, detail: 'fake vmrun' }
  baselineValue = { ok: true, detail: 'fake clean baseline' }
  failCreate = false
  failNextState = false
  readonly templateId = 'd'.repeat(64)

  async health() {
    this.calls.push('health')
    return this.healthValue
  }

  async inspectTemplate(input: { templateVmxPath: string; snapshot: string }) {
    this.calls.push(`inspectTemplate:${input.snapshot}`)
    return { templateId: this.templateId, snapshot: input.snapshot }
  }

  async create(input: { roomId: string; templateVmxPath: string; snapshot: string }) {
    this.calls.push(`create:${input.roomId}:${input.snapshot}`)
    if (this.failCreate) throw new Error('fake create failed before ownership marker')
    this.stateValue = 'stopped'
    return { roomId: input.roomId, templateId: this.templateId, snapshot: input.snapshot }
  }

  async start(roomId: string) {
    this.calls.push(`start:${roomId}`)
    this.stateValue = 'running'
  }

  async state(roomId: string) {
    this.calls.push(`state:${roomId}`)
    if (this.failNextState) {
      this.failNextState = false
      throw new Error('fake state probe failed')
    }
    return this.stateValue
  }

  async sleep(roomId: string) {
    this.calls.push(`sleep:${roomId}`)
    if (this.stateValue !== 'missing') this.stateValue = 'stopped'
  }

  async delete(roomId: string) {
    this.calls.push(`delete:${roomId}`)
    this.stateValue = 'missing'
    return { reclaimedBytes: 2048 }
  }

  async reset(roomId: string) {
    this.calls.push(`reset:${roomId}`)
    this.stateValue = 'stopped'
    return { roomId, templateId: this.templateId, snapshot: 'devhotel-clean' }
  }

  async validateBaseline(roomId: string) {
    this.calls.push(`validateBaseline:${roomId}`)
    return this.baselineValue
  }

  async openConsole(roomId: string) {
    this.calls.push(`openConsole:${roomId}`)
  }
}

export class FakeGateway {
  routes = new Map<string, Route>()
  httpPort: number | null = 80
  httpsPort: number | null = 443
  failNextSetRoute = false

  async start() {
    return this.status()
  }
  async stop() {}
  async setRoute(route: Route) {
    if (this.failNextSetRoute) {
      this.failNextSetRoute = false
      throw new Error('route rejected')
    }
    this.routes.set(route.domain, route)
  }
  removeRoute(domain: string) {
    this.routes.delete(domain)
  }
  status() {
    return {
      running: true,
      httpPort: this.httpPort,
      httpsPort: this.httpsPort,
      routes: [...this.routes.values()].map((r) => ({ domain: r.domain, roomId: r.roomId, https: r.https }))
    }
  }
  urlFor(domain: string, https: boolean) {
    return `${https ? 'https' : 'http'}://${domain}`
  }

  asGateway(): Gateway {
    return this as unknown as Gateway
  }
}

/** Real TCP listener answering with data so verifyWebUp's data-level probe succeeds. */
export async function listeningPort(): Promise<{ port: number; close: () => void }> {
  const server: Server = createServer((socket) => {
    socket.on('data', () => socket.end('HTTP/1.0 200 OK\r\ncontent-length: 0\r\n\r\n'))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return { port, close: () => server.close() }
}


/** A phone as the Host adb reports it, plus the getprop values it would answer. */
export interface FakePhone {
  serial: string
  state: string
  model?: string
  release?: string
  sdk?: string
  usb?: string
}

/**
 * A Host adb with no phone attached to it. Recording every exec is the point:
 * the broker's whole contract is which commands reach the device and which are
 * refused before they get there.
 */
export class FakeAdbHost implements AdbHost {
  execs: { serial: string; args: string[] }[] = []
  availability: AdbHostAvailability = { ok: true, detail: 'fake adb 35.0.0' }
  devicesError: Error | null = null
  /** Raw PNG bytes this fake phone answers exec-out screencap with. */
  screencapPng = Buffer.alloc(0)
  execHook: ((serial: string, args: string[]) => void) | null = null
  execResultFor: ((serial: string, args: string[]) => Promise<ExecResult | null> | ExecResult | null) | null = null
  execBinaryResultFor:
    | ((serial: string, args: string[]) => Promise<AdbBinaryResult | null> | AdbBinaryResult | null)
    | null = null

  constructor(public phones: FakePhone[] = []) {}

  async available(): Promise<AdbHostAvailability> {
    return this.availability
  }

  async devices(): Promise<AdbDeviceLine[]> {
    if (this.devicesError) throw this.devicesError
    return this.phones.map((phone) => ({
      serial: phone.serial,
      state: phone.state,
      model: phone.model ?? null,
      usb: phone.usb ?? null,
      transportId: null
    }))
  }

  async exec(serial: string, args: string[]): Promise<ExecResult> {
    this.execs.push({ serial, args })
    this.execHook?.(serial, args)
    const custom = await this.execResultFor?.(serial, args)
    if (custom) return custom
    if (args[0] === 'get-state') return { code: 0, stdout: 'device\n', stderr: '' }
    const phone = this.phones.find((candidate) => candidate.serial === serial)
    if (args[0] === 'shell' && args[1] === 'getprop') {
      const values: Record<string, string | undefined> = {
        'ro.build.version.release': phone?.release,
        'ro.build.version.sdk': phone?.sdk,
        'ro.product.model': phone?.model?.replaceAll('_', ' ')
      }
      const value = values[args[2] ?? '']
      return { code: value ? 0 : 1, stdout: value ? `${value}\n` : '', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }

  async execBinary(serial: string, args: string[]): Promise<AdbBinaryResult> {
    this.execs.push({ serial, args })
    const custom = await this.execBinaryResultFor?.(serial, args)
    if (custom) return custom
    if (args[0] === 'exec-out' && args[1] === 'screencap') {
      return { code: 0, stdout: this.screencapPng, stderr: '', outputLimitExceeded: false }
    }
    return { code: 0, stdout: Buffer.alloc(0), stderr: '', outputLimitExceeded: false }
  }
}
