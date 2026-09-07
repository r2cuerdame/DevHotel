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

export function isDockerUnitSizeKnown(s: string): boolean {
  const value = s.trim()
  if (value === '0B') return true
  const match = /^([\d.]+)\s*(B|kB|MB|GB|TB|KiB|MiB|GiB|TiB)$/i.exec(value)
  return Boolean(match && Number.isFinite(Number.parseFloat(match[1]!)))
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
  changes?: { list(roomId: string): Array<{ undoable?: boolean; status?: string; captured?: unknown }> }
  fencedRoomIds?: ReadonlySet<string>
  roomDirExists?: (roomId: string) => boolean
}

function isApplicableUndoableChange(change: { undoable?: boolean; status?: string }): boolean {
  return change.undoable === true &&
    (change.status === undefined || change.status === 'applied' || change.status === 'verified')
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
    const isAttached = vol.linksKnown && vol.links > 0
    const hasExactManagedLabels =
      vol.ownership === 'managed-labels' &&
      vol.labels['devhotel.managed'] === '1' &&
      vol.labels['devhotel.role'] === 'volume' &&
      vol.labels['devhotel.room'] === parsed.roomId
    const hasExplicitOwnership = hasExactManagedLabels || vol.ownership === 'legacy-adoption'

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
      const runningOperation = context.activeOperations?.find(
        (operation) => operation.roomId === parsed.roomId && operation.status === 'running'
      )

      if (fenced) {
        livenessClass = 'fenced'
        safeToDelete = false
        reason = `Room ${parsed.roomId} is protected by an active recovery or acceptance fence (#61); all volumes must remain undisturbed.`
      } else if (!context.activeOperations) {
        livenessClass = 'retained-recovery'
        safeToDelete = false
        reason = `Room ${parsed.roomId} operation state is unavailable; preserving all volumes fail-closed.`
      } else if (runningOperation) {
        livenessClass = 'retained-active'
        safeToDelete = false
        reason = `Room ${parsed.roomId} has active operation ${runningOperation.id}; all volumes remain protected.`
      } else if (!room) {
        // Room does not exist in canonical database
        const hasDiskDir = context.roomDirExists?.(parsed.roomId)
        if (hasDiskDir !== false) {
          livenessClass = 'unowned'
          safeToDelete = false
          reason = hasDiskDir
            ? `Room ${parsed.roomId} has on-disk directory but is missing from DB; fail-closed preservation required.`
            : `Room ${parsed.roomId} directory state is unknown; fail-closed preservation required.`
        } else {
          // Both DB and disk say room does not exist
          if (hasExplicitOwnership) {
            livenessClass = 'orphaned-deleted-room'
            safeToDelete = vol.linksKnown && !isAttached && vol.sizeKnown
            reason = !vol.linksKnown
              ? `Room ${parsed.roomId} was deleted but container attachment state is unknown; GC must fail closed.`
              : isAttached
              ? `Room ${parsed.roomId} was deleted but volume still has active container attachments.`
              : !vol.sizeKnown
                ? `Room ${parsed.roomId} was deleted but volume size is unknown; bounded GC must fail closed.`
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
              const roomChanges = context.changes?.list(parsed.roomId)
              const neededForUndo = roomChanges?.some((change) => {
                if (!isApplicableUndoableChange(change)) return false
                const captured = change.captured as Record<string, unknown> | null
                return captured?.previousWorkspaceGeneration === rev
              }) ?? false
              const activeOpUsing = context.activeOperations?.find(
                (op) =>
                  op.roomId === parsed.roomId &&
                  op.status === 'running' &&
                  (op.extra as Record<string, unknown> | undefined)?.workspaceVolumeRevision === rev
              )
              if (!roomChanges) {
                livenessClass = 'retained-recovery'
                safeToDelete = false
                reason = `Workspace change history is unavailable; preserving generation r${rev} fail-closed.`
              } else if (neededForUndo) {
                livenessClass = 'retained-recovery'
                safeToDelete = false
                reason = `Retained workspace generation r${rev} required for change undo.`
              } else if (activeOpUsing) {
                livenessClass = 'retained-active'
                safeToDelete = false
                reason = `Workspace generation r${rev} in use by active operation ${activeOpUsing.id}.`
              } else {
                livenessClass = 'orphaned-stale-generation'
                safeToDelete = hasExplicitOwnership && vol.linksKnown && !isAttached && vol.sizeKnown
                reason = !vol.linksKnown
                  ? `Stale workspace generation r${rev} has unknown container attachment state.`
                  : isAttached
                  ? `Stale historical workspace generation r${rev} is still attached to a container.`
                  : !hasExplicitOwnership
                    ? `Stale workspace generation r${rev} lacks explicit managed ownership proof.`
                    : !vol.sizeKnown
                      ? `Stale workspace generation r${rev} has unknown size; bounded GC must fail closed.`
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
            if (!context.activeOperations) {
              livenessClass = 'retained-recovery'
              safeToDelete = false
              reason = `Operation state is unavailable; preserving workspace snapshot fail-closed.`
            } else if (op && op.status === 'running') {
              livenessClass = 'retained-active'
              safeToDelete = false
              reason = `Build workspace snapshot in use by active operation ${op.id}.`
            } else {
              livenessClass = 'orphaned-stale-snapshot'
              safeToDelete = hasExplicitOwnership && vol.linksKnown && !isAttached && vol.sizeKnown
              reason = !vol.linksKnown
                ? `Stale workspace snapshot has unknown container attachment state.`
                : isAttached
                ? `Stale workspace snapshot volume is still attached to a container.`
                : !hasExplicitOwnership
                  ? `Stale workspace snapshot lacks explicit managed ownership proof.`
                  : !vol.sizeKnown
                    ? `Stale workspace snapshot has unknown size; bounded GC must fail closed.`
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
              const roomChanges = context.changes?.list(parsed.roomId)
              if (!roomChanges) {
                livenessClass = 'retained-recovery'
                safeToDelete = false
                reason = `Dependency change history is unavailable; preserving generation ${gen} fail-closed.`
                break
              }
              const neededForUndo = roomChanges.some((c) => {
                if (!isApplicableUndoableChange(c)) return false
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
                safeToDelete = hasExplicitOwnership && vol.linksKnown && !isAttached && vol.sizeKnown
                reason = !vol.linksKnown
                  ? `Stale dependency volume has unknown container attachment state.`
                  : isAttached
                  ? `Stale dependency volume is still attached to a container.`
                  : !hasExplicitOwnership
                    ? `Stale dependency volume lacks explicit managed ownership proof.`
                    : !vol.sizeKnown
                      ? `Stale dependency volume has unknown size; bounded GC must fail closed.`
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
      sizeKnown: vol.sizeKnown,
      ownership: vol.ownership,
      links: vol.links,
      linksKnown: vol.linksKnown,
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
    if (vol.linksKnown && vol.links === 0) {
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
    if (rec.linksKnown && rec.links === 0) {
      totalDockerReclaimableBytes += rec.sizeBytes
    }

    if (rec.purpose !== 'external') {
      devHotelVolumeCount += 1
      devHotelTotalBytes += rec.sizeBytes
      if (rec.linksKnown && rec.links === 0) {
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
      rec.class === 'retained-active' ||
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

export interface VolumeGcRemovalGuard {
  removeCandidateIfStillSafe(candidate: VolumeRecord, remainingBytes: number): Promise<number>
}

export async function executeVolumeGc(
  _backend: IsolationBackend,
  context: VolumeReconciliationContext,
  opts: VolumeGcOptions = {},
  guard?: VolumeGcRemovalGuard
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

  const { maxVolumes, maxBytes } = opts
  if (typeof maxVolumes !== 'number' || !Number.isSafeInteger(maxVolumes) || maxVolumes <= 0 || maxVolumes > 500) {
    throw new Error('Real volume GC requires an explicit bounded maxVolumes')
  }
  if (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('Real volume GC requires an explicit bounded maxBytes')
  }
  if (!guard) throw new Error('Real volume GC requires a concurrent-state removal guard')

  const candidates = report.volumes.filter((v) => v.safeToDelete)
  const deletedVolumes: string[] = []
  const errors: string[] = []
  let reclaimedBytes = 0

  for (const candidate of candidates) {
    if (deletedVolumes.length >= maxVolumes) break
    if (!candidate.sizeKnown || reclaimedBytes + candidate.sizeBytes > maxBytes) continue

    // Double-check fail-closed invariants
    if (
      !candidate.safeToDelete ||
      !candidate.linksKnown ||
      candidate.links > 0 ||
      candidate.class === 'fenced' ||
      candidate.class === 'retained-current' ||
      candidate.class === 'retained-active' ||
      candidate.class === 'retained-sleeping' ||
      candidate.class === 'retained-recovery' ||
      candidate.class === 'unowned'
    ) {
      errors.push(`Refusing unsafe deletion for volume ${candidate.name} (class ${candidate.class})`)
      continue
    }

    try {
      const removedBytes = await guard.removeCandidateIfStillSafe(candidate, maxBytes - reclaimedBytes)
      deletedVolumes.push(candidate.name)
      reclaimedBytes += removedBytes
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
