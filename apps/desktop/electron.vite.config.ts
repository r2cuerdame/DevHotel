import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveBuildIdentity } from './buildIdentityConfig'

const repoRoot = resolve(__dirname, '../..')
const packageVersion = (JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }).version
const buildIdentity = resolveBuildIdentity(repoRoot, packageVersion)

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
