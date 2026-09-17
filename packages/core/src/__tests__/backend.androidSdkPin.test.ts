import { describe, expect, it } from 'vitest'
import {
  ANDROID_API_LEVELS,
  ANDROID_SDK_ALLOWED_HOSTS,
  ANDROID_SDK_HOST,
  ANDROID_SDK_TOOLS,
  ANDROID_SYSTEM_IMAGES,
  UnknownAndroidVersionError,
  UnpinnedAndroidSystemImageError,
  androidApiLevel,
  androidSdkArtifacts,
  androidSdkDownloadBytes,
  assertAndroidSdkArtifactPinned,
  isAndroidSdkArtifactPinned,
  pinnedAndroidVersions,
  type AndroidSdkArtifact
} from '../backend/androidSdkPin'
import { ANDROID_EMULATOR_VERSIONS } from '@devhotel/shared'
import { EMULATOR_DEFAULT_VERSION } from '../backend/naming'
import {
  UNPINNED_TEST_API_LEVEL,
  UNPINNED_TEST_VERSION,
  withUnpinnedAndroidVersion
} from './androidPinTestSupport'

function artifact(overrides: Partial<AndroidSdkArtifact> = {}): AndroidSdkArtifact {
  return {
    id: 'android-test',
    sdkPackage: 'platform-tools',
    url: `https://${ANDROID_SDK_HOST}/android/repository/platform-tools_r37.0.1-linux.zip`,
    sizeBytes: 9054187,
    upstreamSha1: 'a'.repeat(40),
    sha256: 'b'.repeat(64),
    sha512: 'c'.repeat(128),
    extension: '.zip',
    ...overrides
  }
}

describe('pinned Android SDK provisioning set', () => {
  it('provisions the Room default version end to end', () => {
    const artifacts = androidSdkArtifacts(EMULATOR_DEFAULT_VERSION)
    // sdkmanager + adb + emulator + the guest Android itself. Anything less
    // cannot launch an emulator without falling back to a prebuilt image.
    expect(artifacts.map((a) => a.sdkPackage)).toEqual([
      'cmdline-tools;latest',
      'platform-tools',
      'emulator',
      'system-images;android-34;google_apis;x86_64'
    ])
    for (const a of artifacts) assertAndroidSdkArtifactPinned(a)
    expect(androidSdkDownloadBytes(EMULATOR_DEFAULT_VERSION)).toBe(
      artifacts.reduce((total, a) => total + a.sizeBytes, 0)
    )
  })

  it('binds every artifact to the one allowed origin', () => {
    expect([...ANDROID_SDK_ALLOWED_HOSTS]).toEqual([ANDROID_SDK_HOST])
    for (const a of [...ANDROID_SDK_TOOLS, ...Object.values(ANDROID_SYSTEM_IMAGES)]) {
      const url = new URL(a.url)
      expect(url.protocol).toBe('https:')
      expect(url.hostname).toBe(ANDROID_SDK_HOST)
      expect(url.port).toBe('')
      expect(a.extension).toBe('.zip')
      // Immutable, build-numbered filenames only. A "_latest" alias that is not
      // build-numbered would let the bytes move under a fixed digest.
      expect(url.pathname).toMatch(/\d{4,}|_r\d+/)
    }
  })

  it('tells an unknown version apart from a known one with no pinned image', () => {
    // Both are refusals, but only one of them is a DevHotel migration gap, and
    // the caller has to be able to say which to the user.
    expect(() => androidSdkArtifacts('9.9')).toThrow(UnknownAndroidVersionError)
    // No offered version can trigger the second refusal any more, so it is
    // exercised through a synthetic one — see androidPinTestSupport for why the
    // branch is kept rather than deleted with its last live caller.
    withUnpinnedAndroidVersion(UNPINNED_TEST_VERSION, UNPINNED_TEST_API_LEVEL, () => {
      expect(androidApiLevel(UNPINNED_TEST_VERSION)).toBe(UNPINNED_TEST_API_LEVEL)
      expect(() => androidSdkArtifacts(UNPINNED_TEST_VERSION)).toThrow(UnpinnedAndroidSystemImageError)
      try {
        androidSdkArtifacts(UNPINNED_TEST_VERSION)
      } catch (err) {
        expect(err).toBeInstanceOf(UnpinnedAndroidSystemImageError)
        expect((err as UnpinnedAndroidSystemImageError).apiLevel).toBe(UNPINNED_TEST_API_LEVEL)
      }
      // A version with no pinned image must not be advertised as runnable.
      expect(pinnedAndroidVersions()).not.toContain(UNPINNED_TEST_VERSION)
    })
  })

  it('pins a system image for every Android version the Stack tab offers', () => {
    // This is the #111 B1 claim in one assertion. While only API 34 was pinned,
    // a Room on 13.0/12.0/11.0 fell through to budtmo/docker-android, so
    // "Android without Docker" was true for one of the four offered versions.
    //
    // The offered list is read from the control schema rather than restated here,
    // so adding a version the UI can select without pinning its system image
    // fails this test instead of quietly reintroducing the docker-android path.
    expect(Object.keys(ANDROID_API_LEVELS)).toEqual([...ANDROID_EMULATOR_VERSIONS])
    expect(pinnedAndroidVersions()).toEqual([...ANDROID_EMULATOR_VERSIONS])
    expect(pinnedAndroidVersions()).toContain(EMULATOR_DEFAULT_VERSION)

    for (const [version, apiLevel] of Object.entries(ANDROID_API_LEVELS)) {
      const image = ANDROID_SYSTEM_IMAGES[apiLevel]
      expect(image, `Android ${version} (API ${apiLevel}) has no pinned system image`).toBeDefined()
      // The pin must name the level it is filed under: an image filed at the
      // wrong key boots a different Android than the Room asked for, and every
      // other assertion here would still pass.
      expect(image!.sdkPackage).toBe(`system-images;android-${apiLevel};google_apis;x86_64`)
      expect(image!.id).toBe(`android-system-image-${apiLevel}`)
      expect(image!.url).toContain(`x86_64-${apiLevel}_r`)
      // Every offered version resolves to a full, verifiable provisioning set.
      for (const a of androidSdkArtifacts(version)) assertAndroidSdkArtifactPinned(a)
    }
  })

  it('keeps each system image on its own bytes', () => {
    // Four entries copied from one another is the likeliest way this table goes
    // wrong, and a duplicated digest would make three versions provision the
    // fourth one's Android while every per-artifact check still passed.
    const images = Object.values(ANDROID_SYSTEM_IMAGES)
    expect(images.length).toBe(Object.keys(ANDROID_API_LEVELS).length)
    for (const field of ['url', 'sha256', 'sha512', 'upstreamSha1', 'sizeBytes'] as const) {
      expect(new Set(images.map((i) => i[field])).size, `system images share a ${field}`).toBe(images.length)
    }
  })

  it('refuses a pin that could only be verified by the upstream SHA-1', () => {
    // Google publishes sha1 and nothing stronger. An artifact whose DevHotel
    // digests were never captured must fail loudly rather than quietly verify
    // against the weaker upstream value.
    expect(isAndroidSdkArtifactPinned(artifact({ sha256: '', sha512: '' }))).toBe(false)
    expect(() => assertAndroidSdkArtifactPinned(artifact({ sha256: '' }))).toThrow(/pin:android-sdk/)
    expect(() => assertAndroidSdkArtifactPinned(artifact({ sha512: 'short' }))).toThrow(/pin:android-sdk/)
    expect(() => assertAndroidSdkArtifactPinned(artifact({ upstreamSha1: '' }))).toThrow(/provenance/)
  })

  it('refuses an origin, port or size that would widen the download', () => {
    expect(() => assertAndroidSdkArtifactPinned(artifact({ url: 'https://example.com/a.zip' }))).toThrow(/origin/)
    expect(() =>
      assertAndroidSdkArtifactPinned(artifact({ url: `http://${ANDROID_SDK_HOST}/a.zip` }))
    ).toThrow(/origin/)
    expect(() =>
      assertAndroidSdkArtifactPinned(artifact({ url: `https://${ANDROID_SDK_HOST}:8443/a.zip` }))
    ).toThrow(/origin/)
    expect(() =>
      assertAndroidSdkArtifactPinned(artifact({ url: `https://user:pw@${ANDROID_SDK_HOST}/a.zip` }))
    ).toThrow(/origin/)
    expect(() => assertAndroidSdkArtifactPinned(artifact({ sizeBytes: 0 }))).toThrow(/size/)
    expect(() => assertAndroidSdkArtifactPinned(artifact({ sizeBytes: 1.5 }))).toThrow(/size/)
  })

  it('keeps artifact ids distinct and shaped for the runtime artifact store', () => {
    const all = [...ANDROID_SDK_TOOLS, ...Object.values(ANDROID_SYSTEM_IMAGES)]
    expect(new Set(all.map((a) => a.id)).size).toBe(all.length)
    for (const a of all) {
      // Same identity rule downloadManagedRuntimeArtifact enforces, since these
      // land in the same store under `<id>-<sha256>.zip`.
      expect(a.id).toMatch(/^[a-z0-9][a-z0-9._-]{0,63}$/)
    }
  })
})
