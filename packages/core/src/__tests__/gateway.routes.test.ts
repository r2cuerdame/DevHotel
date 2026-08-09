import { describe, expect, it } from 'vitest'
import { formatUrl } from '../gateway/gateway'
import { RouteTable, type Route } from '../gateway/routes'

const routeA: Route = { domain: 'alpha.localhost', roomId: 'room-a', targetPort: 3100, https: false }
const routeB: Route = { domain: 'beta.localhost', roomId: 'room-b', targetPort: 3200, https: true }

describe('RouteTable', () => {
  it('resolves by exact host', () => {
    const t = new RouteTable()
    t.set(routeA)
    expect(t.byDomain('alpha.localhost')).toEqual(routeA)
  })

  it('is case-insensitive', () => {
    const t = new RouteTable()
    t.set(routeA)
    expect(t.byDomain('ALPHA.localhost')).toEqual(routeA)
    expect(t.byDomain('Alpha.LocalHost')).toEqual(routeA)
  })

  it('matches routes registered with uppercase domains', () => {
    const t = new RouteTable()
    t.set({ ...routeA, domain: 'Alpha.Localhost' })
    expect(t.byDomain('alpha.localhost')).not.toBeNull()
  })

  it('strips :port from the Host header', () => {
    const t = new RouteTable()
    t.set(routeA)
    expect(t.byDomain('alpha.localhost:8080')).toEqual(routeA)
    expect(t.byDomain('ALPHA.LOCALHOST:443')).toEqual(routeA)
  })

  it('returns null for unknown or missing hosts', () => {
    const t = new RouteTable()
    t.set(routeA)
    expect(t.byDomain('other.localhost')).toBeNull()
    expect(t.byDomain(undefined)).toBeNull()
    expect(t.byDomain('')).toBeNull()
  })

  it('remove and list', () => {
    const t = new RouteTable()
    t.set(routeA)
    t.set(routeB)
    expect(t.list()).toHaveLength(2)
    t.remove('ALPHA.localhost')
    expect(t.byDomain('alpha.localhost')).toBeNull()
    expect(t.list()).toEqual([routeB])
  })

  it('set replaces an existing route for the same domain', () => {
    const t = new RouteTable()
    t.set(routeA)
    t.set({ ...routeA, targetPort: 9999 })
    expect(t.byDomain('alpha.localhost')?.targetPort).toBe(9999)
    expect(t.list()).toHaveLength(1)
  })
})

describe('formatUrl', () => {
  it('omits standard ports', () => {
    expect(formatUrl('a.localhost', false, 80)).toBe('http://a.localhost')
    expect(formatUrl('a.localhost', true, 443)).toBe('https://a.localhost')
  })

  it('includes non-standard ports', () => {
    expect(formatUrl('a.localhost', false, 8080)).toBe('http://a.localhost:8080')
    expect(formatUrl('a.localhost', true, 8443)).toBe('https://a.localhost:8443')
  })

  it('omits the port when unknown', () => {
    expect(formatUrl('a.localhost', false, null)).toBe('http://a.localhost')
    expect(formatUrl('a.localhost', true, null)).toBe('https://a.localhost')
  })
})
