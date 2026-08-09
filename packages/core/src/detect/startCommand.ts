import type { Detected, PmKind } from '@devhotel/shared'
import type { SourceReader } from './sourceReader'

export async function detectStartCommand(src: SourceReader, pm: PmKind, override?: string): Promise<Detected<string>> {
  if (override !== undefined && override.trim() !== '') {
    return { value: override.trim(), source: 'user override' }
  }

  let scripts: Record<string, unknown> = {}
  const pkgRaw = await src.readFile('package.json')
  if (pkgRaw !== null) {
    try {
      const parsed = (JSON.parse(pkgRaw) as Record<string, unknown>)['scripts']
      if (parsed !== null && typeof parsed === 'object') scripts = parsed as Record<string, unknown>
    } catch {
      // fall through to fallback
    }
  }

  if (typeof scripts['dev'] === 'string') return { value: `${pm} run dev`, source: 'scripts.dev' }
  if (typeof scripts['start'] === 'string') return { value: `${pm} run start`, source: 'scripts.start' }
  return { value: `${pm} run dev`, source: 'fallback' }
}
