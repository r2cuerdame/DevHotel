import { EMULATOR_ADB_SERIAL } from '@devhotel/core'
import type { AndroidAction } from '@devhotel/shared'

const KEYCODES = { back: 4, home: 3, recents: 187 } as const

/**
 * Phone-strip navigation is Room-local input: it becomes an `adb` command run
 * *inside* the Room against the Room's own emulator serial, never a synthetic
 * Host mouse click on the preview surface. The caller executes the returned
 * argv with the orchestrator's in-Room exec channel.
 *
 * Rotation steps the guest through its four orientations. The emulator screen
 * keeps the size the Room was created with, so a rotated device is letterboxed
 * inside it — Stack's orientation setting resizes the screen itself for a
 * full-size landscape Room.
 */
export function androidActionCommand(action: AndroidAction): string[] {
  const shellCommand =
    action === 'rotate'
      ? `adb -s ${EMULATOR_ADB_SERIAL} shell 'settings put system accelerometer_rotation 0; r=$(settings get system user_rotation); case "$r" in 0|1|2|3) ;; *) r=0 ;; esac; settings put system user_rotation $(((r + 1) % 4))'`
      : `adb -s ${EMULATOR_ADB_SERIAL} shell input keyevent ${KEYCODES[action]}`
  return ['sh', '-lc', shellCommand]
}
