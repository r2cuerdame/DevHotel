import type { ChangeDefinition } from '../types'

const DEVICE_UNAVAILABLE =
  'Android Rooms are build-only. Running on a device will be available through the Hotel Device Service.'

export const androidRunChange: ChangeDefinition<Record<string, never>> = {
  kind: 'android-run',
  plan(ctx) {
    return {
      title: 'Run unavailable in build-only Android Room',
      component: 'Device',
      before: null,
      after: { command: ctx.room().startCommand },
      undoable: false,
      undoStrategy: 'none',
      autoRollback: false
    }
  },
  async preflight(ctx) {
    const room = ctx.room()
    if (room.provider !== 'android') throw new Error('Only Android rooms can run on the emulator')
    throw new Error(DEVICE_UNAVAILABLE)
  },
  async apply() {
    throw new Error(DEVICE_UNAVAILABLE)
  },
  async verify() {
    return { ok: false, detail: DEVICE_UNAVAILABLE }
  }
}
