import type { ChangeDefinition } from '../types'
import { verifyWebUp } from '../types'

export const restartWebChange: ChangeDefinition<Record<string, never>> = {
  kind: 'restart-web',
  plan() {
    return {
      title: 'Web process restarted',
      component: 'Web process',
      before: null,
      after: null,
      undoable: false,
      undoStrategy: 'none',
      autoRollback: false
    }
  },
  async preflight(ctx) {
    if (!ctx.isAwake()) throw new Error('The room is asleep — wake it instead of restarting')
  },
  async apply(ctx, _p, steps) {
    steps.push('Restart web container')
    await ctx.backend.restartWeb(ctx.roomId, ctx.webSpec())
    // An observation or check may have revoked ingress while the process was
    // dead (I2); the restarted workload re-derives its route from the record (I1).
    steps.push('Re-derive gateway route')
    await ctx.syncRoute()
  },
  verify(ctx) {
    return verifyWebUp(ctx)
  }
}
