import { createHash } from 'node:crypto'
import { open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ANDROID_API_LEVELS,
  ANDROID_SDK_TOOLS,
  ANDROID_SYSTEM_IMAGES,
  androidSdkArtifacts,
  isAndroidSdkArtifactPinned,
  pinnedAndroidVersions,
  type AndroidSdkArtifact
} from '../src/backend/androidSdkPin'

/**
 * Maintainer task, not a unit test: capture DevHotel's own digests for the
 * pinned Android SDK artifacts (#108).
 *
 * Google publishes `<checksum type="sha1">` and nothing stronger, so the pin in
 * `androidSdkPin.ts` has to carry SHA-256/SHA-512 this project measured itself.
 * This script is how those numbers are produced, so that the values in the diff
 * are reproducible by anyone reviewing them rather than pasted from a shell.
 *
 *   DEVHOTEL_PIN_ANDROID_SDK=1 pnpm --filter @devhotel/core pin:android-sdk
 *
 * It downloads ~6.8 GB — the three shared tools plus one system image per
 * offered Android version. Without the environment variable it only asserts that
 * the checked-in pin is internally consistent, which is what CI runs.
 */

const ENABLED = process.env.DEVHOTEL_PIN_ANDROID_SDK === '1'

interface Measured {
  id: string
  sizeBytes: number
  upstreamSha1: string
  sha256: string
  sha512: string
}

async function measure(artifact: AndroidSdkArtifact): Promise<Measured> {
  const response = await fetch(artifact.url, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`${artifact.id}: HTTP ${response.status}`)
  const sha1 = createHash('sha1')
  const sha256 = createHash('sha256')
  const sha512 = createHash('sha512')
  let sizeBytes = 0
  // Streamed to a scratch file rather than held in memory: the system image
  // alone is 1.5 GB.
  const scratch = path.join(tmpdir(), `devhotel-pin-${artifact.id}-${process.pid}.zip`)
  const handle = await open(scratch, 'w')
  try {
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      sizeBytes += value.byteLength
      sha1.update(value)
      sha256.update(value)
      sha512.update(value)
      await handle.write(value)
    }
  } finally {
    await handle.close()
    await rm(scratch, { force: true })
  }
  return {
    id: artifact.id,
    sizeBytes,
    upstreamSha1: sha1.digest('hex'),
    sha256: sha256.digest('hex'),
    sha512: sha512.digest('hex')
  }
}

describe('pinned Android SDK artifacts', () => {
  it('keeps the checked-in pin internally consistent', () => {
    const all = [...ANDROID_SDK_TOOLS, ...Object.values(ANDROID_SYSTEM_IMAGES)]
    expect(all.length).toBeGreaterThan(0)
    for (const artifact of all) {
      expect(artifact.url.startsWith('https://dl.google.com/android/repository/')).toBe(true)
      expect(artifact.upstreamSha1).toMatch(/^[a-f0-9]{40}$/)
      expect(Number.isSafeInteger(artifact.sizeBytes) && artifact.sizeBytes > 0).toBe(true)
    }
    // Every artifact every supported Room needs must be genuinely pinned. A pin
    // left blank is the failure this file exists to make loud, and checking only
    // the default version is how the other three stayed unpinned unnoticed.
    const versions = pinnedAndroidVersions()
    expect(versions).toEqual(Object.keys(ANDROID_API_LEVELS))
    for (const version of versions) {
      for (const artifact of androidSdkArtifacts(version)) {
        expect(
          isAndroidSdkArtifactPinned(artifact),
          `${artifact.id} (Android ${version}) has no DevHotel digest — run pin:android-sdk`
        ).toBe(true)
      }
    }
  })

  it.runIf(ENABLED)(
    're-measures every artifact against the checked-in pin',
    async () => {
      const all = [...ANDROID_SDK_TOOLS, ...Object.values(ANDROID_SYSTEM_IMAGES)]
      const measured: Measured[] = []
      for (const artifact of all) measured.push(await measure(artifact))
      // Printed so a maintainer can paste verified values into androidSdkPin.ts
      // when adding an artifact or moving a version.
      console.log(`ANDROID_SDK_PIN ${JSON.stringify(measured, null, 2)}`)
      for (const artifact of all) {
        const got = measured.find((m) => m.id === artifact.id)
        expect(got, artifact.id).toBeDefined()
        expect(got!.sizeBytes, `${artifact.id} size`).toBe(artifact.sizeBytes)
        expect(got!.upstreamSha1, `${artifact.id} upstream sha1`).toBe(artifact.upstreamSha1)
        if (!isAndroidSdkArtifactPinned(artifact)) continue
        expect(got!.sha256, `${artifact.id} sha256`).toBe(artifact.sha256)
        expect(got!.sha512, `${artifact.id} sha512`).toBe(artifact.sha512)
      }
    },
    45 * 60_000
  )
})
