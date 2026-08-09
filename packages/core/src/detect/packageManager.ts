import type { Detected, PmKind } from '@devhotel/shared'
import type { SourceReader } from './sourceReader'

export interface PmDetection {
  detected: Detected<PmKind> & { version?: string }
  warnings: string[]
}

interface PmField {
  kind: PmKind
  version?: string
}

function parsePmField(raw: unknown, warnings: string[]): PmField | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const [name = '', version] = raw.trim().split('@')
  if (name === 'npm' || name === 'pnpm') {
    return version !== undefined && version !== '' ? { kind: name, version } : { kind: name }
  }
  warnings.push(`packageManager "${raw.trim()}" is not supported; ignoring it`)
  return null
}

export async function detectPackageManager(src: SourceReader, override?: PmKind): Promise<PmDetection> {
  const warnings: string[] = []

  const [hasPnpmLock, hasNpmLock, hasYarnLock, hasBunLock, hasBunLockb] = await Promise.all([
    src.exists('pnpm-lock.yaml'),
    src.exists('package-lock.json'),
    src.exists('yarn.lock'),
    src.exists('bun.lock'),
    src.exists('bun.lockb'),
  ])

  let field: PmField | null = null
  const pkgRaw = await src.readFile('package.json')
  if (pkgRaw !== null) {
    try {
      field = parsePmField((JSON.parse(pkgRaw) as Record<string, unknown>)['packageManager'], warnings)
    } catch {
      field = null
    }
  }

  if (hasPnpmLock && hasNpmLock) {
    warnings.push('Both pnpm-lock.yaml and package-lock.json present; preferring pnpm')
  }
  if (hasPnpmLock) {
    const version = field?.kind === 'pnpm' ? field.version : undefined
    return { detected: { value: 'pnpm', source: 'pnpm-lock.yaml', ...(version !== undefined ? { version } : {}) }, warnings }
  }
  if (hasNpmLock) {
    const version = field?.kind === 'npm' ? field.version : undefined
    return { detected: { value: 'npm', source: 'package-lock.json', ...(version !== undefined ? { version } : {}) }, warnings }
  }
  if (hasYarnLock) {
    warnings.push('yarn.lock found but yarn is not yet supported; using npm')
    return { detected: { value: 'npm', source: 'fallback' }, warnings }
  }
  if (hasBunLock || hasBunLockb) {
    warnings.push('Bun lockfile found but bun is not yet supported; using npm')
    return { detected: { value: 'npm', source: 'fallback' }, warnings }
  }

  if (field !== null) {
    return {
      detected: {
        value: field.kind,
        source: 'packageManager field',
        ...(field.version !== undefined ? { version: field.version } : {}),
      },
      warnings,
    }
  }

  if (override !== undefined) {
    return { detected: { value: override, source: 'user override' }, warnings }
  }

  return { detected: { value: 'npm', source: 'default' }, warnings }
}
