import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(__dirname, '../..')
const packageVersion = (JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }).version
const commit = (process.env.DEVHOTEL_BUILD_COMMIT || execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repoRoot,
  encoding: 'utf8'
})).trim().toLowerCase()
const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH
const buildTime = process.env.DEVHOTEL_BUILD_TIME || (sourceDateEpoch
  ? new Date(Number(sourceDateEpoch) * 1000).toISOString()
  : new Date().toISOString())
if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(packageVersion)) {
  throw new Error('Desktop package version is not semantic')
}
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Build commit must be a full lowercase Git SHA')
if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(buildTime) || new Date(buildTime).toISOString() !== buildTime) {
  throw new Error('Build time must be canonical UTC ISO-8601')
}
const buildIdentity = { version: packageVersion, commit, buildTime }

const emitBuildIdentity: Plugin = {
  name: 'devhotel-build-identity',
  generateBundle() {
    this.emitFile({
      type: 'asset' as const,
      fileName: 'build-identity.json',
      source: `${JSON.stringify(buildIdentity, null, 2)}\n`
    })
  }
}

export default defineConfig({
  main: {
    // bundle workspace packages and their pure-JS deps so the packaged app
    // needs no runtime node_modules resolution for them
    plugins: [
      externalizeDepsPlugin({ exclude: ['@devhotel/core', '@devhotel/shared', 'node-forge', 'js-yaml', 'nanoid', 'zod'] }),
      emitBuildIdentity
    ],
    define: { __DEVHOTEL_BUILD_IDENTITY__: JSON.stringify(buildIdentity) },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@devhotel/shared', 'zod'] })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: { format: 'cjs' }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    }
  }
})
