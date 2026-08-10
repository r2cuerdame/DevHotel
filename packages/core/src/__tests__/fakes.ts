import { mkdtempSync } from 'node:fs'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RoomRecord } from '@devhotel/shared'
import type { ExecResult, ExportedArtifact, IsolationBackend, WebSpec } from '../backend/types'
import type { Gateway } from '../gateway/gateway'
import type { Route } from '../gateway/routes'
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
  managedContainers: { roomId: string; role: string; state: string; name: string }[] = []
  managedNetworks: { roomId: string; name: string }[] = []
  webStateValue: 'running' | 'exited' | 'missing' = 'running'
  oneShotResult: ExecResult = ok
  exportedArtifacts: ExportedArtifact[] = [
    { relativePath: 'app/build/outputs/apk/debug/app-debug.apk', size: 8, sha256: 'a'.repeat(64) }
  ]
  execResult: ExecResult = ok
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
  async execInRoom(_roomId: string, _cmd: string[], _opts?: { timeoutMs?: number }): Promise<ExecResult> {
    return this.execResult
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
    return this.oneShotResult
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
  emulatorStateValue: 'running' | 'exited' | 'missing' = 'missing'
  async createEmulator(roomId: string, opts?: { device: string; version: string }) {
    this.calls.push(`createEmulator:${roomId}:${opts?.device ?? 'default'}:${opts?.version ?? 'default'}`)
    this.emulatorStateValue = 'running'
  }
  async removeEmulator(roomId: string) {
    this.calls.push(`removeEmulator:${roomId}`)
    this.emulatorStateValue = 'missing'
  }
  async emulatorState() {
    return this.emulatorStateValue
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
