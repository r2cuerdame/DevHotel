import {
  EMULATOR_DEFAULT_DEVICE,
  EMULATOR_DEFAULT_VERSION,
  emulatorAvdOverride,
  emulatorBudget,
  emulatorScreen,
  type EmulatorLimits,
  type EmulatorOpts
} from './naming'
import { androidApiLevel, ANDROID_SYSTEM_IMAGES, UnpinnedAndroidSystemImageError } from './androidSdkPin'

/**
 * The direct `emulator` launch plan for a managed Android Room (#108).
 *
 * `budtmo/docker-android` takes its configuration as environment variables
 * (`EMULATOR_DEVICE`, `EMULATOR_ADDITIONAL_ARGS`, `SCREEN_*`, …) and builds the
 * command line itself. Owning the emulator means owning that argv, so this
 * module produces it directly from the same Room inputs `buildEmulatorArgs`
 * uses today. It is deliberately backend-neutral and free of Docker: whatever
 * executes it — the external compatibility backend today, the managed runtime
 * once #107/#109 land — only has to run the argv.
 *
 * Every option below was verified against the pinned emulator build's own
 * option table rather than recalled, including that `-accel` takes `on|off|auto`
 * and that `-ports` is `<consoleport>,<adbport>`.
 *
 * Design: docs/superpowers/specs/2026-09-17-android-room-managed-runtime-design.md
 */

/** Where the Room's SDK and AVD live inside the runtime. Room-owned, not `/home/androidusr`. */
export const ANDROID_SDK_ROOT = '/opt/devhotel/android-sdk'
export const ANDROID_AVD_HOME = '/opt/devhotel/android-avd'
/** The X display the emulator window is mapped into and x11vnc exports. */
export const ANDROID_EMULATOR_DISPLAY = ':0'

/**
 * Fixed console/adb ports.
 *
 * `EMULATOR_ADB_SERIAL` is `emulator-5554` because adb names a local emulator
 * after its console port. Letting the emulator auto-allocate would let that
 * serial drift, and every fenced ADB command, install receipt and acceptance
 * report in this project is written against the constant. Pinning the pair is
 * what keeps the existing contract true rather than probable.
 */
export const ANDROID_EMULATOR_CONSOLE_PORT = 5554
export const ANDROID_EMULATOR_ADB_PORT = 5555

export interface AndroidAvdPlan {
  /** AVD name; also the directory under ANDROID_AVD_HOME. */
  name: string
  /** `sdkmanager` coordinate of the system image this AVD is created from. */
  systemImage: string
  /** `avdmanager create avd` argv, without the executable. */
  createArgs: string[]
  /**
   * Lines appended to the AVD's `config.ini`. docker-android performs this
   * append itself from `EMULATOR_CONFIG_PATH`; owning the AVD means writing
   * them, which is what removes the `/home/androidusr` staging path.
   */
  configIni: string
}

export function androidAvdName(roomId: string): string {
  return `dh-${roomId}`
}

/** How a managed Room's AVD is created, before any emulator is launched. */
export function androidAvdPlan(roomId: string, opts?: Partial<EmulatorOpts>): AndroidAvdPlan {
  const version = opts?.version ?? EMULATOR_DEFAULT_VERSION
  const apiLevel = androidApiLevel(version)
  const image = ANDROID_SYSTEM_IMAGES[apiLevel]
  if (!image) throw new UnpinnedAndroidSystemImageError(version, apiLevel)
  const name = androidAvdName(roomId)
  const device = opts?.device ?? EMULATOR_DEFAULT_DEVICE
  return {
    name,
    systemImage: image.sdkPackage,
    createArgs: [
      'create',
      'avd',
      '--name',
      name,
      '--package',
      image.sdkPackage,
      '--device',
      device,
      // A Room's AVD is created once and then owned; never silently replaced.
      '--force'
    ],
    configIni: emulatorAvdOverride(device, opts?.resolution ?? 'fast', opts?.orientation ?? 'portrait')
  }
}

export interface AndroidEmulatorLaunch {
  argv: string[]
  env: Record<string, string>
}

/**
 * The emulator command line and the environment it needs.
 *
 * Notable absences, each deliberate:
 *
 * - **no `-no-window`.** The Room's "site" is the phone screen: the emulator
 *   must map a real window into the Xvfb display so openbox can make it
 *   frameless and x11vnc can export it to noVNC on `EMULATOR_SCREEN_PORT`.
 *   A headless emulator would leave the preview permanently black.
 * - **no snapshot flags.** The emulator's default quickboot save/load is what
 *   makes a warm Room's AVD state survive, which is the half of #78 that owning
 *   the AVD directory unblocks. Passing `-no-snapshot-save` here would throw it
 *   away on every stop.
 * - **no `--gpus` / `-gpu host`.** Measured under #104: the Host selects
 *   llvmpipe and Vulkan fails with `VK_ERROR_INCOMPATIBLE_DRIVER`. Software
 *   rendering is the supported configuration and no hardware acceleration is
 *   claimed.
 */
export function androidEmulatorLaunch(
  roomId: string,
  opts?: Partial<EmulatorOpts>,
  limits?: EmulatorLimits
): AndroidEmulatorLaunch {
  const budget = emulatorBudget(limits)
  const screen = emulatorScreen(opts?.orientation)
  return {
    argv: [
      '-avd',
      androidAvdName(roomId),
      // Hold the serial contract: adb names this device emulator-5554.
      '-ports',
      `${ANDROID_EMULATOR_CONSOLE_PORT},${ANDROID_EMULATOR_ADB_PORT}`,
      // `on` rather than `auto`: without KVM the emulator is unusably slow, and
      // a Host that refused nested virtualization has to fail loudly here
      // instead of producing a Room that looks alive and never boots.
      '-accel',
      'on',
      '-gpu',
      'swiftshader_indirect',
      '-cores',
      String(budget.cores),
      '-memory',
      String(budget.memoryMB),
      '-noaudio',
      '-no-boot-anim',
      // ADB authentication is disabled only for this managed emulator: its ADB
      // transport has no Host port and no Room-network path, and immutable-ID
      // helpers can reach it only through the proved private control netns.
      '-skip-adb-auth'
    ],
    env: {
      ANDROID_SDK_ROOT,
      ANDROID_AVD_HOME,
      DISPLAY: ANDROID_EMULATOR_DISPLAY,
      // Xvfb is sized by the same function that sizes the docker-android
      // screen, so the preview geometry does not change across the migration.
      SCREEN_WIDTH: String(screen.width),
      SCREEN_HEIGHT: String(screen.height)
    }
  }
}
