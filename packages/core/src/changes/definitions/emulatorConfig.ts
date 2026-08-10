import { EMULATOR_DEFAULT_DEVICE, EMULATOR_DEFAULT_VERSION, type EmulatorResolution } from '../../backend/naming'
import type { ChangeDefinition } from '../types'
import { sleep } from '../types'

type EmulatorSelection = { device: string; version: string; resolution?: EmulatorResolution }

const DEFAULT_SELECTION: EmulatorSelection = {
  device: EMULATOR_DEFAULT_DEVICE,
  version: EMULATOR_DEFAULT_VERSION,
  resolution: 'balanced'
}

function label(selection: EmulatorSelection): string {
  return `${selection.device} (Android ${selection.version}, ${selection.resolution ?? 'balanced'})`
}

export const emulatorConfigChange: ChangeDefinition<{ device: string; version: string; resolution?: EmulatorResolution }> = {
  kind: 'emulator-config',
  plan(ctx, p) {
    const prev = ctx.room().android ?? DEFAULT_SELECTION
    return {
      title: `Emulator ${label(prev)} → ${label(p)}`,
      component: 'Emulator',
      before: prev,
      after: { device: p.device, version: p.version, resolution: p.resolution ?? 'balanced' },
      undoable: true,
      undoStrategy: 'inverse-apply',
      autoRollback: false
    }
  },
  async preflight(ctx, p) {
    const room = ctx.room()
    if (room.provider !== 'android') throw new Error('Emulator settings apply to Android rooms')
    const prev = room.android
    if (
      prev &&
      prev.device === p.device &&
      prev.version === p.version &&
      (prev.resolution ?? 'balanced') === (p.resolution ?? 'balanced')
    ) {
      throw new Error('Emulator settings are unchanged')
    }
  },
  async capture(ctx) {
    return { prev: ctx.room().android ?? DEFAULT_SELECTION }
  },
  async apply(ctx, p, steps) {
    const next: EmulatorSelection = { device: p.device, version: p.version, resolution: p.resolution ?? 'balanced' }
    ctx.rooms.update(ctx.roomId, { android: next })
    if (ctx.isAwake()) {
      steps.push(`Start ${label(next)} (a new OS version downloads its image first)`)
      await ctx.backend.removeEmulator(ctx.roomId)
      await ctx.backend.createEmulator(ctx.roomId, next)
    } else {
      steps.push('Recorded — applies on next wake')
    }
  },
  async verify(ctx) {
    if (!ctx.isAwake()) return { ok: true, detail: 'applies on next wake (room is asleep)' }
    for (let i = 0; i < 10; i++) {
      const state = await ctx.backend.emulatorState(ctx.roomId)
      if (state === 'running') return { ok: true, detail: 'emulator container running — the screen appears on the site view as it boots' }
      if (state === 'missing') return { ok: false, detail: 'emulator container missing' }
      await sleep(2000)
    }
    return { ok: false, detail: 'emulator container did not stay up' }
  },
  async undo(ctx, entry) {
    const prev =
      (entry.captured as { prev?: EmulatorSelection } | null)?.prev ??
      (entry.before as EmulatorSelection)
    ctx.rooms.update(ctx.roomId, { android: prev })
    if (ctx.isAwake()) {
      await ctx.backend.removeEmulator(ctx.roomId)
      await ctx.backend.createEmulator(ctx.roomId, prev)
    }
  }
}
