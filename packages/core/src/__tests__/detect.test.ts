import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { detectFramework, FRAMEWORK_PORTS } from '../detect/framework'
import { detectNodeVersion } from '../detect/nodeVersion'
import { detectPackageManager } from '../detect/packageManager'
import { detectPort } from '../detect/port'
import { detectProject, slugify, slugifyDomain } from '../detect/detector'
import { fsSourceReader, type SourceReader } from '../detect/sourceReader'
import { detectStartCommand } from '../detect/startCommand'

function fixture(name: string): SourceReader {
  return fsSourceReader(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)))
}

function memReader(files: Record<string, string>): SourceReader {
  return {
    readFile: async (rel) => files[rel] ?? null,
    exists: async (rel) => rel in files,
  }
}

describe('fsSourceReader', () => {
  it('reads existing files and reports existence', async () => {
    const src = fixture('next-pnpm')
    expect(await src.exists('package.json')).toBe(true)
    expect(JSON.parse((await src.readFile('package.json'))!).name).toBe('loop-office')
  })

  it('returns null/false for missing files instead of throwing', async () => {
    const src = fixture('empty')
    expect(await src.readFile('package.json')).toBeNull()
    expect(await src.exists('pnpm-lock.yaml')).toBe(false)
  })
})

describe('detectNodeVersion', () => {
  it('user override wins and is reduced to major', async () => {
    expect(await detectNodeVersion(fixture('next-pnpm'), 'v20.11.1')).toEqual({ value: '20', source: 'user override' })
  })

  it('reads .nvmrc and takes the major', async () => {
    expect(await detectNodeVersion(fixture('next-pnpm'))).toEqual({ value: '22', source: '.nvmrc' })
  })

  it('volta.node beats .nvmrc', async () => {
    const src = memReader({
      'package.json': JSON.stringify({ volta: { node: '18.19.0' } }),
      '.nvmrc': '22',
    })
    expect(await detectNodeVersion(src)).toEqual({ value: '18', source: 'volta' })
  })

  it('.nvmrc beats .node-version', async () => {
    const src = memReader({ '.nvmrc': 'v20.10.0', '.node-version': '18' })
    expect(await detectNodeVersion(src)).toEqual({ value: '20', source: '.nvmrc' })
  })

  it('falls back to .node-version', async () => {
    expect(await detectNodeVersion(memReader({ '.node-version': '20.9.0' }))).toEqual({
      value: '20',
      source: '.node-version',
    })
  })

  it('uses engines.node when no version files exist', async () => {
    expect(await detectNodeVersion(fixture('engines-only'))).toEqual({ value: '20', source: 'engines' })
  })

  it('takes the first integer >= 14 from an engines range', async () => {
    const src = memReader({ 'package.json': JSON.stringify({ engines: { node: '^18.17.0 || >=20' } }) })
    expect(await detectNodeVersion(src)).toEqual({ value: '18', source: 'engines' })
  })

  it('ignores engines integers below 14 and falls back to the default LTS', async () => {
    const src = memReader({ 'package.json': JSON.stringify({ engines: { node: '>=8' } }) })
    expect(await detectNodeVersion(src)).toEqual({ value: '22', source: 'default LTS' })
  })

  it('defaults to LTS 22 for empty sources', async () => {
    expect(await detectNodeVersion(fixture('empty'))).toEqual({ value: '22', source: 'default LTS' })
  })
})

describe('detectPackageManager', () => {
  it('pnpm lockfile wins and carries the packageManager field version', async () => {
    const { detected, warnings } = await detectPackageManager(fixture('next-pnpm'))
    expect(detected).toEqual({ value: 'pnpm', source: 'pnpm-lock.yaml', version: '10.4.0' })
    expect(warnings).toEqual([])
  })

  it('package-lock.json means npm', async () => {
    const { detected, warnings } = await detectPackageManager(fixture('vite-npm'))
    expect(detected).toEqual({ value: 'npm', source: 'package-lock.json' })
    expect(warnings).toEqual([])
  })

  it('pnpm wins with a warning when both lockfiles exist', async () => {
    const src = memReader({ 'pnpm-lock.yaml': '', 'package-lock.json': '{}' })
    const { detected, warnings } = await detectPackageManager(src)
    expect(detected.value).toBe('pnpm')
    expect(detected.source).toBe('pnpm-lock.yaml')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/preferring pnpm/)
  })

  it('packageManager field decides when there is no lockfile', async () => {
    const src = memReader({ 'package.json': JSON.stringify({ packageManager: 'pnpm@9.1.0' }) })
    const { detected } = await detectPackageManager(src)
    expect(detected).toEqual({ value: 'pnpm', source: 'packageManager field', version: '9.1.0' })
  })

  it('user override applies below lockfile and field', async () => {
    const { detected } = await detectPackageManager(fixture('empty'), 'pnpm')
    expect(detected).toEqual({ value: 'pnpm', source: 'user override' })
  })

  it('defaults to npm', async () => {
    const { detected } = await detectPackageManager(fixture('empty'))
    expect(detected).toEqual({ value: 'npm', source: 'default' })
  })

  it('yarn.lock falls back to npm with a warning', async () => {
    const { detected, warnings } = await detectPackageManager(memReader({ 'yarn.lock': '' }))
    expect(detected.value).toBe('npm')
    expect(warnings.some((w) => /yarn/.test(w))).toBe(true)
  })

  it('bun lockfiles fall back to npm with a warning', async () => {
    for (const lock of ['bun.lock', 'bun.lockb']) {
      const { detected, warnings } = await detectPackageManager(memReader({ [lock]: '' }))
      expect(detected.value).toBe('npm')
      expect(warnings.some((w) => /bun/i.test(w))).toBe(true)
    }
  })

  it('warns on an unsupported packageManager field and keeps detecting', async () => {
    const src = memReader({ 'package.json': JSON.stringify({ packageManager: 'yarn@4.5.0' }) })
    const { detected, warnings } = await detectPackageManager(src)
    expect(detected).toEqual({ value: 'npm', source: 'default' })
    expect(warnings.some((w) => /yarn@4\.5\.0/.test(w))).toBe(true)
  })
})

describe('detectStartCommand', () => {
  it('user override wins', async () => {
    expect(await detectStartCommand(fixture('next-pnpm'), 'pnpm', 'node server.js')).toEqual({
      value: 'node server.js',
      source: 'user override',
    })
  })

  it('prefers scripts.dev', async () => {
    expect(await detectStartCommand(fixture('next-pnpm'), 'pnpm')).toEqual({
      value: 'pnpm run dev',
      source: 'scripts.dev',
    })
  })

  it('falls back to scripts.start', async () => {
    const src = memReader({ 'package.json': JSON.stringify({ scripts: { start: 'node server.js' } }) })
    expect(await detectStartCommand(src, 'npm')).toEqual({ value: 'npm run start', source: 'scripts.start' })
  })

  it('falls back to <pm> run dev when no scripts exist', async () => {
    expect(await detectStartCommand(fixture('empty'), 'npm')).toEqual({ value: 'npm run dev', source: 'fallback' })
  })
})

describe('detectFramework', () => {
  it('detects known frameworks from deps and devDeps', () => {
    expect(detectFramework({ dependencies: { next: '15.0.0' } })).toBe('next')
    expect(detectFramework({ dependencies: { nuxt: '3.0.0' } })).toBe('nuxt')
    expect(detectFramework({ dependencies: { astro: '5.0.0' } })).toBe('astro')
    expect(detectFramework({ devDependencies: { '@remix-run/dev': '2.0.0' } })).toBe('remix')
    expect(detectFramework({ devDependencies: { '@sveltejs/kit': '2.0.0' } })).toBe('sveltekit')
    expect(detectFramework({ dependencies: { 'react-scripts': '5.0.1' } })).toBe('cra')
    expect(detectFramework({ devDependencies: { vite: '^6.0.0' } })).toBe('vite')
  })

  it('prefers the meta-framework over its vite devDep', () => {
    expect(detectFramework({ devDependencies: { '@sveltejs/kit': '2.0.0', vite: '^6.0.0' } })).toBe('sveltekit')
  })

  it('returns null when nothing matches', () => {
    expect(detectFramework({ dependencies: { express: '4.0.0' } })).toBeNull()
    expect(detectFramework(null)).toBeNull()
  })

  it('exposes the framework default port map', () => {
    expect(FRAMEWORK_PORTS).toEqual({ next: 3000, nuxt: 3000, remix: 3000, cra: 3000, astro: 4321, sveltekit: 5173, vite: 5173 })
  })
})

describe('detectPort', () => {
  const src = fixture('empty')

  it('parses -p <n> from the script line', async () => {
    expect(await detectPort(src, 'next', 'next dev -p 4100')).toEqual({ value: 4100, source: 'script flag' })
  })

  it('parses --port <n>, --port=<n> and -p=<n>', async () => {
    expect(await detectPort(src, null, 'vite --port 5000')).toEqual({ value: 5000, source: 'script flag' })
    expect(await detectPort(src, null, 'vite --port=5001')).toEqual({ value: 5001, source: 'script flag' })
    expect(await detectPort(src, null, 'vite -p=5002')).toEqual({ value: 5002, source: 'script flag' })
  })

  it('uses the framework default when no flag is present', async () => {
    expect(await detectPort(src, 'next', 'next dev')).toEqual({ value: 3000, source: 'framework (next)' })
    expect(await detectPort(src, 'vite', 'vite')).toEqual({ value: 5173, source: 'framework (vite)' })
    expect(await detectPort(src, 'astro', undefined)).toEqual({ value: 4321, source: 'framework (astro)' })
  })

  it('defaults to 3000', async () => {
    expect(await detectPort(src, null, undefined)).toEqual({ value: 3000, source: 'default' })
  })
})

describe('slugify / slugifyDomain', () => {
  it('lowercases, keeps alnum, collapses dashes, trims', () => {
    expect(slugify('Loop Office')).toBe('loop-office')
    expect(slugify('  Hello,  World!! ')).toBe('hello-world')
    expect(slugify('--a__b--')).toBe('a-b')
  })

  it('builds the room domain', () => {
    expect(slugifyDomain('Loop Office', 'dev')).toBe('loop-office-dev.localhost')
  })
})

describe('detectProject', () => {
  it('composes a full plan for a next + pnpm project', async () => {
    const plan = await detectProject(fixture('next-pnpm'), { project: 'Loop Office', nickname: 'dev' })
    expect(plan).toEqual({
      project: 'Loop Office',
      framework: 'next',
      runtime: { kind: 'node', value: '22', source: '.nvmrc' },
      packageManager: { value: 'pnpm', source: 'pnpm-lock.yaml', version: '10.4.0' },
      startCommand: { value: 'pnpm run dev', source: 'scripts.dev' },
      internalPort: { value: 3000, source: 'framework (next)' },
      domain: 'loop-office-dev.localhost',
      https: false,
      warnings: [],
    })
  })

  it('composes a plan for a vite + npm project', async () => {
    const plan = await detectProject(fixture('vite-npm'), { project: 'vite-app', nickname: 'main' })
    expect(plan.framework).toBe('vite')
    expect(plan.packageManager).toEqual({ value: 'npm', source: 'package-lock.json' })
    expect(plan.startCommand).toEqual({ value: 'npm run dev', source: 'scripts.dev' })
    expect(plan.internalPort).toEqual({ value: 5173, source: 'framework (vite)' })
    expect(plan.domain).toBe('vite-app-main.localhost')
  })

  it('script port flag beats the framework default', async () => {
    const plan = await detectProject(fixture('port-flag'), { project: 'port-flag', nickname: 'dev' })
    expect(plan.internalPort).toEqual({ value: 4100, source: 'script flag' })
  })

  it('handles an empty source with warnings and defaults', async () => {
    const plan = await detectProject(fixture('empty'), { project: 'Fresh', nickname: 'dev' })
    expect(plan.warnings).toContain('No package.json found')
    expect(plan.warnings.some((w) => /port/.test(w))).toBe(true)
    expect(plan.runtime).toEqual({ kind: 'node', value: '22', source: 'default LTS' })
    expect(plan.packageManager).toEqual({ value: 'npm', source: 'default' })
    expect(plan.startCommand).toEqual({ value: 'npm run dev', source: 'fallback' })
    expect(plan.internalPort).toEqual({ value: 3000, source: 'default' })
    expect(plan.https).toBe(false)
  })

  it('applies overrides with user override attribution', async () => {
    const plan = await detectProject(fixture('next-pnpm'), {
      project: 'Loop Office',
      nickname: 'dev',
      overrides: { runtimeVersion: '24.1.0', startCommand: 'pnpm run preview', internalPort: 8080 },
    })
    expect(plan.runtime).toEqual({ kind: 'node', value: '24', source: 'user override' })
    expect(plan.startCommand).toEqual({ value: 'pnpm run preview', source: 'user override' })
    expect(plan.internalPort).toEqual({ value: 8080, source: 'user override' })
  })

  it('reads the port flag out of an override start command', async () => {
    const plan = await detectProject(fixture('next-pnpm'), {
      project: 'Loop Office',
      nickname: 'dev',
      overrides: { startCommand: 'next dev --port 4200' },
    })
    expect(plan.internalPort).toEqual({ value: 4200, source: 'script flag' })
  })

  it('falls back to the package.json name when project is empty', async () => {
    const plan = await detectProject(fixture('next-pnpm'), { project: '', nickname: 'dev' })
    expect(plan.project).toBe('loop-office')
    expect(plan.domain).toBe('loop-office-dev.localhost')
  })

  it('reads package.json from the underlying source only once', async () => {
    let reads = 0
    const inner = fixture('next-pnpm')
    const counting: SourceReader = {
      readFile: (rel) => {
        if (rel === 'package.json') reads += 1
        return inner.readFile(rel)
      },
      exists: (rel) => inner.exists(rel),
    }
    await detectProject(counting, { project: 'Loop Office', nickname: 'dev' })
    expect(reads).toBe(1)
  })
})
