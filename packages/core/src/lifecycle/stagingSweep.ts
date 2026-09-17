import { existsSync, lstatSync, readdirSync, realpathSync, rmdirSync, unlinkSync, type Dirent } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Host-private staging directory families under `<userData>/tmp` whose
 * lifetime is one Room operation: file pull/push, physical-device ADB installs,
 * and sealed emulator installs. Each is created before its work and removed in
 * a `finally`; a process that dies in between leaves the directory behind, and
 * nothing else ever revisits it. Artifact export staging has its own exact
 * quarantine sweep and is deliberately not listed here.
 */
export const STALE_STAGING_FAMILIES: readonly RegExp[] = [
  /^android-sealed-install-[A-Za-z0-9]{6}$/,
  /^device-adb-[A-Za-z0-9]{6}$/,
  /^pull-[0-9a-z]{8}$/,
  /^push-[0-9a-z]{8}$/
]

export interface StagingSweepReport {
  /** False when `<userData>/tmp` was not a private regular directory; nothing was touched. */
  rootOk: boolean
  /** Stale family directories removed completely. */
  removed: number
  /** Family directories kept: live in this process, or holding a link or nested directory. */
  retained: number
  /** Family directories whose removal raised; their remaining files are left in place. */
  failed: number
}

export interface StagingSweepOptions {
  /** Absolute staging directories the running process still owns. */
  live: ReadonlySet<string>
  /** Test seam for a file that cannot be unlinked (open handle, EBUSY). */
  unlink?: (path: string) => void
}

/**
 * Remove crash-leftover staging directories without following anything.
 * Every family is flat: regular files directly inside one directory. A stage
 * holding a symlink, junction, or nested directory is not one DevHotel wrote
 * and is retained rather than traversed. Failures are counted, never thrown,
 * so startup can report them and continue with Room reconciliation.
 */
export function sweepStaleStaging(userData: string, options: StagingSweepOptions): StagingSweepReport {
  const report: StagingSweepReport = { rootOk: true, removed: 0, retained: 0, failed: 0 }
  const root = join(userData, 'tmp')
  if (!existsSync(root)) return report
  try {
    const rootStat = lstatSync(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { ...report, rootOk: false }
    if (relative(realpathSync.native(userData), realpathSync.native(root)) !== 'tmp') return { ...report, rootOk: false }
  } catch {
    return { ...report, rootOk: false }
  }
  const unlink = options.unlink ?? unlinkSync
  const live = new Set([...options.live].map((dir) => canonical(dir) ?? dir))

  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return { ...report, rootOk: false }
  }
  for (const entry of entries) {
    if (!STALE_STAGING_FAMILIES.some((family) => family.test(entry.name))) continue
    const directory = join(root, entry.name)
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      if (entry.isSymbolicLink()) report.retained++
      continue
    }
    if (live.has(directory) || live.has(canonical(directory) ?? directory)) {
      report.retained++
      continue
    }
    let files: string[]
    try {
      const children = readdirSync(directory, { withFileTypes: true })
      if (children.some((child) => child.isSymbolicLink() || !child.isFile())) {
        report.retained++
        continue
      }
      files = children.map((child) => child.name)
    } catch {
      report.failed++
      continue
    }
    try {
      for (const file of files) {
        const path = join(directory, file)
        // Re-check at removal time: a link swapped in after the listing is
        // still never followed, and unlink on a link would only drop the link.
        if (lstatSync(path).isSymbolicLink()) throw new Error('staging entry changed to a link')
        unlink(path)
      }
      rmdirSync(directory)
      report.removed++
    } catch {
      report.failed++
    }
  }
  return report
}

function canonical(path: string): string | null {
  try {
    return realpathSync.native(path)
  } catch {
    return null
  }
}
