export interface Route {
  domain: string
  roomId: string
  targetPort: number
  https: boolean
}

export class RouteTable {
  private routes = new Map<string, Route>()

  set(r: Route): void {
    this.routes.set(r.domain.toLowerCase(), r)
  }

  remove(domain: string): void {
    this.routes.delete(domain.toLowerCase())
  }

  byDomain(host: string | undefined): Route | null {
    if (!host) return null
    const bare = host.trim().toLowerCase().replace(/:\d+$/, '')
    return this.routes.get(bare) ?? null
  }

  list(): Route[] {
    return [...this.routes.values()]
  }
}
