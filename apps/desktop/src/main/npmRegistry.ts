import {
  zNpmSearchResponse,
  zPackageSearchOffset,
  zPackageSearchQuery,
  zRegistryPackageName,
  zRegistryPackageVersion,
  type RegistryPackageInfo
} from '@devhotel/shared'

const SEARCH_LIMIT = 20
const MAX_RESPONSE_BYTES = 1_000_000
const SEARCH_TIMEOUT_MS = 8_000
const CACHE_TTL_MS = 5 * 60_000
const MAX_CACHE_ENTRIES = 100
const resultCache = new Map<string, { expiresAt: number; items: RegistryPackageInfo[] }>()
const inFlight = new Map<string, Promise<RegistryPackageInfo[]>>()

async function readBoundedBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error('npm Registry search response was too large')
  }
  if (!response.body) {
    const body = await response.text()
    if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('npm Registry search response was too large')
    return body
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Error('npm Registry search response was too large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
}

export async function searchNpmRegistry(
  rawQuery: string,
  fetchImpl: typeof fetch = fetch,
  rawOffset = 0
): Promise<RegistryPackageInfo[]> {
  const query = zPackageSearchQuery.parse(rawQuery)
  const offset = zPackageSearchOffset.parse(rawOffset)
  const cacheKey = `${query}\u0000${offset}`
  const useCache = fetchImpl === fetch
  const cached = useCache ? resultCache.get(cacheKey) : undefined
  if (cached && cached.expiresAt > Date.now()) return cached.items
  const pending = useCache ? inFlight.get(cacheKey) : undefined
  if (pending) return pending

  const request = searchNpmRegistryPage(query, offset, fetchImpl)
  if (useCache) inFlight.set(cacheKey, request)
  try {
    const items = await request
    if (useCache) {
      const now = Date.now()
      for (const [key, value] of resultCache) {
        if (value.expiresAt <= now) resultCache.delete(key)
      }
      while (resultCache.size >= MAX_CACHE_ENTRIES) {
        const oldest = resultCache.keys().next().value as string | undefined
        if (oldest === undefined) break
        resultCache.delete(oldest)
      }
      resultCache.set(cacheKey, { expiresAt: now + CACHE_TTL_MS, items })
    }
    return items
  } finally {
    if (useCache) inFlight.delete(cacheKey)
  }
}

async function searchNpmRegistryPage(query: string, offset: number, fetchImpl: typeof fetch): Promise<RegistryPackageInfo[]> {
  const url = new URL('https://registry.npmjs.org/-/v1/search')
  url.searchParams.set('text', query)
  url.searchParams.set('size', String(SEARCH_LIMIT))
  url.searchParams.set('from', String(offset))

  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    redirect: 'error'
  })
  if (!response.ok) throw new Error(`npm Registry search failed (HTTP ${response.status})`)

  const body = await readBoundedBody(response)

  let decoded: unknown
  try {
    decoded = JSON.parse(body)
  } catch {
    throw new Error('npm Registry returned invalid JSON')
  }
  const parsed = zNpmSearchResponse.parse(decoded)

  const results: RegistryPackageInfo[] = []
  for (const item of parsed.objects) {
    const pkg = item.package
    const name = zRegistryPackageName.safeParse(pkg.name)
    const version = zRegistryPackageVersion.safeParse(pkg.version)
    // Search can contain legacy records that cannot be safely represented as
    // a registry-only package spec. Hide those instead of relaxing execution.
    if (!name.success || !version.success) continue
    results.push({
      name: name.data,
      version: version.data,
      description: pkg.description ?? '',
      publisher: pkg.publisher?.username ?? '',
      updatedAt: pkg.date ?? ''
    })
  }
  return results.slice(0, SEARCH_LIMIT)
}
