import type { Detected, PmKind, RoomPlan } from '@devhotel/shared'
import { detectFramework } from './framework'
import { detectNodeVersion } from './nodeVersion'
import { detectPackageManager } from './packageManager'
import { detectPort } from './port'
import type { SourceReader } from './sourceReader'
import { detectStartCommand } from './startCommand'

export interface DetectOptions {
  project: string
  nickname: string
  overrides?: {
    runtimeVersion?: string
    pmKind?: PmKind
    startCommand?: string
    internalPort?: number
  }
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function slugifyDomain(project: string, nickname: string): string {
  return `${slugify(project)}-${slugify(nickname)}.localhost`
}

/** Memoizes reads so each underlying file (package.json in particular) is read once. */
function cachingReader(src: SourceReader): SourceReader {
  const reads = new Map<string, Promise<string | null>>()
  const checks = new Map<string, Promise<boolean>>()
  return {
    readFile(rel) {
      let p = reads.get(rel)
      if (p === undefined) {
        p = src.readFile(rel)
        reads.set(rel, p)
      }
      return p
    },
    exists(rel) {
      let p = checks.get(rel)
      if (p === undefined) {
        p = src.exists(rel)
        checks.set(rel, p)
      }
      return p
    },
  }
}

export async function detectProject(src: SourceReader, opts: DetectOptions): Promise<RoomPlan> {
  const reader = cachingReader(src)
  const warnings: string[] = []

  const pkgRaw = await reader.readFile('package.json')
  let pkg: any = null
  if (pkgRaw === null) {
    warnings.push('No package.json found')
  } else {
    try {
      pkg = JSON.parse(pkgRaw)
    } catch {
      warnings.push('package.json is not valid JSON')
    }
  }

  const project =
    opts.project.trim() !== '' ? opts.project : typeof pkg?.name === 'string' && pkg.name.trim() !== '' ? pkg.name : 'app'

  const runtime = await detectNodeVersion(reader, opts.overrides?.runtimeVersion)
  const pm = await detectPackageManager(reader, opts.overrides?.pmKind)
  warnings.push(...pm.warnings)
  const startCommand = await detectStartCommand(reader, pm.detected.value, opts.overrides?.startCommand)
  const framework = detectFramework(pkg)

  const scripts: Record<string, unknown> = pkg?.scripts ?? {}
  let scriptLine: string | undefined
  if (opts.overrides?.startCommand !== undefined) scriptLine = opts.overrides.startCommand
  else if (typeof scripts['dev'] === 'string') scriptLine = scripts['dev']
  else if (typeof scripts['start'] === 'string') scriptLine = scripts['start']

  let internalPort: Detected<number>
  if (opts.overrides?.internalPort !== undefined) {
    internalPort = { value: opts.overrides.internalPort, source: 'user override' }
  } else {
    internalPort = await detectPort(reader, framework, scriptLine)
    if (internalPort.source === 'default') warnings.push('Could not detect the dev server port; assuming 3000')
  }

  return {
    project,
    framework,
    runtime: { kind: 'node', ...runtime },
    packageManager: pm.detected,
    startCommand,
    internalPort,
    domain: slugifyDomain(project, opts.nickname),
    https: false,
    warnings,
  }
}
