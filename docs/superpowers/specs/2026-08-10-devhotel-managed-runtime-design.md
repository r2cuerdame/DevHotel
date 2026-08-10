# DevHotel Managed Runtime — Design

**Status:** Product direction / release-gate design

**Scope:** Windows 11, Web Room first

**Implementation status:** Managed-runtime release target. The current developer preview still uses an external Docker Engine. It now has an initial Hotel Service catalog and pinned GitHub Service provisioning/credential slice, but not the independent daemon, managed isolation runtime, Agent-native assignment/injection, or context-aware permission Gateway described here.

## 1. Why this exists

Room isolation is not enough if DevHotel asks the user to install and manage Docker Desktop, Node.js, databases, global PATH entries, and unrelated host services.

The shipping product boundary is therefore:

> **Install DevHotel once. DevHotel owns everything it needs, and can remove everything it created.**

The current external-Docker backend remains a developer-preview compatibility adapter. It is not the final installation architecture and must not be marketed as `Zero Prerequisites`.

## 2. Product invariants

1. The user installs one Windows application.
2. Project runtimes and services never install into the host's global development stack.
3. The isolation runtime has a DevHotel-specific identity, data root, version, health state, and uninstall path.
4. No Docker daemon socket or privileged TCP endpoint is exposed to other host applications.
5. DevHotel application updates do not silently change a Room's Node, package-manager, PostgreSQL, or Redis version.
6. Sleep preserves Room data while stopping every Room-owned process.
7. Complete removal deletes only resources proven to be owned by DevHotel.
8. If Windows needs virtualization, an optional feature, elevation, or a reboot, the installer explains and records that change.
9. A pre-existing WSL distribution, VM or runtime data root is never adopted or deleted by name/path alone.
10. Room components are pinned by immutable image digest or component build ID, not only by a floating major-version tag.
11. GitHub and later MCP/Skills packages and their dependencies are DevHotel-owned Hotel resources: installed once, absent from global PATH, and removable without touching unrelated Host software.
12. Installing a Hotel service never grants Host or Room access; Agent context and permission are evaluated separately for every use.
13. Room Services and project-versioned tools remain Room-owned even when they consume Hotel infrastructure; Hotel updates never silently change their versions or state.

## 3. Target architecture

```text
DevHotel.exe
├─ Lobby / browser UI / tray / updater
├─ Stable REST API / Agent Gateway
│  ├─ Host/Room context and permission enforcement
│  └─ Windows web gateway and local CA
├─ Hotel Service Controller
│  ├─ GitHub Service / credentials / permissions
│  ├─ device pool / queue / scheduler / registry / update
│  └─ later MCP / Skills lifecycle and context routing
├─ Managed Runtime Controller
│  ├─ install / resume / health / repair
│  ├─ version and migration state
│  ├─ storage inventory and cleanup
│  └─ uninstall manifest
├─ Full Agent Room Provider
│  └─ per-Room Windows Hypervisor Platform microVM or equivalent
│     ├─ private Linux kernel and runtime daemon
│     ├─ Room filesystem and network
│     └─ no implicit Host filesystem/network access
└─ Compatibility Provider
   ├─ optional DevHotel-owned WSL/OCI runtime
   └─ external Docker adapter for contributors only
```

This is a logical ownership diagram, not a public process-placement contract. The exact VM/OCI implementation and the placement of each Hotel service may change. A service may run as a constrained Windows helper, in the managed runtime, or beside a Room when the capability requires it; clients still see the same service ID/version, health, context and permission result through the Gateway. The stable application contract is a managed isolation backend, not a Docker product, WSL distribution, process tree or command name. The default autonomous-Agent provider must satisfy the separate-kernel threat model; a shared-kernel WSL/container provider is not promoted to Full Agent Room without equivalent evidence.

The service boundary is semantic, not “anything with a CLI.” PostgreSQL, Redis, Web, Build/Test, local HTTPS, backup, Node, pnpm, Vite, Prisma and compilers are Room-owned when they define a project's environment or reproducibility. `gh`, and later candidates such as `glab`, `aws`, `gcloud`, `vercel` or `kubectl`, can back Hotel CLI Services when they broker shared external infrastructure and credentials. The common control contract covers manifest, lifecycle, health, assignment, permission and scoped connection; service-specific commands stay with the native service adapter.

### GitHub Service ownership

GitHub is the first concrete Hotel Service. DevHotel downloads and verifies a pinned `gh` build into its data root, keeps its encrypted credential private to the Hotel, updates it on the Hotel Service channel, and removes it through the ownership manifest. It does not adopt Host `gh`, Host PATH or a user's global GitHub CLI session. An Agent adapter connects the native GitHub interface to an approved `hotel | host-project | room` context; DevHotel does not duplicate every GitHub operation in its core API. Room-free use still requires explicit Host-project and credential scope.

## 4. Host footprint

The expected host footprint is explicit and inspectable:

- DevHotel application under the per-user install directory.
- DevHotel application data and manifests.
- DevHotel-owned runtime binaries, base images and per-Room VM/disks under the data root.
- DevHotel-owned Hotel service packages, resolved versions, caches and service state under the data root.
- If a WSL compatibility provider is installed, a DevHotel-owned distribution such as `DevHotelRuntime` under that data root.
- Optional Windows-start entry.
- Optional DevHotel local CA trust entry.
- Windows integration state required to reach Room domains.

DevHotel must not add global Node/npm/pnpm/JDK/SDK installations, user PATH entries, arbitrary background services, or a shared Docker context.

At provisioning time DevHotel refuses to overwrite a pre-existing VM, data root or `DevHotelRuntime` distribution unless a deliberate recovery/adoption flow proves ownership. Each installation has a random install GUID stored both in the Host ownership manifest and inside every managed runtime root. VM deletion or `wsl --unregister` is allowed only after those values and the canonical storage path match. The manifest also records whether DevHotel enabled a Windows optional feature so removal never disables a feature that was already enabled by the user or another product.

Settings → Host footprint shows the physical locations, runtime version, total storage, Room storage, cache/image storage, and every removable integration.

## 5. Installation state machine

Installation and first launch use a recoverable state machine:

```text
not-installed
  → checking-windows-capabilities
  → enabling-required-windows-feature (only when needed)
  → reboot-required (resumable)
  → provisioning-runtime-provider
  → verifying-runtime-manifest
  → starting-private-daemon
  → health-checking
  → ready
```

Every completed phase is recorded outside the runtime disk so an interrupted install can resume or roll back. Downloads and runtime archives are version-pinned and checksum-verified before import.

The application may open before preparation completes, but the Lobby shows a product-level state such as `Preparing DevHotel` rather than Docker/WSL/container terminology. Room creation stays disabled until the runtime is healthy.

## 6. Runtime command boundary

Core code must not spawn a globally resolved `docker` command directly.

All backend operations go through a runtime executor interface:

```ts
interface RuntimeExecutor {
  health(): Promise<RuntimeHealth>
  run(args: string[], options?: RunOptions): Promise<ExecResult>
  toGuestPath(hostPath: string): Promise<string>
  storage(): Promise<RuntimeStorage>
}
```

Production uses the managed provider selected by the measured backend bake-off in the [Sandbox Research ADR](./2026-08-10-devhotel-sandbox-research.md). The target default is a separate-kernel Full Agent Room. A managed-WSL executor may serve a restricted compatibility tier; the external-Docker executor is available only for repository development, tests, and an explicitly labeled compatibility mode.

Linked local folders require deliberate Windows-to-guest path mapping and clear performance/permission checks. Managed Git Rooms keep their source inside the DevHotel runtime and do not require host Git.

## 7. Ownership and cleanup

Ownership is proved through both labels and a durable manifest.

The manifest records:

- runtime provider, VM/distribution identity and version;
- Room IDs and volumes;
- managed images and caches;
- local CA fingerprint;
- startup and network integration;
- physical data roots;
- incomplete install, migration, clone, and delete operations.
- the per-install ownership GUID stored inside and outside the runtime;
- the exact runtime endpoint/engine identity used by a compatibility backend;
- resolved immutable component/image digests referenced by each Room.

Prefix matching alone is not sufficient authorization for destructive cleanup.

The removal experience offers two explicit choices:

### Remove app, keep Rooms and data

- Stop active Room processes safely.
- Remove the desktop application and optional startup entry.
- Keep the managed provider data and Room disks/data for reinstall/recovery.
- Tell the user exactly how much data remains and where it lives.

### Remove DevHotel and delete Rooms/data

- Block new mutations.
- Sleep or stop every Room.
- Remove Room containers, volumes, browser profiles, logs, backups, images, and caches.
- Stop and remove verified DevHotel-owned Hotel service packages, processes, caches and context bindings.
- Remove CA trust and Windows integration owned by DevHotel.
- Terminate and delete every verified DevHotel-owned Room VM/runtime; unregister `DevHotelRuntime` only if that compatibility provider was installed and its ownership proof matches.
- Remove the DevHotel data root and application.
- Preserve an error report instead of deleting ownership metadata if cleanup cannot finish.

Cleanup never removes an external Docker installation or unrelated WSL distribution.

Before a destructive compatibility-backend operation, DevHotel verifies that the current engine identity matches the identity recorded when the Room resource was created. A changed Docker context, endpoint, remote daemon, missing ownership label, unexpected driver, reparse point, or manifest mismatch stops cleanup and preserves retry metadata.

## 8. Updates

Application, managed runtime, Hotel service, and Room stack versions are separate channels:

- **App update:** UI/orchestrator fixes; active Rooms are gracefully slept before replacement.
- **Runtime maintenance:** explicit, compatibility-checked update of the private daemon/base distribution.
- **Hotel service update:** explicit update of one shared GitHub or later MCP/Skills service package; existing context bindings and grants remain separate and are revalidated for compatibility.
- **Room change:** user-requested Node/service/package-manager change recorded as an undoable Room action.

A runtime migration creates a safety checkpoint of control metadata, runs schema compatibility checks, and leaves existing Room version selections unchanged.

## 9. Failure and recovery

DevHotel distinguishes:

- runtime unavailable;
- runtime preparing;
- runtime repairable;
- runtime update required;
- Room broken while runtime is healthy.

Repair operations act only on the managed runtime. They do not reset Room volumes unless the user selects a destructive recovery with a displayed impact summary.

After an abnormal exit, startup reconciliation uses the ownership manifest to stop or remove incomplete resources, marks partially created/cloned Rooms as needing attention, and never erases their source or service data automatically.

## 10. Security boundary

- The private daemon does not listen on a host TCP port.
- Renderer code never receives daemon access or arbitrary host command execution.
- IPC validates all Room mutations in the main process.
- Host Agents and Room Agents enter through the same context-aware Agent Gateway. Room calls reach the Room-scoped orchestrator; Host/shared-resource calls require their own explicit grant.
- A Hotel service being installed or healthy does not authorize access. The Gateway derives the effective scope from Agent identity, Host/Room context, target, lease/fencing state and grant.
- Hotel service processes receive only scoped handles and never a privileged daemon/runtime socket, raw CLI passthrough or unrestricted Host shell because of their physical placement.
- Secrets remain in Room-scoped storage and are redacted from diagnostics.
- Runtime archives, upgrades, and helper binaries are pinned and checksum-verified.

## 11. Delivery stages

### Stage A — transition safety

- Resolve the current compatibility CLI without requiring PATH mutation.
- Label external Docker as a developer-preview dependency.
- Fail clearly when the compatibility backend is unavailable.
- Gracefully stop Rooms before app update or uninstall.

### Stage B — managed-runtime vertical slice

- Provision the selected Full Agent Room provider on a clean Windows 11 VM.
- Run two Web Rooms with the same internal port.
- Sleep/wake and reboot without losing state.
- Prove no external Docker, Node, or database installation is required.

### Stage C — lifecycle ownership

- Storage inventory and safe cache/image cleanup.
- GitHub Service install/update/remove inventory with pinned build ownership, private auth/config and context bindings kept separate.
- Later MCP/Skills Hotel Service inventory using the same ownership/permission boundary.
- Runtime repair and versioned migration.
- App-only uninstall and complete uninstall.
- Crash/reboot recovery for install, clone, change, and delete.

### Stage D — release gate

- Fresh-install, upgrade, rollback, reboot, low-disk, offline-retry, enterprise-policy, and complete-uninstall tests on Windows 11.
- External Docker is removed from end-user requirements and remains only as an explicit contributor backend.

## 12. Acceptance criteria

The managed runtime is complete only when all of the following are demonstrated:

1. A clean Windows 11 machine installs DevHotel without a preinstalled Docker/Node/DB stack.
2. The North Star Web demo passes using only the DevHotel-owned runtime.
3. Reboot and application update preserve Room data and selected versions.
4. An AI Agent installing a tool cannot affect the host or another Room.
5. Host footprint reports every DevHotel-owned location and integration.
6. Complete uninstall removes the managed distribution, Room data, cache/images, CA trust, and startup integration.
7. Uninstall failure preserves enough ownership metadata to retry cleanup safely.
8. A colliding pre-existing VM, WSL distribution or runtime data root cannot be overwritten or removed without verified ownership.
9. Clone/wake/clean-run uses the Room's recorded immutable component digests and does not silently advance floating images.
10. GitHub Service uses a pinned Hotel-owned `gh` and private auth/config without Host `gh` or global login prerequisites, and remote mutations fail without an explicit structured grant.
11. Complete uninstall removes verified Hotel service packages and state without deleting unrelated Host tools or widening any Agent grant.
12. Later MCP/Skills packages can be installed once and serve separately authorized contexts without becoming Room installs.
