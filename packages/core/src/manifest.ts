import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RoomRecord } from '@devhotel/shared'
import { dump } from 'js-yaml'

function nodeMajor(version: string): string {
  return version.split('.')[0] ?? version
}

export function generateManifestYaml(room: RoomRecord): string {
  const source: Record<string, string> = { type: room.sourceType }
  if (room.sourceType === 'managed-git') source['repository'] = room.sourceRef
  else if (room.sourceType === 'linked-folder') {
    source['hostSync'] = room.hostSyncEnabled ? 'enabled' : 'detached'
    if (room.hostSyncEnabled) source['path'] = room.sourceRef
  }
  const doc = {
    project: room.project,
    nickname: room.nickname,
    provider: room.provider,
    source,
    workingState: {
      owner: room.workspaceMode === 'hotel' ? 'room' : room.workspaceMode === 'legacy-host-bind' ? 'host-compatibility' : 'none',
      revision: room.stateRevision,
      volumeRevision: room.workspaceVolumeRevision,
      syncStatus: room.syncStatus,
      ...(room.lastSyncedAt ? { lastSyncedAt: room.lastSyncedAt } : {})
    },
    runtime: room.runtime.kind === 'jdk' ? { jdk: room.runtime.version } : { node: nodeMajor(room.runtime.version) },
    packageManager: {
      type: room.packageManager.kind,
      ...(room.packageManager.version === undefined ? {} : { version: room.packageManager.version }),
    },
    web: { command: room.startCommand, internalPort: room.internalPort },
    domain: { host: room.domain, https: room.https },
    services: room.services ?? {},
  }
  return dump(doc, { lineWidth: 120 })
}

export async function writeManifest(userDataDir: string, room: RoomRecord): Promise<void> {
  const roomDir = join(userDataDir, 'rooms', room.id)
  await mkdir(roomDir, { recursive: true })
  await writeFile(join(roomDir, 'manifest.yaml'), generateManifestYaml(room), 'utf8')
}
