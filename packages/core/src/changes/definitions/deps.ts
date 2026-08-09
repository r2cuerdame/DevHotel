import type { RoomRecord } from '@devhotel/shared'
import { depsVolume } from '../../backend/naming'
import type { ChangeCtx, ChangeDefinition } from '../types'
import { verifyWebUp } from '../types'

export function pmInstallCommand(room: RoomRecord): string {
  return `${room.packageManager.kind} install`
}

export function depsGenKey(roomId: string): string {
  return `depsGen:${roomId}`
}

export function currentDepsGen(ctx: ChangeCtx): number {
  const raw = ctx.settings.get(depsGenKey(ctx.roomId))
  return raw ? Number.parseInt(raw, 10) : 0
}

export function depsVolumeForGen(roomId: string, nodeMajor: string, gen: number): string {
  return gen === 0 ? depsVolume(roomId, nodeMajor) : `${depsVolume(roomId, nodeMajor)}-g${gen}`
}

export const depsInstallChange: ChangeDefinition<{ clean: boolean }> = {
  kind: 'deps-install',
  plan(ctx, p) {
    return {
      title: p.clean ? 'Dependencies clean reinstalled' : 'Dependencies installed',
      component: 'Dependencies',
      before: p.clean ? { depsGen: currentDepsGen(ctx) } : null,
      after: p.clean ? { depsGen: currentDepsGen(ctx) + 1 } : null,
      undoable: p.clean,
      undoStrategy: p.clean ? 'volume-swap' : 'none',
      autoRollback: false
    }
  },
  async preflight(ctx) {
    if (ctx.room().sourceType === 'empty') throw new Error('An empty room has no dependencies to install')
  },
  async capture(ctx, p) {
    return p.clean ? { prevGen: currentDepsGen(ctx) } : null
  },
  async apply(ctx, p, steps) {
    const room = ctx.room()
    const installCmd = pmInstallCommand(room)
    if (p.clean) {
      const nextGen = currentDepsGen(ctx) + 1
      const freshVolume = depsVolumeForGen(ctx.roomId, room.runtime.version, nextGen)
      steps.push(`Create fresh dependency volume`)
      steps.push(`Run ${installCmd} into the fresh volume`)
      const result = await ctx.backend.runOneShot(ctx.webSpec({ depsVolumeOverride: freshVolume }), installCmd, ctx.log)
      if (result.code !== 0) {
        throw new Error(`${installCmd} failed: ${result.stderr.slice(-400) || `exit ${result.code}`}`)
      }
      ctx.settings.set(depsGenKey(ctx.roomId), String(nextGen))
    } else {
      steps.push(`Run ${installCmd}`)
      const result = await ctx.backend.runOneShot(ctx.webSpec(), installCmd, ctx.log)
      if (result.code !== 0) {
        throw new Error(`${installCmd} failed: ${result.stderr.slice(-400) || `exit ${result.code}`}`)
      }
    }
    if (ctx.isAwake()) {
      steps.push('Restart web process on the updated dependencies')
      await ctx.backend.recreateWeb(ctx.webSpec())
    }
  },
  verify(ctx) {
    return verifyWebUp(ctx)
  },
  async undo(ctx, entry) {
    const prevGen = (entry.captured as { prevGen?: number } | null)?.prevGen ?? 0
    ctx.settings.set(depsGenKey(ctx.roomId), String(prevGen))
    if (ctx.isAwake()) await ctx.backend.recreateWeb(ctx.webSpec())
  }
}
