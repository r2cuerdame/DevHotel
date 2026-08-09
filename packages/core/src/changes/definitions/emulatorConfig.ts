import { EMULATOR_DEFAULT_DEVICE, EMULATOR_DEFAULT_VERSION } from '../../backend/naming'
import type { ChangeDefinition } from '../types'
import { sleep } from '../types'

export const emulatorConfigChange: ChangeDefinition<{ device: string; version: string }> = {
  kind: 'emulator-config',
  plan(ctx, p) {
    const prev = ctx.room().android ?? { device: EMULATOR_DEFAULT_DEVICE, version: EMULATOR_DEFAULT_VERSION }
    return {
      title: `Emulator ${prev.device} (Android ${prev.version}) → ${p.device} (Android ${p.version})`,
      component: 'Emulator',
      before: prev,
      after: { device: p.device, version: p.version },
      undoable: true,
      undoStrategy: 'inverse-apply',
      autoRollback: false
    }
  },
  async preflight(ctx, p) {
    const room = ctx.room()
    if (room.provider !== 'android') throw new Error('Emulator settings apply to Android rooms')
    const prev = room.android
    if (prev && prev.device === p.device && prev.version === p.version) throw new Error('Emulator settings are unchanged')
  },
  async capture(ctx) {
    return { prev: ctx.room().android ?? { device: EMULATOR_DEFAULT_DEVICE, version: EMULATOR_DEFAULT_VERSION } }
  },
  async apply(ctx, p, steps) {
    ctx.rooms.update(ctx.roomId, { android: { device: p.device, version: p.version } })
    if (ctx.isAwake()) {
      steps.push(`Start ${p.device} on Android ${p.version} (a new OS version downloads its image first)`)
      await ctx.backend.removeEmulator(ctx.roomId)
      await ctx.backend.createEmulator(ctx.roomId, { device: p.device, version: p.version })
    } else {
      steps.push('Recorded — applies on next wake')
    }
  },
  async verify(ctx) {
    if (!ctx.isAwake()) return { ok: true, detail: 'applies on next wake (room is asleep)' }
    for (let i = 0; i < 10; i++) {
      const state = await ctx.backend.emulatorState(ctx.roomId)
      if (state === 'running') return { ok: true, detail: 'emulator container running — the screen appears on the Site page as it boots' }
      if (state === 'missing') return { ok: false, detail: 'emulator container missing' }
      await sleep(2000)
    }
    return { ok: false, detail: 'emulator container did not stay up' }
  },
  async undo(ctx, entry) {
    const prev =
      (entry.captured as { prev?: { device: string; version: string } } | null)?.prev ??
      (entry.before as { device: string; version: string })
    ctx.rooms.update(ctx.roomId, { android: prev })
    if (ctx.isAwake()) {
      await ctx.backend.removeEmulator(ctx.roomId)
      await ctx.backend.createEmulator(ctx.roomId, prev)
    }
  }
}
