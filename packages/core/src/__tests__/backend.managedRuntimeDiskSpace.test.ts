import type { statfs } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  MANAGED_RUNTIME_DISK_HEADROOM_BYTES,
  assertManagedRuntimeDiskSpace,
  measureManagedRuntimeDiskSpace
} from '../backend/managedRuntimeDiskSpace'

const MB = 1024 * 1024

/** A `statfs` that answers with a fixed number of free bytes. */
function volumeWith(freeBytes: number): typeof statfs {
  return vi.fn(async () => ({ bsize: 4096, bavail: freeBytes / 4096 })) as unknown as typeof statfs
}

describe('managed runtime disk space', () => {
  it('refuses a write that would not fit, and names both numbers', async () => {
    const space = await measureManagedRuntimeDiskSpace({
      path: os.tmpdir(),
      bytes: 150 * MB,
      headroomBytes: 256 * MB,
      statfs: volumeWith(200 * MB)
    })

    expect(space).toMatchObject({ availableBytes: 200 * MB, requiredBytes: 406 * MB, sufficient: false })
    expect(space.detail).toContain('200 MB free')
    expect(space.detail).toContain('150 MB')
    expect(space.detail).toContain('256 MB')

    await expect(
      assertManagedRuntimeDiskSpace({
        path: os.tmpdir(),
        bytes: 150 * MB,
        headroomBytes: 256 * MB,
        statfs: volumeWith(200 * MB)
      })
    ).rejects.toThrow(/Not enough disk space .*200 MB free/)
  })

  it('allows a write that fits with its headroom intact', async () => {
    await expect(
      assertManagedRuntimeDiskSpace({
        path: os.tmpdir(),
        bytes: 150 * MB,
        headroomBytes: 256 * MB,
        statfs: volumeWith(406 * MB)
      })
    ).resolves.toMatchObject({ sufficient: true })

    // One byte short is short.
    await expect(
      assertManagedRuntimeDiskSpace({
        path: os.tmpdir(),
        bytes: 150 * MB,
        headroomBytes: 256 * MB,
        statfs: volumeWith(406 * MB - 4096)
      })
    ).rejects.toThrow('Not enough disk space')
  })

  it('keeps headroom by default so a provision cannot fill the volume to the last block', async () => {
    const space = await measureManagedRuntimeDiskSpace({
      path: os.tmpdir(),
      bytes: 0,
      statfs: volumeWith(1024 * MB)
    })
    expect(space.requiredBytes).toBe(MANAGED_RUNTIME_DISK_HEADROOM_BYTES)
  })

  it('measures the nearest existing parent, because the path is usually about to be created', async () => {
    const probe = vi.fn(async (target: string) => {
      // Only the real temp directory exists; everything below it does not yet.
      if (target !== path.resolve(os.tmpdir())) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return { bsize: 4096, bavail: (1024 * MB) / 4096 }
    }) as unknown as typeof statfs

    const space = await measureManagedRuntimeDiskSpace({
      path: path.join(os.tmpdir(), 'devhotel', 'runtime', 'not-created-yet.vhd'),
      bytes: MB,
      statfs: probe
    })
    expect(space).toMatchObject({ availableBytes: 1024 * MB, sufficient: true })
  })

  it('proceeds, visibly, when the platform will not report free space', async () => {
    // Refusing to provision on a filesystem Node cannot measure would break
    // installs that would have worked. The `null` is what keeps the silence
    // legible instead of passing it off as a measurement.
    const unmeasurable = vi.fn(async () => {
      throw new Error('ENOTSUP')
    }) as unknown as typeof statfs

    const space = await measureManagedRuntimeDiskSpace({ path: os.tmpdir(), bytes: 150 * MB, statfs: unmeasurable })
    expect(space.availableBytes).toBeNull()
    expect(space.sufficient).toBe(true)
    expect(space.detail).toContain('could not be measured')

    await expect(
      assertManagedRuntimeDiskSpace({ path: os.tmpdir(), bytes: 150 * MB, statfs: unmeasurable })
    ).resolves.toMatchObject({ availableBytes: null, sufficient: true })
  })

  it('refuses a nonsensical request rather than guessing', async () => {
    for (const bytes of [-1, 1.5, Number.NaN]) {
      await expect(measureManagedRuntimeDiskSpace({ path: os.tmpdir(), bytes })).rejects.toThrow(
        'disk-space request is invalid'
      )
    }
    await expect(
      measureManagedRuntimeDiskSpace({ path: os.tmpdir(), bytes: 1, headroomBytes: -1 })
    ).rejects.toThrow('headroom is invalid')
  })
})
