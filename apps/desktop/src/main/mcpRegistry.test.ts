import { describe, expect, it, vi } from 'vitest'
import { browseMcpRegistry } from './mcpRegistry'

describe('official MCP Registry client', () => {
  it('classifies only HTTPS streamable HTTP servers as remotely connectable', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ servers: [
      { server: { name: 'remote.example/mcp', title: 'Remote', version: '1.0.0', remotes: [{ type: 'streamable-http', url: 'https://mcp.example.test' }] }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } } },
      { server: { name: 'package.example/mcp', version: '2.0.0', packages: [{ registryType: 'npm' }] } }
    ], metadata: { count: 2, nextCursor: 'next' } }), { headers: { 'content-type': 'application/json' } }))
    const page = await browseMcpRegistry('unique-test-query', '', fetcher as typeof fetch)
    expect(page.items.map((i) => i.installMode)).toEqual(['remote-http', 'managed-runtime-required'])
    expect(page.nextCursor).toBe('next')
  })

  it('rejects oversized bodies before parsing', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { headers: { 'content-length': String(3 * 1024 * 1024) } }))
    await expect(browseMcpRegistry('oversize-test-query', '', fetcher as typeof fetch)).rejects.toThrow(/too large/)
  })
})
