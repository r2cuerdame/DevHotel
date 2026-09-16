# Managed Hyper-V runtime

This is the concrete provider behind the managed-runtime bootstrap.

Since #107 it is also the **preferred** Room executor for Web Rooms: when the
runtime is healthy, Web Rooms run inside it and need no external Docker Engine.
A Host whose Hyper-V gate has not been passed, or whose runtime is still
preparing, falls back to the clearly labelled external compatibility backend and
is told which one it got. Android Rooms stay on the compatibility backend until
#108, because they need KVM in the guest.

The live acceptance gate has **not** been run. See
[issue-107-managed-web-rooms.md](./verification/issue-107-managed-web-rooms.md)
for what is proven, what is not, and the matrix #107 closes on.

## Why the substrate is an ISO and not a cloud disk image

The first implementation pinned Alpine's `aws_…-uefi-tiny-r0.vhd` and delivered
DevHotel's identity and agent through a `CIDATA` cloud-init seed. That could
never work, for two independent reasons that are provable from upstream sources
without a Hyper-V Host:

1. **A Generation 2 VM cannot boot a `.vhd`.** Generation 2 boots from a SCSI
   `.vhdx` or a virtual DVD; `.vhd` on an IDE controller is a Generation 1 boot
   device, and Generation 2 has no IDE controller at all. See the boot-method
   table in [Generation 1 or 2](https://learn.microsoft.com/windows-server/virtualization/hyper-v/plan/should-i-create-a-generation-1-or-2-virtual-machine-in-hyper-v).

2. **No published Alpine `.vhd` reads a `CIDATA` seed.** The `tiny` bootstrap
   installs `tiny-cloud` and no cloud-init at all, so a `#cloud-config`
   `user-data` file is inert. The `cloudinit` bootstrap does install cloud-init,
   but `scripts/setup-cloudinit` appends `datasource_list: ["Ec2"]` (Azure
   equivalently) to `/etc/cloud/cloud.cfg`, so NoCloud is never probed — and
   only the `aws_` and `azure_` images are published as `.vhd` at all, the
   `nocloud_` variants being `qcow2` only. There is no offline config-injection
   path into those images either: the root filesystem and `grub.cfg` live on
   ext4, and Hyper-V can set neither a kernel command line nor an SMBIOS serial.

The substrate is therefore the Alpine **`virt` ISO**, attached read-only as a
Generation 2 SCSI DVD, with DevHotel's configuration delivered as an Alpine
**apkovl** overlay. Alpine's `nlplug-findfs` scans every attached block device
for a `*.apkovl.tar.gz`, and `initramfs-init` extracts the first one it finds
into the new root before OpenRC starts. That needs no network, no cloud-init,
no datasource and no extra bundled binaries.

## Pinned Linux substrate

Runtime version `0.2.0` uses the official Alpine Linux `3.22.5` x86-64 `virt`
ISO as immutable, read-only boot media:

- URL: `https://dl-cdn.alpinelinux.org/alpine/v3.22/releases/x86_64/alpine-virt-3.22.5-x86_64.iso`
- size: `68157440` bytes
- SHA-256: `b7b0f2785aeaf23d2c225e01e4a48337de3ebc5688dba196b88d3c515dbba623`
- SHA-512: `fa9b1c717dacbc9ca2c40a3766c87c407083c6ea4a0ac074baa094228a035c5a0a863034cb52388634964202b137b391cee72b1376fed29b1f5ea44d5155af45`

The downloader accepts HTTPS from the exact Alpine CDN host, rejects an
off-host redirect, bounds bytes to the declared size, verifies both digests,
and publishes the file atomically under the DevHotel data root. Existing bytes
are reused only after the same full verification.

Alpine publishes image signatures, checksums and its package/license sources.
A release that redistributes this image rather than downloading it from the
recorded upstream URL still needs the release-level SBOM and NOTICE gate from
the managed-runtime design.

## Guest bootstrap

`buildManagedRuntimeGuestOverlay` produces `devhotel.apkovl.tar.gz` entirely on
the Host, as a deterministic gzipped ustar archive — fixed mtimes, root
ownership, fixed member order — so the same runtime identity always yields the
same bytes and the digest is recordable as ownership evidence. It contains
only:

- `etc/devhotel/ownership.json` (`0600`) — the install/runtime identity;
- `usr/local/sbin/devhotel-runtime-agent` (`0755`) — the private serial agent;
- `etc/init.d/devhotel-runtime-agent` (`0755`) — its OpenRC service;
- `etc/runlevels/default/devhotel-runtime-agent` — the symlink `rc-update add`
  would create;
- `etc/.default_boot_services` — without this marker `initramfs-init` skips
  Alpine's own boot services whenever an apkovl is present, leaving the guest
  with no `devfs`, `mdev`, `hwdrivers` or `modloop`, and therefore no kernel
  modules.

Since runtime `0.2.0` — the version that can actually run a Room — it also
contains, as ordered OpenRC services:

- `usr/local/sbin/devhotel-runtime-state` — claims the persistent state disk.
  This is the one destructive act in the guest bootstrap, so it is fenced twice:
  a disk is formatted only when it carries no filesystem and no partition at
  all, and it is only ever *found* again by DevHotel's own `DHSTATE` label. A
  disk holding something DevHotel cannot recognise is left alone and the service
  fails, because guessing would cost the user Room data.
- `usr/local/sbin/devhotel-engine` — installs the pinned guest packages and
  starts the container engine with its data root on the state disk. The guest
  boots diskless, so a package installed at boot is gone by the next one; the
  packages are resolved once from the pinned branch into a cache on the
  persistent disk, and every later boot installs from that cache with no network
  at all. That is what makes the first provision the only one that needs
  connectivity.
- `usr/local/sbin/devhotel-room-agent` — serves the Room command channel.
- `etc/apk/repositories`, pinned to the same branch as the boot image, and
  `etc/network/interfaces`, bringing up the runtime's private NIC.

The services depend in that order, so a Room command can never be served before
the engine answers, and the engine can never start before its data root exists.

The archive is written to a small FAT disk attached to the VM. Nothing outside
those DevHotel-owned paths is ever written into the guest.

The agent must survive losing the line. `NamedPipeHyperVGuestTransport` opens a
fresh connection for every probe and destroys the socket the moment it has the
reply, so the guest sees the port drop after *each* health check. The agent
therefore reopens the serial line in a loop rather than running one read pass:
a single-pass agent answers exactly one probe and leaves the runtime
permanently unhealthy afterwards. The reopen happens in a subshell because
`exec` is a POSIX special built-in — under busybox `ash` a failed redirection
exits the shell outright, and neither `if` nor `||` intercepts it — and `stty`
sets `clocal` so the open cannot block waiting for a carrier the emulated UART
need not assert.

## Ownership and boot

The provider creates one Generation 2 Hyper-V VM with no boot VHD: the pinned
ISO is attached as a DVD and set as the first boot device, so the boot media
can never drift from its verified digest. Two SCSI disks are attached — a
disposable FAT **seed** carrying the overlay, and a persistent **state** disk
holding Room and runtime data. VM name and private named-pipe name are derived
from the installation and runtime identities. The on-disk provider marker and
the VM's Hyper-V Notes must agree on installation ID, runtime ID, version,
paths, pipe, base-image digest and overlay digest before any start, save or
repair mutation occurs. A colliding VM is refused.

The serial agent listens only on Hyper-V COM2 through a private named pipe.
Every health response carries a fresh nonce plus the exact installation ID,
runtime ID, runtime version and daemon version. Host readiness therefore
requires all three proofs: Host marker, Hyper-V object Notes/ID and guest daemon
identity.

Rooms need far more bandwidth than an emulated UART can carry, so since `0.2.0`
the guest also has one network adapter on the Hyper-V **Default Switch**, and the
Room command agent listens on it. The serial line bootstraps that channel rather
than being replaced by it: `channel:<nonce>` reports the guest's address, the
agent port and this boot's token. Both are per-boot facts — a DHCP address and a
regenerated token — so nothing is cached, and the token reaches the Host only over
the channel that is private to it by construction. The agent answers nothing
before that token is presented, compares it in constant time, runs one pinned
engine executable rather than any shell string, and writes only beneath its own
staging root.

The Default Switch is required rather than created. It is the only switch
Hyper-V maintains itself, and it makes that adapter a NAT'd private network
rather than a bridge onto the user's LAN; creating a switch would mean DevHotel
owning a Host network object with its own uninstall and collision problems. A
Host without it is reported rather than worked around.

Two Host permissions the VM needs are asked for explicitly rather than assumed.
Provisioning grants `NT VIRTUAL MACHINE\Virtual Machines` **traverse** on every
ancestor of the machine directory: a VM worker account is in no ordinary group,
so it cannot otherwise walk a user profile path to reach its own attachments,
and the start fails with "failed to open attachment … Access is denied" even
though Hyper-V granted it those files. `(X)` carries no `(OI)`/`(CI)`, so
nothing in those directories is listed, read or inherited.

Nested virtualization is requested but **optional**. It matters only for KVM in
the guest, which is what Android Rooms will need (#108); the runtime boots and
serves Web Rooms without it, and Hyper-V
refuses it on hosts that cannot nest — including inside a VM at all, since it
does not stack three levels deep. Provisioning asks with `-ErrorAction Stop`,
falls back to setting the processor count alone, and reports which it got, so a
refusal is a recorded outcome rather than a lost VM or a silent downgrade. The
answer is written into the provider marker and surfaced in the runtime
observation, because nothing else on the Host distinguishes "this Host refused"
from "nobody ever asked", and only a guest that was granted it can run
KVM-backed Android emulators later. A marker written before this was recorded
reports `null` — unknown, not refused.

Hyper-V state is saved on DevHotel shutdown and configured for
`StartIfRunning`/`Save` across Host shutdown. Startup repair rechecks the pinned
image and all ownership proofs, recreates only a missing VM already described
by the exact retained marker, starts it, and re-proves guest health. A repair
regenerates the seed from the marker identity but **never** destroys the state
disk: a power loss during provisioning must not cost the user Room data.

## What the app shows

Settings → **Managed Linux runtime** reports the live runtime state and phase,
the runtime identity and version, the verified digest of each pinned artifact,
and whether this Host granted nested virtualization. That is deliberate rather
than decorative: the clean Windows machine this is proven on has no Node, no
adb and no shell tooling, so the app window is the only place those values can
be read, and the digest is what separates a runtime actually running the pinned
image from one that merely reports itself healthy.

The renderer gets an observation narrowed by `managedRuntimeStatusInfo`. The
Windows feature harness's `failure` is dropped there: it carries raw DISM or
elevation text, which is Host detail of exactly the kind the provider keeps
private everywhere else. The gate's `stage` and `detail` say what the user can
do without quoting Windows back at them.

## Uninstall

Deleting DevHotel's app data is not sufficient on Windows. A registered Hyper-V
VM keeps its configuration and its VHDX attachments open, so a recursive delete
of `%APPDATA%\DevHotel` either fails on the lock or succeeds and leaves Hyper-V
holding a VM whose disks no longer exist. The Hyper-V object therefore has to go
first, and only a running DevHotel still holds the proof that it may.

Clean removal runs `ManagedRuntimeManager.remove()` in-process, after the Rooms
are deleted and **before** the detached coordinator that runs the uninstaller
and deletes app data is launched. The provider re-proves the Host marker and
the exact Notes payload inside the same PowerShell pass that removes the VM, so
nothing can be swapped onto the name in between; a running guest is turned off
rather than saved, since a saved state would only hold the attachments open
against the delete that follows. It then removes its own machine directory and
runtime root, and nothing outside them.

Without that proof the removal reports `refused` and touches nothing, and clean
removal stops and says so. An orphaned VM the user can see and delete is a
better outcome than DevHotel deleting a virtual machine that might be theirs —
a name collision or a restored backup looks exactly like an install DevHotel
made. A Host that was never provisioned reports `nothing-owned` and no
PowerShell runs at all.

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

## Verification

`pnpm --filter @devhotel/core probe:managed-runtime` records the local Windows
capability without mutating the Host. Set
`DEVHOTEL_RUNTIME_PROBE_DOWNLOAD=1` to additionally download, verify and remove
the pinned ISO in a temporary directory.

Unit coverage exercises collision refusal, identity drift, interrupted
provisioning, app/Host restart, saved shutdown, nonce-bound named-pipe health,
redirect refusal, oversize and digest failure cleanup, manager phase recovery,
the Windows feature/elevation/reboot-resume gate, the recorded nested-
virtualization outcome, ownership-fenced removal (removed / refused /
nothing-owned), and the overlay's exact contents, permissions, determinism and
extraction by a real `tar`.

### Guest bootstrap, proven on a real boot

The guest half has been exercised against the real pinned bytes, off Hyper-V,
by booting the ISO under QEMU/TCG with the overlay on a FAT SCSI disk and the
two serial ports wired to sockets. What that run established:

- the pinned ISO downloads at exactly `68,157,440` bytes with the pinned
  SHA-256, and boots through UEFI/OVMF;
- Alpine's initramfs finds `devhotel.apkovl.tar.gz` on the attached FAT disk
  and extracts it, with `modloop` mounted — confirming `.default_boot_services`
  does its job;
- OpenRC reaches `Starting DevHotel private runtime agent ... [ ok ]` from the
  runlevel symlink alone;
- COM2 answers `health:<nonce>` with the exact install/runtime/daemon identity
  and the echoed nonce;
- **five consecutive probes, each on its own connection that is fully closed
  afterwards, all answer** — the disconnect-per-probe case that a single-pass
  agent fails on its second probe.

That run is guest-bootstrap evidence only. It deliberately does **not** stand in
for Hyper-V: QEMU enumerates the disks over `virtio-scsi` and the serial ports
as ISA 16550As, where Hyper-V Gen 2 presents storage through `hv_storvsc` and
COM2 through a named pipe. Those paths are still unproven on a live VM.

What *can* be checked without a Hyper-V Host is whether the pinned image carries
the drivers that path needs at all, since the ISO fixes its own boot cmdline to
`modules=loop,squashfs,sd-mod,usb-storage` and names no Hyper-V module. Reading
the pinned `initramfs-virt` and `config-6.12.94-0-virt` directly:

- `CONFIG_HYPERV=y` — the VMBus core is built into the kernel, so it needs no
  entry in `modules=`;
- `hv_storvsc.ko` ships **inside the initramfs**, and `modules.alias` carries
  its three `vmbus:` aliases, so `nlplug-findfs` autoloads it by modalias when
  VMBus enumerates the controller;
- `sr_mod.ko` is present for the Generation 2 SCSI DVD, and `vfat.ko` with the
  `nls_*` tables for the FAT seed the apkovl lives on;
- `CONFIG_SERIAL_8250=y`, so COM2 needs no module either.

That is static evidence about the pinned bytes, not a boot. It says the missing
`modules=` entry is not a blocker; it does not prove the Hyper-V boot works.

### Still unproven — release blockers

- a clean Windows 11 VM run of installer-led Hyper-V enable, elevation and
  reboot resume;
- the same guest boot **under Hyper-V**: Gen 2 UEFI boot from a SCSI DVD,
  `hv_storvsc` enumerating the seed and state disks so the initramfs can find
  the apkovl, and COM2 reaching the Host named pipe;
- reboot/repair and state-disk preservation against a real VM;
- ownership-safe uninstall;
- the guest half of the #107 Room path on a real boot: the container engine
  reaching ready, the state disk being claimed and mounted, the Room command
  agent answering on the private NIC, and two managed Web Rooms both serving
  internal port 3000;
- the second-boot offline case: guest packages installed from the persistent
  cache with no network;
- update/rollback and the dependent #110 safety matrix.

Relevant upstream references:

- [Hyper-V Generation 2 boot methods and COM-port configuration](https://learn.microsoft.com/windows-server/virtualization/hyper-v/plan/should-i-create-a-generation-1-or-2-virtual-machine-in-hyper-v)
- [`Set-VMComPort`](https://learn.microsoft.com/powershell/module/hyper-v/set-vmcomport)
- [`Enable-WindowsOptionalFeature`](https://learn.microsoft.com/powershell/module/dism/enable-windowsoptionalfeature)
- [Alpine cloud images](https://www.alpinelinux.org/cloud/)
- [Alpine local backup (`apkovl`)](https://wiki.alpinelinux.org/wiki/Alpine_local_backup)
