import type { RoomPlan, RoomRecord } from '@devhotel/shared'
import type { WebSpec } from '../backend/types'
import { detectProject, type DetectOptions } from '../detect/detector'
import type { SourceReader } from '../detect/sourceReader'
import type { RoomProvider, RoomProviderInfo } from './types'

/** Mirrors RoomOrchestrator.webSpecFor so the orchestrator can delegate here without behavior change. */
export function buildWebSpec(room: RoomRecord, overrides?: Partial<WebSpec>): WebSpec {
  return {
    roomId: room.id,
    internalPort: room.internalPort,
    nodeMajor: room.runtime.version,
    sourceType: room.sourceType,
    sourceRef: room.sourceRef,
    workspaceMode: room.workspaceMode,
    workspaceVolumeRevision: room.workspaceVolumeRevision,
    startCommand: room.startCommand,
    env: {},
    ...overrides
  }
}

export class WebRoomProvider implements RoomProvider {
  readonly info: RoomProviderInfo = {
    kind: 'web',
    label: 'Web Room',
    available: true,
    execution: 'served',
    preview: 'browser',
    requiresKvm: false
  }

  detect(src: SourceReader, opts: DetectOptions): Promise<RoomPlan> {
    return detectProject(src, opts)
  }

  buildSpec(room: RoomRecord, overrides?: Partial<WebSpec>): WebSpec {
    return buildWebSpec(room, overrides)
  }

  components(): string[] {
    return ['Node.js', 'Package manager', 'Web process', 'Dependencies', 'Domain', 'HTTPS', 'Browser profile']
  }
}
