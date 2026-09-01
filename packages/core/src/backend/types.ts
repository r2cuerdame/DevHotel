import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { SourceType, WorkspaceMode } from '@devhotel/shared'
import type { WorkspaceSnapshot } from '../workspaceDrift'

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
  /** Android keeps user workloads in a runtime namespace isolated from the emulator relay/control namespace. */
  androidRuntimeIsolation?: boolean
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
  /** Recreate the Android control relay and ensure its separate runtime namespace leader is running. */
  androidRuntimeIsolation?: boolean
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
  /** The process was killed as soon as a configured stdout/stderr byte cap was crossed. */
  outputLimitExceeded?: boolean
}

export type ExecOutputChunk = string | Uint8Array

export interface ExecOpts {
  timeoutMs?: number
  /** Cancel the command and complete its mandatory ownership-safe cleanup. */
  signal?: AbortSignal
  /** Optional hard capture caps used by fenced helpers and high-level automation. */
  maxStdoutBytes?: number
  maxStderrBytes?: number
  /**
   * Receive stdout as it is produced. A backend that honours this must not also
   * accumulate the stream into `ExecResult.stdout` — that is the whole point:
   * the caller bounds and retains the output itself.
   */
  onStdout?: (chunk: ExecOutputChunk) => void
  /** Same contract as onStdout, for stderr. */
  onStderr?: (chunk: ExecOutputChunk) => void
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

/** Immutable identity the backend must prove before and after publishing a Room artifact. */
export interface RoomArtifactExpectation {
  sizeBytes: number
  sha256: string
}

/**
 * Immutable live-runtime identity captured before a Room artifact export.
 * A backend may restore the original container or a token-fenced exact
 * recreation, but must never treat an unrelated same-name container as this
 * runtime.
 */
export interface RoomArtifactWebRuntimeFence {
  /** Full immutable OCI container ID (never a mutable name or short ID). */
  containerId: string
  /** Exact owned workspace generation mounted read-write at /workspace. */
  workspaceVolume: string
  /** Digest of the validated runtime configuration observed at capture time. */
  runtimeSpecSha256: string
  /** Digest of every owned named-volume instance, including creation identity and mountpoint. */
  volumeSetSha256: string
  /** Immutable container/network authority backing the web network namespace. */
  networkAuthorityId: string
  /** Immutable ID of the underlying owned Room bridge network. */
  networkId: string
  /** Exact live namespace identity when the authority is another container. */
  networkSandboxId?: string
  /** Canonical raw OCI start generation when the authority is another container. */
  networkAuthorityStartedAt?: string
}

export type RoomArtifactPublicationFailureReason =
  | 'invalid-source'
  | 'invalid-input'
  | 'unsafe-parent'
  | 'destination-exists'
  | 'fence-changed'
  | 'publication-ambiguous'
  | 'helper-failed'

export type RoomArtifactRecoveryOutcome =
  | 'committed'
  | 'absent'
  | 'destination-exists'
  | 'unsafe-parent'
  | 'incomplete'

/** Stable cross-backend failure contract; callers must not infer security outcomes from text. */
export class RoomArtifactPublicationError extends Error {
  constructor(
    readonly reason: RoomArtifactPublicationFailureReason,
    message: string
  ) {
    super(message)
    this.name = 'RoomArtifactPublicationError'
  }
}

export interface IsolationBackend {
  health(): Promise<{ ok: boolean; detail: string }>
  createRoomPod(
    spec: WebSpec,
    opts?: { initializeManagedSource?: boolean; startWeb?: boolean }
  ): Promise<{ hostPort: number | null }>
  /** Secret needed by the host gateway to cross this Room's published relay gate. */
  relayToken(roomId: string): Promise<string>
  startRoomPod(
    roomId: string,
    opts?: { standalone?: boolean; androidRuntimeIsolation?: boolean }
  ): Promise<{ hostPort: number | null }>
  startWeb(roomId: string): Promise<void>
  stopRoomPod(roomId: string): Promise<void>
  /** Freeze/unfreeze the web container while taking a consistent volume copy. */
  pauseWeb(roomId: string): Promise<void>
  unpauseWeb(roomId: string): Promise<void>
  /** Capture a complete immutable web-runtime fence before artifact publication. */
  captureRoomArtifactWebFence(spec: WebSpec): Promise<RoomArtifactWebRuntimeFence>
  /** Pause only the exact fenced web runtime and prove its configuration did not change. */
  pauseRoomArtifactWeb(spec: WebSpec, fence: RoomArtifactWebRuntimeFence): Promise<void>
  /** Restore only the exact fenced runtime or a one-time-token exact recreation. */
  restoreRoomArtifactWeb(spec: WebSpec, fence: RoomArtifactWebRuntimeFence): Promise<void>
  /** Exact execution fence state; acceptance code must not infer this from `running`. */
  webPaused(roomId: string): Promise<boolean>
  /** One owned-container inspect proving the web workload is both running and not paused. */
  webRunningUnpaused(roomId: string): Promise<boolean>
  restartWeb(roomId: string, spec?: WebSpec): Promise<void>
  recreateWeb(spec: WebSpec, expectedWebId?: string): Promise<void>
  recreateAnchor(spec: AnchorSpec): Promise<{ hostPort: number }>
  deleteRoomPod(roomId: string, opts: { volumes: boolean }): Promise<{ reclaimedBytes: number }>
  execInRoom(roomId: string, cmd: string[], opts?: ExecOpts): Promise<ExecResult>
  /** Spawn an interactive command only after engine and exact web-container ownership validation. */
  spawnInteractiveExec(roomId: string, cmd: string[]): Promise<ChildProcessWithoutNullStreams>
  /** Follow web logs only after engine and exact web-container ownership validation. */
  followRoomLogs(roomId: string, tail?: number): Promise<ChildProcessWithoutNullStreams>
  /**
   * Run a disposable Room job with bounded output and ownership-safe cleanup.
   * Existing callers may omit opts; the production backend still applies hard
   * stdout/stderr caps and a finite timeout.
   */
  runOneShot(
    spec: WebSpec,
    cmd: string,
    log?: (line: string) => void,
    opts?: ExecOpts
  ): Promise<ExecResult>
  /** Export APKs from an owned immutable workspace volume beneath a Room-owned Hotel artifact root. */
  exportAndroidArtifacts(
    roomId: string,
    workspaceVolume: string,
    artifactsRoot: string,
    operationId: string
  ): Promise<ExportedArtifact[]>
  /**
   * Atomically publish one Host-private PNG into the active owned workspace.
   * The production backend accepts only an exact paused web-container fence and
   * independently proves both the private input and the final workspace file.
   */
  publishRoomArtifact(
    roomId: string,
    workspaceVolumeRevision: number,
    hostPngPath: string,
    relativePath: string,
    expected: RoomArtifactExpectation,
    stageToken: string | undefined,
    webFence: RoomArtifactWebRuntimeFence
  ): Promise<void>
  /** Settle one durable interrupted artifact publication after all Room workloads are stopped. */
  reconcileRoomArtifactPublication(
    roomId: string,
    workspaceVolumeRevision: number,
    relativePath: string,
    expected: RoomArtifactExpectation,
    stageToken: string
  ): Promise<RoomArtifactRecoveryOutcome>
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
  /** Transaction guard: excludes disposable build caches, retains Git control state, and prunes only Git objects. */
  fingerprintWorkspace(roomId: string, workspaceVolumeRevision: number, workspaceVolumeOverride?: string): Promise<string>
  /** Path-addressable Host-sync source snapshot that filters generated output and VCS internals. */
  snapshotWorkspace(roomId: string, workspaceVolumeRevision: number, workspaceVolumeOverride?: string): Promise<WorkspaceSnapshot>
  /** Pre-R2C-8 fingerprint, used only to migrate a clean existing Room without accepting unknown drift. */
  fingerprintWorkspaceLegacy(roomId: string, workspaceVolumeRevision: number): Promise<string>
  /** Same legacy record format with today's generated-output exclusions, for a conservative migration fallback. */
  fingerprintWorkspaceLegacyCurrentExclusions(roomId: string, workspaceVolumeRevision: number): Promise<string>
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
  /** Controlled emulator ADB outside the user Room; acceptance callers separately require a pause fence. */
  execFencedEmulatorAdb(roomId: string, args: string[], opts?: ExecOpts): Promise<ExecResult>
  /** Recovery-only ADB through the retained control anchor; never starts the Room web workload. */
  execFencedEmulatorRecoveryAdb(roomId: string, args: string[], opts?: ExecOpts): Promise<ExecResult>
  /** Install one Host-private staged APK without reopening the Room workspace. */
  installFencedEmulatorApk(roomId: string, hostApkPath: string, opts?: ExecOpts): Promise<ExecResult>
  /* --- android emulator sidecar (KVM) --- */
  /**
   * Restart only the already-existing control anchor and emulator for durable
   * locale recovery. Implementations must prove the web/runtime identities but
   * never start a stopped Room workload or substitute a container identity.
   */
  startExistingEmulatorForRecovery(roomId: string): Promise<void>
  createEmulator(
    roomId: string,
    opts?: { device: string; version: string; resolution?: 'native' | 'balanced' | 'fast'; orientation?: 'portrait' | 'landscape' }
  ): Promise<void>
  /** X11 grab of the emulator screen (base64 PNG) — sees exactly what noVNC shows, FLAG_SECURE included */
  captureEmulatorScreen(roomId: string, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<string>
  removeEmulator(roomId: string): Promise<void>
  emulatorState(roomId: string): Promise<'running' | 'exited' | 'missing'>
}
