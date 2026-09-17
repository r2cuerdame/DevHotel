import { statfs } from 'node:fs/promises'
import path from 'node:path'

/**
 * The free-space precondition the managed runtime checks before it writes
 * anything large.
 *
 * Provisioning stages a pinned artifact of a known size and then creates disks
 * beside it. Without this check the first symptom of a full volume is a
 * half-written VHD or a truncated ISO, which the digest check then reports as
 * a *corrupt download* — a true statement about the bytes and a useless one
 * about the cause. The user retries, fills the volume again, and gets the same
 * wrong answer. So the size is asserted before the write, and the failure names
 * the two numbers that actually decide it.
 *
 * Headroom exists because "exactly enough" is not enough: Windows still needs
 * room for its page file and the runtime still needs room for its own state
 * disk. Filling the volume to the last block turns a DevHotel problem into a
 * Host problem.
 */
export const MANAGED_RUNTIME_DISK_HEADROOM_BYTES = 256 * 1024 * 1024

export interface ManagedRuntimeDiskSpace {
  /**
   * Bytes this account may still write to the volume holding the path, or
   * `null` when the platform would not say.
   */
  availableBytes: number | null
  /** What the caller is about to write, plus the headroom it asked to keep. */
  requiredBytes: number
  /** False only when the platform gave a number and that number was too small. */
  sufficient: boolean
  detail: string
}

export interface ManagedRuntimeDiskSpaceOptions {
  /** A path on the target volume. It need not exist; the nearest existing parent is measured. */
  path: string
  /** Bytes about to be written. */
  bytes: number
  /** Bytes to leave free afterwards. Defaults to {@link MANAGED_RUNTIME_DISK_HEADROOM_BYTES}. */
  headroomBytes?: number
  /** Test seam. */
  statfs?: typeof statfs
}

function describe(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
  return `${bytes} bytes`
}

/**
 * Measures the volume behind `path`, walking up to the nearest parent that
 * exists.
 *
 * The path is usually a file DevHotel is about to create inside a directory it
 * is about to create, so measuring the path itself would fail with `ENOENT` on
 * every first run — which is precisely the run that most needs the answer.
 */
async function measureVolume(target: string, probe: typeof statfs): Promise<number | null> {
  let candidate = path.resolve(target)
  for (;;) {
    try {
      const stats = await probe(candidate)
      // `bavail` rather than `bfree`: reserved blocks are not ours to spend.
      const available = Number(stats.bavail) * Number(stats.bsize)
      return Number.isFinite(available) && available >= 0 ? available : null
    } catch {
      const parent = path.dirname(candidate)
      if (parent === candidate) return null
      candidate = parent
    }
  }
}

/**
 * Reports whether a write of `bytes` fits, without deciding what to do about it.
 *
 * A platform that will not answer is reported as `availableBytes: null` and
 * `sufficient: true`. Refusing to provision on a filesystem Node cannot measure
 * would break installs that would have worked, and this check exists to make a
 * real failure legible, not to invent a new one. The `null` keeps that silence
 * visible to whatever reports runtime state, instead of dressing it up as a
 * measurement.
 */
export async function measureManagedRuntimeDiskSpace(
  opts: ManagedRuntimeDiskSpaceOptions
): Promise<ManagedRuntimeDiskSpace> {
  if (!Number.isSafeInteger(opts.bytes) || opts.bytes < 0) {
    throw new Error('Managed runtime disk-space request is invalid')
  }
  const headroom = opts.headroomBytes ?? MANAGED_RUNTIME_DISK_HEADROOM_BYTES
  if (!Number.isSafeInteger(headroom) || headroom < 0) {
    throw new Error('Managed runtime disk-space headroom is invalid')
  }

  const requiredBytes = opts.bytes + headroom
  const availableBytes = await measureVolume(opts.path, opts.statfs ?? statfs)

  if (availableBytes === null) {
    return {
      availableBytes: null,
      requiredBytes,
      sufficient: true,
      detail: 'Free space on this volume could not be measured, so the size was not checked.'
    }
  }

  const sufficient = availableBytes >= requiredBytes
  return {
    availableBytes,
    requiredBytes,
    sufficient,
    detail: sufficient
      ? `${describe(availableBytes)} free; ${describe(requiredBytes)} needed.`
      : `${describe(availableBytes)} free, but ${describe(opts.bytes)} plus ${describe(headroom)} of headroom is needed.`
  }
}

/** {@link measureManagedRuntimeDiskSpace}, as a precondition. */
export async function assertManagedRuntimeDiskSpace(
  opts: ManagedRuntimeDiskSpaceOptions
): Promise<ManagedRuntimeDiskSpace> {
  const space = await measureManagedRuntimeDiskSpace(opts)
  if (!space.sufficient) throw new Error(`Not enough disk space for the DevHotel runtime. ${space.detail}`)
  return space
}
