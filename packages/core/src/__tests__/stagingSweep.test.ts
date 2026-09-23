import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { STALE_STAGING_FAMILIES, sweepStaleStaging } from '../lifecycle/stagingSweep'

describe('sweepStaleStaging', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function makeRoot(): { userData: string; tmp: string } {
    const userData = mkdtempSync(join(tmpdir(), 'dh-sweep-'))
    roots.push(userData)
    const tmp = join(userData, 'tmp')
    mkdirSync(tmp)
    return { userData, tmp }
  }

  function stage(tmp: string, name: string, files: Record<string, string> = { 'file.bin': 'leftover' }): string {
    const dir = join(tmp, name)
    mkdirSync(dir)
    for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content)
    return dir
  }

  it('names exactly the crash-leftover families', () => {
    const accepted = ['android-sealed-install-Ab12cd', 'device-adb-Zz9900', 'pull-a1b2c3d4', 'push-0123abcd']
    const refused = ['artifact-export-Ab12cd', 'pull-', 'pull-ABCDEFGH', 'push-a1b2c3d4e', 'device-adb-', 'rooms', 'devhotel.db']
    for (const name of accepted) expect(STALE_STAGING_FAMILIES.some((family) => family.test(name)), name).toBe(true)
    for (const name of refused) expect(STALE_STAGING_FAMILIES.some((family) => family.test(name)), name).toBe(false)
  })

  it('removes every stale family and leaves unrelated entries untouched', () => {
    const { userData, tmp } = makeRoot()
    const stale = [
      stage(tmp, 'android-sealed-install-Ab12cd', { 'installed.apk': 'apk' }),
      stage(tmp, 'device-adb-Zz9900', { '000.apk': 'apk', '001.apk': 'apk' }),
      stage(tmp, 'pull-a1b2c3d4'),
      stage(tmp, 'push-0123abcd')
    ]
    const unrelated = stage(tmp, 'artifact-export-Ab12cd', { 'content.png': 'png' })
    writeFileSync(join(tmp, 'pull-a1b2c3d4.txt'), 'a file wearing a family prefix')
    const empty = stage(tmp, 'pull-emptyyy1', {})

    const report = sweepStaleStaging(userData, { live: new Set() })

    expect(report).toEqual({ rootOk: true, removed: 5, retained: 0, failed: 0 })
    for (const dir of stale) expect(existsSync(dir), dir).toBe(false)
    expect(existsSync(empty)).toBe(false)
    expect(readFileSync(join(unrelated, 'content.png'), 'utf8')).toBe('png')
    expect(readFileSync(join(tmp, 'pull-a1b2c3d4.txt'), 'utf8')).toBe('a file wearing a family prefix')
  })

  it('retains live stages claimed by this process', () => {
    const { userData, tmp } = makeRoot()
    const live = stage(tmp, 'push-livelive')
    const stale = stage(tmp, 'push-stalestl')

    const report = sweepStaleStaging(userData, { live: new Set([live]) })

    expect(report).toEqual({ rootOk: true, removed: 1, retained: 1, failed: 0 })
    expect(readFileSync(join(live, 'file.bin'), 'utf8')).toBe('leftover')
    expect(existsSync(stale)).toBe(false)
  })

  it('never traverses a junction or symlink and never removes a stage holding one', () => {
    const { userData, tmp } = makeRoot()
    const outside = mkdtempSync(join(tmpdir(), 'dh-sweep-outside-'))
    roots.push(outside)
    writeFileSync(join(outside, 'sentinel.txt'), 'keep')
    // A family-named junction pointing outside private app data.
    symlinkSync(outside, join(tmp, 'pull-junction'), 'junction')
    // A regular stage whose content is a link: refuse rather than follow.
    const linked = stage(tmp, 'device-adb-Linkd1', {})
    symlinkSync(join(outside, 'sentinel.txt'), join(linked, '000.apk'), 'file')
    // A stage holding a nested directory is not a known flat family either.
    const nested = stage(tmp, 'push-nestedd1')
    mkdirSync(join(nested, 'unexpected'))
    writeFileSync(join(nested, 'unexpected', 'keep.txt'), 'keep')

    const report = sweepStaleStaging(userData, { live: new Set() })

    expect(report).toEqual({ rootOk: true, removed: 0, retained: 3, failed: 0 })
    expect(readFileSync(join(outside, 'sentinel.txt'), 'utf8')).toBe('keep')
    expect(readdirSync(outside)).toEqual(['sentinel.txt'])
    expect(existsSync(join(tmp, 'pull-junction'))).toBe(true)
    expect(existsSync(join(linked, '000.apk'))).toBe(true)
    expect(readFileSync(join(nested, 'unexpected', 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('refuses a linked temporary root outright', () => {
    const userData = mkdtempSync(join(tmpdir(), 'dh-sweep-'))
    roots.push(userData)
    const outside = mkdtempSync(join(tmpdir(), 'dh-sweep-outside-'))
    roots.push(outside)
    stage(outside, 'pull-a1b2c3d4')
    symlinkSync(outside, join(userData, 'tmp'), 'junction')

    const report = sweepStaleStaging(userData, { live: new Set() })

    expect(report).toEqual({ rootOk: false, removed: 0, retained: 0, failed: 0 })
    expect(existsSync(join(outside, 'pull-a1b2c3d4', 'file.bin'))).toBe(true)
  })

  it('is a no-op without a temporary root and idempotent across repeated runs', () => {
    const { userData, tmp } = makeRoot()
    rmSync(tmp, { recursive: true })
    expect(sweepStaleStaging(userData, { live: new Set() })).toEqual({ rootOk: true, removed: 0, retained: 0, failed: 0 })

    mkdirSync(tmp)
    stage(tmp, 'pull-a1b2c3d4')
    const nested = stage(tmp, 'push-nestedd1')
    mkdirSync(join(nested, 'unexpected'))
    expect(sweepStaleStaging(userData, { live: new Set() })).toEqual({ rootOk: true, removed: 1, retained: 1, failed: 0 })
    expect(sweepStaleStaging(userData, { live: new Set() })).toEqual({ rootOk: true, removed: 0, retained: 1, failed: 0 })
    expect(readdirSync(tmp)).toEqual(['push-nestedd1'])
  })

  it('reports a stage it could not remove instead of throwing', () => {
    const { userData, tmp } = makeRoot()
    const stuck = stage(tmp, 'pull-stuckkk1')
    const removable = stage(tmp, 'pull-removab1')
    const failing = new Set<string>([join(stuck, 'file.bin')])

    const report = sweepStaleStaging(userData, {
      live: new Set(),
      unlink: (path) => {
        if (failing.has(path)) throw new Error('EBUSY: resource busy or locked')
        rmSync(path)
      }
    })

    expect(report).toEqual({ rootOk: true, removed: 1, retained: 0, failed: 1 })
    expect(existsSync(join(stuck, 'file.bin'))).toBe(true)
    expect(existsSync(removable)).toBe(false)
  })
})
