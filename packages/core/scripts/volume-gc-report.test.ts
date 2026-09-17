import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { VolumeLivenessClass, VolumeRecord } from '@devhotel/shared'
import type { DockerVolumeUsage } from '../src/backend/types'
import { changesRepo } from '../src/store/changesRepo'
import type { Db } from '../src/store/db'
import { operationsRepo } from '../src/store/operationsRepo'
import { roomsRepo } from '../src/store/roomsRepo'
import { settingsRepo } from '../src/store/settingsRepo'
import { executeVolumeGc, isDockerUnitSizeKnown, parseDockerUnitSize } from '../src/volumeGc'

/**
 * The #63 host dry-run: every Docker volume on this Host, reconciled against
 * the live DevHotel registry, with the class, the bytes and the reason each
 * one is safe or unsafe to collect. Read-only: it observes and plans, and
 * `executeVolumeGc` is called with `dryRun: true` and no removal guard, so
 * there is no path in this file that can remove anything.
 *
 * Opt-in, because it needs a live engine and the app's own database:
 *
 *   DEVHOTEL_VOLUME_GC_REPORT=1 pnpm --filter @devhotel/core report:volume-gc
 *
 * `DEVHOTEL_USER_DATA` names the app-data directory (default: the packaged
 * app's `%APPDATA%\devhotel`). The database is opened read-only, so the report
 * can run while the app is up; what it reads is the durable state — Room
 * records, settings (fences, retained generations, dependency pointers),
 * change history and the operations the app has persisted as running. Sizes
 * and attachment counts come from one `docker system df -v` pass, exactly as
 * the app's own inventory does. Legacy adoption ledgers are not consulted
 * here, so an unlabeled legacy volume reads as unowned and is refused, which
 * is the fail-closed direction.
 */

const ENABLED = process.env['DEVHOTEL_VOLUME_GC_REPORT'] === '1'

function docker(args: string[]): string {
  const result = spawnSync('docker', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr?.slice(0, 300)}`)
  return result.stdout
}

function labelsOf(raw: unknown): Record<string, string> {
  if (typeof raw !== 'string' || raw.length === 0) return {}
  const labels: Record<string, string> = {}
  for (const pair of raw.split(',')) {
    const index = pair.indexOf('=')
    if (index > 0) labels[pair.slice(0, index)] = pair.slice(index + 1)
  }
  return labels
}

function inventory(): DockerVolumeUsage[] {
  const parsed = JSON.parse(docker(['system', 'df', '-v', '--format', '{{json .Volumes}}'])) as Array<{
    Name?: string
    Driver?: string
    Scope?: string
    Mountpoint?: string
    Size?: string
    Links?: string | number
    Labels?: string
  }>
  return parsed
    .filter((item) => (item.Name ?? '').length > 0)
    .map((item) => {
      const name = item.Name ?? ''
      const labels = labelsOf(item.Labels)
      const roomId = /^dh-([a-z0-9]{8})-/.exec(name)?.[1]
      const managed =
        roomId !== undefined &&
        labels['devhotel.room'] === roomId &&
        labels['devhotel.role'] === 'volume' &&
        labels['devhotel.managed'] === '1'
      const rawSize = item.Size ?? ''
      const rawLinks = item.Links
      const linksKnown = typeof rawLinks === 'number'
        ? Number.isSafeInteger(rawLinks) && rawLinks >= 0
        : typeof rawLinks === 'string' && /^\d+$/.test(rawLinks)
      return {
        name,
        driver: item.Driver ?? 'local',
        scope: item.Scope ?? 'local',
        mountpoint: item.Mountpoint ?? '',
        sizeBytes: parseDockerUnitSize(rawSize),
        sizeKnown: isDockerUnitSizeKnown(rawSize),
        ownership: managed ? 'managed-labels' : 'unowned',
        links: linksKnown ? Number(rawLinks) : 0,
        linksKnown,
        labels
      }
    })
}

function openReadOnly(userData: string): Db {
  const sqlite = new DatabaseSync(join(userData, 'devhotel.db'), { readOnly: true })
  return { sqlite, close: () => sqlite.close() }
}

const gb = (bytes: number) => `${(bytes / 1_000_000_000).toFixed(2)} GB`

describe.skipIf(!ENABLED)('Volume GC host dry-run (#63)', () => {
  it('classifies every volume on this Host against the live registry and removes nothing', async () => {
    const userData = process.env['DEVHOTEL_USER_DATA'] ?? join(process.env['APPDATA'] ?? '', 'devhotel')
    const db = openReadOnly(userData)
    try {
      const rooms = roomsRepo(db).list()
      const operations = operationsRepo(db)
      const activeOperations = rooms.flatMap((room) =>
        operations.listForRoom(room.id).filter((operation) => operation.status === 'running')
      )
      const volumes = inventory()

      const result = await executeVolumeGc(
        undefined as never,
        {
          volumes,
          rooms,
          settings: settingsRepo(db),
          changes: changesRepo(db),
          activeOperations,
          roomDirExists: (roomId) => existsSync(join(userData, 'rooms', roomId))
        },
        { dryRun: true }
      )
      const report = result.report

      const lines = [
        `app data            ${userData}`,
        `rooms               ${rooms.length} (${rooms.map((room) => `${room.id}:${room.status}`).join(', ')})`,
        `running operations  ${activeOperations.length}`,
        `docker volumes      ${report.totalDockerVolumes}  ${gb(report.totalDockerBytes)} (docker-reclaimable ${gb(report.totalDockerReclaimableBytes)})`,
        `devhotel volumes    ${report.devHotelVolumeCount}  ${gb(report.devHotelTotalBytes)}`,
        `  fenced            ${report.fencedVolumeCount}  ${gb(report.fencedVolumeBytes)}`,
        `  retained          ${report.retainedVolumeCount}  ${gb(report.retainedVolumeBytes)}`,
        `  unowned           ${report.unownedVolumeCount}  ${gb(report.unownedVolumeBytes)}`,
        `safe gc candidates  ${report.safeGcCandidateCount}  ${gb(report.safeGcCandidateBytes)}`,
        '',
        'by class'
      ]
      for (const [cls, summary] of Object.entries(report.byClass) as Array<[VolumeLivenessClass, { count: number; totalBytes: number }]>) {
        if (summary.count > 0) lines.push(`  ${cls.padEnd(28)}${String(summary.count).padStart(4)}  ${gb(summary.totalBytes)}`)
      }

      const describeVolume = (volume: VolumeRecord) =>
        `  ${volume.name.padEnd(40)} ${gb(volume.sizeBytes).padStart(10)}  links=${volume.linksKnown ? volume.links : '?'}  ${volume.class}\n      ${volume.reason}`

      const candidates = report.volumes.filter((volume) => volume.safeToDelete)
      lines.push('', `candidates (${candidates.length}) — would be removed by a real bounded pass, smallest first`)
      for (const volume of [...candidates].sort((a, b) => a.sizeBytes - b.sizeBytes)) lines.push(describeVolume(volume))

      const held = report.volumes.filter((volume) => !volume.safeToDelete && volume.roomId !== null && volume.class !== 'unowned')
      lines.push('', `held DevHotel volumes (${held.length})`)
      for (const volume of [...held].sort((a, b) => b.sizeBytes - a.sizeBytes)) lines.push(describeVolume(volume))

      const nameOnly = report.volumes.filter((volume) => volume.roomId !== null && volume.class === 'unowned')
      lines.push('', `DevHotel-pattern names without ownership proof (${nameOnly.length}, ${gb(nameOnly.reduce((sum, volume) => sum + volume.sizeBytes, 0))}) — refused; a legacy adoption record is the only way in`)
      for (const volume of [...nameOnly].sort((a, b) => b.sizeBytes - a.sizeBytes).slice(0, 15)) {
        lines.push(`  ${volume.name.padEnd(40)} ${gb(volume.sizeBytes).padStart(10)}  links=${volume.linksKnown ? volume.links : '?'}`)
      }

      const external = report.volumes.filter((volume) => volume.roomId === null)
      lines.push('', `external / anonymous volumes (${external.length}, ${gb(external.reduce((sum, volume) => sum + volume.sizeBytes, 0))}) — never touched`)

      console.log(`\n${lines.join('\n')}\n`)

      // The invariants this dry-run exists to demonstrate on real data.
      expect(result.dryRun).toBe(true)
      expect(result.deletedCount).toBe(0)
      expect(result.attemptedCount).toBe(0)
      for (const volume of candidates) {
        expect(volume.ownership).not.toBe('unowned')
        expect(volume.linksKnown).toBe(true)
        expect(volume.links).toBe(0)
        expect(volume.sizeKnown).toBe(true)
        expect(volume.class.startsWith('orphaned-')).toBe(true)
      }
      for (const fencedRoom of ['njfstb4z', '29c5e8ys']) {
        for (const volume of report.volumes.filter((candidate) => candidate.roomId === fencedRoom)) {
          expect(volume.safeToDelete, `${volume.name} must stay held`).toBe(false)
        }
      }
    } finally {
      db.close()
    }
  })
})
