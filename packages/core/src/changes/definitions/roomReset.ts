import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ResetServiceMode, ServiceKind } from '@devhotel/shared'
import { cacheVolume } from '../../backend/naming'
import type { ChangeCtx, ChangeDefinition } from '../types'
import { verifyWebUp } from '../types'
import { currentDepsGen, depsGenKey, depsGenMaxKey, depsVolumeForGen, pmInstallCommand } from './deps'
import { backupServiceToFile, pingService } from './services'

export interface RoomResetInput {
  reinstallDependencies: boolean
  clearCaches: boolean
  services: ResetServiceMode
  clearBrowserData: boolean
}

interface Captured {
  /** safety dumps taken before any service data is destroyed, by service */
  backups: Partial<Record<ServiceKind, string>>
  /** services that had to be backed up — used to tell "nothing to do" from "backup failed" */
  expected: ServiceKind[]
}

function serviceEntries(ctx: ChangeCtx): [ServiceKind, { version: string }][] {
  return Object.entries(ctx.room().services ?? {}) as [ServiceKind, { version: string }][]
}

function summarise(p: RoomResetInput): string[] {
  const parts: string[] = []
  if (p.reinstallDependencies) parts.push('dependencies')
  if (p.clearCaches) parts.push('caches')
  if (p.services === 'empty') parts.push('app data')
  if (p.services === 'remove') parts.push('apps')
  if (p.clearBrowserData) parts.push('browser data')
  return parts
}

/**
 * Reset a Room in place (goal.md §11 Reset, §12.1 scoped safety capture): the
 * Room keeps its number, nickname, domain, plan and history, and gives back
 * everything it can rebuild for itself. Source code is deliberately out of
 * scope — §13.3 keeps environment actions off the user's tree; restoring code
 * stays Sync from Host / Git.
 */
export const roomResetChange: ChangeDefinition<RoomResetInput> = {
  kind: 'room-reset',
  plan(ctx, p) {
    const parts = summarise(p)
    return {
      title: `Room reset — ${parts.join(', ')}`,
      component: 'Room',
      before: { services: Object.keys(ctx.room().services ?? {}), depsGen: currentDepsGen(ctx) },
      after: { reset: parts },
      // Browser data and cleared caches have no inverse, so the whole reset
      // cannot honestly claim one (§13.4). Service data is recoverable from the
      // safety backup this change records, through Restore in Room Apps.
      undoable: false,
      undoStrategy: 'none',
      autoRollback: false
    }
  },
  async preflight(ctx, p) {
    const room = ctx.room()
    if (summarise(p).length === 0) throw new Error('Choose at least one thing to reset')
    if (room.workspaceMode === 'legacy-host-bind') {
      throw new Error('Move this legacy Host-bound Room into the Hotel before resetting it')
    }
    if (p.reinstallDependencies && room.sourceType === 'empty') {
      throw new Error('An empty room has no dependencies to reinstall')
    }
    if (p.services !== 'keep' && serviceEntries(ctx).length > 0 && !ctx.isAwake()) {
      // the safety dump is taken by talking to the running service
      throw new Error('Wake the room before resetting Room App data')
    }
  },
  async capture(ctx, p): Promise<Captured> {
    if (p.services === 'keep') return { backups: {}, expected: [] }
    const backups: Partial<Record<ServiceKind, string>> = {}
    const expected = serviceEntries(ctx).map(([svc]) => svc)
    for (const svc of expected) {
      const file = await backupServiceToFile(ctx, svc)
      ctx.log(`safety backup before reset: ${file}`)
      backups[svc] = file
    }
    return { backups, expected }
  },
  /** Never destroy service data on a failed run until its dump is on disk. */
  canRollbackApplyFailure(_ctx, _p, captured) {
    const state = captured as Captured | null
    if (!state) return false
    return state.expected.every((svc) => Boolean(state.backups[svc]))
  },
  async apply(ctx, p, steps) {
    const room = ctx.room()

    if (p.services !== 'keep') {
      for (const [svc, cfg] of serviceEntries(ctx)) {
        steps.push(p.services === 'empty' ? `Start ${svc} with empty data` : `Remove ${svc}`)
        await ctx.backend.removeService(ctx.roomId, svc, { volume: true })
        if (p.services === 'empty') {
          await ctx.backend.createService(ctx.roomId, svc, cfg.version)
          const ready = await pingService(ctx, svc)
          if (!ready.ok) throw new Error(`${svc} did not come back after reset: ${ready.detail}`)
        }
      }
      if (p.services === 'remove') ctx.rooms.update(ctx.roomId, { services: {} })
    }

    if (p.clearCaches) {
      steps.push('Clear download caches')
      await ctx.backend.resetVolume(ctx.roomId, cacheVolume(ctx.roomId))
      if (room.provider === 'android') {
        steps.push('Clear the Android SDK and Gradle cache')
        await ctx.backend.resetVolume(ctx.roomId, `dh-${ctx.roomId}-sdk`)
      }
    }

    if (p.reinstallDependencies) {
      // same published-pointer rule as a clean reinstall: build a fresh
      // generation, then flip the pointer — the live volume is never wiped
      const major = room.runtime.version
      const maxRaw = ctx.settings.get(depsGenMaxKey(ctx.roomId, major))
      const nextGen = (maxRaw ? Number.parseInt(maxRaw, 10) : currentDepsGen(ctx)) + 1
      const freshVolume = depsVolumeForGen(ctx.roomId, major, nextGen)
      const installCmd = pmInstallCommand(room)
      steps.push('Create a fresh dependency volume')
      await ctx.backend.resetVolume(ctx.roomId, freshVolume)
      steps.push(`Run ${installCmd} into the fresh volume`)
      const result = await ctx.backend.runOneShot(ctx.webSpec({ depsVolumeOverride: freshVolume }), installCmd, ctx.log)
      if (result.code !== 0) {
        throw new Error(`${installCmd} failed: ${result.stderr.slice(-400) || `exit ${result.code}`}`)
      }
      ctx.settings.set(depsGenKey(ctx.roomId, major), String(nextGen))
      ctx.settings.set(depsGenMaxKey(ctx.roomId, major), String(nextGen))
    }

    if (p.clearBrowserData) {
      steps.push('Clear the Room browser profile')
      if (ctx.clearBrowserData) await ctx.clearBrowserData()
      else ctx.log('no browser profile in this context — nothing to clear')
    }

    // the card must not keep showing a picture of the Room before the reset
    ctx.rooms.update(ctx.roomId, { thumbPath: null })
    try {
      rmSync(join(ctx.userData, 'rooms', ctx.roomId, 'thumb.png'), { force: true })
    } catch {
      // a stale thumbnail file is cosmetic; the record no longer points at it
    }

    if (ctx.isAwake()) {
      steps.push('Restart the room on its reset state')
      await ctx.backend.recreateWeb(ctx.webSpec())
    }
  },
  verify(ctx) {
    return verifyWebUp(ctx)
  }
}
