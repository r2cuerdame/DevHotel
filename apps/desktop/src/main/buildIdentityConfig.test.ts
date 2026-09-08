import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveBuildIdentity } from '../../buildIdentityConfig'

const roots: string[] = []
const stableEnv = { DEVHOTEL_BUILD_TIME: '2026-09-08T12:34:56.789Z' }

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function repository(): { root: string; commit: string } {
  const root = mkdtempSync(join(tmpdir(), 'devhotel-build-identity-'))
  roots.push(root)
  execFileSync('git', ['init'], { cwd: root })
  writeFileSync(join(root, 'tracked.txt'), 'original\n')
  execFileSync('git', ['add', 'tracked.txt'], { cwd: root })
  execFileSync('git', [
    '-c', 'user.name=DevHotel Test',
    '-c', 'user.email=devhotel@example.invalid',
    'commit', '-m', 'fixture'
  ], { cwd: root })
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  return { root, commit }
}

describe('desktop build identity source verification', () => {
  it('verifies only the clean exact HEAD', () => {
    const { root, commit } = repository()
    expect(resolveBuildIdentity(root, '0.5.2', stableEnv)).toEqual({
      version: '0.5.2',
      commit,
      buildTime: stableEnv.DEVHOTEL_BUILD_TIME,
      sourceVerified: true
    })
  })

  it('marks tracked and untracked source changes unverifiable', () => {
    const { root } = repository()
    writeFileSync(join(root, 'tracked.txt'), 'changed\n')
    expect(resolveBuildIdentity(root, '0.5.2', stableEnv).sourceVerified).toBe(false)
    writeFileSync(join(root, 'tracked.txt'), 'original\n')
    writeFileSync(join(root, 'untracked.txt'), 'new\n')
    expect(resolveBuildIdentity(root, '0.5.2', stableEnv).sourceVerified).toBe(false)
    unlinkSync(join(root, 'untracked.txt'))
  })

  it('marks a commit override other than HEAD unverifiable', () => {
    const { root } = repository()
    expect(resolveBuildIdentity(root, '0.5.2', {
      ...stableEnv,
      DEVHOTEL_BUILD_COMMIT: 'a'.repeat(40)
    }).sourceVerified).toBe(false)
  })
})
