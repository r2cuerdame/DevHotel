import type { RoomRecord } from '@devhotel/shared'
import type {
  VolumeClassSummary,
  VolumeGcResult,
  VolumeLivenessClass,
  VolumePurpose,
  VolumeReconciliationReport,
  VolumeRecord
} from '@devhotel/shared'
import type { DockerVolumeUsage, IsolationBackend } from './backend/types'
import { retainedWorkspaceGenKey } from './workingState'
import { depsGenKey } from './changes/definitions/deps'

const ROOM_ID_RE = /^[a-z0-9]{8}$/
const DEVHOTEL_VOLUME_PREFIX_RE = /^dh-([a-z0-9]{8})-(.+)$/

export function parseDockerUnitSize(s: string): number {
  if (!s || s === '0B' || s === 'N/A') return 0
  const m = /^([\d.]+)\s*([A-Za-z]+)$/.exec(s.trim())
  if (!m || !m[1] || !m[2]) return 0
  const val = Number.parseFloat(m[1])
  const unit = m[2]
  switch (unit) {
    case 'B': return Math.round(val)
    case 'kB': return Math.round(val * 1000)
    case 'MB': return Math.round(val * 1000 * 1000)
    case 'GB': return Math.round(val * 1000 * 1000 * 1000)
    case 'TB': return Math.round(val * 1000 * 1000 * 1000 * 1000)
    case 'KiB': return Math.round(val * 1024)
    case 'MiB': return Math.round(val * 1024 * 1024)
    case 'GiB': return Math.round(val * 1024 * 1024 * 1024)
    case 'TiB': return Math.round(val * 1024 * 1024 * 1024 * 1024)
    default:
      if (unit.toLowerCase() === 'kb') return Math.round(val * 1000)
      if (unit.toLowerCase() === 'mb') return Math.round(val * 1000 * 1000)
      if (unit.toLowerCase() === 'gb') return Math.round(val * 1000 * 1000 * 1000)
      return Math.round(val)
  }
}

export interface ParsedVolumeIdentity {
  roomId: string | null
  purpose: VolumePurpose
  revision: number | null
  generation: number | null
  nodeMajor: string | null
  serviceKind: string | null
  snapshotOperationId: string | null
  isDevHotelNamed: boolean
}

export function parseVolumeNameAndLabels(
  name: string,
  labels: Record<string, string> = {}
): ParsedVolumeIdentity {
  const labelRoom = labels['devhotel.room']
  const labelManaged = labels['devhotel.managed'] === '1'

  const prefixMatch = DEVHOTEL_VOLUME_PREFIX_RE.exec(name)

  const roomId = prefixMatch ? prefixMatch[1] : (labelRoom && ROOM_ID_RE.test(labelRoom) ? labelRoom : null)
  if (!roomId || (!prefixMatch && !labelManaged)) {
    return {
      roomId: null,
      purpose: 'external',
      revision: null,
      generation: null,
      nodeMajor: null,
      serviceKind: null,
      snapshotOperationId: null,
      isDevHotelNamed: false
    }
  }

  const suffix = prefixMatch?.[2] ?? (name.startsWith(`dh-${roomId}-`) ? name.slice(`dh-${roomId}-`.length) : name)

  if (suffix === 'cache') {
    return {
      roomId,
      purpose: 'cache',
      revision: null,
      generation: null,
      nodeMajor: null,
      serviceKind: null,
      snapshotOperationId: null,
      isDevHotelNamed: true
    }
  }

  if (suffix === 'sdk') {
    return {
      roomId,
      purpose: 'sdk',
      revision: null,
      generation: null,
      nodeMajor: null,
      serviceKind: null,
      snapshotOperationId: null,
      isDevHotelNamed: true
    }
  }

  if (suffix === 'src') {
    return {
      roomId,
      purpose: 'workspace',
      revision: 0,
      generation: null,
      nodeMajor: null,
      serviceKind: null,
      snapshotOperationId: null,
      isDevHotelNamed: true
    }
  }

  const srcRevMatch = /^src-r([1-9][0-9]*)$/.exec(suffix)
  if (srcRevMatch && srcRevMatch[1]) {
    return {
      roomId,
      purpose: 'workspace',
      revision: Number.parseInt(srcRevMatch[1], 10),
      generation: null,
      nodeMajor: null,
      serviceKind: null,
      snapshotOperationId: null,
      isDevHotelNamed: true
    }
  }

  const snapshotMatch = /^src-build-([a-f0-9]{32})$/.exec(suffix)
  if (snapshotMatch && snapshotMatch[1]) {
    return {
      roomId,
      purpose: 'workspace-snapshot',
      revision: null,
      generation: null,
      nodeMajor: null,
      serviceKind: null,
      snapshotOperationId: snapshotMatch[1],
      isDevHotelNamed: true
    }
  }

  const depsMatch = /^deps-node([a-z0-9_.-]+?)(?:-g([0-9]+))?$/i.exec(suffix)
  if (depsMatch && depsMatch[1]) {
    return {
      roomId,
      purpose: 'dependencies',
      revision: null,
      generation: depsMatch[2] ? Number.parseInt(depsMatch[2], 10) : 0,
      nodeMajor: depsMatch[1],
      serviceKind: null,
      snapshotOperationId: null,
      isDevHotelNamed: true
    }
  }

  const svcMatch = /^svc-(postgres|redis)-data$/.exec(suffix)
  if (svcMatch && svcMatch[1]) {
    return {
      roomId,
      purpose: 'service-data',
      revision: null,
      generation: null,
      nodeMajor: null,
      serviceKind: svcMatch[1],
      snapshotOperationId: null,
      isDevHotelNamed: true
    }
  }

  return {
    roomId,
    purpose: 'unknown',
    revision: null,
    generation: null,
    nodeMajor: null,
    serviceKind: null,
    snapshotOperationId: null,
    isDevHotelNamed: true
  }
}

export interface VolumeReconciliationContext {
  volumes: DockerVolumeUsage[]
  rooms: RoomRecord[]
  settings: { get(key: string): string | null }
  activeOperations?: Array<{ id: string; roomId: string; status: string; extra?: unknown }>
  changes?: { list(roomId: string): Array<{ undoable?: boolean; captured?: unknown }> }
  fencedRoomIds?: ReadonlySet<string>
  roomDirExists?: (roomId: string) => boolean
  isLegacyAdopted?: (roomId: string, name: string) => boolean
}

export function isRoomFencedForRecovery(
  roomId: string,
  settings: { get(key: string): string | null },
  explicitFences?: ReadonlySet<string>,
  roomStatus?: string
): boolean {
  if (explicitFences?.has(roomId)) return true
  if (roomStatus === 'attention') return true
  if (settings.get(`androidLocaleRestorePending:${roomId}`) !== null) return true
  if (settings.get(`androidAcceptanceRestorePending:${roomId}`) !== null) return true
  if (settings.get(`artifactExportPending:${roomId}`) !== null) return true
  return false
}

export function reconcileVolumesState(context: VolumeReconciliationContext): VolumeReconciliationReport {
  const roomsMap = new Map<string, RoomRecord>(context.rooms.map((r) => [r.id, r]))
  const volumeRecords: VolumeRecord[] = []

  const ALL_CLASSES: VolumeLivenessClass[] = [
    'retained-current',
    'retained-active',
    'retained-sleeping',
    'retained-recovery',
    'fenced',
    'orphaned-deleted-room',
    'orphaned-stale-generation',
    'orphaned-stale-snapshot',
    'orphaned-stale-deps',
    'unowned'
  ]

  const byClass: Record<VolumeLivenessClass, VolumeClassSummary> = Object.fromEntries(
    ALL_CLASSES.map((cls) => [cls, { count: 0, totalBytes: 0, reclaimableBytes: 0 }])
  ) as Record<VolumeLivenessClass, VolumeClassSummary>

  for (const vol of context.volumes) {
    const parsed = parseVolumeNameAndLabels(vol.name, vol.labels)
    const isAttached = vol.links > 0

    let livenessClass: VolumeLivenessClass = 'unowned'
    let safeToDelete = false
    let reason = 'Volume is not owned or managed by DevHotel (external storage).'

    if (!parsed.roomId || parsed.purpose === 'external') {
      livenessClass = 'unowned'
      safeToDelete = false
      reason = 'Volume is not owned or managed by DevHotel (external or anonymous Docker volume).'
    } else {
      const room = roomsMap.get(parsed.roomId)
      const fenced = isRoomFencedForRecovery(parsed.roomId, context.settings, context.fencedRoomIds, room?.status)

      if (fenced) {
        livenessClass = 'fenced'
        safeToDelete = false
        reason = `Room ${parsed.roomId} is protected by an active recovery or acceptance fence (#61); all volumes must remain undisturbed.`
      } else if (!room) {
        // Room does not exist in canonical database
        const hasDiskDir = context.roomDirExists ? context.roomDirExists(parsed.roomId) : false
        if (hasDiskDir) {
          livenessClass = 'unowned'
          safeToDelete = false
          reason = `Room ${parsed.roomId} has on-disk directory but is missing from DB; fail-closed preservation required.`
        } else {
          // Both DB and disk say room does not exist
          const hasManagedLabel = vol.labels['devhotel.managed'] === '1' && vol.labels['devhotel.room'] === parsed.roomId
          const isAdopted = context.isLegacyAdopted ? context.isLegacyAdopted(parsed.roomId, vol.name) : false

          if (hasManagedLabel || parsed.isDevHotelNamed || isAdopted) {
            livenessClass = 'orphaned-deleted-room'
            safeToDelete = !isAttached
            reason = isAttached
              ? `Room ${parsed.roomId} was deleted but volume still has active container attachments.`
              : `Room ${parsed.roomId} was deleted from DevHotel; volume is provably orphaned.`
          } else {
            livenessClass = 'unowned'
            safeToDelete = false
            reason = `Volume matches prefix for deleted room ${parsed.roomId} but lacks ownership labels or legacy adoption record.`
          }
        }
      } else {
        // Room exists in canonical registry
        const isRoomAwake = room.status === 'running' || room.status === 'ready'

        switch (parsed.purpose) {
          case 'cache': {
            livenessClass = isRoomAwake ? 'retained-active' : 'retained-sleeping'
            safeToDelete = false
            reason = `Persistent package/build cache volume for room ${parsed.roomId} (${room.status}).`
            break
          }
          case 'sdk': {
            livenessClass = isRoomAwake ? 'retained-active' : 'retained-sleeping'
            safeToDelete = false
            reason = `Persistent Android SDK cache volume for room ${parsed.roomId} (${room.status}).`
            break
          }
          case 'service-data': {
            livenessClass = isRoomAwake ? 'retained-active' : 'retained-sleeping'
            safeToDelete = false
            reason = `Persistent ${parsed.serviceKind ?? 'database'} service data volume for room ${parsed.roomId}.`
            break
          }
          case 'workspace': {
            const rev = parsed.revision ?? 0
            const currentRev = room.workspaceVolumeRevision
            const retainedRaw = context.settings.get(retainedWorkspaceGenKey(parsed.roomId))
            const retainedGen = retainedRaw !== null && Number.isSafeInteger(Number(retainedRaw)) ? Number(retainedRaw) : null

            if (rev === currentRev) {
              livenessClass = isRoomAwake ? 'retained-current' : 'retained-sleeping'
              safeToDelete = false
              reason = `Current workspace revision r${rev} for room ${parsed.roomId} (${room.status}).`
            } else if (retainedGen !== null && rev === retainedGen) {
              livenessClass = 'retained-recovery'
              safeToDelete = false
              reason = `Retained recovery workspace generation r${rev} for room ${parsed.roomId}.`
            } else if (rev < currentRev) {
              // Older historical generation
              const activeOpUsing = context.activeOperations?.find(
                (op) =>
                  op.roomId === parsed.roomId &&
                  op.status === 'running' &&
                  (op.extra as Record<string, unknown> | undefined)?.workspaceVolumeRevision === rev
              )
              if (activeOpUsing) {
                livenessClass = 'retained-active'
                safeToDelete = false
                reason = `Workspace generation r${rev} in use by active operation ${activeOpUsing.id}.`
              } else {
                livenessClass = 'orphaned-stale-generation'
                safeToDelete = !isAttached
                reason = isAttached
                  ? `Stale historical workspace generation r${rev} is still attached to a container.`
                  : `Stale historical workspace generation r${rev} superseded by r${currentRev} (retained recovery is r${retainedGen ?? 'none'}).`
              }
            } else {
              // Future/staged generation (rev > currentRev)
              livenessClass = 'retained-recovery'
              safeToDelete = false
              reason = `Unpublished future workspace revision r${rev} staged for room ${parsed.roomId}.`
            }
            break
          }
          case 'workspace-snapshot': {
            const opId = parsed.snapshotOperationId
            const op = context.activeOperations?.find(
              (o) => o.roomId === parsed.roomId && o.id.replaceAll('-', '').toLowerCase() === opId
            )
            if (op && op.status === 'running') {
              livenessClass = 'retained-active'
              safeToDelete = false
              reason = `Build workspace snapshot in use by active operation ${op.id}.`
            } else {
              livenessClass = 'orphaned-stale-snapshot'
              safeToDelete = !isAttached
              reason = isAttached
                ? `Stale workspace snapshot volume is still attached to a container.`
                : `Stale workspace snapshot volume from inactive or completed build operation.`
            }
            break
          }
          case 'dependencies': {
            const major = parsed.nodeMajor ?? room.runtime.version
            const gen = parsed.generation ?? 0
            const currentGenRaw =
              context.settings.get(depsGenKey(parsed.roomId, major)) ??
              (major === room.runtime.version ? context.settings.get(`depsGen:${parsed.roomId}`) : null)
            const currentGen = currentGenRaw ? Number.parseInt(currentGenRaw, 10) : 0

            if (gen === currentGen) {
              livenessClass = isRoomAwake ? 'retained-active' : 'retained-sleeping'
              safeToDelete = false
              reason = `Active dependency volume for Node ${major} generation ${gen} for room ${parsed.roomId}.`
            } else {
              const roomChanges = context.changes?.list(parsed.roomId) ?? []
              const neededForUndo = roomChanges.some((c) => {
                const rawCap = c.captured as Record<string, unknown> | null
                const cap = (rawCap?.deps as Record<string, unknown> | undefined) ?? rawCap
                const prevGen = cap?.prevGen ?? cap?.gen
                const capMajor = (cap?.nodeMajor as string | undefined) ?? room.runtime.version
                return prevGen === gen && capMajor === major
              })
              if (neededForUndo) {
                livenessClass = 'retained-recovery'
                safeToDelete = false
                reason = `Retained dependency generation ${gen} for Node ${major} required for change undo.`
              } else {
                livenessClass = 'orphaned-stale-deps'
                safeToDelete = !isAttached
                reason = isAttached
                  ? `Stale dependency volume is still attached to a container.`
                  : `Stale dependency generation ${gen} for Node ${major} superseded by generation ${currentGen}.`
              }
            }
            break
          }
          default: {
            livenessClass = 'unowned'
            safeToDelete = false
            reason = `Unrecognized DevHotel volume suffix for room ${parsed.roomId}.`
            break
          }
        }
      }
    }

    const rec: VolumeRecord = {
      name: vol.name,
      roomId: parsed.roomId,
      purpose: parsed.purpose,
      revision: parsed.revision,
      generation: parsed.generation,
      nodeMajor: parsed.nodeMajor,
      serviceKind: parsed.serviceKind,
      snapshotOperationId: parsed.snapshotOperationId,
      sizeBytes: vol.sizeBytes,
      links: vol.links,
      labels: vol.labels,
      class: livenessClass,
      safeToDelete,
      reason,
      mountpoint: vol.mountpoint,
      driver: vol.driver
    }

    volumeRecords.push(rec)

    const summary = byClass[livenessClass]
    summary.count += 1
    summary.totalBytes += vol.sizeBytes
    if (vol.links === 0) {
      summary.reclaimableBytes += vol.sizeBytes
    }
  }

  let totalDockerBytes = 0
  let totalDockerReclaimableBytes = 0
  let devHotelVolumeCount = 0
  let devHotelTotalBytes = 0
  let devHotelReclaimableBytes = 0
  let safeGcCandidateCount = 0
  let safeGcCandidateBytes = 0
  let fencedVolumeCount = 0
  let fencedVolumeBytes = 0
  let retainedVolumeCount = 0
  let retainedVolumeBytes = 0
  let unownedVolumeCount = 0
  let unownedVolumeBytes = 0

  for (const rec of volumeRecords) {
    totalDockerBytes += rec.sizeBytes
    if (rec.links === 0) {
      totalDockerReclaimableBytes += rec.sizeBytes
    }

    if (rec.purpose !== 'external') {
      devHotelVolumeCount += 1
      devHotelTotalBytes += rec.sizeBytes
      if (rec.links === 0) {
        devHotelReclaimableBytes += rec.sizeBytes
      }
    }

    if (rec.safeToDelete) {
      safeGcCandidateCount += 1
      safeGcCandidateBytes += rec.sizeBytes
    }

    if (rec.class === 'fenced') {
      fencedVolumeCount += 1
      fencedVolumeBytes += rec.sizeBytes
    } else if (
      rec.class === 'retained-current' ||
      rec.class === 'retained-sleeping' ||
      rec.class === 'retained-recovery'
    ) {
      retainedVolumeCount += 1
      retainedVolumeBytes += rec.sizeBytes
    } else if (rec.class === 'unowned') {
      unownedVolumeCount += 1
      unownedVolumeBytes += rec.sizeBytes
    }
  }

  return {
    totalDockerVolumes: volumeRecords.length,
    totalDockerBytes,
    totalDockerReclaimableBytes,
    devHotelVolumeCount,
    devHotelTotalBytes,
    devHotelReclaimableBytes,
    safeGcCandidateCount,
    safeGcCandidateBytes,
    fencedVolumeCount,
    fencedVolumeBytes,
    retainedVolumeCount,
    retainedVolumeBytes,
    unownedVolumeCount,
    unownedVolumeBytes,
    byClass,
    volumes: volumeRecords
  }
}

export interface VolumeGcOptions {
  dryRun?: boolean
  maxVolumes?: number
  maxBytes?: number
}

export async function executeVolumeGc(
  backend: IsolationBackend,
  context: VolumeReconciliationContext,
  opts: VolumeGcOptions = {}
): Promise<VolumeGcResult> {
  const report = reconcileVolumesState(context)
  const isDryRun = opts.dryRun !== false

  if (isDryRun) {
    return {
      dryRun: true,
      report,
      deletedCount: 0,
      reclaimedBytes: 0,
      deletedVolumes: [],
      errors: []
    }
  }

  const maxVolumes = opts.maxVolumes ?? 50
  const maxBytes = opts.maxBytes ?? Number.POSITIVE_INFINITY

  const candidates = report.volumes.filter((v) => v.safeToDelete)
  const deletedVolumes: string[] = []
  const errors: string[] = []
  let reclaimedBytes = 0

  for (const candidate of candidates) {
    if (deletedVolumes.length >= maxVolumes) break
    if (reclaimedBytes + candidate.sizeBytes > maxBytes && deletedVolumes.length > 0) break

    // Double-check fail-closed invariants
    if (
      !candidate.safeToDelete ||
      candidate.links > 0 ||
      candidate.class === 'fenced' ||
      candidate.class === 'retained-current' ||
      candidate.class === 'retained-sleeping' ||
      candidate.class === 'retained-recovery' ||
      candidate.class === 'unowned'
    ) {
      errors.push(`Refusing unsafe deletion for volume ${candidate.name} (class ${candidate.class})`)
      continue
    }

    try {
      await backend.removeManagedVolume(candidate.name)
      deletedVolumes.push(candidate.name)
      reclaimedBytes += candidate.sizeBytes
    } catch (err) {
      errors.push(
        `Failed to remove volume ${candidate.name}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  return {
    dryRun: false,
    report,
    deletedCount: deletedVolumes.length,
    reclaimedBytes,
    deletedVolumes,
    errors
  }
}
