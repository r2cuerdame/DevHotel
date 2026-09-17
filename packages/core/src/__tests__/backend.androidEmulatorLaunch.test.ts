import { describe, expect, it } from 'vitest'
import {
  ANDROID_AVD_HOME,
  ANDROID_EMULATOR_ADB_PORT,
  ANDROID_EMULATOR_CONSOLE_PORT,
  ANDROID_EMULATOR_DISPLAY,
  ANDROID_SDK_ROOT,
  androidAvdName,
  androidAvdPlan,
  androidEmulatorLaunch
} from '../backend/androidEmulatorLaunch'
import { ANDROID_API_LEVELS, UnpinnedAndroidSystemImageError } from '../backend/androidSdkPin'
import {
  EMULATOR_ADB_SERIAL,
  EMULATOR_DEFAULT_VERSION,
  emulatorAvdOverride,
  emulatorBudget
} from '../backend/naming'
import {
  UNPINNED_TEST_API_LEVEL,
  UNPINNED_TEST_VERSION,
  withUnpinnedAndroidVersion
} from './androidPinTestSupport'

/** `-flag value` pairs from an emulator argv. */
function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}

describe('direct Android emulator launch', () => {
  it('pins the console/adb ports the emulator-5554 serial contract depends on', () => {
    const { argv } = androidEmulatorLaunch('r1')
    // adb names a local emulator after its console port. Every fenced ADB
    // command, install receipt and acceptance report in this project is written
    // against EMULATOR_ADB_SERIAL, so the port cannot be left to auto-allocate.
    expect(flag(argv, '-ports')).toBe(`${ANDROID_EMULATOR_CONSOLE_PORT},${ANDROID_EMULATOR_ADB_PORT}`)
    expect(EMULATOR_ADB_SERIAL).toBe(`emulator-${ANDROID_EMULATOR_CONSOLE_PORT}`)
  })

  it('requires KVM rather than silently falling back to software CPU emulation', () => {
    const { argv } = androidEmulatorLaunch('r1')
    // '-accel on' is a hard requirement; 'auto' would give a Host that refused
    // nested virtualization a Room that looks alive and never finishes booting.
    expect(flag(argv, '-accel')).toBe('on')
    expect(argv).not.toContain('-no-accel')
    expect(flag(argv, '-gpu')).toBe('swiftshader_indirect')
    // #104 measured that -gpu host / --gpus all is not usable here, and no
    // hardware acceleration is claimed.
    expect(argv).not.toContain('host')
    expect(argv).not.toContain('--gpus')
  })

  it('keeps the emulator windowed so the Room preview is not permanently black', () => {
    const { argv, env } = androidEmulatorLaunch('r1')
    // The Room's "site" is the phone screen exported by x11vnc from this
    // display; a headless emulator maps no window for openbox or x11vnc.
    expect(argv).not.toContain('-no-window')
    expect(env.DISPLAY).toBe(ANDROID_EMULATOR_DISPLAY)
    expect(env.SCREEN_WIDTH).toBe('540')
    expect(env.SCREEN_HEIGHT).toBe('1140')
    expect(androidEmulatorLaunch('r1', { orientation: 'landscape' }).env).toMatchObject({
      SCREEN_WIDTH: '1140',
      SCREEN_HEIGHT: '540'
    })
  })

  it('leaves quickboot alone so a warm Room can keep its AVD state', () => {
    const { argv } = androidEmulatorLaunch('r1')
    // Owning the AVD directory is the half of #78 this unblocks. Discarding the
    // snapshot on every stop would throw it away before #78 can use it.
    for (const flagName of ['-no-snapshot', '-no-snapshot-save', '-no-snapshot-load', '-wipe-data']) {
      expect(argv).not.toContain(flagName)
    }
  })

  it('spends the Room budget on the guest and names its own AVD', () => {
    const { argv, env } = androidEmulatorLaunch('r1', undefined, { cpus: 2, memoryMB: 4096 })
    const budget = emulatorBudget({ cpus: 2, memoryMB: 4096 })
    expect(flag(argv, '-cores')).toBe(String(budget.cores))
    expect(flag(argv, '-memory')).toBe(String(budget.memoryMB))
    expect(flag(argv, '-avd')).toBe(androidAvdName('r1'))
    expect(argv).toContain('-noaudio')
    expect(argv).toContain('-no-boot-anim')
    expect(argv).toContain('-skip-adb-auth')
    // Room-owned paths, not the docker-android image's /home/androidusr.
    expect(env.ANDROID_SDK_ROOT).toBe(ANDROID_SDK_ROOT)
    expect(env.ANDROID_AVD_HOME).toBe(ANDROID_AVD_HOME)
    expect(Object.values(env).some((v) => v.includes('androidusr'))).toBe(false)
  })

  it('creates the AVD from the pinned system image with the Room resolution', () => {
    const plan = androidAvdPlan('r1', { device: 'Nexus 5', version: EMULATOR_DEFAULT_VERSION })
    expect(plan.name).toBe('dh-r1')
    expect(plan.systemImage).toBe('system-images;android-34;google_apis;x86_64')
    expect(plan.createArgs.slice(0, 2)).toEqual(['create', 'avd'])
    expect(flag(plan.createArgs, '--name')).toBe('dh-r1')
    expect(flag(plan.createArgs, '--package')).toBe(plan.systemImage)
    expect(flag(plan.createArgs, '--device')).toBe('Nexus 5')
    // The resolution override stops being a file docker-android appends and
    // becomes config.ini content DevHotel writes; the content is unchanged.
    expect(plan.configIni).toBe(emulatorAvdOverride('Nexus 5', 'fast', 'portrait'))
    expect(androidAvdPlan('r1', { orientation: 'landscape' }).configIni).toContain('hw.initialOrientation=landscape')
  })

  it('plans an AVD from the right system image for every offered version', () => {
    // Each offered version has its own pinned image now, so the AVD must be
    // created from the one matching the Room's Android — not from the default,
    // which is the failure a single-version test could not have seen.
    for (const [version, apiLevel] of Object.entries(ANDROID_API_LEVELS)) {
      const plan = androidAvdPlan('r1', { version })
      const expected = `system-images;android-${apiLevel};google_apis;x86_64`
      expect(plan.systemImage, `Android ${version}`).toBe(expected)
      expect(plan.createArgs).toContain(expected)
      // One AVD name per Room, never per version: a Room keeps its AVD across a
      // version change rather than silently growing a second one.
      expect(plan.name).toBe(androidAvdName('r1'))
    }
  })

  it('refuses an Android version whose system image is not pinned', () => {
    // Every offered version is pinned now, so this is exercised through a
    // synthetic version — the branch still guards the next one added.
    withUnpinnedAndroidVersion(UNPINNED_TEST_VERSION, UNPINNED_TEST_API_LEVEL, () => {
      expect(() => androidAvdPlan('r1', { version: UNPINNED_TEST_VERSION })).toThrow(
        UnpinnedAndroidSystemImageError
      )
    })
  })
})
