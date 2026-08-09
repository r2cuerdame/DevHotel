import type { SourceType } from '@devhotel/shared'

export interface WebSpec {
  roomId: string
  internalPort: number
  nodeMajor: string
  sourceType: SourceType
  sourceRef: string
  startCommand: string
  env?: Record<string, string>
  /** overrides the default deps volume name — used by clean-reinstall generations */
  depsVolumeOverride?: string
  /** overrides the node:<major> image — used by non-node providers (android sdk image) */
  imageOverride?: string
  /** standalone containers own their network namespace: no anchor, no published port */
  standalone?: boolean
  /** skip the /workspace/node_modules deps volume (non-node providers) */
  noDepsVolume?: boolean
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

export interface IsolationBackend {
  health(): Promise<{ ok: boolean; detail: string }>
  createRoomPod(spec: WebSpec): Promise<{ hostPort: number | null }>
  startRoomPod(roomId: string): Promise<{ hostPort: number }>
  stopRoomPod(roomId: string): Promise<void>
  restartWeb(roomId: string): Promise<void>
  recreateWeb(spec: WebSpec): Promise<void>
  recreateAnchor(spec: AnchorSpec): Promise<{ hostPort: number }>
  deleteRoomPod(roomId: string, opts: { volumes: boolean }): Promise<{ reclaimedBytes: number }>
  execInRoom(roomId: string, cmd: string[], opts?: { timeoutMs?: number }): Promise<ExecResult>
  runOneShot(spec: WebSpec, cmd: string, log?: (line: string) => void): Promise<ExecResult>
  webState(roomId: string): Promise<'running' | 'exited' | 'missing'>
  listManagedContainers(): Promise<{ roomId: string; role: string; state: string; name: string }[]>
  cloneIntoVolume(roomId: string, gitUrl: string, log?: (line: string) => void): Promise<void>
  volumeSizes(roomId: string): Promise<Record<string, number>>
  imageExists(image: string): Promise<boolean>
  pullImage(image: string, log?: (line: string) => void): Promise<void>
  /** force-remove and recreate a volume, guaranteeing it is empty */
  resetVolume(name: string): Promise<void>
  /* --- in-room services (postgres/redis join the room's network namespace) --- */
  createService(roomId: string, svc: 'postgres' | 'redis', version: string): Promise<void>
  startService(roomId: string, svc: 'postgres' | 'redis'): Promise<void>
  stopService(roomId: string, svc: 'postgres' | 'redis'): Promise<void>
  removeService(roomId: string, svc: 'postgres' | 'redis', opts: { volume: boolean }): Promise<void>
  serviceState(roomId: string, svc: 'postgres' | 'redis'): Promise<'running' | 'exited' | 'missing'>
  execInService(roomId: string, svc: 'postgres' | 'redis', cmd: string[], opts?: { timeoutMs?: number; input?: string }): Promise<ExecResult>
  /** copy a file out of the service container to the host */
  copyFromService(roomId: string, svc: 'postgres' | 'redis', containerPath: string, hostPath: string): Promise<void>
  /** copy a host file into the service container */
  copyToService(roomId: string, svc: 'postgres' | 'redis', hostPath: string, containerPath: string): Promise<void>
  /* --- android emulator sidecar (KVM) --- */
  createEmulator(roomId: string, opts?: { device: string; version: string }): Promise<void>
  removeEmulator(roomId: string): Promise<void>
  emulatorState(roomId: string): Promise<'running' | 'exited' | 'missing'>
}
