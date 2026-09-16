import { describe, expect, it } from 'vitest'
import {
  buildAndroidSdkProvisionScript,
  buildAndroidSdkProvisionArgs,
  ANDROID_SDK_TOOLS,
  ANDROID_SYSTEM_IMAGES,
  UnpinnedAndroidSystemImageError
} from '../backend/androidSdkPin'
import { androidSdkVolume } from '../backend/naming'
import { MANAGED_EMULATOR_PREVIEW_IMAGE } from '../backend/androidEmulatorLaunch'

const SDK_ROOT = '/opt/devhotel/android-sdk'
const VERSION = '14.0'
const API_LEVEL = 34

describe('buildAndroidSdkProvisionScript (#108 sdk-less managed path)', () => {
  it('generates a POSIX sh script starting with set -eu', () => {
    const script = buildAndroidSdkProvisionScript(VERSION, SDK_ROOT)
    expect(script.startsWith('set -eu')).toBe(true)
  })

  it('includes idempotent sentinel check to skip re-provisioning', () => {
    const script = buildAndroidSdkProvisionScript(VERSION, SDK_ROOT)
    expect(script).toContain('.devhotel-provisioned')
    expect(script).toContain('if [ -f ')
    expect(script).toContain('already provisioned, skipping')
  })

  it('downloads each SDK artifact via curl with sha256sum verification', () => {
    const script = buildAndroidSdkProvisionScript(VERSION, SDK_ROOT)
    // Each download step must include curl and sha256sum
    expect(script).toContain('curl ')
    expect(script).toContain('sha256sum')
    // Must use --fail to abort on HTTP errors
    expect(script).toContain('--fail')
    // Must use --location to follow redirects
    expect(script).toContain('--location')
  })

  it('downloads cmdline-tools from the pinned URL', () => {
    const script = buildAndroidSdkProvisionScript(VERSION, SDK_ROOT)
    expect(script).toContain(ANDROID_SDK_TOOLS[0]!.url)
    expect(script).toContain(ANDROID_SDK_TOOLS[0]!.sha256)
  })

  it('downloads platform-tools from the pinned URL', () => {
    const script = buildAndroidSdkProvisionScript(VERSION, SDK_ROOT)
    expect(script).toContain(ANDROID_SDK_TOOLS[1]!.url)
    expect(script).toContain(ANDROID_SDK_TOOLS[1]!.sha256)
  })

  it('downloads the emulator binary from the pinned URL', () => {
    const script = buildAndroidSdkProvisionScript(VERSION, SDK_ROOT)
    expect(script).toContain(ANDROID_SDK_TOOLS[2]!.url)
    expect(script).toContain(ANDROID_SDK_TOOLS[2]!.sha256)
  })

  it('downloads the system image for the correct API level', () => {
    const script = buildAndroidSdkProvisionScript(VERSION, SDK_ROOT)
    const sysImage = ANDROID_SYSTEM_IMAGES[API_LEVEL]!
    expect(script).toContain(sysImage.url)
    expect(script).toContain(sysImage.sha256)
  })

  it('creates the SDK layout that cmdline-tools/avdmanager expects', () => {
    const script = buildAndroidSdkProvisionScript(VERSION, SDK_ROOT)
    // cmdline-tools must end up at cmdline-tools/latest/
    expect(script).toContain(`${SDK_ROOT}/cmdline-tools`)
    expect(script).toContain('latest')
    // system-images directory
    expect(script).toContain(`system-images/android-${API_LEVEL}/google_apis`)
  })

  it('throws UnpinnedAndroidSystemImageError for unpinned versions', () => {
    expect(() => buildAndroidSdkProvisionScript('13.0', SDK_ROOT)).toThrow(UnpinnedAndroidSystemImageError)
  })

  it('writes a sentinel file after successful provisioning', () => {
    const script = buildAndroidSdkProvisionScript(VERSION, SDK_ROOT)
    // Sentinel is written at the end
    const sentinelWriteIdx = script.lastIndexOf('.devhotel-provisioned')
    const sentinelCheckIdx = script.indexOf('.devhotel-provisioned')
    // Should appear twice: once in the check, once in the write
    expect(sentinelWriteIdx).toBeGreaterThan(sentinelCheckIdx)
    expect(script).toContain(`echo '${VERSION}' >`)
  })

  it('extracts artifacts and cleans up temp files', () => {
    const script = buildAndroidSdkProvisionScript(VERSION, SDK_ROOT)
    expect(script).toContain('unzip')
    expect(script).toContain('rm -f')
    expect(script).toContain('/tmp/dh-sdk-')
  })
})

describe('buildAndroidSdkProvisionArgs (#108 sdk-less managed path)', () => {
  const opts = {
    version: VERSION,
    sdkRoot: SDK_ROOT,
    sdkVolumeName: androidSdkVolume(API_LEVEL),
    imageRef: MANAGED_EMULATOR_PREVIEW_IMAGE,
    roomId: 'r1'
  }

  it('generates docker run --rm args', () => {
    const args = buildAndroidSdkProvisionArgs(opts)
    expect(args[0]).toBe('run')
    expect(args).toContain('--rm')
  })

  it('mounts the SDK volume read-write for provisioning', () => {
    const args = buildAndroidSdkProvisionArgs(opts)
    const vIdx = args.indexOf('-v')
    expect(args[vIdx + 1]).toBe(`${androidSdkVolume(API_LEVEL)}:${SDK_ROOT}`)
    // Must NOT be :ro — provisioner needs write access
    expect(args[vIdx + 1]).not.toContain(':ro')
  })

  it('uses the DevHotel preview image (not docker-android)', () => {
    const args = buildAndroidSdkProvisionArgs(opts)
    expect(args).toContain(MANAGED_EMULATOR_PREVIEW_IMAGE)
    expect(args).not.toContain('budtmo')
    expect(args).not.toContain('docker-android')
  })

  it('overrides entrypoint to sh and passes script as -c', () => {
    const args = buildAndroidSdkProvisionArgs(opts)
    const epIdx = args.indexOf('--entrypoint')
    expect(args[epIdx + 1]).toBe('sh')
    const imageIdx = args.indexOf(MANAGED_EMULATOR_PREVIEW_IMAGE)
    expect(args[imageIdx + 1]).toBe('-c')
    // Script is last arg
    const script = args[args.length - 1]!
    expect(script).toContain('set -eu')
    expect(script).toContain('.devhotel-provisioned')
  })

  it('applies DevHotel labels for diagnostics', () => {
    const args = buildAndroidSdkProvisionArgs(opts)
    const labels: string[] = []
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '-l') labels.push(args[i + 1]!)
    }
    expect(labels).toContain('devhotel.room=r1')
    expect(labels).toContain('devhotel.role=sdk-provision')
    expect(labels).toContain('devhotel.managed=1')
  })

  it('uses the bridge network (internet access for dl.google.com)', () => {
    const args = buildAndroidSdkProvisionArgs(opts)
    const netIdx = args.indexOf('--network')
    expect(args[netIdx + 1]).toBe('bridge')
  })
})
