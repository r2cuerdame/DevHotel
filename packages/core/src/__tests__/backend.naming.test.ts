import { describe, expect, it } from 'vitest'
import {
  ANCHOR_IMAGE,
  RELAY_PORT,
  anchorName,
  buildAnchorArgs,
  buildOneShotArgs,
  buildWebCreateArgs,
  cacheVolume,
  depsVolume,
  parsePortOutput,
  srcVolume,
  webImage,
  webName,
  wrapStartCommand,
} from '../backend/naming'
import type { WebSpec } from '../backend/types'

function spec(overrides: Partial<WebSpec> = {}): WebSpec {
  return {
    roomId: 'r1',
    internalPort: 5173,
    nodeMajor: '22',
    sourceType: 'managed-git',
    sourceRef: 'https://example.com/repo.git',
    startCommand: 'npm run dev',
    ...overrides,
  }
}

function mounts(args: string[]): string[] {
  return args.flatMap((a, i) => (a === '-v' ? [args[i + 1] ?? ''] : []))
}

function envs(args: string[]): string[] {
  return args.flatMap((a, i) => (a === '-e' ? [args[i + 1] ?? ''] : []))
}

describe('names and images', () => {
  it('derives container, volume, and image names', () => {
    expect(anchorName('r1')).toBe('dh-r1-anchor')
    expect(webName('r1')).toBe('dh-r1-web')
    expect(srcVolume('r1')).toBe('dh-r1-src')
    expect(depsVolume('r1', '22')).toBe('dh-r1-deps-node22')
    expect(cacheVolume('r1')).toBe('dh-r1-cache')
    expect(webImage('22')).toBe('node:22-bookworm')
    expect(ANCHOR_IMAGE).toBe('alpine/socat')
    expect(RELAY_PORT).toBe(3999)
  })
})

describe('buildAnchorArgs', () => {
  it('runs socat relay with ephemeral loopback publish and labels', () => {
    expect(buildAnchorArgs({ roomId: 'r1', internalPort: 5173 })).toEqual([
      'run',
      '-d',
      '--name',
      'dh-r1-anchor',
      '-l',
      'devhotel.room=r1',
      '-l',
      'devhotel.role=anchor',
      '-l',
      'devhotel.managed=1',
      '-p',
      '127.0.0.1:0:3999',
      'alpine/socat',
      'TCP-LISTEN:3999,fork,reuseaddr',
      'TCP:127.0.0.1:5173',
    ])
  })
})

describe('buildWebCreateArgs', () => {
  it('managed-git mounts src volume, deps volume, cache volume', () => {
    const args = buildWebCreateArgs(spec())
    expect(args[0]).toBe('create')
    expect(mounts(args)).toEqual([
      'dh-r1-src:/workspace',
      'dh-r1-deps-node22:/workspace/node_modules',
      'dh-r1-cache:/cache',
    ])
  })

  it('linked-folder bind-mounts the host path with deps volume overlay', () => {
    const args = buildWebCreateArgs(spec({ sourceType: 'linked-folder', sourceRef: 'C:\\proj\\app' }))
    expect(mounts(args)).toEqual([
      'C:\\proj\\app:/workspace',
      'dh-r1-deps-node22:/workspace/node_modules',
      'dh-r1-cache:/cache',
    ])
  })

  it('empty source has no src mount and no deps volume, cache only', () => {
    const args = buildWebCreateArgs(spec({ sourceType: 'empty', sourceRef: '' }))
    expect(mounts(args)).toEqual(['dh-r1-cache:/cache'])
  })

  it('joins the anchor network namespace', () => {
    const args = buildWebCreateArgs(spec())
    const i = args.indexOf('--network')
    expect(args[i + 1]).toBe('container:dh-r1-anchor')
  })

  it('carries the devhotel labels', () => {
    const args = buildWebCreateArgs(spec())
    const labels = args.flatMap((a, i) => (a === '-l' ? [args[i + 1] ?? ''] : []))
    expect(labels).toEqual(['devhotel.room=r1', 'devhotel.role=web', 'devhotel.managed=1'])
  })

  it('sets cache env, passes extra env, and never sets CI', () => {
    const args = buildWebCreateArgs(spec({ env: { FOO: 'bar' } }))
    expect(envs(args)).toEqual(['npm_config_cache=/cache/npm', 'PNPM_HOME=/cache/pnpm', 'FOO=bar'])
    expect(envs(args).some((e) => e.startsWith('CI='))).toBe(false)
  })

  it('wraps the start command with a tolerant corepack enable and exec', () => {
    const args = buildWebCreateArgs(spec())
    expect(args.slice(-3)).toEqual([
      'sh',
      '-lc',
      "export COREPACK_ENABLE_DOWNLOAD_PROMPT=0; command -v corepack >/dev/null 2>&1 && corepack enable >/dev/null 2>&1; exec npm run dev",
    ])
    expect(args).toContain('node:22-bookworm')
    const w = args.indexOf('-w')
    expect(args[w + 1]).toBe('/workspace')
  })
})

describe('buildOneShotArgs', () => {
  it('uses run --rm with the same mounts and env as the web container', () => {
    const web = buildWebCreateArgs(spec())
    const oneShot = buildOneShotArgs(spec(), 'npm install')
    expect(oneShot.slice(0, 2)).toEqual(['run', '--rm'])
    expect(mounts(oneShot)).toEqual(mounts(web))
    expect(envs(oneShot)).toEqual(envs(web))
    expect(oneShot).not.toContain('--network')
    expect(oneShot.slice(-3)).toEqual(['sh', '-lc', wrapStartCommand('npm install')])
  })
})

describe('parsePortOutput', () => {
  it('parses a single ipv4 line', () => {
    expect(parsePortOutput('127.0.0.1:54321\n')).toBe(54321)
  })

  it('prefers the ipv4 loopback line in dual-line ipv6 output', () => {
    expect(parsePortOutput('[::1]:54321\n127.0.0.1:54322\n')).toBe(54322)
    expect(parsePortOutput('127.0.0.1:54322\n[::1]:54321')).toBe(54322)
  })

  it('falls back to any port-suffixed line', () => {
    expect(parsePortOutput('0.0.0.0:49153\n')).toBe(49153)
  })

  it('throws on garbage', () => {
    expect(() => parsePortOutput('')).toThrow()
    expect(() => parsePortOutput('no ports here')).toThrow()
  })
})
