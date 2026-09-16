import type { ManagedRuntimeRemoteArtifact } from './managedRuntimeArtifact'

/**
 * The Android SDK components a managed Android Room provisions for itself
 * (#108), replacing what `budtmo/docker-android` bakes into its image.
 *
 * Design: docs/superpowers/specs/2026-09-17-android-room-managed-runtime-design.md
 *
 * ## Why the pin carries its own digests
 *
 * Google's package manifests — `repository2-3.xml` and the `sys-img` indexes —
 * publish `<checksum type="sha1">` and nothing else; the string `sha256` does
 * not appear in them. SHA-1 is not an integrity proof this project accepts on
 * its own, so the pin is two-step, exactly as the Alpine ISO is handled:
 *
 * 1. at pin time, `pin:android-sdk` downloads each artifact, confirms the byte
 *    length and the upstream SHA-1, and records DevHotel's own SHA-256 and
 *    SHA-512 here, where they are reviewable in the diff;
 * 2. at provision time, `downloadAndroidSdkArtifact` verifies only DevHotel's
 *    recorded digests. `upstreamSha1` is provenance, never the runtime gate.
 *
 * `sdkPackage` is the `sdkmanager` coordinate the same bytes carry, kept so an
 * installed SDK can be reconciled against what was pinned.
 */
export interface AndroidSdkArtifact extends ManagedRuntimeRemoteArtifact {
  extension: '.zip'
  /** `sdkmanager` package path these bytes install, e.g. `platform-tools`. */
  sdkPackage: string
  /** Upstream provenance only — recorded, compared at pin time, never trusted at provision time. */
  upstreamSha1: string
}

/** The single origin every Android SDK artifact may come from. */
export const ANDROID_SDK_HOST = 'dl.google.com'
export const ANDROID_SDK_ALLOWED_HOSTS: ReadonlySet<string> = new Set([ANDROID_SDK_HOST])

const BASE = `https://${ANDROID_SDK_HOST}/android/repository/`

/**
 * Android platform API level per the emulator version the Stack tab offers.
 *
 * All four appear here because all four are selectable today; only the ones
 * with a pinned system image below can run on the managed path, and
 * `androidSdkArtifacts` distinguishes the two cases rather than collapsing them
 * into one "unsupported". docker-android carries images for all of them, which
 * is why it stays the default until this table and `ANDROID_SYSTEM_IMAGES`
 * agree — see the migration order in the design doc.
 */
export const ANDROID_API_LEVELS: Readonly<Record<string, number>> = {
  '14.0': 34,
  '13.0': 33,
  '12.0': 32,
  '11.0': 30
}

/**
 * Host-independent SDK tooling, shared by every managed Android Room.
 *
 * `cmdline-tools` carries `sdkmanager`/`avdmanager`, `platform-tools` carries
 * `adb`, and `emulator` is the emulator binary itself. docker-android supplies
 * all three from its image today.
 */
export const ANDROID_SDK_TOOLS: readonly AndroidSdkArtifact[] = [
  {
    id: 'android-cmdline-tools',
    sdkPackage: 'cmdline-tools;latest',
    url: `${BASE}commandlinetools-linux-16111833_latest.zip`,
    sizeBytes: 181052239,
    upstreamSha1: 'e025545c62a8e64c7559119566a569fb1dec5f60',
    sha256: '0877a1d048fe4a24efe2eff536ca4223f7adeb58648bb81909d33c446918cfa8',
    sha512: '28b71dcfd7d491a999f59d90683785c70fd9d26d364ad5562ac889c76ac9861457dd466534471420c9d0aac69f62461d2b112bd28b70407c07dc081c1688a999',
    extension: '.zip'
  },
  {
    id: 'android-platform-tools',
    sdkPackage: 'platform-tools',
    url: `${BASE}platform-tools_r37.0.1-linux.zip`,
    sizeBytes: 9054187,
    upstreamSha1: '477254aa5f903c15cf51001717bdf347fb6b53e0',
    sha256: 'd230f13842f60f782a8645f9c813f8f845bf36089ea7289f28c48f17979313f1',
    sha512: '990ee47ae823724599679fe56561df31a6056668246390698c94f9b00a5af8e5966bff4c31c8f8b8d11b3c419ea994147d38e2234fa6e881255dbb29ff203449',
    extension: '.zip'
  },
  {
    id: 'android-emulator',
    sdkPackage: 'emulator',
    url: `${BASE}emulator-linux_x64-16322952.zip`,
    sizeBytes: 353755112,
    upstreamSha1: 'fadd2b669640e56da18fad7d685e9a316ca7d14c',
    sha256: '703aac00501161e5388e2ca9e3ec8fb5f5b71074b48c35b798d252b0fde81e5a',
    sha512: '8a723a51d626c30149b34216d854a7823200b2954e596b5db7084cd9e151afdb5abc3df6eef94ec47cdf42f11e379bd6e1131a040109a4f5abe61bc2b24104b5',
    extension: '.zip'
  }
]

/** One system image per supported API level; the guest Android itself. */
export const ANDROID_SYSTEM_IMAGES: Readonly<Record<number, AndroidSdkArtifact>> = {
  34: {
    id: 'android-system-image-34',
    sdkPackage: 'system-images;android-34;google_apis;x86_64',
    url: `${BASE}sys-img/google_apis/x86_64-34_r14.zip`,
    sizeBytes: 1563721130,
    upstreamSha1: 'e0f6c9a0691aa27bd597d0deb1bcfdc943ac8ca7',
    sha256: '783a40134baf4f3012d4464fbe1571b1612a0dbd2e7a44d14bd8328923443833',
    sha512: '891e0430412754f1af29b5ac4e5219e3663c70982c23e05e046014b21e22b09f6c177cb66c2a2ad6e46e327893360c6ec736ae575e2cbe258f868da8700229a3',
    extension: '.zip'
  }
}

/** The Room asked for an Android version DevHotel does not know at all. */
export class UnknownAndroidVersionError extends Error {
  constructor(readonly version: string) {
    super(`DevHotel does not know Android emulator version ${version}`)
    this.name = 'UnknownAndroidVersionError'
  }
}

/**
 * A known Android version whose system image is not pinned for the managed
 * path yet. Deliberately distinct from "unknown": this Room is fine on the
 * external-Docker backend and only the managed migration is missing, which is
 * what a caller has to be able to tell the user.
 */
export class UnpinnedAndroidSystemImageError extends Error {
  constructor(readonly version: string, readonly apiLevel: number) {
    super(`DevHotel has no pinned Android ${version} (API ${apiLevel}) system image for the managed runtime`)
    this.name = 'UnpinnedAndroidSystemImageError'
  }
}

export function androidApiLevel(version: string): number {
  const api = ANDROID_API_LEVELS[version]
  if (api === undefined) throw new UnknownAndroidVersionError(version)
  return api
}

/** Android versions a managed Android Room can actually be provisioned for. */
export function pinnedAndroidVersions(): readonly string[] {
  return Object.keys(ANDROID_API_LEVELS).filter((version) => ANDROID_SYSTEM_IMAGES[ANDROID_API_LEVELS[version]!])
}

/**
 * Everything one managed Android Room of this version has to have on disk
 * before an emulator can be launched directly.
 */
export function androidSdkArtifacts(version: string): readonly AndroidSdkArtifact[] {
  const apiLevel = androidApiLevel(version)
  const image = ANDROID_SYSTEM_IMAGES[apiLevel]
  if (!image) throw new UnpinnedAndroidSystemImageError(version, apiLevel)
  return [...ANDROID_SDK_TOOLS, image]
}

/** True once a maintainer has actually captured this artifact's digests. */
export function isAndroidSdkArtifactPinned(artifact: AndroidSdkArtifact): boolean {
  return /^[a-f0-9]{64}$/.test(artifact.sha256) && /^[a-f0-9]{128}$/.test(artifact.sha512)
}

/**
 * Refuses a pin that cannot be verified the way the managed runtime verifies
 * everything else. An artifact whose SHA-256/SHA-512 were never captured must
 * fail here rather than silently fall back to the upstream SHA-1 — that
 * downgrade is the exact failure this two-step pin exists to prevent.
 */
export function assertAndroidSdkArtifactPinned(artifact: AndroidSdkArtifact): void {
  if (!/^[a-f0-9]{40}$/.test(artifact.upstreamSha1)) {
    throw new Error(`Android SDK artifact ${artifact.id} has no upstream provenance`)
  }
  if (!isAndroidSdkArtifactPinned(artifact)) {
    throw new Error(
      `Android SDK artifact ${artifact.id} has no DevHotel digest: run 'pnpm --filter @devhotel/core pin:android-sdk'`
    )
  }
  const url = new URL(artifact.url)
  if (url.protocol !== 'https:' || url.hostname !== ANDROID_SDK_HOST || url.username || url.password || url.port) {
    throw new Error(`Android SDK artifact ${artifact.id} does not come from the pinned origin`)
  }
  if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 1) {
    throw new Error(`Android SDK artifact ${artifact.id} has an invalid size`)
  }
}

/** Total bytes a first managed Android Room of this version downloads. */
export function androidSdkDownloadBytes(version: string): number {
  return androidSdkArtifacts(version).reduce((total, artifact) => total + artifact.sizeBytes, 0)
}
