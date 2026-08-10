import { afterEach, describe, expect, it, vi } from 'vitest'
import { searchNpmRegistry } from './npmRegistry'

describe('npm Registry search', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('bounds and normalizes official registry results', async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(url.origin).toBe('https://registry.npmjs.org')
      expect(url.pathname).toBe('/-/v1/search')
      expect(url.searchParams.get('text')).toBe('vite react')
      expect(url.searchParams.get('size')).toBe('20')
      expect(url.searchParams.get('from')).toBe('0')
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      return new Response(
        JSON.stringify({
          objects: [
            {
              package: {
                name: '@vitejs/plugin-react',
                version: '5.0.1',
                description: 'React plugin',
                date: '2026-01-01T00:00:00.000Z',
                publisher: { username: 'vitebot' }
              }
            },
            { package: { name: 'unsafe;package', version: '1.0.0' } }
          ]
        }),
        { status: 200 }
      )
    }) as unknown as typeof fetch

    await expect(searchNpmRegistry('  vite react  ', fetchImpl)).resolves.toEqual([
      {
        name: '@vitejs/plugin-react',
        version: '5.0.1',
        description: 'React plugin',
        publisher: 'vitebot',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    ])
  })

  it('rejects invalid queries and malformed responses', async () => {
    const unused = vi.fn() as unknown as typeof fetch
    await expect(searchNpmRegistry('../'.repeat(40), unused)).rejects.toThrow()
    await expect(searchNpmRegistry('react', unused, -1)).rejects.toThrow()
    expect(unused).not.toHaveBeenCalled()

    const malformed = vi.fn(async () => new Response('{nope', { status: 200 })) as unknown as typeof fetch
    await expect(searchNpmRegistry('react', malformed)).rejects.toThrow(/invalid JSON/)
  })

  it('rejects oversized responses from both metadata and the actual stream', async () => {
    const declared = vi.fn(
      async () => new Response('{}', { status: 200, headers: { 'content-length': '1000001' } })
    ) as unknown as typeof fetch
    await expect(searchNpmRegistry('react', declared)).rejects.toThrow(/too large/)

    const streamed = vi.fn(
      async () => new Response(new Uint8Array(1_000_001), { status: 200 })
    ) as unknown as typeof fetch
    await expect(searchNpmRegistry('react', streamed)).rejects.toThrow(/too large/)
  })

  it('bounds the live-fetch cache and evicts the oldest search', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ objects: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    for (let index = 0; index < 105; index++) await searchNpmRegistry(`cache-query-${index}`)
    expect(fetchMock).toHaveBeenCalledTimes(105)
    await searchNpmRegistry('cache-query-0')
    expect(fetchMock).toHaveBeenCalledTimes(106)
  })
})
