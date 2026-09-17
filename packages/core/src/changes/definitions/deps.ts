import type { RoomRecord } from '@devhotel/shared'
import { depsVolume } from '../../backend/naming'
import type { ChangeCtx, ChangeDefinition } from '../types'
import { verifyWebUp } from '../types'

export function pmInstallCommand(room: RoomRecord): string {
  return `${room.packageManager.kind} install`
}

/** Dependency generations are tracked per (room, node major) — volumes are keyed the same way. */
export function depsGenKey(roomId: string, nodeMajor: string): string {
  return `depsGen:${roomId}:node${nodeMajor}`
}

export function depsGenMaxKey(roomId: string, nodeMajor: string): string {
  return `depsGenMax:${roomId}:node${nodeMajor}`
}

export function currentDepsGen(ctx: ChangeCtx): number {
  const room = ctx.room()
  const raw =
    ctx.settings.get(depsGenKey(room.id, room.runtime.version)) ??
    // legacy key from before generations were per-major
    ctx.settings.get(`depsGen:${room.id}`)
  return raw ? Number.parseInt(raw, 10) : 0
}

export function depsVolumeForGen(roomId: string, nodeMajor: string, gen: number): string {
  return gen === 0 ? depsVolume(roomId, nodeMajor) : `${depsVolume(roomId, nodeMajor)}-g${gen}`
}

/**
 * Reserve the next dependency generation for (room, major) and return it.
 *
 * The high-water mark is written *before* the caller touches any volume, so a
 * crash between "create the fresh volume" and "publish the pointer" leaves a
 * number that is spent: the next attempt allocates above it and can never
 * reuse a name whose contents are half-written. Generations are never
 * recycled, whether they were undone, failed or interrupted.
 */
export function reserveNextDepsGen(ctx: ChangeCtx, roomId: string, nodeMajor: string, current: number): number {
  const raw = ctx.settings.get(depsGenMaxKey(roomId, nodeMajor))
  const parsed = raw === null ? current : Number.parseInt(raw, 10)
  const highWater = Number.isSafeInteger(parsed) && parsed >= 0 ? Math.max(current, parsed) : current
  const next = highWater + 1
  ctx.settings.set(depsGenMaxKey(roomId, nodeMajor), String(next))
  return next
}

export const depsInstallChange: ChangeDefinition<{ clean: boolean }> = {
  kind: 'deps-install',
  plan(ctx, p) {
    return {
      title: p.clean ? 'Dependencies clean reinstalled' : 'Dependencies installed',
      component: 'Dependencies',
      before: p.clean ? { depsGen: currentDepsGen(ctx) } : null,
      after: null,
      undoable: p.clean,
      undoStrategy: p.clean ? 'volume-swap' : 'none',
      autoRollback: false
    }
  },
  async preflight(ctx) {
    if (ctx.room().sourceType === 'empty') throw new Error('An empty room has no dependencies to install')
  },
  async capture(ctx, p) {
    return p.clean ? { prevGen: currentDepsGen(ctx), nodeMajor: ctx.room().runtime.version } : null
  },
  async apply(ctx, p, steps) {
    const room = ctx.room()
    const installCmd = pmInstallCommand(room)
    if (p.clean) {
      const major = room.runtime.version
      // generations are never reused: reserved durably before the volume exists
      const nextGen = reserveNextDepsGen(ctx, room.id, major, currentDepsGen(ctx))
      const freshVolume = depsVolumeForGen(room.id, major, nextGen)
      steps.push('Create fresh dependency volume')
      await ctx.backend.resetVolume(ctx.roomId, freshVolume)
      steps.push(`Run ${installCmd} into the fresh volume`)
      const result = await ctx.backend.runOneShot(ctx.webSpec({ depsVolumeOverride: freshVolume }), installCmd, ctx.log)
      if (result.code !== 0) {
        throw new Error(`${installCmd} failed: ${result.stderr.slice(-400) || `exit ${result.code}`}`)
      }
      ctx.settings.set(depsGenKey(room.id, major), String(nextGen))
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
    const captured = entry.captured as { prevGen?: number; nodeMajor?: string } | null
    const room = ctx.room()
    const capturedMajor = captured?.nodeMajor ?? room.runtime.version
    if (capturedMajor !== room.runtime.version) {
      throw new Error(
        `This dependency change belongs to Node ${capturedMajor} — the room now runs Node ${room.runtime.version}. ` +
          `Switch back to Node ${capturedMajor} first, or run a fresh install instead.`
      )
    }
    ctx.settings.set(depsGenKey(room.id, capturedMajor), String(captured?.prevGen ?? 0))
    if (ctx.isAwake()) await ctx.backend.recreateWeb(ctx.webSpec())
  }
}
