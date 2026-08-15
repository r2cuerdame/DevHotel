import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { SourceType, WorkspaceMode } from '@devhotel/shared'

export interface WebSpec {
  roomId: string
  internalPort: number
  nodeMajor: string
  sourceType: SourceType
  sourceRef: string
  workspaceMode: WorkspaceMode
  workspaceVolumeRevision: number
  /** overrides the Room's published workspace volume (immutable jobs/snapshots only) */
  workspaceVolumeOverride?: string
  startCommand: string
  env?: Record<string, string>
  /** overrides the default deps volume name — used by clean-reinstall generations */
  depsVolumeOverride?: string
  /** overrides the node:<major> image — used by non-node providers (android sdk image) */
  imageOverride?: string
  /** standalone containers join the owned Room network directly: no anchor or published port */
  standalone?: boolean
  /** skip the /workspace/node_modules deps volume (non-node providers) */
  noDepsVolume?: boolean
  /** skip the persistent Room cache for a clean, disposable job */
  noCacheVolume?: boolean
  /** additional named-volume mounts (docker seeds them from image content on first use) */
  extraVolumes?: { volume: string; path: string }[]
  /** docker --cpus limit */
  cpus?: number
  /** docker --memory limit in MB */
  memoryMB?: number
}

export interface AnchorSpec {
  roomId: string
  internalPort: number
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export interface ManagedNetwork {
  roomId: string
  name: string
}

export interface ExportedArtifact {
  /** Path relative to the exported artifact directory. */
  relativePath: string
  size: number
  sha256: string
}

export interface IsolationBackend {
  health(): Promise<{ ok: boolean; detail: string }>
  createRoomPod(
    spec: WebSpec,
    opts?: { initializeManagedSource?: boolean; startWeb?: boolean }
  ): Promise<{ hostPort: number | null }>
  /** Secret needed by the host gateway to cross this Room's published relay gate. */
  relayToken(roomId: string): Promise<string>
  startRoomPod(roomId: string, opts?: { standalone?: boolean }): Promise<{ hostPort: number | null }>
  startWeb(roomId: string): Promise<void>
  stopRoomPod(roomId: string): Promise<void>
  /** Freeze/unfreeze the web container while taking a consistent volume copy. */
  pauseWeb(roomId: string): Promise<void>
  unpauseWeb(roomId: string): Promise<void>
  restartWeb(roomId: string): Promise<void>
  recreateWeb(spec: WebSpec): Promise<void>
  recreateAnchor(spec: AnchorSpec): Promise<{ hostPort: number }>
  deleteRoomPod(roomId: string, opts: { volumes: boolean }): Promise<{ reclaimedBytes: number }>
  execInRoom(roomId: string, cmd: string[], opts?: { timeoutMs?: number }): Promise<ExecResult>
  /** Spawn an interactive command only after engine and exact web-container ownership validation. */
  spawnInteractiveExec(roomId: string, cmd: string[]): Promise<ChildProcessWithoutNullStreams>
  /** Follow web logs only after engine and exact web-container ownership validation. */
  followRoomLogs(roomId: string, tail?: number): Promise<ChildProcessWithoutNullStreams>
  runOneShot(spec: WebSpec, cmd: string, log?: (line: string) => void): Promise<ExecResult>
  /** Export APKs from an owned immutable workspace volume beneath a Room-owned Hotel artifact root. */
  exportAndroidArtifacts(
    roomId: string,
    workspaceVolume: string,
    artifactsRoot: string,
    operationId: string
  ): Promise<ExportedArtifact[]>
  webState(roomId: string): Promise<'running' | 'exited' | 'missing'>
  listManagedContainers(): Promise<{ roomId: string; role: string; state: string; name: string }[]>
  /** Remove a container after re-validating exact DevHotel ownership metadata. */
  removeManagedContainer(name: string): Promise<void>
  listManagedNetworks(): Promise<ManagedNetwork[]>
  /** Remove a network already verified as DevHotel-managed. */
  removeManagedNetwork(name: string): Promise<void>
  cloneIntoVolume(roomId: string, gitUrl: string, workspaceVolumeRevision?: number, log?: (line: string) => void): Promise<void>
  /** Import a canonical Host folder through a short-lived read-only mount into a new owned workspace generation. */
  importHostFolder(
    roomId: string,
    hostPath: string,
    workspaceVolumeRevision: number,
    log?: (line: string) => void
  ): Promise<void>
  /** Content fingerprint excluding dependency/build caches and VCS internals. */
  fingerprintWorkspace(roomId: string, workspaceVolumeRevision: number, workspaceVolumeOverride?: string): Promise<string>
  /**
   * Full immutable build-input digest. No workspace path is excluded; paths are
   * NUL-delimited and file type/metadata/content or symlink target are hashed.
   */
  fingerprintBuildInput(roomId: string, workspaceVolume: string): Promise<string>
  /** Remove one no-longer-published owned workspace generation. */
  removeWorkspaceVolume(roomId: string, workspaceVolumeRevision: number): Promise<void>
  /** Remove the short-lived immutable workspace captured for one build operation. */
  removeWorkspaceSnapshot(roomId: string, operationId: string): Promise<void>
  /** Remove one no-longer-published dependency generation. Generation zero is never accepted. */
  removeDependencyVolume(roomId: string, nodeMajor: string, generation: number): Promise<void>
  /** Copy one owned Room volume into a new owned Room volume without exposing either on the host. */
  copyVolume(
    sourceRoomId: string,
    source: string,
    targetRoomId: string,
    target: string,
    log?: (line: string) => void
  ): Promise<void>
  volumeSizes(roomId: string): Promise<Record<string, number>>
  imageExists(image: string): Promise<boolean>
  pullImage(image: string, log?: (line: string) => void): Promise<void>
  /** force-remove and recreate a volume, guaranteeing it is empty */
  resetVolume(roomId: string, name: string): Promise<void>
  /* --- in-room services (postgres/redis join the room's network namespace) --- */
  createService(roomId: string, svc: 'postgres' | 'redis', version: string): Promise<void>
  startService(roomId: string, svc: 'postgres' | 'redis'): Promise<void>
  stopService(roomId: string, svc: 'postgres' | 'redis'): Promise<void>
  removeService(roomId: string, svc: 'postgres' | 'redis', opts: { volume: boolean }): Promise<void>
  serviceState(roomId: string, svc: 'postgres' | 'redis'): Promise<'running' | 'exited' | 'missing'>
  execInService(roomId: string, svc: 'postgres' | 'redis', cmd: string[], opts?: { timeoutMs?: number; input?: string }): Promise<ExecResult>
  /** Stream service stdout directly to a host file without buffering it in JS memory. */
  execInServiceToFile(
    roomId: string,
    svc: 'postgres' | 'redis',
    cmd: string[],
    hostPath: string,
    opts?: { timeoutMs?: number }
  ): Promise<ExecResult>
  /** Stream a host file directly to service stdin without buffering it in JS memory. */
  execInServiceFromFile(
    roomId: string,
    svc: 'postgres' | 'redis',
    cmd: string[],
    hostPath: string,
    opts?: { timeoutMs?: number }
  ): Promise<ExecResult>
  /** copy a file out of the service container to the host */
  copyFromService(roomId: string, svc: 'postgres' | 'redis', containerPath: string, hostPath: string): Promise<void>
  /** copy a host file into the service container */
  copyToService(roomId: string, svc: 'postgres' | 'redis', hostPath: string, containerPath: string): Promise<void>
  /** empty a volume that containers still mount — deleting it would be refused while in use */
  clearVolumeContents(roomId: string, name: string): Promise<void>
  /** copy a host file into the room's web/build container */
  copyIntoRoom(roomId: string, hostPath: string, containerPath: string): Promise<void>
  /** copy a file out of the room's web/build container to the host */
  copyFromRoom(roomId: string, containerPath: string, hostPath: string): Promise<void>
  /* --- android emulator sidecar (KVM) --- */
  createEmulator(
    roomId: string,
    opts?: { device: string; version: string; resolution?: 'native' | 'balanced' | 'fast'; orientation?: 'portrait' | 'landscape' }
  ): Promise<void>
  /** X11 grab of the emulator screen (base64 PNG) — sees exactly what noVNC shows, FLAG_SECURE included */
  captureEmulatorScreen(roomId: string): Promise<string>
  removeEmulator(roomId: string): Promise<void>
  emulatorState(roomId: string): Promise<'running' | 'exited' | 'missing'>
}
