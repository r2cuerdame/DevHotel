import { ensureCa, issueLeafCert } from '../../gateway/ca'
import { join } from 'node:path'
import type { ChangeDefinition } from '../types'

export const httpsChange: ChangeDefinition<{ enabled: boolean }> = {
  kind: 'https',
  plan(ctx, p) {
    const room = ctx.room()
    return {
      title: p.enabled ? `HTTPS enabled for ${room.domain}` : `HTTPS disabled for ${room.domain}`,
      component: 'HTTPS',
      before: { https: room.https },
      after: { https: p.enabled },
      undoable: true,
      undoStrategy: 'inverse-apply',
      autoRollback: true
    }
  },
  async preflight(ctx, p) {
    if (p.enabled === ctx.room().https) {
      throw new Error(`HTTPS is already ${p.enabled ? 'on' : 'off'}`)
    }
  },
  async capture(ctx) {
    return { prevHttps: ctx.room().https }
  },
  async apply(ctx, p, steps) {
    const caDir = join(ctx.userData, 'ca')
    ctx.rooms.update(ctx.roomId, { https: p.enabled })
    if (p.enabled) {
      steps.push('Ensure DevHotel Local CA')
      await ensureCa(caDir)
      steps.push(`Issue certificate for ${ctx.room().domain}`)
      await issueLeafCert(caDir, ctx.room().domain)
    }
    if (ctx.isAwake()) {
      steps.push(p.enabled ? 'Route via TLS with HTTP redirect' : 'Route via plain HTTP')
      await ctx.syncRoute()
    } else {
      steps.push('Recorded — routes on next wake')
    }
  },
  async verify(ctx) {
    const room = ctx.room()
    if (!room.https) return { ok: true, detail: 'HTTPS off' }
    const status = ctx.gateway.status()
    if (status.httpsPort == null) {
      return { ok: false, detail: 'gateway could not bind an HTTPS port (443/8443 both busy)' }
    }
    if (!ctx.isAwake()) return { ok: true, detail: 'certificate ready; routes on next wake' }
    const routed = status.routes.some((r) => r.domain === room.domain && r.https)
    return routed
      ? { ok: true, detail: `https://${room.domain} routed with a local certificate` }
      : { ok: false, detail: 'HTTPS route missing from the gateway' }
  },
  async undo(ctx, entry) {
    const prev =
      (entry.captured as { prevHttps?: boolean } | null)?.prevHttps ?? (entry.before as { https: boolean }).https
    ctx.rooms.update(ctx.roomId, { https: prev })
    if (ctx.isAwake()) await ctx.syncRoute()
  }
}
