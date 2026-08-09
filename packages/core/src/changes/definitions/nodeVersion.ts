import type { ChangeDefinition } from '../types'
import { verifyWebUp } from '../types'
import { pmInstallCommand } from './deps'

export const nodeVersionChange: ChangeDefinition<{ version: string }> = {
  kind: 'node-version',
  plan(ctx, p) {
    const room = ctx.room()
    return {
      title: `Node ${room.runtime.version} → ${p.version}`,
      component: 'Node.js',
      before: { version: room.runtime.version },
      after: { version: p.version },
      undoable: true,
      undoStrategy: 'volume-swap',
      autoRollback: false
    }
  },
  async preflight(ctx, p) {
    if (!/^\d+$/.test(p.version)) throw new Error(`Not a Node major version: ${p.version}`)
    if (p.version === ctx.room().runtime.version) throw new Error(`Room already uses Node ${p.version}`)
  },
  async capture(ctx) {
    return { prevVersion: ctx.room().runtime.version }
  },
  async apply(ctx, p, steps) {
    const room = ctx.room()
    ctx.rooms.update(ctx.roomId, { runtime: { kind: 'node', version: p.version } })
    if (room.sourceType !== 'empty') {
      steps.push(`Install dependencies for Node ${p.version} (kept separate from Node ${room.runtime.version})`)
      const result = await ctx.backend.runOneShot(ctx.webSpec(), pmInstallCommand(ctx.room()), ctx.log)
      if (result.code !== 0) {
        throw new Error(`dependency install on Node ${p.version} failed: ${result.stderr.slice(-400) || `exit ${result.code}`}`)
      }
    }
    if (ctx.isAwake()) {
      steps.push(`Recreate web container on node:${p.version}-bookworm`)
      await ctx.backend.recreateWeb(ctx.webSpec())
      await ctx.syncRoute()
    } else {
      steps.push('Recorded — the room is asleep, applies on next wake')
    }
  },
  verify(ctx) {
    return verifyWebUp(ctx)
  },
  async undo(ctx, entry) {
    const prev =
      (entry.captured as { prevVersion?: string } | null)?.prevVersion ??
      (entry.before as { version: string }).version
    ctx.rooms.update(ctx.roomId, { runtime: { kind: 'node', version: prev } })
    if (ctx.isAwake()) {
      await ctx.backend.recreateWeb(ctx.webSpec())
      await ctx.syncRoute()
    }
  }
}
