# Managed Hyper-V runtime

This is the first concrete provider behind the managed-runtime bootstrap. It is
not yet the selected Room executor: Web and Android Rooms remain on the clearly
labelled external compatibility backend until their provider migrations and
live acceptance gates pass.

## Pinned Linux substrate

Runtime version `0.1.0` uses Alpine Linux `3.22.5`'s official x86-64 UEFI tiny
VHD as an immutable parent image:

- URL: `https://dl-cdn.alpinelinux.org/alpine/v3.22/releases/cloud/aws_alpine-3.22.5-x86_64-uefi-tiny-r0.vhd`
- size: `148898304` bytes
- SHA-256: `9f042de9c7ab3c99093cbfaa46946b0c73138035f0fba382bbf5a3794dc67c83`
- SHA-512: `ba667c2b2d6a67183efe08fc1ce007bb6a0dcdbaffe673a72a9e0ce09abb0ab431fa2817733bb083db74774893bf04787724e6e6f97baf6a42dc2aea2b572b43`

The downloader accepts HTTPS from the exact Alpine CDN host, rejects an
off-host redirect, bounds bytes to the declared size, verifies both digests,
and publishes the file atomically under the DevHotel data root. Existing bytes
are reused only after the same full verification.

Alpine publishes image signatures, checksums and its package/license sources.
A release that redistributes this image rather than downloading it from the
recorded upstream URL still needs the release-level SBOM and NOTICE gate from
the managed-runtime design.

## Ownership and boot

The provider creates one Generation 2 Hyper-V VM with a differencing disk under
the DevHotel runtime root. VM name and private named-pipe name are derived from
the installation and runtime identities. The on-disk provider marker and the
VM's Hyper-V Notes must agree on installation ID, runtime ID, version, paths,
pipe and base-image digest before any start, save or repair mutation occurs.
A colliding VM is refused.

A per-install `CIDATA` seed disk writes a guest ownership record and an OpenRC
runtime agent. The agent listens only on Hyper-V COM2 through a private named
pipe; it has no Host TCP or management socket. Every health response carries a
fresh nonce plus the exact installation ID, runtime ID, runtime version and
daemon version. Host readiness therefore requires all three proofs: Host
marker, Hyper-V object Notes/ID and guest daemon identity.

Hyper-V state is saved on DevHotel shutdown and configured for
`StartIfRunning`/`Save` across Host shutdown. Startup repair rechecks the pinned
image and all ownership proofs, recreates only a missing VM already described
by the exact retained marker, starts it, and re-proves guest health.

## Windows gates

The capability probe distinguishes:

- `ready`: the hypervisor, Hyper-V PowerShell module and management access are
  available;
- `elevation-required`: Hyper-V exists but this process cannot manage it;
- `virtualization-ready`: hardware virtualization is active/available but the
  selected Hyper-V provider still needs Windows feature provisioning;
- unsupported, disabled and probe-failed states.

No feature is enabled, no UAC prompt is opened and no reboot is scheduled by
the provider slice. Installer-owned feature enablement, recorded reboot resume,
and clean Windows 11 VM evidence remain required before issue #106 can close.

## Verification

`pnpm --filter @devhotel/core probe:managed-runtime` records the local Windows
capability without mutating the Host. Set
`DEVHOTEL_RUNTIME_PROBE_DOWNLOAD=1` to additionally download, verify and remove
the pinned base image in a temporary directory. Unit coverage exercises
collision refusal, identity drift, interrupted provisioning, app/Host restart,
saved shutdown, nonce-bound named-pipe health, redirect refusal, oversize and
digest failure cleanup, and manager phase recovery.

The following are not proven by unit tests and remain release blockers:

- installer-led Hyper-V enable/elevation/reboot on a clean Windows 11 VM;
- a real boot of the pinned VHD with `CIDATA` discovery and COM2 health;
- two managed Web Rooms, persistent reboot state and the dependent #107 path;
- update/rollback/complete-uninstall and the dependent #110 safety matrix.

Relevant upstream references:

- [Hyper-V Generation 2 and COM-port configuration](https://learn.microsoft.com/windows-server/virtualization/hyper-v/plan/should-i-create-a-generation-1-or-2-virtual-machine-in-hyper-v)
- [`Set-VMComPort`](https://learn.microsoft.com/powershell/module/hyper-v/set-vmcomport)
- [Alpine cloud images](https://www.alpinelinux.org/cloud/)
