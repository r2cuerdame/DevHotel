# Managed Hyper-V runtime

This is the first concrete provider behind the managed-runtime bootstrap. It is
not yet the selected Room executor: Web and Android Rooms remain on the clearly
labelled external compatibility backend until their provider migrations and
live acceptance gates pass.

## Known substrate defect (blocks #106)

The guest bootstrap described below **cannot work with the image currently
pinned**, for two independent reasons that are provable from upstream sources
without a Hyper-V Host. Both are open; neither is fixed by a version bump.

1. **A Generation 2 VM cannot boot a `.vhd`.** Generation 2 boots from a SCSI
   `.vhdx` or a virtual DVD; `.vhd` on an IDE controller is a Generation 1 boot
   device, and Generation 2 has no IDE controller at all. The provider now
   converts the verified upstream VHD once into an owned VHDX parent
   (`Convert-VHD`, named after the digest it was produced from) and boots the
   differencing child from that. See the boot-method table in
   [Generation 1 or 2](https://learn.microsoft.com/windows-server/virtualization/hyper-v/plan/should-i-create-a-generation-1-or-2-virtual-machine-in-hyper-v).

2. **The `CIDATA` seed is inert on this image, so guest health can never
   pass.** The pinned artifact is built with `bootstrap: tiny`, which installs
   `tiny-cloud` and *no* cloud-init (`configs/bootstrap/tiny.conf` in
   `alpine-cloud-images`). Nothing in the guest reads a `#cloud-config`
   `user-data` file, so `/etc/devhotel/ownership.json` and the OpenRC COM2
   agent are never created and `requireGuestHealth` cannot succeed.

   This is not fixable by choosing a different Alpine `.vhd`. Only the `aws_`
   and `azure_` images are published as `.vhd`, and `scripts/setup-cloudinit`
   appends `datasource_list: ["Ec2"]` (Azure equivalently) to
   `/etc/cloud/cloud.cfg`, so the NoCloud datasource is never probed. The
   `nocloud_` variants exist only as `qcow2`. There is no offline
   config-injection path into those images either: the root filesystem and
   `grub.cfg` are ext4, and Hyper-V cannot set a kernel command line or an
   SMBIOS serial.

   The substrate therefore has to change before #106 can pass. The recommended
   replacement is the Alpine `virt` ISO plus an **apkovl** overlay: a
   Generation 2 VM can boot a SCSI DVD, and `nlplug-findfs` scans every block
   device for `*.apkovl.tar.gz`, which `initramfs-init` then unpacks — fully
   offline, with no cloud-init, no datasource and no extra bundled binaries.
   The alternatives are bundling `qemu-img` to convert a `nocloud_` qcow2, or
   building and hosting a DevHotel rootfs.

The provider remains fail-closed in the meantime: without a guest health proof
it reports `broken` rather than claiming readiness.

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

The provider creates one Generation 2 Hyper-V VM with a differencing VHDX under
the DevHotel runtime root, whose parent is the owned VHDX converted from the
verified upstream VHD. VM name and private named-pipe name are derived from
the installation and runtime identities. The on-disk provider marker and the
VM's Hyper-V Notes must agree on installation ID, runtime ID, version, paths,
pipe and base-image digest before any start, save or repair mutation occurs.
A colliding VM is refused.

A per-install `CIDATA` seed disk is written with a guest ownership record and an
OpenRC runtime agent. The agent listens only on Hyper-V COM2 through a private
named pipe; it has no Host TCP or management socket. Every health response
carries a fresh nonce plus the exact installation ID, runtime ID, runtime
version and daemon version. Host readiness therefore requires all three proofs:
Host marker, Hyper-V object Notes/ID and guest daemon identity.

**This seed is currently inert**, because the pinned image ships no cloud-init —
see the substrate defect above. The Host-side proofs are exercised by unit
tests; the guest side of this design has never run.

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

The provider slice itself enables no feature, opens no UAC prompt and schedules
no reboot. `ManagedRuntimeWindowsFeatureHarness` owns that step separately: it
enables only `Microsoft-Hyper-V-All`, through one caller-driven elevation with
`-NoRestart`, treats DISM's `EnablePending` as "restart required", and proves a
restart happened by a change in the Host boot identity rather than by elapsed
time, so a deferred reboot never causes a second prompt. It refuses Windows
editions that do not offer Hyper-V, and records a declined UAC prompt as a
retryable outcome. DevHotel never restarts the Host itself.

Clean Windows 11 VM evidence remains required before issue #106 can close.

## Verification

`pnpm --filter @devhotel/core probe:managed-runtime` records the local Windows
capability without mutating the Host. Set
`DEVHOTEL_RUNTIME_PROBE_DOWNLOAD=1` to additionally download, verify and remove
the pinned base image in a temporary directory. Unit coverage exercises
collision refusal, identity drift, interrupted provisioning, app/Host restart,
saved shutdown, nonce-bound named-pipe health, redirect refusal, oversize and
digest failure cleanup, and manager phase recovery.

The following are not proven by unit tests and remain release blockers:

- a substrate whose guest bootstrap can actually read DevHotel's seed (see the
  substrate defect above) — this one is known-broken, not merely unproven;
- the clean Windows 11 VM run of installer-led Hyper-V enable, elevation and
  reboot resume; the Host half of that gate is implemented and unit-tested in
  `ManagedRuntimeWindowsFeatureHarness`, but has never run on a clean VM;
- a real boot of the pinned image with seed discovery and COM2 health;
- two managed Web Rooms, persistent reboot state and the dependent #107 path;
- update/rollback/complete-uninstall and the dependent #110 safety matrix.

Relevant upstream references:

- [Hyper-V Generation 2 boot methods and COM-port configuration](https://learn.microsoft.com/windows-server/virtualization/hyper-v/plan/should-i-create-a-generation-1-or-2-virtual-machine-in-hyper-v)
- [`Convert-VHD`](https://learn.microsoft.com/powershell/module/hyper-v/convert-vhd)
- [`Enable-WindowsOptionalFeature`](https://learn.microsoft.com/powershell/module/dism/enable-windowsoptionalfeature)
- [`Set-VMComPort`](https://learn.microsoft.com/powershell/module/hyper-v/set-vmcomport)
- [Alpine cloud images](https://www.alpinelinux.org/cloud/)
