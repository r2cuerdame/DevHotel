import type { SourceType } from '@devhotel/shared'

export interface WebSpec {
  roomId: string
  internalPort: number
  nodeMajor: string
  sourceType: SourceType
  sourceRef: string
  startCommand: string
  env?: Record<string, string>
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
  createRoomPod(spec: WebSpec): Promise<{ hostPort: number }>
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
}
