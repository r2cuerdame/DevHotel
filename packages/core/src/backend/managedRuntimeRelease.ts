import type { ManagedRuntimeRemoteArtifact } from './managedRuntimeArtifact'

/**
 * One runtime version and the immutable artifacts that make it.
 *
 * A release is a product fact, not a build detail: it is what an install can be
 * moved on to, what it can be moved back to, and what its ownership manifest
 * records having verified. Keeping the older entries is the whole point — an
 * update that fails has to be able to re-fetch and re-verify exactly the
 * release it came from, and "whatever this build happens to ship" is not that.
 */
export interface ManagedRuntimeReleaseDescriptor {
  runtimeVersion: string
  bootImage: ManagedRuntimeRemoteArtifact
}

/**
 * Official Alpine `virt` ISO, used read-only as the immutable Linux substrate.
 *
 * The cloud VHD images cannot be used: they ship either tiny-cloud with no
 * cloud-init at all, or a cloud-init pinned to their own provider's
 * datasource, so DevHotel's seed is never read and guest health can never
 * pass. A Generation 2 VM boots this ISO from a SCSI DVD, and DevHotel's
 * identity and private serial daemon are delivered by an apkovl overlay that
 * Alpine's initramfs discovers on an attached disk — offline, with no
 * cloud-init and no datasource. The upstream bytes remain independently
 * reproducible.
 */
export const MANAGED_HYPERV_BOOT_ISO: ManagedRuntimeRemoteArtifact = {
  id: 'alpine-3.22.5-virt-iso',
  url: 'https://dl-cdn.alpinelinux.org/alpine/v3.22/releases/x86_64/alpine-virt-3.22.5-x86_64.iso',
  sha256: 'b7b0f2785aeaf23d2c225e01e4a48337de3ebc5688dba196b88d3c515dbba623',
  sha512:
    'fa9b1c717dacbc9ca2c40a3766c87c407083c6ea4a0ac074baa094228a035c5a0a863034cb52388634964202b137b391cee72b1376fed29b1f5ea44d5155af45',
  sizeBytes: 68_157_440,
  extension: '.iso'
}

/** Hosts the runtime downloader will talk to, and no others. */
export const MANAGED_RUNTIME_ALLOWED_HOSTS: ReadonlySet<string> = new Set(['dl-cdn.alpinelinux.org'])

/**
 * Every runtime version this build knows how to stand up, oldest first.
 *
 * `0.1.0` is kept deliberately. It is not shipped to anyone new, but it is the
 * version installs provisioned before the guest gained a container engine, and
 * an update off it must be able to put it back if the new runtime cannot be
 * made healthy. Both releases boot the same pinned substrate; what differs is
 * the DevHotel guest overlay, which this build generates from the release
 * version rather than downloading.
 */
export const MANAGED_RUNTIME_RELEASES: readonly ManagedRuntimeReleaseDescriptor[] = [
  { runtimeVersion: '0.1.0', bootImage: MANAGED_HYPERV_BOOT_ISO },
  { runtimeVersion: '0.2.0', bootImage: MANAGED_HYPERV_BOOT_ISO }
]

/**
 * `0.2.0` is the first runtime that can actually run a Room.
 *
 * The bump is mandatory rather than cosmetic: the guest bootstrap now carries a
 * container engine, a persistent state disk and the Room command agent, so the
 * apkovl's bytes and therefore its digest changed. The provider refuses to
 * re-seed a different overlay under a runtime it already provisioned — that is
 * what stops a build from silently replacing a live runtime's guest — so the
 * version is what authorises the new bootstrap.
 */
export const MANAGED_HYPERV_RUNTIME_VERSION = '0.2.0'

export const MANAGED_RUNTIME_CURRENT_RELEASE: ManagedRuntimeReleaseDescriptor =
  MANAGED_RUNTIME_RELEASES.find((release) => release.runtimeVersion === MANAGED_HYPERV_RUNTIME_VERSION) ??
  ({ runtimeVersion: MANAGED_HYPERV_RUNTIME_VERSION, bootImage: MANAGED_HYPERV_BOOT_ISO } as const)

/** The release for a version, or `null` when this build no longer carries it. */
export function findManagedRuntimeRelease(runtimeVersion: string): ManagedRuntimeReleaseDescriptor | null {
  return MANAGED_RUNTIME_RELEASES.find((release) => release.runtimeVersion === runtimeVersion) ?? null
}
