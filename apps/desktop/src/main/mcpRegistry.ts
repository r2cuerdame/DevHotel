import { zMcpRegistryResponse, type McpRegistryPage } from '@devhotel/shared'

const MAX_BODY = 2 * 1024 * 1024
interface CacheEntry { expires: number; page: McpRegistryPage }
const cache = new Map<string, CacheEntry>()

export async function browseMcpRegistry(search = '', cursor = '', fetchImpl: typeof fetch = fetch): Promise<McpRegistryPage> {
  if (search.length > 100 || cursor.length > 500) throw new Error('Invalid MCP Registry query')
  const key = `${search}\0${cursor}`, hit = cache.get(key)
  if (hit && hit.expires > Date.now()) return { ...hit.page, fromCache: true }
  const url = new URL('https://registry.modelcontextprotocol.io/v0.1/servers')
  url.searchParams.set('search', search); url.searchParams.set('version', 'latest'); url.searchParams.set('limit', '30')
  if (cursor) url.searchParams.set('cursor', cursor)
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8_000)
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { Accept: 'application/json', 'User-Agent': 'DevHotel' } })
    if (!response.ok || !response.body) throw new Error(`MCP Registry request failed (${response.status})`)
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_BODY) throw new Error('MCP Registry response is too large')
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_BODY) { await reader.cancel(); throw new Error('MCP Registry response exceeded its safety limit') }; chunks.push(value) }
    const bytes = new Uint8Array(size); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength }
    const body = zMcpRegistryResponse.parse(JSON.parse(new TextDecoder().decode(bytes)))
    const page: McpRegistryPage = {
      items: body.servers.map(({ server, _meta }) => {
        const remote = server.remotes?.find((r) => r.type === 'streamable-http' && new URL(r.url).protocol === 'https:')
        const official = (_meta?.['io.modelcontextprotocol.registry/official'] ?? {}) as { status?: unknown }
        return { id: server.name, name: server.name, title: server.title ?? server.name, description: server.description ?? '', version: server.version,
          status: typeof official.status === 'string' ? official.status : 'unknown', installMode: remote ? 'remote-http' : 'managed-runtime-required',
          remoteUrl: remote?.url ?? null, packageKinds: [...new Set(server.packages?.map((p) => p.registryType) ?? [])] }
      }),
      nextCursor: body.metadata.nextCursor ?? null, fromCache: false
    }
    cache.set(key, { expires: Date.now() + 5 * 60_000, page }); return page
  } finally { clearTimeout(timer) }
}
