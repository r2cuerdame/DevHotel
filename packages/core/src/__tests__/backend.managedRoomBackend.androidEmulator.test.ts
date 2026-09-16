import { describe, expect, it } from 'vitest'
import {
  ANDROID_AVD_HOME,
  ANDROID_SDK_ROOT,
  ANDROID_EMULATOR_DISPLAY,
  androidAvdPlan,
  androidEmulatorLaunch,
  buildManagedEmulatorContainerArgs,
  type ManagedEmulatorContainerLifecycle
} from '../backend/androidEmulatorLaunch'
import { androidAvdVolume, emulatorName, EMULATOR_DEFAULT_VERSION, emulatorImage } from '../backend/naming'
import { pinnedAndroidVersions, UnpinnedAndroidSystemImageError } from '../backend/androidSdkPin'

const FAKE_SANDBOX = 'a'.repeat(64)
const FAKE_STARTED_AT = '2026-09-17T00:00:00Z'
const FAKE_ANCHOR_ID = 'b'.repeat(64)
const FAKE_ABORT_TOKEN = 'c'.repeat(36)

const baseLifecycle: ManagedEmulatorContainerLifecycle = {
  networkNamespace: FAKE_ANCHOR_ID,
  networkAuthoritySandboxId: FAKE_SANDBOX,
  networkAuthorityStartedAt: FAKE_STARTED_AT,
  abortToken: FAKE_ABORT_TOKEN
}

const IMAGE_REF = emulatorImage(EMULATOR_DEFAULT_VERSION)

describe('buildManagedEmulatorContainerArgs (#108 wiring)', () => {
  it('starts with docker create and names the container correctly', () => {
    const plan = androidAvdPlan('r1')
    const launch = androidEmulatorLaunch('r1')
    const args = buildManagedEmulatorContainerArgs('r1', plan, launch, baseLifecycle, IMAGE_REF)
    expect(args[0]).toBe('create')
    expect(args).toContain('--name')
    const nameIdx = args.indexOf('--name')
    expect(args[nameIdx + 1]).toBe(emulatorName('r1'))
  })

  it('joins the control anchor network namespace', () => {
    const plan = androidAvdPlan('r1')
    const launch = androidEmulatorLaunch('r1')
    const args = buildManagedEmulatorContainerArgs('r1', plan, launch, baseLifecycle, IMAGE_REF)
    const netIdx = args.indexOf('--network')
    expect(args[netIdx + 1]).toBe(`container:${FAKE_ANCHOR_ID}`)
  })

  it('adds /dev/kvm device access', () => {
    const plan = androidAvdPlan('r1')
    const launch = androidEmulatorLaunch('r1')
    const args = buildManagedEmulatorContainerArgs('r1', plan, launch, baseLifecycle, IMAGE_REF)
    const devIdx = args.indexOf('--device')
    expect(args[devIdx + 1]).toBe('/dev/kvm')
  })

  it('mounts the per-Room AVD volume at ANDROID_AVD_HOME', () => {
    const plan = androidAvdPlan('r1')
    const launch = androidEmulatorLaunch('r1')
    const args = buildManagedEmulatorContainerArgs('r1', plan, launch, baseLifecycle, IMAGE_REF)
    const vIdx = args.indexOf('-v')
    expect(args[vIdx + 1]).toBe(`${androidAvdVolume('r1')}:${ANDROID_AVD_HOME}`)
  })

  it('applies DevHotel ownership labels', () => {
    const plan = androidAvdPlan('r1')
    const launch = androidEmulatorLaunch('r1')
    const args = buildManagedEmulatorContainerArgs('r1', plan, launch, baseLifecycle, IMAGE_REF)
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

  it('overrides the entrypoint to sh so docker-android supervisord never runs', () => {
    const plan = androidAvdPlan('r1')
    const launch = androidEmulatorLaunch('r1')
    const args = buildManagedEmulatorContainerArgs('r1', plan, launch, baseLifecycle, IMAGE_REF)
    const epIdx = args.indexOf('--entrypoint')
    expect(args[epIdx + 1]).toBe('sh')
  })

  it('uses the docker-android image as the base and passes the script as -c', () => {
    const plan = androidAvdPlan('r1')
    const launch = androidEmulatorLaunch('r1')
    const args = buildManagedEmulatorContainerArgs('r1', plan, launch, baseLifecycle, IMAGE_REF)
    // image ref appears immediately after --entrypoint sh
    const epIdx = args.indexOf('--entrypoint')
    expect(args[epIdx + 2]).toBe(IMAGE_REF)
    expect(args[epIdx + 3]).toBe('-c')
    // The script is the last element
    const script = args[args.length - 1]!
    expect(script.length).toBeGreaterThan(50)
  })

  it('embeds ANDROID_SDK_ROOT and ANDROID_AVD_HOME env exports in the script', () => {
    const plan = androidAvdPlan('r1')
    const launch = androidEmulatorLaunch('r1')
    const args = buildManagedEmulatorContainerArgs('r1', plan, launch, baseLifecycle, IMAGE_REF)
    const script = args[args.length - 1]!
    expect(script).toContain(`ANDROID_SDK_ROOT='${ANDROID_SDK_ROOT}'`)
    expect(script).toContain(`ANDROID_AVD_HOME='${ANDROID_AVD_HOME}'`)
    expect(script).toContain(`DISPLAY='${ANDROID_EMULATOR_DISPLAY}'`)
  })

  it('includes the emulator binary path in the exec call', () => {
    const plan = androidAvdPlan('r1')
    const launch = androidEmulatorLaunch('r1')
    const args = buildManagedEmulatorContainerArgs('r1', plan, launch, baseLifecycle, IMAGE_REF)
    const script = args[args.length - 1]!
    expect(script).toContain(`${ANDROID_SDK_ROOT}/emulator/emulator`)
    expect(script).toContain('exec ')
  })

  it('starts Xvfb, openbox, x11vnc and websockify in the script', () => {
    const plan = androidAvdPlan('r1')
    const launch = androidEmulatorLaunch('r1')
    const args = buildManagedEmulatorContainerArgs('r1', plan, launch, baseLifecycle, IMAGE_REF)
    const script = args[args.length - 1]!
    expect(script).toContain('Xvfb')
    expect(script).toContain('openbox')
    expect(script).toContain('x11vnc')
    expect(script).toContain('websockify')
  })

  it('checks for an existing AVD directory before creating (warm restart idempotence)', () => {
    const plan = androidAvdPlan('r1')
    const launch = androidEmulatorLaunch('r1')
    const args = buildManagedEmulatorContainerArgs('r1', plan, launch, baseLifecycle, IMAGE_REF)
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
    const args = buildManagedEmulatorContainerArgs('r1', plan, launch, { ...baseLifecycle, openbox }, IMAGE_REF)
    const script = args[args.length - 1]!
    const rcXmlB64 = Buffer.from('<openbox_config/>', 'utf8').toString('base64')
    expect(script).toContain(rcXmlB64)
    expect(script).toContain('base64 -d')
    expect(script).toContain('rc.xml')
  })

  it('respects Room limits for the container memory ceiling', () => {
    const plan = androidAvdPlan('r1')
    const launch = androidEmulatorLaunch('r1', undefined, { cpus: 2, memoryMB: 4096 })
    const args = buildManagedEmulatorContainerArgs('r1', plan, launch, { ...baseLifecycle, limits: { cpus: 2, memoryMB: 4096 } }, IMAGE_REF)
    const memIdx = args.indexOf('--memory')
    // Budget: min(4, 2)=2 cores, min(4096-1024,4096)=3072 MB guest; ceiling = 3072+1024=4096m
    expect(args[memIdx + 1]).toMatch(/^\d+m$/)
  })

  it('drops NET_RAW capability', () => {
    const plan = androidAvdPlan('r1')
    const launch = androidEmulatorLaunch('r1')
    const args = buildManagedEmulatorContainerArgs('r1', plan, launch, baseLifecycle, IMAGE_REF)
    expect(args).toContain('--cap-drop')
    const capIdx = args.indexOf('--cap-drop')
    expect(args[capIdx + 1]).toBe('NET_RAW')
  })

  it('uses the per-Room AVD volume for different room IDs independently', () => {
    const plan1 = androidAvdPlan('r1')
    const plan2 = androidAvdPlan('r2')
    const launch1 = androidEmulatorLaunch('r1')
    const launch2 = androidEmulatorLaunch('r2')
    const args1 = buildManagedEmulatorContainerArgs('r1', plan1, launch1, baseLifecycle, IMAGE_REF)
    const args2 = buildManagedEmulatorContainerArgs('r2', plan2, launch2, baseLifecycle, IMAGE_REF)
    const vIdx1 = args1.indexOf('-v')
    const vIdx2 = args2.indexOf('-v')
    expect(args1[vIdx1 + 1]).toBe(`${androidAvdVolume('r1')}:${ANDROID_AVD_HOME}`)
    expect(args2[vIdx2 + 1]).toBe(`${androidAvdVolume('r2')}:${ANDROID_AVD_HOME}`)
    // Volumes must differ between rooms
    expect(args1[vIdx1 + 1]).not.toBe(args2[vIdx2 + 1])
  })
})

describe('managed runtime emulator version selection', () => {
  it('pinnedAndroidVersions includes 14.0 (Android 14)', () => {
    // This is the only version with a pinned system image today (#108).
    expect(pinnedAndroidVersions()).toContain('14.0')
  })

  it('androidAvdPlan throws UnpinnedAndroidSystemImageError for 13.0', () => {
    // 13.0 is offered in the Stack tab but its system image is not yet pinned.
    // The managed path must produce a named error so the fallback can route to
    // docker-android rather than crashing the Room.
    expect(() => androidAvdPlan('r1', { version: '13.0' })).toThrow(UnpinnedAndroidSystemImageError)
  })

  it('androidAvdPlan succeeds for 14.0 (the one pinned version)', () => {
    const plan = androidAvdPlan('r1', { version: '14.0' })
    expect(plan.systemImage).toBe('system-images;android-34;google_apis;x86_64')
    expect(plan.name).toBe('dh-r1')
  })
})
