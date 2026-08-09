import type { ChangeDefinition } from '../types'

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.localhost$/

export const domainChange: ChangeDefinition<{ domain: string }> = {
  kind: 'domain',
  plan(ctx, p) {
    const room = ctx.room()
    return {
      title: `Domain ${room.domain} → ${p.domain}`,
      component: 'Domain',
      before: { domain: room.domain },
      after: { domain: p.domain },
      undoable: true,
      undoStrategy: 'inverse-apply',
      autoRollback: true
    }
  },
  async preflight(ctx, p) {
    if (!DOMAIN_RE.test(p.domain)) {
      throw new Error(`Domain must look like my-project.localhost (got: ${p.domain})`)
    }
    const taken = ctx.rooms.list().find((r) => r.domain === p.domain && r.id !== ctx.roomId)
    if (taken) throw new Error(`${p.domain} is already used by ${taken.project} / ${taken.nickname}`)
  },
  async capture(ctx) {
    return { prevDomain: ctx.room().domain }
  },
  async apply(ctx, p, steps) {
    const prev = ctx.room().domain
    ctx.rooms.update(ctx.roomId, { domain: p.domain })
    ctx.gateway.removeRoute(prev)
    if (ctx.isAwake()) {
      steps.push(`Route ${p.domain} to the room`)
      await ctx.syncRoute()
    } else {
      steps.push('Recorded — routes on next wake')
    }
  },
  async verify(ctx) {
    if (!ctx.isAwake()) return { ok: true, detail: 'applies on next wake (room is asleep)' }
    const domain = ctx.room().domain
    const routed = ctx.gateway.status().routes.some((r) => r.domain === domain)
    return routed
      ? { ok: true, detail: `${domain} routed by the local gateway` }
      : { ok: false, detail: `${domain} missing from the gateway routing table` }
  },
  async undo(ctx, entry) {
    const prev =
      (entry.captured as { prevDomain?: string } | null)?.prevDomain ?? (entry.before as { domain: string }).domain
    const cur = ctx.room().domain
    ctx.rooms.update(ctx.roomId, { domain: prev })
    ctx.gateway.removeRoute(cur)
    if (ctx.isAwake()) await ctx.syncRoute()
  }
}
