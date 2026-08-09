import type { Detected } from '@devhotel/shared'
import type { SourceReader } from './sourceReader'

const DEFAULT_LTS_MAJOR = '22'

function parseMajor(raw: string): string | null {
  const match = raw.trim().replace(/^v/i, '').match(/^(\d+)/)
  return match ? match[1]! : null
}

/** First integer >= 14 in an engines range string like ">=20 <23" or "^18.17.0". */
function majorFromEngines(range: string): string | null {
  for (const match of range.matchAll(/\d+/g)) {
    const n = Number.parseInt(match[0], 10)
    if (n >= 14) return String(n)
  }
  return null
}

export async function detectNodeVersion(src: SourceReader, override?: string): Promise<Detected<string>> {
  if (override !== undefined && override.trim() !== '') {
    return { value: parseMajor(override) ?? override.trim(), source: 'user override' }
  }

  let pkg: Record<string, unknown> | null = null
  const pkgRaw = await src.readFile('package.json')
  if (pkgRaw !== null) {
    try {
      pkg = JSON.parse(pkgRaw) as Record<string, unknown>
    } catch {
      pkg = null
    }
  }

  const volta = (pkg?.['volta'] as { node?: unknown } | undefined)?.node
  if (typeof volta === 'string') {
    const major = parseMajor(volta)
    if (major !== null) return { value: major, source: 'volta' }
  }

  for (const file of ['.nvmrc', '.node-version'] as const) {
    const content = await src.readFile(file)
    if (content !== null) {
      const major = parseMajor(content)
      if (major !== null) return { value: major, source: file }
    }
  }

  const engines = (pkg?.['engines'] as { node?: unknown } | undefined)?.node
  if (typeof engines === 'string') {
    const major = majorFromEngines(engines)
    if (major !== null) return { value: major, source: 'engines' }
  }

  return { value: DEFAULT_LTS_MAJOR, source: 'default LTS' }
}
