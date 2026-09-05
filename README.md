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

DevHotel is a local Agent Runtime that gives AI a strongly isolated, persistent development server — a **Room** — instead of access to your computer. Humans supervise permissions, state, jobs, and results through a browser-like Windows client.

> DevHotel protects the computer, not by limiting the agent, but by limiting its world.

## Key capabilities

- **Isolation First:** Room-owned files, processes, network, dependencies, and service data cannot affect another Room or the Host. The Room executes in its own network namespace and working state.
- **Port-Free Routing:** Rooms are accessed by stable local domains like `https://my-project-dev.localhost`, never by raw port numbers. Two rooms can run internal services on identical ports (e.g. 3000, 5432, 6379) simultaneously without conflict.
- **Your Desktop Stays Yours:** UI input is injected strictly inside the Room (in-Room `adb`, the Room's browser view, or the emulator's virtual display). Tests never move the Host cursor, press Host keys, or steal the foreground window. The one path that interacts with the Host desktop (opening a Windows Room in the VMware console) is a named, user-only, journaled capability. See [Host input isolation](./docs/host-input-isolation.md).
- **Sleep & Persistence:** Sleeping a Room stops every process it owns and frees CPU/RAM; workspace files, dependencies, database state, and browser sessions survive app restarts and Host reboots.
- **Room Services:** PostgreSQL and Redis run as Room-scoped services with dedicated health monitoring, persistent storage, version selection, and isolated connection environments.
- **Clone & Branching:** A working Web Room can be cloned into `stage` or `node24-test`, optionally copying dependencies and service data; the clone receives a fresh isolated browser profile.
- **Quick Changes with Undo:** Environment modifications run as verified transactions with action-level Undo: `↶ Undo: Node 22 → 24`.
- **15-Step Check Pipeline & Diagnostics:** When something breaks, a 15-step check pipeline (including CRLF `line-endings` detection) identifies which layer failed. **Copy Diagnostic** generates a secret-redacted bundle ready for issues or LLMs.
- **Guarded Host Sync:** Inbound sync from Host folders uses `safe_resync_from_host`: drift is inspected first, common generated build outputs are ignored, and meaningful drift returns an opaque single-use confirmation token before anything is imported.
- **Bounded Command Execution & Run Retention:** `run_in_room` returns a bounded stream view (default 64KB per stream) with server-side substring filtering (`include`/`exclude`). When output exceeds the inline window, the full raw stream is durably retained under the Room and paged with `read_run_output`.
- **Durable Long Operations:** Long-running lifecycle actions like `start_room` return a durable operation ID with observable progress stages (`check_operation`), surviving client timeouts and disconnects.
- **One USB Phone, Many Projects (Device Broker):** A physical Android phone is a shared Hotel Service lent to one Room at a time under an exclusive lease. Waiters see the queue and current owner. Crucially, verified builds stay installed on release or reclaim without destructive uninstalls. See [Android Device Broker](./docs/android-device-broker.md).

## Room providers

DevHotel supports three Room providers:

| Provider | What it does | Current status & limitations |
|---|---|---|
| **Web** | Serves web applications with Node.js, package managers (pnpm/npm/yarn), Room-scoped PostgreSQL/Redis, and local HTTPS. | Fully supported. Agents create via `provider: 'web'` (default). |
| **Android** | Builds APKs without Host SDK or `adb`. Includes a private KVM-backed AOSP emulator sidecar with routed noVNC screen preview, phone strip controls (Back/Home/Recents/Rotate), resident fenced ADB helper, app-scoped locale matrices ([docs](./docs/android-locale-matrix.md)), and cryptographic acceptance reports ([docs](./docs/android-acceptance-reports.md)). | Fully supported. Requires KVM via Docker. Agents create via `provider: 'android'`. |
| **Windows (VMware)** | Clones a VMware Workstation template snapshot into a headless Room-owned VM for isolated Windows testing. | Preview. Setup is guided via the desktop app; console access is a user-only capability. Guest exec and file ingress are planned for the forthcoming guest agent. Not creatable via agent API (`provider: 'windows'` is reserved for desktop setup). |

## Installation & prerequisites

DevHotel is currently in developer preview. While the long-term goal is a zero-prerequisite runtime (see [Managed Runtime design](./docs/superpowers/specs/2026-08-10-devhotel-managed-runtime-design.md)), the current release utilizes external container and virtualization engines:

- **OS:** Windows 11 x64.
- **Container Engine:** Docker Engine via Docker Desktop with the WSL2 backend, or any local engine exposing the standard `docker` CLI.
- **For Android Rooms:** KVM hardware acceleration enabled and exposed through the engine (`/dev/kvm`).
- **For Windows Rooms:** VMware Workstation Pro installed on the Host.
- **For building from source:** Node.js ≥ 22 and pnpm ≥ 10.

### Download

**[⬇ Download the latest installer](https://github.com/r2cuerdame/DevHotel/releases/latest)** — `DevHotel-Setup-<version>.exe`, Windows 11 x64.

Run the installer and DevHotel starts in the system tray. Auto-updates verify checksums against `latest.yml` before downloading. Releases are cut locally — see [Releasing](./docs/releasing.md).

## Hotel Services

A **Hotel Service** is shared infrastructure owned once by DevHotel and lent or bound to Rooms with explicit permissions, rather than being re-installed in every Room:

- **Android Device Broker:** Manages physical USB Android devices as an exclusive leased queue across projects. Features include dead-worker reclaim, PID tracking, and non-destructive release. Secure wireless pairing is restricted to the trusted desktop UI and never exposed to agents or raw ADB. See [Android Device Broker](./docs/android-device-broker.md).
- **GitHub Service:** Provisions and maintains a pinned, checksum-verified `gh` binary in Hotel-owned storage. Stores user-provided tokens in Electron's encrypted credential vault without touching Host global PATH or git config.

## For agents & AI tools

DevHotel is built from the ground up for autonomous coding agents.

### Setup

In the desktop app, go to **Settings → MCP** for ready-to-copy registration configurations.

**Claude Code:**
```bash
claude mcp add devhotel -s user -e ELECTRON_RUN_AS_NODE=1 -- "<path-to-DevHotel.exe>" "<path-to-resources\mcp\index.js>"
```

**Claude Desktop / Cursor (`mcpServers`):**
```json
{
  "mcpServers": {
    "devhotel": {
      "command": "<path-to-DevHotel.exe>",
      "args": ["<path-to-resources\\mcp\\index.js>"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```
*Always register using absolute paths so agents started outside DevHotel's environment can resolve the executable.*

### MCP tool surface (52 tools)

The bundled MCP server exposes 52 tools across the complete development lifecycle:

- **Room Lifecycle & Health (12):** `list_rooms`, `create_room` (`web` | `android`), `inspect_room`, `start_room`, `check_operation`, `sleep_room`, `delete_room`, `rename_room`, `hotel_status`, `check_room` (15-step pipeline), `room_logs`, `copy_diagnostic`.
- **Working State, Changes & Sync (10):** `apply_quick_change`, `undo_change`, `list_changes`, `room_components`, `restart_web`, `clone_room`, `reset_room`, `safe_resync_from_host`, `sync_from_host`, `reset_sync_baseline`.
- **Execution & Output Retention (3):** `run_in_room` (bounded output with server-side substring filter), `read_run_output` (paging retained output by byte offset with optional base64), `list_room_runs`.
- **Room Files (2):** `room_pull_file`, `room_push_file` (workspace-scoped file transfer).
- **Room Artifacts (3):** `list_room_artifacts`, `read_room_artifact`, `export_room_artifact`.
- **Android Automation & Verification (11):** `android_run`, `android_launch_app`, `android_force_stop`, `android_wait_for_text`, `android_tap_text`, `android_dump_ui`, `android_logcat`, `android_run_crash_scenario`, `android_screenshot`, `android_locale_screenshot_matrix`, `abandon_android_locale_matrix_recovery`.
- **Android Acceptance Reports (3):** `android_create_acceptance_report`, `list_android_acceptance_reports`, `get_android_acceptance_report` (cryptographically sealed HMAC receipts for emulator development or final physical proof).
- **Shared Device Broker (6):** `android_devices`, `attach_android_device`, `release_android_device`, `heartbeat_android_device`, `cancel_android_device_request`, `android_device_adb`.
- **Hotel Services (2):** `hotel_github_status`, `hotel_github_install`.

### Control API (without MCP)

External agents can drive DevHotel directly over the loopback REST API without MCP. On startup, DevHotel writes `%APPDATA%\DevHotel\control.json` containing the ephemeral port and bearer token:

```json
{ "port": 6084, "token": "…48 hex chars…", "pid": 12345, "version": "0.5.0" }
```

See [Control API (v1)](./docs/control-api.md) for endpoint details and agent security boundaries.

### Agent boundaries & guarantees

- **Audited mutations:** All agent mutations are recorded as `actor: agent` in the Room's change journal with action-level undo where possible.
- **Host protection:** Agents cannot create linked-folder Rooms (user approval in UI required), cannot read arbitrary Host paths, and cannot hijack Host mouse, keyboard, or foreground windows.
- **Pairing isolation:** Wireless pairing is restricted to the trusted desktop UI and cannot be initiated by agents or raw ADB.

## Local development

```bash
pnpm install
pnpm dev              # run the desktop app in dev mode
pnpm test             # automated test suite
pnpm typecheck        # TypeScript check across all packages
pnpm lint             # ESLint check
pnpm build:installer  # build NSIS installer into apps/desktop/release
```

Live backend smoke test (talks to your local Docker):
```powershell
$env:DEVHOTEL_SMOKE='1'; pnpm --filter @devhotel/core exec vitest run src/__tests__/backend.smoke.test.ts --testTimeout=180000
```

Live host input probe check (verifies desktop isolation on an idle machine):
```powershell
$env:DEVHOTEL_HOST_INPUT_PROBE='1'; pnpm --filter devhotel test
```

### Architecture layout

```text
apps/desktop      Electron app — UI (React 19), embedded per-room browser views,
                  tray, auto-update, loopback REST control API
packages/core     Orchestrator — OCI room backend (docker CLI), VMware backend,
                  local gateway (*.localhost + SNI TLS + local CA), SQLite store,
                  change transaction engine with undo, 15-step check pipeline,
                  secret-redacted diagnostics, device broker
packages/mcp      devhotel-mcp — stdio MCP server (52 tools over the control API)
packages/shared   Shared schemas, contracts, and host input boundary definitions
```

## Documentation

- [Control API (v1)](./docs/control-api.md) — REST API endpoints, discovery, and agent semantics.
- [Android Device Broker](./docs/android-device-broker.md) — Shared USB phone queue and exclusive lease model.
- [Android Acceptance Reports](./docs/android-acceptance-reports.md) — Cryptographically sealed verification receipts.
- [Android Locale Matrix](./docs/android-locale-matrix.md) — App-scoped locale testing and recovery contract.
- [Host Input Isolation](./docs/host-input-isolation.md) — Desktop cursor and window protection contract.
- [Releasing](./docs/releasing.md) — Release packaging, checksum verification, and update process.
- [Changelog](./CHANGELOG.md) — Detailed version history and release notes.
- [Product Definition (`goal.md`)](./goal.md) — Original product specification (Korean).

## License

[MIT](./LICENSE)
