import { EMULATOR_DEFAULT_DEVICE, EMULATOR_DEFAULT_VERSION } from '../../backend/naming'
import type { ChangeDefinition } from '../types'

const EMULATOR_UNAVAILABLE =
  'Managed emulators are unavailable in build-only Android Rooms. Use the future Hotel Device Service.'

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
  async preflight(ctx, _p) {
    const room = ctx.room()
    if (room.provider !== 'android') throw new Error('Emulator settings apply to Android rooms')
    throw new Error(EMULATOR_UNAVAILABLE)
  },
  async capture(ctx) {
    return { prev: ctx.room().android ?? { device: EMULATOR_DEFAULT_DEVICE, version: EMULATOR_DEFAULT_VERSION } }
  },
  async apply() {
    throw new Error(EMULATOR_UNAVAILABLE)
  },
  async verify() {
    return { ok: false, detail: EMULATOR_UNAVAILABLE }
  },
  async undo() {
    throw new Error(EMULATOR_UNAVAILABLE)
  }
}
