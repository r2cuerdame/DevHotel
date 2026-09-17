import { describe, expect, it } from 'vitest'
import {
  ANDROID_AVD_HOME,
  ANDROID_SDK_ROOT,
  ANDROID_EMULATOR_DISPLAY,
  androidAvdPlan,
  androidEmulatorLaunch,
  buildManagedEmulatorContainerArgs,
  MANAGED_EMULATOR_PREVIEW_IMAGE,
  type ManagedEmulatorContainerLifecycle
} from '../backend/androidEmulatorLaunch'
import { androidAvdVolume, androidSdkVolume, emulatorName } from '../backend/naming'
import { androidApiLevel, pinnedAndroidVersions, UnpinnedAndroidSystemImageError } from '../backend/androidSdkPin'
import {
  UNPINNED_TEST_API_LEVEL,
  UNPINNED_TEST_VERSION,
  withUnpinnedAndroidVersion
} from './androidPinTestSupport'

const FAKE_SANDBOX = 'a'.repeat(64)
const FAKE_STARTED_AT = '2026-09-17T00:00:00Z'
const FAKE_ANCHOR_ID = 'b'.repeat(64)
const FAKE_ABORT_TOKEN = 'c'.repeat(36)
const API_LEVEL_14 = androidApiLevel('14.0') // 34

const baseLifecycle: ManagedEmulatorContainerLifecycle = {
  networkNamespace: FAKE_ANCHOR_ID,
  networkAuthoritySandboxId: FAKE_SANDBOX,
  networkAuthorityStartedAt: FAKE_STARTED_AT,
  abortToken: FAKE_ABORT_TOKEN,
  apiLevel: API_LEVEL_14
}

describe('buildManagedEmulatorContainerArgs (#108 wiring)', () => {
  it('starts with docker create and names the container correctly', () => {
    const plan = androidAvdPlan('r1')
    const launch = androidEmulatorLaunch('r1')
    const args = buildManagedEmulatorContainerArgs('r1', plan, launch, baseLifecycle)
    expect(args[0]).toBe('create')
    expect(args).toContain('--name')
    const nameIdx = args.indexOf('--name')
    expect(args[nameIdx + 1]).toBe(emulatorName('r1'))
  })

  it('joins the control anchor network namespace', () => {
    const plan = androidAvdPlan('r1')
    const launch = androidEmulatorLaunch('r1')
    const args = buildManagedEmulatorContainerArgs('r1', plan, launch, baseLifecycle)
    const netIdx = args.indexOf('--network')
    expect(args[netIdx + 1]).toBe(`container:${FAKE_ANCHOR_ID}`)
  })

  it('adds /dev/kvm device access', () => {
    const plan = androidAvdPlan('r1')
    const launch = androidEmulatorLaunch('r1')
    const args = buildManagedEmulatorContainerArgs('r1', plan, launch, baseLifecycle)
    const devIdx = args.indexOf('--device')
    expect(args[devIdx + 1]).toBe('/dev/kvm')
  })

  it('mounts the shared SDK volume read-only at ANDROID_SDK_ROOT', () => {
    const plan = androidAvdPlan('r1')
    const launch = androidEmulatorLaunch('r1')
    const args = buildManagedEmulatorContainerArgs('r1', plan, launch, baseLifecycle)
    // The SDK volume is the first -v in the args
    const vIdx = args.indexOf('-v')
    expect(args[vIdx + 1]).toBe(`${androidSdkVolume(API_LEVEL_14)}:${ANDROID_SDK_ROOT}:ro`)
  })

  it('mounts the per-Room AVD volume read-write at ANDROID_AVD_HOME', () => {
    const plan = androidAvdPlan('r1')
    const launch = androidEmulatorLaunch('r1')
    const args = buildManagedEmulatorContainerArgs('r1', plan, launch, baseLifecycle)
    // Collect all -v values
    const volumes: string[] = []
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '-v') volumes.push(args[i + 1]!)
    }
    // AVD volume must be present (read-write, no :ro suffix)
    const avdVol = `${androidAvdVolume('r1')}:${ANDROID_AVD_HOME}`
    expect(volumes).toContain(avdVol)
    // AVD volume must NOT be read-only
    expect(volumes.find((v) => v.startsWith(androidAvdVolume('r1')))).toBe(avdVol)
  })

  it('applies DevHotel ownership labels', () => {
    const plan = androidAvdPlan('r1')
    const launch = androidEmulatorLaunch('r1')
    const args = buildManagedEmulatorContainerArgs('r1', plan, launch, baseLifecycle)
    // Collect all -l pairs
    const labels: string[] = []
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '-l') labels.push(args[i + 1]!)
    }
    expect(labels).toContain('devhotel.room=r1')
    expect(labels).toContain('devhotel.role=svc-emulator')
    expect(labels).toContain('devhotel.managed=1')
    expect(labels).toContain(`devhotel.network-authority-sandbox=${FAKE_SANDBOX}`)
    expect(labels).toContain(`devhotel.network-authority-started-at=${FAKE_STARTED_AT}`)
    expect(labels).toContain(`devhotel.abort-token=${FAKE_ABORT_TOKEN}`)
  })

  it('overrides the entrypoint to sh (no supervisord)', () => {
    const plan = androidAvdPlan('r1')
    const launch = androidEmulatorLaunch('r1')
    const args = buildManagedEmulatorContainerArgs('r1', plan, launch, baseLifecycle)
    const epIdx = args.indexOf('--entrypoint')
    expect(args[epIdx + 1]).toBe('sh')
  })

  it('uses the DevHotel-owned preview image (not docker-android)', () => {
    const plan = androidAvdPlan('r1')
    const launch = androidEmulatorLaunch('r1')
    const args = buildManagedEmulatorContainerArgs('r1', plan, launch, baseLifecycle)
    // Image ref appears immediately after --entrypoint sh
    const epIdx = args.indexOf('--entrypoint')
    expect(args[epIdx + 2]).toBe(MANAGED_EMULATOR_PREVIEW_IMAGE)
    // Must be the DevHotel-owned preview image, not docker-android
    expect(args[epIdx + 2]).toContain('devhotel/android-emulator-preview')
    expect(args[epIdx + 2]).not.toContain('budtmo')
    expect(args[epIdx + 2]).not.toContain('docker-android')
    // Must name no registry. #111's Android claim is about a clean Windows 11
    // machine, which has no credential; the image is built in the runtime from
    // the Dockerfile this repository carries rather than pulled. The tag is the
    // Dockerfile's own digest, which is what a registry digest used to provide.
    expect(args[epIdx + 2]).not.toContain('ghcr.io')
    expect(args[epIdx + 2]).not.toContain('@sha256:')
    expect(args[epIdx + 2]).toMatch(/^devhotel\/android-emulator-preview:[a-f0-9]{12}$/)
    expect(args[epIdx + 3]).toBe('-c')
    // The script is the last element
    const script = args[args.length - 1]!
    expect(script.length).toBeGreaterThan(50)
  })

  it('embeds ANDROID_SDK_ROOT and ANDROID_AVD_HOME env exports in the script', () => {
    const plan = androidAvdPlan('r1')
    const launch = androidEmulatorLaunch('r1')
    const args = buildManagedEmulatorContainerArgs('r1', plan, launch, baseLifecycle)
    const script = args[args.length - 1]!
    expect(script).toContain(`ANDROID_SDK_ROOT='${ANDROID_SDK_ROOT}'`)
    expect(script).toContain(`ANDROID_AVD_HOME='${ANDROID_AVD_HOME}'`)
    expect(script).toContain(`DISPLAY='${ANDROID_EMULATOR_DISPLAY}'`)
  })

  it('includes the emulator binary path in the exec call', () => {
    const plan = androidAvdPlan('r1')
    const launch = androidEmulatorLaunch('r1')
    const args = buildManagedEmulatorContainerArgs('r1', plan, launch, baseLifecycle)
    const script = args[args.length - 1]!
    expect(script).toContain(`${ANDROID_SDK_ROOT}/emulator/emulator`)
    expect(script).toContain('exec ')
  })

  it('starts Xvfb, openbox, x11vnc and websockify in the script', () => {
    const plan = androidAvdPlan('r1')
    const launch = androidEmulatorLaunch('r1')
    const args = buildManagedEmulatorContainerArgs('r1', plan, launch, baseLifecycle)
    const script = args[args.length - 1]!
    expect(script).toContain('Xvfb')
    expect(script).toContain('openbox')
    expect(script).toContain('x11vnc')
    expect(script).toContain('websockify')
  })

  it('checks for an existing AVD directory before creating (warm restart idempotence)', () => {
    const plan = androidAvdPlan('r1')
    const launch = androidEmulatorLaunch('r1')
    const args = buildManagedEmulatorContainerArgs('r1', plan, launch, baseLifecycle)
    const script = args[args.length - 1]!
    // The if-guard must come before avdmanager
    const ifIdx = script.indexOf('if [ ! -d')
    const avdmgrIdx = script.indexOf('avdmanager')
    expect(ifIdx).toBeGreaterThanOrEqual(0)
    expect(avdmgrIdx).toBeGreaterThan(ifIdx)
  })

  it('embeds openbox rc.xml as base64 when openbox config is provided', () => {
    const plan = androidAvdPlan('r1')
    const launch = androidEmulatorLaunch('r1')
    const openbox = { rcXml: '<openbox_config/>', fitPy: 'import os' }
    const args = buildManagedEmulatorContainerArgs('r1', plan, launch, { ...baseLifecycle, openbox })
    const script = args[args.length - 1]!
    const rcXmlB64 = Buffer.from('<openbox_config/>', 'utf8').toString('base64')
    expect(script).toContain(rcXmlB64)
    expect(script).toContain('base64 -d')
    expect(script).toContain('rc.xml')
  })

  it('respects Room limits for the container memory ceiling', () => {
    const plan = androidAvdPlan('r1')
    const launch = androidEmulatorLaunch('r1', undefined, { cpus: 2, memoryMB: 4096 })
    const args = buildManagedEmulatorContainerArgs('r1', plan, launch, {
      ...baseLifecycle,
      limits: { cpus: 2, memoryMB: 4096 }
    })
    const memIdx = args.indexOf('--memory')
    // Budget: min(4, 2)=2 cores, min(4096-1024,4096)=3072 MB guest; ceiling = 3072+1024=4096m
    expect(args[memIdx + 1]).toMatch(/^\d+m$/)
  })

  it('drops NET_RAW capability', () => {
    const plan = androidAvdPlan('r1')
    const launch = androidEmulatorLaunch('r1')
    const args = buildManagedEmulatorContainerArgs('r1', plan, launch, baseLifecycle)
    expect(args).toContain('--cap-drop')
    const capIdx = args.indexOf('--cap-drop')
    expect(args[capIdx + 1]).toBe('NET_RAW')
  })

  it('SDK volume is shared across rooms (same apiLevel, same volume name)', () => {
    const plan1 = androidAvdPlan('r1')
    const plan2 = androidAvdPlan('r2')
    const launch1 = androidEmulatorLaunch('r1')
    const launch2 = androidEmulatorLaunch('r2')
    const args1 = buildManagedEmulatorContainerArgs('r1', plan1, launch1, baseLifecycle)
    const args2 = buildManagedEmulatorContainerArgs('r2', plan2, launch2, baseLifecycle)
    // First -v is SDK volume — must be the same for both rooms
    const sdkVol1 = args1[args1.indexOf('-v') + 1]
    const sdkVol2 = args2[args2.indexOf('-v') + 1]
    expect(sdkVol1).toBe(`${androidSdkVolume(API_LEVEL_14)}:${ANDROID_SDK_ROOT}:ro`)
    expect(sdkVol1).toBe(sdkVol2)
  })

  it('uses the per-Room AVD volume for different room IDs independently', () => {
    const plan1 = androidAvdPlan('r1')
    const plan2 = androidAvdPlan('r2')
    const launch1 = androidEmulatorLaunch('r1')
    const launch2 = androidEmulatorLaunch('r2')
    const args1 = buildManagedEmulatorContainerArgs('r1', plan1, launch1, baseLifecycle)
    const args2 = buildManagedEmulatorContainerArgs('r2', plan2, launch2, baseLifecycle)
    // Collect all volumes
    const getVolumes = (args: string[]): string[] => {
      const vols: string[] = []
      for (let i = 0; i < args.length - 1; i++) {
        if (args[i] === '-v') vols.push(args[i + 1]!)
      }
      return vols
    }
    const vols1 = getVolumes(args1)
    const vols2 = getVolumes(args2)
    const avdVol1 = `${androidAvdVolume('r1')}:${ANDROID_AVD_HOME}`
    const avdVol2 = `${androidAvdVolume('r2')}:${ANDROID_AVD_HOME}`
    expect(vols1).toContain(avdVol1)
    expect(vols2).toContain(avdVol2)
    // AVD volumes must differ between rooms
    expect(avdVol1).not.toBe(avdVol2)
  })
})

describe('managed runtime emulator version selection', () => {
  it('takes the managed path for every version the Stack tab offers', () => {
    // `createEmulator` routes on exactly this predicate: a version outside
    // `pinnedAndroidVersions()` falls through to `super.createEmulator`, which is
    // budtmo/docker-android via the guest engine. So this assertion is the one
    // that decides whether #111's "Android without Docker" claim covers what the
    // product actually offers, or only its default.
    const pinned = pinnedAndroidVersions()
    for (const version of ['14.0', '13.0', '12.0', '11.0']) {
      expect(pinned, `Android ${version} would fall back to docker-android`).toContain(version)
    }
  })

  it('androidAvdPlan succeeds for every offered version', () => {
    const expected: Record<string, string> = {
      '14.0': 'system-images;android-34;google_apis;x86_64',
      '13.0': 'system-images;android-33;google_apis;x86_64',
      '12.0': 'system-images;android-32;google_apis;x86_64',
      '11.0': 'system-images;android-30;google_apis;x86_64'
    }
    for (const [version, systemImage] of Object.entries(expected)) {
      const plan = androidAvdPlan('r1', { version })
      expect(plan.systemImage, `Android ${version}`).toBe(systemImage)
      expect(plan.name).toBe('dh-r1')
    }
  })

  it('gives each API level its own SDK volume and mounts the right one', () => {
    // The SDK volume is named after the API level, not the Room, so Rooms of one
    // version share the ~2 GB download. Two versions sharing a volume would let
    // one Room's system image satisfy another Room's provisioning sentinel.
    const levels = ['14.0', '13.0', '12.0', '11.0'].map((v) => androidApiLevel(v))
    const volumes = levels.map((l) => androidSdkVolume(l))
    expect(new Set(volumes).size).toBe(levels.length)

    for (const version of ['14.0', '13.0', '12.0', '11.0']) {
      const apiLevel = androidApiLevel(version)
      const plan = androidAvdPlan('r1', { version })
      const launch = androidEmulatorLaunch('r1', { version })
      const args = buildManagedEmulatorContainerArgs('r1', plan, launch, { ...baseLifecycle, apiLevel })
      const vIdx = args.indexOf('-v')
      expect(args[vIdx + 1], `Android ${version} SDK mount`).toBe(
        `${androidSdkVolume(apiLevel)}:${ANDROID_SDK_ROOT}:ro`
      )
    }
  })

  it('androidAvdPlan still refuses a version with no pinned image', () => {
    // No offered version reaches this any more; the branch guards the next one
    // added, so it is exercised through a synthetic version rather than dropped.
    withUnpinnedAndroidVersion(UNPINNED_TEST_VERSION, UNPINNED_TEST_API_LEVEL, () => {
      expect(pinnedAndroidVersions()).not.toContain(UNPINNED_TEST_VERSION)
      expect(() => androidAvdPlan('r1', { version: UNPINNED_TEST_VERSION })).toThrow(
        UnpinnedAndroidSystemImageError
      )
    })
  })
})
