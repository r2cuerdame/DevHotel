# DevHotel Agent Sandbox Research and Backend ADR

**Date:** 2026-08-10

**Research cutoff:** 2026-08-10; official project/vendor documentation and repositories only

**Status:** Research decision / prototype gates, not an implementation claim

## 1. Decision summary

DevHotel should not build a new sandbox engine first. It should own the product-level control plane:

> **Room + Service + Resource + Lease + Job + Permission**

The underlying sandbox is a provider selected behind a stable backend contract. The immediate decisions are:

1. Treat a separate-kernel microVM as the default trust-boundary candidate for an autonomous **Full Agent Room**.
2. Keep the current shared external-Docker implementation only as an explicitly labeled contributor/compatibility backend.
3. Prototype a Docker Sandboxes adapter because its Windows microVM model most closely matches the philosophy, but do not make it the product foundation until redistribution, account/sign-in, offline, API stability, storage ownership and complete-uninstall constraints are resolved.
4. Evaluate OpenSandbox as an Apache-2.0 protocol/component source, especially its OpenAPI lifecycle/exec contracts, exec daemon, ingress/egress and credential patterns. Do not assume its current local server solves Windows packaging: its documented local path requires Docker and Python.
5. Study Kaiden for Agent session, permission, secret, network and multi-Agent UX and audit its Podman/libkrun implementation. Do not fork the whole desktop product.
6. Reserve Kubernetes Agent Sandbox for a future remote/cloud provider. Running Kubernetes locally would contradict the small Windows footprint goal.
7. Treat Sandlock as a later Linux tool/process isolation layer inside the Hotel, not as the Windows Room trust boundary.
8. Treat Crab and DeltaBox as checkpoint policy/performance research. Neither is a current production dependency decision.
9. Treat containerd as a mature lifecycle/image primitive, not an isolation boundary; its boundary is whichever runtime and Host substrate it is paired with.
10. On Windows, compare a provider-managed Hyper-V Linux VM with a managed WSL2/containerd compatibility baseline. Firecracker, Cloud Hypervisor and Kata are valuable Linux/remote components, but their reviewed upstream paths do not provide a direct Windows-host backend.
11. Do not use Windows Sandbox as the primary Room backend: it is single-instance, disposable on close and lacks a documented programmable persistent snapshot/clone lifecycle.

No new backend is adopted in the v0.3 compatibility release. First fix the current backend's isolation truth, lifecycle races and ownership safety, then run bounded prototypes.

## 2. Why a container-only final boundary is insufficient

The Core Philosophy says an Agent can install packages, change runtimes, run builds and use powerful tools freely inside its Room. Giving that autonomy to an ordinary container on a shared host daemon creates a tension: the more capabilities granted to the Agent, the weaker the container boundary becomes.

Docker's own architecture comparison positions a microVM with its own daemon as the autonomous-Agent choice, while a container sharing a host daemon is for more trusted tools. Docker Sandboxes gives each sandbox a separate kernel boundary, Docker daemon, filesystem and network. That is materially closer to `limit the Agent's world` than the current DevHotel room-pod.

This leads to two honest product tiers:

- **Full Agent Room:** separate-kernel or equivalent strong isolation, default for autonomous work.
- **Compatibility Room:** restricted container backend for contributors and transition testing; never marketed as complete Agent isolation.

The tier is an implementation/security property, not an advanced UI concept. Released Rooms should converge on the Full boundary.

### 2.1 Provider capability contract

The product API must never leak Docker, Podman, Hyper-V or another backend's identifiers. A provider registers immutable identity/version data and declares capabilities; the control plane rejects an operation when the capability is absent instead of silently weakening it.

```text
ProviderDescriptor
  providerId, componentVersion, artifactDigests, hostRequirements
  isolationLevel: separateKernel | sharedKernel | process
  guestOS: linux | windows
  lifecycle: create/start/stop/destroy/reconcile/inventory
  state:
    rootfsPersistence, workspacePersistence
    suspend: none | stop | saveMemory
    snapshot: none | crashConsistent | quiesced | memory
    fork: none | offlineCopy | cow
  exec: streamIO, tty, cancel, exitStatus
  network:
    namespacePerRoom, ingressViaGateway
    defaultRoomToRoom, defaultHostLoopback, defaultPrivateLAN
    egressPolicy, audit
  mounts:
    roomOwnedDefault
    hostGrantModes: none | readOnly | readWrite
    canonicalPathEnforcement, reparseEscapeDefense, revocation
  nestedRuntime: none | rootlessContainers | rootfulContainers
  devices: brokeredGPU, brokeredUSB, hotAttach
  limits: cpu, memory, disk, processCount, io
  distribution: licenseSet, redistributionEvidence, prerequisites, uninstallInventory
```

Normative rules:

- `isolationLevel` describes the boundary around one Room, not around a shared provider VM. WSL2 plus containers is therefore `sharedKernel` even though WSL2 itself is separated from Windows by a VM.
- every mutable call is scoped by DevHotel `roomId`; native provider IDs stay in the ownership ledger only;
- Host paths are absent by default. A mount requires a canonical, expiring DevHotel grant and the provider must prove that junction/reparse/symlink traversal cannot broaden it;
- `stop` and `saveMemory` are distinct. A provider cannot report Sleep as resource-releasing until measured resident-memory gates pass;
- a snapshot capability states what it covers. Workspace, rootfs, attached data volumes, VM memory and service consistency are separate facts;
- Build/Test receives `{ roomId, stateRevision, sourceRevision, environmentRevision, jobId, providerVersion, artifactDigests }`; a provider snapshot handle is internal metadata, never the revision identity;
- provider sockets, hypervisor APIs and Host container daemons are never exposed inside an Agent Room;
- GPU and USB are lease-based broker capabilities, not ambient devices. `nestedRuntime` means containers inside the Room, not access to the Host runtime.

## 3. Candidate comparison

| Candidate | What is directly useful | Windows/host story | Main gaps for DevHotel | Decision |
|---|---|---|---|---|
| Docker Sandboxes | microVM per sandbox, private daemon/filesystem/network, persistent stop/restart, clone workspace, egress policy, credential proxy, CLI/daemon UX | Windows 11 + Windows Hypervisor Platform; Docker Desktop not required | Docker sign-in required; CLI is free but an embeddable OSS/stable API and redistribution rights are not established by the reviewed docs; governance is paid; product data/uninstall ownership must be proven | Highest-priority backend prototype; optional/provider until gates pass |
| OpenSandbox | Apache-2.0 OpenAPI specs, lifecycle server, execd, SDKs/CLI/MCP, SSE, ingress/egress and credential patterns | Current local path is a Python service over a Docker socket | Local Windows substrate and one-installer lifecycle are unsolved; Docker pause does not release Room memory and Docker commit omits mounted data; durable DevHotel Jobs, leases and ownership are additional layers | Prototype `execd` and execution contracts first; do not hand it Room ownership |
| Kaiden | Apache-2.0 desktop Agent workspace UX, provider/extension patterns, secret/network/tool/MCP governance | Current Windows code uses a shared Podman machine through WSL2 or Hyper-V | Source does not establish bundled-runtime provisioning, libkrun on Windows, complete cleanup, a stable daemon/API, or persistent Room semantics | UX/security reference only; direct source reuse is low-value |
| Kubernetes Agent Sandbox | Apache-2.0 Sandbox/Template/Claim/WarmPool model, stable identity, persistence, hibernate/resume, runtime-agnostic CRDs | Requires Kubernetes control plane and runtime | Far too heavy for local Windows MVP; orchestration only, delegates actual isolation | Future remote/cloud provider and lifecycle semantics reference |
| Sandlock | Apache-2.0, unprivileged Landlock/seccomp process sandbox, COW effects, network/syscall policy, very low startup overhead | Linux 6.12+; not a Windows host boundary | Shared kernel, research-stage operational maturity, does not supply persistent full Room/microVM lifecycle | Later fast Tool/MCP/Clean-command isolation inside Hotel |
| Crab | semantics-aware checkpoint selection based on OS-visible effects | Research paper/runtime concept | eBPF/checkpoint integration and production availability; not a Windows product substrate | Learn checkpoint policy after basic correctness |
| DeltaBox | delta filesystem/process checkpoint and fast branching model | Research OS mechanisms | Requires specialized OS support; not drop-in | Long-term Clone/branch/rollback research |

### 3.1 Runtime and VMM component comparison

| Candidate | Boundary and state | Windows/one-installer feasibility | Network, mounts and devices | Maturity/licensing | DevHotel fit |
|---|---|---|---|---|---|
| containerd | No boundary by itself; isolation comes from `runc`, `runhcs`, Kata or another runtime. Snapshotters manage container rootfs layers, not complete Room workspace/service/VM state | Official Windows daemon exists and uses HCS through `hcsshim`; Linux workloads still need a Linux VM/WSL substrate. DevHotel must own setup, CNI, images, services and cleanup | Network and Host mounts are runtime/CNI policy. Never expose its socket. GPU/USB depend on the selected runtime and broker | CNCF-graduated ecosystem, active/LTS release policy; code Apache-2.0, docs CC-BY-4.0 | Strong in-guest/container lifecycle primitive; not a standalone Room provider |
| Podman machine | WSL provider shares one WSL kernel; Hyper-V provider can supply a VM kernel boundary only if DevHotel proves one machine per Room. `init/start/stop/rm` are documented; machine snapshot/clone is not | Signed Windows MSI and WSL/Hyper-V providers exist, but the installer requires the chosen Windows feature in advance and its uninstaller intentionally leaves data/configuration | Windows paths can be mounted; WSL drives are auto-mounted by default. Rootless/rootful containers and Docker-compatible API are useful. WSL USB is Host-brokered and visible to every WSL2 distro after attach | Active OSS project, Apache-2.0 | Useful Hyper-V accelerator prototype or WSL compatibility backend; defaults and cleanup do not meet Room policy without a wrapper |
| Firecracker | One KVM microVM/process and kernel per Room. Memory/device snapshot exists; disks are operator-managed. Restore uses private COW memory mappings; differential snapshots remain developer preview | Requires Linux KVM and `/dev/kvm`; no direct Windows/WHP backend. Running it inside a Windows VM adds nesting and another lifecycle layer | Minimal virtio block/net/vsock device model; Host must implement traffic filtering. No general GPU/USB device model | AWS-maintained, regular releases; Apache-2.0 with some BSD-3-Clause code | Excellent Linux/cloud Full Room substrate; not a direct local-Windows MVP candidate |
| Cloud Hypervisor | Separate VM kernel; snapshot/restore and COW/differencing storage can be composed externally. Snapshot compatibility is not promised across VMM versions | README mentions KVM/MSHV, but the documented Host path and released binaries are Linux-oriented; Windows is documented as a guest, not a Windows-host product path. Direct Windows feasibility is therefore unproven | Richer virtio devices, `virtio-fs`, VFIO and GPU passthrough than Firecracker; policy/network/storage orchestration remains external | Active Rust VMM; REUSE metadata includes Apache-2.0/BSD-3-Clause code and CC-BY-4.0 docs; cloud-workload focus | Linux/remote candidate when richer device support matters; not current evidence for one-installer Windows |
| Kata Containers | One lightweight VM/guest kernel per container or pod; containerd/CRI integration and image sharing over `virtio-fs`. Runtime checkpoint/restore commands are explicitly unsupported | Reviewed install/runtime docs target a Linux virtualization Host; no supported direct Windows-host provider path was found | Containers run inside the guest; GPU/VFIO paths exist. Host mounts/devices need careful policy and privileged containers do not automatically gain Host devices | Mature OpenInfra/CNCF ecosystem, frequent releases; Apache-2.0 | Strong Clean Suite/remote runtime candidate; persistent Room Sleep/Clone requires additional provider-owned state machinery |
| Native Hyper-V Linux VM | Separate kernel per VM. Hyper-V supplies checkpoints, saved state and differencing disks, but DevHotel must define quiescing, disk-chain ownership and service-aware clone | Built into Windows Pro/Enterprise, not Home; enabling features can require admin/reboot. DevHotel distributes the Linux guest artifacts, not Hyper-V itself | Hyper-V switches and explicit VHD/VM resources are controllable. GPU/USB support is not assumed; use broker tests. Containers can run inside the Linux guest without nested virtualization | Microsoft-supported OS component; guest kernel/rootfs and every bundled binary need their own redistribution review | Strong DevHotel-owned Windows control candidate, with edition and engineering-cost gates |
| Managed WSL2 + containerd/Podman | WSL2 distributions are isolated containers inside one managed VM, so Rooms share a Linux kernel. Distro VHDX persists and can be export/imported, but this is not an online Room snapshot API | Custom `.wsl` distros can be distributed and installed from a file; WSL enable/update/reboot/offline behavior remains a prerequisite gate | Default localhost/Host integration and drive automount are too permissive and must be disabled/policed. WSL supports GPU compute; USB uses `usbipd-win` and an attached device is visible to all WSL2 distros | Microsoft-supported Windows feature; WSL, distro and package license/NOTICE sets must be audited independently | Best low-footprint Compatibility Room/control-plane baseline, not Full Agent Room isolation |
| Windows Sandbox | Separate Windows kernel but ephemeral state; internal restart persistence is not persistence across closing the Sandbox | Built into Pro/Enterprise/Education, not Home. No separate VM image, but only one Sandbox instance can run at a time | Networking and vGPU are on by default; `.wsb` can disable them and map Host folders RO/RW. Writable mappings survive by mutating Host data | Microsoft-supported Windows feature and license entitlement | Clean one-off Windows tool/test reference only; incompatible with persistent, parallel Rooms |

## 4. Source-backed findings

### 4.1 Docker Sandboxes

Official documentation states that every sandbox is an isolated microVM with its own Docker daemon, filesystem and network. The Agent has sudo and can install packages inside, while the VM boundary limits Host access to explicitly shared paths. Sandboxes persist across stop/restart.

The workspace model is especially relevant:

- direct mode mounts the Host workspace read-write;
- clone mode mounts the original repository read-only and gives the Agent an in-VM clone;
- multiple named sandboxes support parallel Agent work;
- egress is brokered by a Host proxy with policy and credential injection;
- other sandboxes, Host localhost and raw TCP/UDP are blocked by the documented default boundary.

Important caveats:

- Windows requires Windows 11 and Windows Hypervisor Platform.
- Docker Desktop is explicitly not required.
- Docker account sign-in is required.
- organization governance and audit are commercial features.
- shared Host skills and local Host MCP servers are deliberate boundary exceptions.
- the default direct workspace mode still lets an Agent modify Host code, hooks and configuration.
- stop/restart persistence and Git clone mode are documented, but the reviewed CLI does not establish an immutable Build/Test state snapshot, COW Room fork or memory-snapshot API.
- the private in-VM Docker Engine satisfies nested container use without exposing the Host daemon; no reviewed Sandbox documentation establishes GPU or USB assignment, so both remain `unsupported` until proven.

DevHotel should copy the **boundary pattern**, not blindly copy defaults. Hotel Workspace/clone should be the Agent-first default. Host Workspace must remain an explicit scoped grant. MCP installed by DevHotel should run inside the Hotel whenever possible instead of silently becoming a Host process.

Reviewed sources:

- <https://docs.docker.com/ai/sandboxes/>
- <https://docs.docker.com/ai/sandboxes/get-started/>
- <https://docs.docker.com/ai/sandboxes/architecture/>
- <https://docs.docker.com/ai/sandboxes/security/>
- <https://docs.docker.com/ai/sandboxes/usage/>
- <https://docs.docker.com/ai/sandboxes/faq/>

### 4.2 OpenSandbox

OpenSandbox is the strongest reusable control-plane reference. Its Apache-2.0 repository contains:

- lifecycle and execution OpenAPI specs;
- Python FastAPI lifecycle server;
- in-sandbox execution daemon;
- command and filesystem operations with SSE;
- SDKs in several languages;
- CLI and MCP clients over the same service;
- ingress, egress and credential-vault components;
- Docker and Kubernetes providers;
- snapshot and pause/resume API shapes.

Its public API split is useful: lifecycle management is separate from the in-sandbox exec API. DevHotel can adopt this separation while adding Room semantics, durable Jobs, writer leases, permission grants and Windows ownership.

Reasons not to embed the complete project immediately:

- the documented local runtime requires Docker and Python 3.10+;
- its roadmap says a stable v1 API is not yet planned until lifecycle/runtime/SDK behavior matures;
- Agent audit is still planned;
- background command polling is not evidence of crash-durable DevHotel Job semantics;
- the Docker provider uses `docker.from_env()` and the shared Docker socket; no reviewed code proves Podman compatibility;
- `pause` is Docker container pause, so it does not implement DevHotel Sleep's resource-release contract;
- its Docker snapshot uses `docker commit`, which excludes mounted workspace and database volumes and therefore cannot implement Room Clone;
- container labels are the primary sandbox inventory, while metadata overrides use local JSON and snapshot records use SQLite; this is not a sufficient DevHotel ownership ledger;
- no reviewed material proves a one-installer Windows microVM runtime and complete cleanup boundary.

The source-audited first experiment is narrower than adopting the lifecycle server: put `execd` plus the execution OpenAPI inside a DevHotel-controlled Linux Room image and test command, file, PTY, health, restart and complete-removal behavior. A stock server-in-VM experiment may be used only as a comparison. Room identity, persistence, Sleep/Wake, volumes, Clone and cleanup remain DevHotel-owned.

Apache-2.0 covers the OpenSandbox project source, but a product bundle still needs an SBOM and third-party license review. In particular, its execd image statically builds Bubblewrap, whose upstream license is LGPL-2.0; binary redistribution obligations must be handled rather than inferred from the top-level project license. The reviewed repositories do not supply a complete product-level third-party NOTICE/SBOM for DevHotel to inherit.

Reviewed sources:

- <https://github.com/opensandbox-group/OpenSandbox>
- <https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/api/index.md>
- <https://github.com/opensandbox-group/OpenSandbox/blob/main/server/README.md>
- <https://github.com/opensandbox-group/OpenSandbox/blob/main/ROADMAP.md>
- <https://github.com/opensandbox-group/OpenSandbox/blob/main/LICENSE>
- Source audit baseline: <https://github.com/opensandbox-group/OpenSandbox/tree/83e91528416504eafa429f230999d62634f9af6b>
- Runtime injection: <https://github.com/opensandbox-group/OpenSandbox/blob/83e91528416504eafa429f230999d62634f9af6b/server/opensandbox_server/services/docker/runtime.py>
- Docker snapshot implementation: <https://github.com/opensandbox-group/OpenSandbox/blob/83e91528416504eafa429f230999d62634f9af6b/server/opensandbox_server/services/docker/snapshot_runtime.py>

### 4.3 Kaiden

Kaiden validates that Agent isolation, permission and multi-session UX belong in a desktop control surface. Its product material describes scoped project access, network control, injected credentials, action visibility, MCP/skills configuration and parallel sandboxes. It is Apache-2.0 and advertises Windows support.

The most valuable reuse target is UX and policy modeling:

- visually explicit filesystem/network/tool scopes;
- one dashboard for independent Agent sessions;
- model, MCP, skills and context as workspace configuration;
- secret injection rather than raw secret delivery;
- consistent local/remote Agent experience.

The pinned source audit found a narrower implementation than the product-level description:

- Windows uses Podman CLI/API over a shared Podman machine with WSL2 or Hyper-V providers.
- No libkrun Windows provider, executable or installer exists in the reviewed tree; `+LIBKRUN` is only a test fixture's `crun` build flag.
- Packaging configuration references Podman MSI/image assets that are absent from the reviewed commit, while Windows E2E installs an externally supplied Podman MSI before testing.
- The NSIS uninstall hook removes two Podman Desktop autostart values, not the Podman installation, machines, disks, containers, volumes or data.
- The control plane remains Electron main IPC plus extensions; there is no independent public REST daemon or Kaiden CLI.

Accordingly, Kaiden is a permission/session UX and provider-registry reference, not evidence for DevHotel's One Installer, Full Agent Room, persistence or cleanup guarantees. Its Electron/Podman Desktop coupling also makes direct source transplantation less attractive than copying design patterns.

Reviewed sources:

- <https://openkaiden.ai/>
- <https://openkaiden.ai/docs/ai-agents/>
- <https://github.com/openkaiden/kaiden>
- <https://github.com/openkaiden/kaiden/blob/main/LICENSE>
- Source audit baseline: <https://github.com/openkaiden/kaiden/tree/660333dafa7b6df8adfd3766513d55a2aad6b6e1>
- Windows packaging configuration: <https://github.com/openkaiden/kaiden/blob/660333dafa7b6df8adfd3766513d55a2aad6b6e1/.electron-builder.config.cjs>
- Windows provider E2E: <https://github.com/openkaiden/kaiden/blob/660333dafa7b6df8adfd3766513d55a2aad6b6e1/.github/workflows/workspace-e2e.yaml>
- Uninstall hook: <https://github.com/openkaiden/kaiden/blob/660333dafa7b6df8adfd3766513d55a2aad6b6e1/buildResources/installer.nsh>

### 4.4 Kubernetes Agent Sandbox

The project provides the best mature vocabulary for a future remote provider:

- `Sandbox`: stateful singleton with stable identity;
- `SandboxTemplate`: reusable declared environment;
- `SandboxClaim`: allocation without low-level details;
- `SandboxWarmPool`: pre-created capacity;
- hibernation/resume and persistent volumes;
- runtime choice delegated to gVisor, Kata or another RuntimeClass.

It is an orchestrator, not an isolation engine. Its controller/CRD architecture should influence DevHotel's remote provider and warm Clean Suite allocation, but Kubernetes should not be added to the local Windows install.

Reviewed sources:

- <https://agent-sandbox.sigs.k8s.io/docs/>
- <https://github.com/kubernetes-sigs/agent-sandbox>
- <https://github.com/kubernetes-sigs/agent-sandbox/blob/main/LICENSE>

### 4.5 Sandlock, Crab and DeltaBox

Sandlock uses unprivileged Linux Landlock/seccomp primitives and a supervisor to enforce filesystem, network, IPC and syscall policy without a container or VM. It reports very low startup overhead and includes COW filesystem behavior. Its Linux 6.12+ requirement and shared kernel mean it is not the default Windows Full Room boundary, but it may be excellent for short-lived tools, MCP processes or a Clean command inside an already isolated Hotel runtime.

Crab's key product lesson is to checkpoint when OS-visible state changed, not on every conversational turn. DeltaBox's lesson is that Clone and branch performance should be delta/COW-based rather than full-copy based. Both reinforce the existing product statement: snapshot/checkpoint is an implementation detail; action-based Undo is the user feature.

Reviewed sources:

- <https://arxiv.org/abs/2605.26298>
- <https://github.com/multikernel/sandlock>
- <https://arxiv.org/abs/2604.28138>
- <https://arxiv.org/abs/2605.22781>

### 4.6 containerd and Podman machine

containerd is a mature, portable daemon for image transfer/storage, execution supervision, low-level storage and network attachment. Official releases exist for Linux and Windows; Windows integration delegates to OS-specific libraries such as `hcsshim`. This makes containerd a good component inside a provider, but not a security boundary: `runc` means a shared Linux kernel, `runhcs` can mean process- or Hyper-V-isolated Windows containers, and Kata means a VM-backed pod. Its snapshotter vocabulary refers primarily to container filesystem layers, not a complete, service-consistent Room revision.

Podman on Windows installs a native client and runs Linux containers in a Podman machine backed by WSL2 or Hyper-V. The current official Windows guide is unusually useful for product due diligence: it documents an MSI, per-user/per-machine files, multiple named machines, WSL shared CPU/memory, Hyper-V per-machine allocation, rootless/rootful modes, Docker-compatible API forwarding and explicit removal paths. It also states that WSL/Hyper-V must already be enabled and that uninstall does not clean Podman data/configuration.

Two defaults conflict with DevHotel. WSL exposes Windows drives under `/mnt` unless hardened, while general `podman machine init` defaults include a Host-home mount on VM platforms. Also, WSL USB attachment is Host-brokered and makes the device available to every WSL2 distribution, so DevHotel must never treat it as a Room-private device. A Hyper-V Podman machine per Room is a plausible adapter, but that mapping, concurrent-machine behavior, snapshot/clone, disk ownership and complete cleanup are prototype questions, not established guarantees.

Reviewed sources:

- <https://github.com/containerd/containerd>
- <https://containerd.io/releases/>
- <https://github.com/containerd/containerd/blob/main/docs/getting-started.md>
- <https://learn.microsoft.com/virtualization/windowscontainers/quick-start/set-up-environment>
- <https://learn.microsoft.com/virtualization/windowscontainers/manage-containers/hyperv-container>
- <https://github.com/containers/podman/blob/main/docs/tutorials/podman-for-windows.md>
- <https://docs.podman.io/en/latest/markdown/podman-machine.1.html>
- <https://docs.podman.io/en/latest/markdown/podman-machine-init.1.html>
- <https://github.com/containers/podman/blob/main/LICENSE>

### 4.7 Firecracker and Cloud Hypervisor

Firecracker is the cleanest minimal Linux microVM primitive in this set. It requires Linux KVM and one Firecracker process controls one microVM. Its minimal device model includes block, network, balloon, vsock and serial rather than general USB/GPU emulation. Host code must provide network filtering, disk-image lifecycle, ingress, filesystem sync and device brokering. Firecracker snapshots serialize guest memory and emulated hardware; disk files remain operator-owned. Restore uses private mappings so read-only memory pages can be shared and writes become COW. Differential snapshots are still developer preview, network/vsock connections are not guaranteed to survive, and snapshot portability depends on compatible CPU/kernel/VMM state.

The Firecracker FAQ advertises `<125 ms` startup and `<5 MiB` VMM overhead for its specified minimal configuration. Those are upstream claims on its Linux/KVM design, not DevHotel Windows or workload budgets. They must not be compared directly with a full Room that includes services, workspace sync and gateway readiness. `firecracker-containerd` demonstrates container lifecycle integration, but Firecracker itself is not a container manager.

Cloud Hypervisor provides a richer Rust VMM: Linux/Windows guests, snapshot/restore, CPU/memory/device hotplug, `virtio-net/block/pmem/fs/vsock`, VFIO and documented GPU passthrough. Its snapshot/restore is not supported across VMM versions. Although the README names KVM and Microsoft Hypervisor (MSHV), the reviewed Host prerequisites and release artifacts are Linux-oriented and describe a Linux kernel. **Inference:** MSHV support is not evidence that DevHotel can ship Cloud Hypervisor as a native Windows/WHP executable; that must remain out of the Windows bake-off unless an upstream-supported Windows Host path is produced.

Both VMMs give a Linux guest enough kernel functionality to run a container daemon if DevHotel supplies and supports it. This is containers-inside-the-Room, not nested hardware virtualization and not permission to reach a Host daemon.

Reviewed sources:

- <https://github.com/firecracker-microvm/firecracker>
- <https://github.com/firecracker-microvm/firecracker/blob/main/FAQ.md>
- <https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md>
- <https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md>
- <https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md>
- <https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/versioning.md>
- <https://github.com/firecracker-microvm/firecracker-containerd>
- <https://github.com/cloud-hypervisor/cloud-hypervisor>
- <https://github.com/cloud-hypervisor/cloud-hypervisor/blob/main/docs/vfio.md>
- <https://github.com/cloud-hypervisor/cloud-hypervisor/blob/main/.reuse/dep5>
- <https://github.com/cloud-hypervisor/cloud-hypervisor/tree/main/LICENSES>

### 4.8 Kata Containers

Kata is a containerd/CRI-compatible runtime which places each container or pod in a lightweight VM with its own guest kernel. The current quick-start documents QEMU, Cloud Hypervisor, Firecracker and Dragonball; container root filesystems are commonly shared into the guest over `virtio-fs`. It has active releases, Apache-2.0 licensing and real GPU/VFIO work, making it materially more mature than building a new Linux microVM runtime.

It is still shaped around container/pod lifetime, not a persistent desktop Room. Its own limitations document says runtime `checkpoint` and `restore` are unsupported. Therefore Sleep, Room Clone, live service-state consistency, Build Snapshot and upgrade-safe restore remain DevHotel/provider work. Kata privileged mode elevates inside the guest and does not automatically justify Host-device passthrough, which matches DevHotel's capability model. No reviewed upstream guide establishes a direct Windows Host installation.

Reviewed sources:

- <https://github.com/kata-containers/kata-containers>
- <https://github.com/kata-containers/kata-containers/blob/main/docs/quick-start-guide.md>
- <https://github.com/kata-containers/kata-containers/blob/main/docs/Limitations.md>
- <https://github.com/kata-containers/kata-containers/blob/main/docs/how-to/containerd-kata.md>
- <https://github.com/kata-containers/kata-containers/blob/main/docs/use-cases/NVIDIA-GPU-passthrough-and-Kata-QEMU.md>

### 4.9 Windows substrate and Windows Sandbox

There are three different Windows primitives and they must not be conflated:

- **Windows Hypervisor Platform (WHP)** is a C API for a third-party virtualization stack to create/manage hypervisor partitions. It is not a VMM, Linux image, storage manager, network policy system or Room lifecycle implementation.
- **Hyper-V VM** is the Windows Pro/Enterprise VM product. It offers separate kernels, saved state, standard/production checkpoints, export/import and differencing VHDX chains. Production checkpoints use filesystem freeze for Linux; standard checkpoints also capture memory but can be application-inconsistent. Enabling the Windows feature requires supported hardware/edition and may require admin/reboot. A Linux guest avoids redistributing Windows guest media, but every bundled guest artifact still needs license/SBOM review.
- **WSL2** runs Linux distributions as isolated containers inside one managed VM. Custom `.wsl` distributions can be installed from a file, and distributions can be export/imported/unregistered. That is a viable packaging and persistence mechanism, but not per-Room kernel isolation or an online snapshot/clone contract. Default Host-drive, localhost and interop behavior must be disabled or mediated. GPU compute is supported; USB requires `usbipd-win`, and Microsoft documents that an attached USB device is available to any WSL2 distribution.

Windows Sandbox has the right kernel boundary for a disposable untrusted Windows task and supports `.wsb` controls for networking, memory, vGPU and Host folder mappings. It is nevertheless explicitly temporary: closing it deletes installed software, files and state; only restarts *inside* the open Sandbox persist. It also currently permits only one running instance. Writable mapped folders persist only because they mutate the Host. These properties break persistent Room state, parallel Rooms and controlled Room-to-Host apply, so it is not the primary backend. It may later serve a one-off Clean Windows Test provider if automation and policy gates pass.

Reviewed sources:

- <https://learn.microsoft.com/virtualization/api/hypervisor-platform/hypervisor-platform>
- <https://learn.microsoft.com/windows-server/virtualization/hyper-v/host-hardware-requirements>
- <https://learn.microsoft.com/windows-server/virtualization/hyper-v/checkpoints>
- <https://learn.microsoft.com/windows-server/virtualization/hyper-v/deploy/export-and-import-virtual-machines>
- <https://learn.microsoft.com/windows/wsl/compare-versions>
- <https://learn.microsoft.com/windows/wsl/build-custom-distro>
- <https://learn.microsoft.com/windows/wsl/basic-commands>
- <https://learn.microsoft.com/windows/wsl/wsl-config>
- <https://learn.microsoft.com/windows/wsl/tutorials/gpu-compute>
- <https://learn.microsoft.com/windows/wsl/connect-usb>
- <https://learn.microsoft.com/windows/security/application-security/application-isolation/windows-sandbox/>
- <https://learn.microsoft.com/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file>

## 5. Answers to the fifteen investigation questions

### 5.1 Reusable OSS components

Highest-confidence reuse candidates:

- OpenSandbox OpenAPI schemas, SDK patterns, execd, SSE event vocabulary, ingress/egress and credential-vault concepts/components, subject to component-level dependency and security review.
- containerd for image/container lifecycle inside a DevHotel-owned Linux runtime, with a selected snapshotter/runtime and no Agent access to its socket.
- Kata Containers for a future Linux/remote Clean Suite where a VM-per-pod boundary is useful, after accepting that Room checkpoint/restore is an added layer.
- Kaiden permission/session UI patterns and potentially isolated libraries after a code/dependency audit.
- Kubernetes Agent Sandbox API concepts and controller code for a future remote provider.
- Sandlock for later Linux process/tool isolation.

Docker Sandboxes is a provider/prototype candidate, but reviewed docs establish free commercial use of its CLI, not an Apache/MIT-style embeddable OSS foundation or redistribution agreement.

### 5.2 Strong Windows isolation with the smallest Host footprint

The strongest currently documented fit is a provider-managed microVM using the Windows hypervisor, with one private kernel per autonomous Room. Docker Sandboxes proves this product shape can work without Docker Desktop, but introduces its own CLI/account/product dependency. A native Hyper-V provider exposes documented checkpoint/differencing-disk primitives but is limited to supported Windows editions. WHP is lower-level and would require DevHotel to integrate or write substantially more VMM functionality, so it is an API substrate rather than the first implementation choice.

A DevHotel-owned WSL distribution is straightforward to package and clean up, and Windows can disable distro interop, Windows PATH injection and automatic drive mounting. However, one WSL VM shared by all Room containers is a weaker Room-to-Room boundary than one microVM per Room. It is suitable as a management/runtime plane or compatibility backend, not automatically sufficient for unrestricted autonomous Agents.

### 5.3 Backend without Docker Desktop

Use one DevHotel contract and hostile-workload suite for a three-way bake-off:

1. **Docker Sandboxes adapter:** strongest ready-made product-shape candidate; gate CLI/API automation, account/offline policy, redistribution, Room-owned storage, clone semantics and complete uninstall.
2. **DevHotel-managed Hyper-V Linux VM:** strongest ownership/control candidate; use standard Hyper-V/VHDX primitives rather than building a hypervisor. Gate Windows editions, feature enable/reboot, guest-agent recovery, COW fork, networking and update compatibility. A Podman-machine Hyper-V adapter may be measured as an accelerator within this lane, but is not presumed to satisfy the state contract.
3. **Managed WSL2 + containerd/Podman compatibility baseline:** likely smallest Windows footprint and broadest Linux tooling path. Harden automount, interop and network defaults; label it `sharedKernel`; measure whether its cost advantage warrants a restricted Compatibility Room.

Run OpenSandbox `execd`/protocol inside candidates 2 and 3 as the common execution-plane experiment, not as a fourth isolation substrate. Do not spend the first Windows bake-off on Firecracker, Cloud Hypervisor or Kata unless upstream supplies a supported direct Windows Host path.

### 5.4 Persistent Room sleep/resume cost

Measure rather than infer. Required benchmark matrix:

- cold create, warm start, stop, resume and delete latency;
- idle RAM after 1/5/10 sleeping and running Rooms;
- base VM/image deduplication and per-Room disk growth;
- dependency-heavy Node project and PostgreSQL/Redis persistence;
- Windows reboot and daemon crash recovery;
- Host Workspace versus Hotel Workspace filesystem performance.

Docker Sandboxes documents persistence across stop/restart; Kubernetes Agent Sandbox documents hibernation/warm pools. Neither substitutes for DevHotel's Windows measurements.

### 5.5 Instant Clone technology

Use immutable base images plus COW/differencing storage for source/rootfs and service-aware data copy for databases. Do not raw-copy a live database volume. Record immutable image/component digests in the Room manifest. Evaluate VM differencing disks, filesystem reflink/block clone and runtime snapshot support during the backend bake-off. Crab/DeltaBox remain later optimization research.

### 5.6 Room network isolation

The default policy must be:

- no direct Room-to-Room traffic;
- no Host localhost/private-LAN access;
- no raw access to the runtime daemon;
- explicit gateway ingress only;
- policy-brokered egress with an observable allow/deny log;
- capability-mediated credentials added at the boundary, not stored in the Agent process when possible.

For a compatibility container backend, give every Room a separate internal network and verify denial with a two-Room adversarial smoke test. A microVM provides the stronger default boundary.

### 5.7 Same internal ports

Every Room owns a network namespace or VM network, so `3000`, `5432` and `6379` can repeat. A single DevHotel gateway maps stable local domains to explicit Room ingress endpoints. Host port allocation remains internal metadata.

### 5.8 Permission-based Host filesystem mounts

Hotel Workspace is the Agent-first default. Host Workspace requires a user-approved canonical directory grant with read/write mode, expiry/revocation and audit. Reject roots and broad profile directories, and block symlink/junction/reparse escape. A safer parallel workflow mounts the Host repository read-only and creates a private in-Room clone.

### 5.9 Android physical device arbitration

DevHotel owns the Host-side device broker. Agents receive device capability operations, not raw Host `adb` or USB control. A reservation includes device ID, Room, Agent, lease expiry, fencing token, queue position and cleanup hook. Install/run/log operations validate the reservation. `adb kill-server`, driver changes and device-wide reset remain privileged broker operations. Emulator instances can be Room-owned; physical devices remain shared Hotel resources.

### 5.10 Check-in and exclusive lease

Store leases transactionally with `room_id`, `holder`, `expires_at`, heartbeat and monotonically increasing `fencing_token`. Every mutation carries the token and conditionally updates the expected Room resource version. Take Over increments the token before revoking old credentials. Human-readable Room Key is an identifier; the real credential is high entropy and redacted.

### 5.11 Stable REST API and CLI

Start from versioned OpenAPI resources, not Electron IPC shapes. Use a local authenticated endpoint, runtime validation, idempotency keys, resource versions and SSE/event replay. CLI, GUI and MCP call the same client library. Generic sandbox lifecycle/exec can resemble OpenSandbox, while DevHotel adds `/rooms`, `/check-ins`, `/leases`, `/jobs`, `/capabilities`, `/grants`, `/resources` and `/artifacts`.

### 5.12 Separate DevHotel updates from Room runtime

Use separate app, daemon/runtime and Room-component channels. Persist exact component build IDs/image digests per Room. An app update drains mutations and durable workers safely but does not resolve floating image tags or change Node/DB versions. Runtime migration is explicit, compatibility-checked and recoverable.

### 5.13 Keep MCP/runtime/packages inside the Hotel

Package Room Services as pinned OCI/artifact definitions installed into a Room or Hotel service sandbox. The Host stores only DevHotel binaries, ownership metadata and narrowly scoped integration. Local stdio MCP on the Host is treated as an explicit Host capability exception, not the default topology.

### 5.14 Fast Clean Build/Test instances

Create a Clean Run from immutable source revision, Room declaration and component digests. Reuse read-only base layers and dependency caches without sharing writable state. Add a warm pool only after correctness and cleanup are proven. Job owns the transient instance and artifact retention policy.

### 5.15 Minimum layer DevHotel must add

Even with a reusable sandbox provider, DevHotel still uniquely owns:

- Room/Hotel language and persistent lifecycle;
- Windows installer, footprint, gateway, tray and browser control surface;
- Web runtime/service discovery and Quick Change/Check/Undo;
- Check-in, Room Key, exclusive lease and fencing;
- durable Jobs, logs and artifacts;
- capability catalog, permission grants and audit;
- shared physical resource broker;
- service-aware Clone and Clean Suite;
- provider-neutral API and migration/ownership model.

DevHotel should not own a hypervisor, container runtime, filesystem checkpoint engine or Kubernetes implementation unless every viable reusable provider fails a documented release gate.

## 6. Prototype gates

Each backend prototype gets the same black-box test suite.

### Security

- Agent root cannot read Host files outside an approved grant.
- Agent cannot reach Host localhost, private LAN or another Room by default.
- Agent cannot access the management/runtime socket.
- a revoked/taken-over Agent cannot mutate a Room.
- secrets can be used for an approved destination without appearing in process environment, logs or diagnostics where the provider supports proxy injection.

### Lifecycle

- persistent package/rootfs/workspace/service state survives stop, app exit and reboot;
- Build started at `R100` reads exactly `R100` while the mutable Room advances to `R101`; output metadata names both the state revision and provider/artifact versions;
- snapshot coverage is proven independently for workspace, rootfs, attached data volumes and, when claimed, memory;
- snapshot/fork with PostgreSQL or another stateful service is either quiesced and consistent or explicitly classified crash-consistent;
- accepted Job survives client disconnect;
- clone is isolated and reproducible by digest;
- failed create/clone/delete retains ownership metadata and can recover;
- full uninstall deletes only proven DevHotel-owned resources.

### Product/operations

- one DevHotel installer from a clean Windows 11 image;
- no separate Docker Desktop, Host Node/Python/database or global PATH mutation;
- offline/retry and proxy behavior is explainable;
- storage location and usage are visible;
- licensing permits bundling/redistribution and the expected commercial model;
- nested rootful containers, when claimed, cannot reach the Host provider socket or broaden Host mounts;
- GPU/USB attach, exclusive lease, revoke, Room transfer and Host recovery pass on each specifically supported device class;
- cold/warm latency, RAM and disk meet a written budget.

### Measurement protocol

Do not adopt vendor benchmark numbers as DevHotel results. Before running a prototype, record the test PC, Windows edition/build, CPU, RAM, disk, virtualization/security settings, provider/component versions and a pass/fail budget. Then run the same scripted workload and publish raw samples plus median and p95 where repeated measurements are meaningful:

- clean-install package/download size, admin prompts, Windows feature changes, reboot count, offline install and full removal;
- cold create-to-exec-ready, warm start, stop, memory-releasing Sleep, resume, snapshot, fork-to-ready and destroy;
- Host working set/commit and CPU for 1/5/10 idle and active Rooms; physical and logical disk growth for a base plus 1/5/10 clones;
- Room-local source sync and filesystem performance on a pinned representative repository, followed by its real dependency install, Build and Test;
- one Node/service workload and one stateful database workload across stop/reboot/snapshot/fork;
- two hostile Rooms testing Host filesystem, Host localhost/private LAN, cross-Room traffic, provider socket and reparse/symlink escape;
- Windows reboot, daemon crash and forced process-kill recovery, including orphan reconciliation and idempotent cleanup.

If a provider lacks a claimed operation, record `unsupported`; do not substitute a full copy for COW fork or a paused process for memory-releasing Sleep without changing the capability declaration.

## 7. Next experiments

1. Turn section 2.1 into a versioned provider schema plus conformance tests; finish the threat model and written measurement budgets before choosing a runtime.
2. Run the Docker Sandboxes Windows spike without release integration: lifecycle automation, fixed-state Build, storage ownership, network, clone, offline/account behavior, license terms and uninstall.
3. Run the native Hyper-V Linux VM lane, optionally measuring Podman machine Hyper-V as an accelerator: DevHotel guest agent/`execd`, VHDX COW/checkpoints, container-in-Room, gateway, recovery, edition prerequisites and removal.
4. Run the managed WSL2 + containerd/Podman compatibility lane with automount/interop disabled and adversarially verify the declared `sharedKernel` boundary.
5. Benchmark the three lanes with the identical suite in section 6. Keep upstream claims in a separate column from measured DevHotel results.
6. Record adoption, rejection or another bake-off in a later ADR with raw results, SBOM/NOTICE and redistribution evidence. No prototype result is a shipped-product claim.

## 8. Related DevHotel documents

- [Product Goal](../../../goal.md)
- [Agent Runtime design](./2026-08-10-devhotel-agent-runtime-design.md)
- [Managed Runtime design](./2026-08-10-devhotel-managed-runtime-design.md)

## 9. Platform references

- Microsoft WSL custom distribution: <https://learn.microsoft.com/windows/wsl/build-custom-distro>
- Microsoft WSL import/export/unregister: <https://learn.microsoft.com/windows/wsl/basic-commands>
- Microsoft WSL distribution flags: <https://learn.microsoft.com/windows/win32/api/wslapi/ne-wslapi-wsl_distribution_flags>
- Windows Hypervisor Platform: <https://learn.microsoft.com/virtualization/api/hypervisor-platform/hypervisor-platform>
- Hyper-V checkpoints: <https://learn.microsoft.com/windows-server/virtualization/hyper-v/checkpoints>
- Windows Sandbox: <https://learn.microsoft.com/windows/security/application-security/application-isolation/windows-sandbox/>
