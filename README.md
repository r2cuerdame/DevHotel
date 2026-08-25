# DevHotel

[![Download](https://img.shields.io/github/v/release/r2cuerdame/DevHotel?sort=semver&label=download&color=2ea44f)](https://github.com/r2cuerdame/DevHotel/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/r2cuerdame/DevHotel/total?label=downloads)](https://github.com/r2cuerdame/DevHotel/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%2011-0078D4)](#download)
[![License](https://img.shields.io/github/license/r2cuerdame/DevHotel)](./LICENSE)
[![Release build](https://github.com/r2cuerdame/DevHotel/actions/workflows/release.yml/badge.svg)](https://github.com/r2cuerdame/DevHotel/actions/workflows/release.yml)

> **Give AI a room, not your computer.**
>
> **Inside the Room, AI is free to act. Outside the Room, permission is required.**
>
> **One Room. One Writer. No Accidental Conflicts.**

DevHotel is being built as a local Agent Runtime that gives AI a strongly isolated, persistent development server — a **Room** — instead of access to your computer. Humans supervise permissions, state, jobs, and results through a browser-like Windows client.

> DevHotel protects the computer, not by limiting the agent, but by limiting its world.

Easy Setup · Easy Change · Easy Check · Easy Undo

Quick Start · Quick Change

- **Isolation First:** Room-owned files, processes, network, dependencies, and service data must not affect another Room or the Host. In the target architecture, a selected Host folder is a scoped source/sync endpoint; the Room imports it into Room-owned working state and writes back only through explicit Apply, Export, or Commit actions.
- Two rooms can use the same internal web, PostgreSQL, and Redis ports at the same time — each room has its own network namespace.
- **Your desktop stays yours while tests run.** A Room's UI input is injected inside the Room — in-Room `adb`, the Room's own browser, the emulator's own display — so nothing moves the real cursor, presses real keys, or steals the foreground window. The one path that does take the Host desktop (opening a Windows Room in the VMware console) is a named, user-only, journaled capability. See [Host input isolation](./docs/host-input-isolation.md).
- Rooms are reached by stable domains like `https://my-project-dev.localhost`, never by port numbers.
- Sleeping a room stops every process it owns and frees CPU/RAM; its dependencies, data, and browser session survive app restarts and reboots.
- PostgreSQL and Redis are Room-scoped **Services**, with their own health, storage, version, and connection environment.
- A working Web Room can be cloned into `stage` or `node24-test`, optionally including dependencies and service data; the clone receives a fresh isolated browser profile.
- Quick Changes run as verified transactions with **action-level Undo**: `↶ Undo: Node 22 → 24`.
- When something breaks, a 14-step check pipeline tells you *which* layer failed, and **Copy Diagnostic** produces a secret-redacted bundle you can paste into an issue or an LLM.
- **Reset Room** hands a Room back clean without checking out: it keeps the room number, nickname, domain, plan, source code and history, and rebuilds only what it can — dependencies, caches, Room App data, browser profile. Room App data is dumped to a safety backup first.
- Three Room kinds today. **Web** is the primary served-site provider. **Android** builds APKs with no Host SDK or `adb` and shows a Room-owned KVM-backed emulator screen — portrait or landscape, with Back/Home/Recents/Rotate — as its site. **Windows (VMware)** clones a Workstation template snapshot into a Room-owned VM; guest exec and file ingress are deliberately later capabilities, and shared physical devices remain a later Hotel Device Service.

See [goal.md](./goal.md) for the full product definition (Korean).

## Agent-first architecture

The target product core is a stable local DevHotel daemon, a versioned REST API, and a context-aware Agent Gateway. GUI, CLI, the DevHotel MCP adapter, and future SDKs are clients of the same state and permission model. Long-running builds and tests are durable Jobs, independent of client connections.

Every Room owns the working state it executes. Build and test Jobs consume an immutable `StateRevision`, allowing the Room to keep changing without changing a Job's inputs. Host source is ingress/sync, not a live execution bind; Clone, Undo, and Suite share the same revision primitive. See the [Working State / Sync / Build design](./docs/superpowers/specs/2026-08-10-devhotel-working-state-design.md).

An Agent checks into a Room with an exclusive writer lease. Heartbeats and fencing tokens prevent stale writers after takeover. Parallel Agents get independent Room clones by default. Host folders, devices, secrets, public URLs, and other outside resources require explicit scoped permission grants.

DevHotel distinguishes two service layers. A **Room Service** belongs to one Room's environment: PostgreSQL, Redis, its web process, build/test execution, local HTTPS, and backups. It may consume shared infrastructure, but its configuration, state, and lifecycle remain Room-scoped. A **Hotel Service** is shared infrastructure owned once by DevHotel: GitHub integration, credentials and permissions, device pools, queues/scheduling, registry/update infrastructure, and later MCP or Skills catalogs. Hotel Services are bound to a Room or Agent through permission; they are not installed into each Room.

The first concrete Hotel Service is **GitHub Service**. This preview provisions a checksum-verified, pinned `gh` build in Hotel-owned storage and can keep an explicitly supplied GitHub token in Electron's encrypted credential vault; it does not resolve or authenticate through Host `gh`. Provisioning makes the service available but does not enable it for an Agent. The current vertical slice covers owned installation, version/health checks, credential Connect/Disconnect, and cleanup with Hotel data. Agent assignment, scoped permission enforcement, native-interface connection, and revoke are still target control-plane work. Project-versioned Node, pnpm, Vite, Prisma, and compilers remain Room-owned because they affect reproducibility. MCP and Skills are later Hotel Service categories, not Room package installs. The DevHotel MCP adapter remains a replaceable client of the stable REST API, not the foundation or lifecycle owner. See the [Agent Runtime design](./docs/superpowers/specs/2026-08-10-devhotel-agent-runtime-design.md) and [sandbox/backend research ADR](./docs/superpowers/specs/2026-08-10-devhotel-sandbox-research.md).

> **Target architecture:** the current developer preview still keeps orchestration in the Electron main process and does not yet provide the independent daemon, durable Job recovery, Room Key, lease, fencing, or capability-grant model described above.

## One Installer. Zero Prerequisites.

This is a hard product and release goal, not a convenience item. The shipping product must install and manage its own isolation runtime, keep runtimes/images/caches/rooms in a DevHotel-owned data area, show storage use, clean unused resources, and offer a complete `Remove DevHotel + Delete Rooms/Data` uninstall path.

Users must not have to install or manage Docker Desktop, Node.js, PostgreSQL, Redis, or another container runtime to use the released product.

## Current developer preview

> **Important:** the current developer preview has not reached the zero-prerequisite goal. It still uses an external Docker Engine through the `docker` CLI. The DevHotel-owned managed runtime, dedicated lifecycle, and complete cleanup/uninstall flow are not finished yet.

The compatibility backend separates direct Room-to-Room traffic, but it does not yet enforce the Full Agent Room policy that also blocks Host gateway/private-LAN egress. Do not use it as the final security boundary for an untrusted autonomous Agent.

Room-local changes made only in a container's writable root filesystem are not yet a durable, cloneable component contract, and compatibility images are still selected by floating major-version tags rather than recorded immutable digests. Managed workspace, dependency and service volumes persist, but the final Agent Room must also preserve or declaratively reproduce installed system tools and clone the exact resolved component builds.

New Local Folder Rooms import Host source through a short-lived read-only mount into a Room-owned source volume. **Sync from Host** stages and fingerprints a new generation, rejects detected Room-side drift, and never writes back implicitly. Existing Local Folder Rooms stay in visible `legacy-host-bind` compatibility mode with Agent mutation/Clone blocked until the user selects **Move into Hotel**. Import is currently a full staged copy rather than incremental/COW sync. Android Clean Build snapshots the complete Room-owned source, uses the pinned image with disposable SDK/Gradle state, and exports APKs plus verified provenance under the Room; Web Build/Test and durable per-Job recovery still lack the shared immutable `StateRevision` implementation.

Current preview requirements:

- Windows 11 (first supported OS)
- Docker Engine — Docker Desktop with the WSL2 backend, or any engine exposing the `docker` CLI
- Android Rooms additionally need KVM through that engine; Windows Rooms need VMware Workstation Pro on the host

## Download

**[⬇ Download the latest installer](https://github.com/r2cuerdame/DevHotel/releases/latest)** — `DevHotel-Setup-<version>.exe`, Windows 11 x64.

Run the installer and DevHotel starts in the tray. It keeps itself up to date from Releases; app updates never silently change a Room's Node, PostgreSQL, Redis, or package-manager selection — Room stacks change only when you change them.

This is a developer preview: it still expects the external Docker requirement above, so it is not yet the zero-prerequisite install described in the previous section. Windows Rooms additionally need VMware Workstation Pro on the host.

Every release ships `DevHotel-Setup-<version>.exe`, its `.blockmap`, and `latest.yml`; the `latest.yml` checksum must match the installer or auto-update refuses the download. Releases are cut locally rather than by CI — see [Releasing](./docs/releasing.md).

## Hotel Services — shared infrastructure, scoped access

In the target control plane, Hotel Services are installed and updated once in DevHotel-owned storage, then connected through the Agent Gateway. Selecting a Hotel Service for a Room creates an access binding; it does not create another physical installation. This layer must not be confused with Room Services such as PostgreSQL or Redis, whose state and lifecycle belong to an individual Room. The current preview has the persistence and manifest foundation, but does not yet expose these generic assignment or connection operations.

Hotel Infra and Rooms are independent. A Host Agent may use an assigned Hotel Service without creating or waking a Room, but **No Room does not mean unrestricted Host access**: selected projects, folders, credentials, devices, and networks still require explicit grants. Availability never implies enablement. DevHotel prepares and maintains; the guest decides and uses.

Availability is not authority. In the target Gateway, every call carries an Agent identity and a Host or Room context. Room Agents receive only that Room's filesystem, browser, database, network, lease, and permission scope. Host Agents use the same services but still need explicit Host or shared-resource grants; “Host Agent” never means unrestricted Host shell access. Runtime placement — Host helper, managed runtime process, or sidecar — remains an internal implementation choice rather than a user-visible topology.

GitHub is the first implemented Hotel Service foundation. Its pinned Hotel-managed `gh` and encrypted private credential stay outside Host global PATH and outside Room images. The current preview automatically maintains the built-in binary as available infrastructure, keeps Agent enablement false by default, and provides install/repair/health and credential Connect/Disconnect. Connecting a credential does not assign the service or authorize an Agent. Agent-native assignment/injection and a complete permission broker are still milestones. MCP and Skills may later use the same Hotel-owned lifecycle and binding model, but they are not part of a Room's installed app list.

The target common control plane is intentionally small: discover, describe, install, update, enable, disable, assign, request permission, inspect health, and obtain a scoped connection. The actual GitHub, Serena, or Playwright tools remain owned by that service's native interface. These generic operations and native connections are not implemented by the current preview. **DevHotel MCP is the concierge, not every service worker.**

The **DevHotel MCP adapter** translates MCP tools to the stable, versioned local REST API. This repository currently includes an experimental stdio MCP package that calls an ephemeral loopback control API owned by the Electron process. It does not yet implement the independent stable daemon/API, Hotel service registry, Gateway context propagation, durable Jobs, leases, fencing, permission grants, or managed isolation described above.

## Development

Requirements: Node ≥ 22, pnpm ≥ 10, Docker.

```bash
pnpm install
pnpm dev              # run the desktop app in dev mode
pnpm test             # automated tests (live Docker smoke is opt-in below)
pnpm typecheck
pnpm build:installer  # NSIS installer into apps/desktop/release
```

Live backend smoke test (talks to your local Docker):

```powershell
$env:DEVHOTEL_SMOKE='1'; pnpm --filter @devhotel/core exec vitest run src/__tests__/backend.smoke.test.ts --testTimeout=180000
```

### Current preview architecture

```text
apps/desktop      Electron app — UI (React), embedded per-room browser views,
                  tray, auto-update, loopback control API
packages/core     Orchestrator — OCI room-pod backend (docker CLI), local
                  gateway (*.localhost + SNI TLS + local CA), SQLite store,
                  change-transaction engine with undo, check pipeline,
                  diagnostics with secret redaction
packages/mcp      devhotel-mcp — stdio MCP server over the control API
packages/shared   Types and contracts
```

Each served Room uses an **anchor** relay on its owned network. The gateway routes `<project>-<nickname>.localhost` domains to Rooms, so port numbers stay invisible. Web Rooms serve their site; Android Rooms run the build runtime plus a KVM-backed emulator sidecar in the same netns, and the emulator's noVNC screen is the Room's routed site. Dependency volumes are keyed by Node major (`…-deps-node22`, `…-deps-node24`), which is why a Node version change undoes instantly.

This describes the current external-Docker developer preview. The target release architecture adds a DevHotel-owned runtime bootstrap, dedicated data root, storage cleanup, and uninstall manifest around the room backend.

See [Managed Runtime design](./docs/superpowers/specs/2026-08-10-devhotel-managed-runtime-design.md) for the zero-prerequisite installation, ownership, update, recovery, and cleanup boundary.

Releases are cut locally, not by CI — see [Releasing](./docs/releasing.md).

## For agents

Settings → **MCP** gives you a one-line registration command for Claude Code and an `mcpServers` snippet for any other client. Register it by absolute path; the bundled server reconnects by itself when the DevHotel app restarts.

The MCP server exposes 27 tools over the same contract the app uses: create/start/sleep/clone/rename/delete a Room, run commands in it, apply and undo Quick Changes, read logs, components and diagnostics, push and pull workspace files, reset a Room, request a Host sync under the Room's revocable grant, and — for Android Rooms — build, install and launch an APK and take a screenshot of the phone.

Agents (or any local tool) can drive DevHotel **without MCP** through the same stable loopback REST API — see [Control API](./docs/control-api.md) for discovery (`%APPDATA%\DevHotel\control.json`), bearer auth, agent semantics, and every endpoint.

Everything an agent changes lands in the Room's Changes list, attributed to `agent` and undoable where an inverse honestly exists. Host resources stay outside that boundary: agents cannot create Host-linked Rooms, choose Host paths, or transfer files in a legacy Host-bound Room. The Host's mouse, keyboard and foreground window are outside it too — drive a Room's UI from inside the Room, never with host automation aimed at the preview window ([Host input isolation](./docs/host-input-isolation.md)).

## License

[MIT](./LICENSE)
