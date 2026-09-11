import { describe, expect, it } from 'vitest'
import { zBuildIdentity } from '../buildIdentity'

const valid = {
  version: '1.2.3-beta.1',
  commit: 'a'.repeat(40),
  buildTime: '2026-09-08T12:34:56.789Z',
  sourceVerified: true
}

describe('build identity', () => {
  it('accepts semantic version, full commit SHA, and ISO build time', () => {
    expect(zBuildIdentity.parse(valid)).toEqual(valid)
    expect(zBuildIdentity.parse({ ...valid, sourceVerified: false }).sourceVerified).toBe(false)
  })

  it.each([
    { ...valid, version: 'latest' },
    { ...valid, commit: 'a'.repeat(39) },
    { ...valid, commit: 'A'.repeat(40) },
    { ...valid, buildTime: 'yesterday' },
    { version: valid.version, commit: valid.commit, buildTime: valid.buildTime },
    { ...valid, localPath: 'C:\\private\\artifact.exe' }
  ])('rejects malformed or extra identity data', (candidate) => {
    expect(zBuildIdentity.safeParse(candidate).success).toBe(false)
  })
})
