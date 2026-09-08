import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(desktopDir, '../..')

export default async function verifyPackageSource() {
  const dirty = execFileSync('git', ['status', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8'
  }).trim()
  if (dirty) throw new Error('Refusing to package a tracked dirty worktree; commit the exact source first')

  const expectedCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim().toLowerCase()
  const expectedVersion = JSON.parse(readFileSync(resolve(desktopDir, 'package.json'), 'utf8')).version
  const identity = JSON.parse(readFileSync(resolve(desktopDir, 'out/main/build-identity.json'), 'utf8'))
  if (identity.commit !== expectedCommit || identity.version !== expectedVersion) {
    throw new Error('Compiled build identity does not match the exact package source')
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(identity.buildTime) ||
    new Date(identity.buildTime).toISOString() !== identity.buildTime
  ) {
    throw new Error('Compiled build identity does not contain a canonical UTC build time')
  }
}
