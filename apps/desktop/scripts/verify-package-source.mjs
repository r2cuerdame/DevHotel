import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(desktopDir, '../..')
const mcpDir = resolve(repoRoot, 'packages/mcp')
const require = createRequire(import.meta.url)

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
}

export default async function verifyPackageSource() {
  const expectedCommit = git(['rev-parse', 'HEAD']).toLowerCase()
  if (git(['status', '--porcelain'])) throw new Error('Refusing to package a dirty worktree; commit the exact source first')

  // Ignored build output cannot be authenticated by Git. Recreate every
  // first-party executable payload from the just-verified source.
  rmSync(resolve(desktopDir, 'out'), { recursive: true, force: true })
  rmSync(resolve(mcpDir, 'dist'), { recursive: true, force: true })
  const electronVitePackage = require.resolve('electron-vite/package.json', { paths: [desktopDir] })
  const electronViteCli = resolve(dirname(electronVitePackage), 'bin/electron-vite.js')
  const esbuildCli = require.resolve('esbuild/bin/esbuild', { paths: [mcpDir] })
  execFileSync(process.execPath, [esbuildCli,
    'src/index.ts', '--bundle', '--platform=node', '--format=esm', '--target=node22',
    '--outfile=dist/index.js', '--banner:js=#!/usr/bin/env node', '--external:node:*'
  ], { cwd: mcpDir, stdio: 'inherit' })
  execFileSync(process.execPath, [electronViteCli, 'build'], {
    cwd: desktopDir,
    stdio: 'inherit'
  })

  if (git(['rev-parse', 'HEAD']).toLowerCase() !== expectedCommit || git(['status', '--porcelain'])) {
    throw new Error('Source changed while rebuilding package input')
  }
  const expectedVersion = JSON.parse(readFileSync(resolve(desktopDir, 'package.json'), 'utf8')).version
  const identity = JSON.parse(readFileSync(resolve(desktopDir, 'out/main/build-identity.json'), 'utf8'))
  if (identity.commit !== expectedCommit || identity.version !== expectedVersion || identity.sourceVerified !== true) {
    throw new Error('Compiled build identity does not match the exact package source')
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(identity.buildTime) ||
    new Date(identity.buildTime).toISOString() !== identity.buildTime
  ) {
    throw new Error('Compiled build identity does not contain a canonical UTC build time')
  }
}
