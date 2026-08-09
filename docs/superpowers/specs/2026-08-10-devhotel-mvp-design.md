# DevHotel MVP — Implementation Design

Date: 2026-08-10
Status: Approved via `/goal` directive ("goal.md 전체 구현해줘") — autonomous session; goal.md is the product spec of record, this document records the implementation decisions that goal.md intentionally left open.

## Scope

Target: goal.md §21.1 Vertical Slice + §21.2 MVP Release, plus two items the goal directive explicitly added:

- Basic MCP server (goal.md §20 tool list) — pulled forward from post-MVP.
- Open-source release pipeline: GitHub Actions → GitHub Releases; local testing by building and installing the real installer.

Explicitly deferred (post-MVP per goal.md §21.3): PostgreSQL/Redis adapters (the ServiceAdapter interface and room-pod network model are built so they slot in), Room clone, env-profile UI, yarn/Bun/Deno, protected arbitrary-command transactions. Deferring services is safe because the pod model (below) already gives every room a private network namespace where `5432`/`6379` will live.

## Decision 1 — App framework: Electron + TypeScript + React

Alternatives considered:

1. **Electron** (chosen) — Chromium embedded browser with per-`session` partitions gives Room-scoped cookies/localStorage/IndexedDB (goal.md §10.6) natively via `partition: 'persist:room-<id>'`; Node.js main process is the natural home for the orchestrator (spawning `docker`/`git`, filesystem, SQLite); `electron-builder` + `electron-updater` are the most proven NSIS-installer + GitHub-Releases auto-update path.
2. Tauri (WebView2) — smaller binary, but WebView2 profile isolation is weaker to script, orchestration would live in Rust (slower to build well), and auto-update via GitHub Releases is less turnkey.
3. .NET + WebView2 — same profile/update drawbacks, loses the JS ecosystem for MCP/detection code sharing.

Electron's cost (bundle size) is acceptable for a desktop dev tool; product fit wins.

Stack: `electron-vite` (main/preload/renderer), React 18, TypeScript strict, pnpm workspaces:

```text
apps/desktop        Electron app (main = orchestrator host, renderer = UI)
packages/shared     Types + IPC/control-API contracts (zod schemas)
packages/core       Orchestrator: backend, gateway, detection, changes, checks, store
packages/mcp        devhotel-mcp stdio server (thin client of the control API)
```

`packages/core` has no Electron imports — it is plain Node, unit-testable with vitest, and reusable by a future headless CLI.

## Decision 2 — Isolation backend: OCI containers behind an interface

goal.md §19 wants WSL2 + OCI-compatible runtime without hard-coupling to Docker Desktop. Implementation:

- `IsolationBackend` interface in core; first implementation `OciCliBackend` drives the `docker` CLI (JSON output). The CLI surface is podman-compatible, so a future podman/nerdctl backend is mostly a binary-path change. No dockerode/socket SDK dependency.
- On this machine Docker Desktop 29.x (WSL2 engine) is present and is what the MVP verifies against.
- Backend health check = `docker version` + daemon reachability; surfaced in Easy Check step 1 and in tray.

### Room pod model (the core isolation design)

Per room, Kubernetes-pod style:

- **Anchor container** (`alpine`, `sleep infinity`): owns the room's network namespace and its published ports. Labeled `devhotel.room=<id>`, `devhotel.role=anchor`.
- **Web container** (`node:<major>-bookworm`): joins with `--network container:<anchor>`, runs the start command via `sh -lc` with corepack-enabled package manager. Labeled `devhotel.role=web`.
- Future service containers (postgres/redis) join the same netns → apps reach them at `localhost:5432`/`6379` inside the room, satisfying §10.3 without host port conflicts.

Ports: the anchor publishes the room's internal web port to `127.0.0.1:0` (ephemeral host port). Two rooms both use internal `3000`; the ephemeral mapping is invisible — the gateway routes domains to it. This satisfies §10.3 ("호스트에는 Room별 임의 포트를 직접 노출하지 않고" — the user never sees ports; loopback-only ephemeral binds are the hidden transport).

Internal-port change ⇒ anchor recreate; modeled inside the change transaction (documented, verified, undoable).

### Storage layout

- **Managed checkout**: `git clone` into a named volume (`dh-<room>-src`) via a one-shot `alpine/git` container. Fast (ext4 in WSL2), isolated. Access via Room Terminal; "Open Source Folder" is best-effort volume path discovery.
- **Linked local folder**: host folder bind-mounted at `/workspace`; a named volume mounted over `/workspace/node_modules` keeps deps in the managed layer and the host folder clean (§8.3).
- **Dependency volumes are keyed by runtime version**: `dh-<room>-deps-node22`, `dh-<room>-deps-node24`. Node version change = recreate web container with new image + that version's deps volume. **Undo = switch back to the old image + old volume — instant, no copying, provably scoped** (§13.2). Old volumes are kept until the change history referencing them is pruned or the room is deleted (storage shown in UI).
- Cache volume `dh-<room>-cache` (npm/pnpm store), logs on host under `userData/rooms/<id>/logs/`.

### Lifecycle mapping

| Room action | Backend operation |
|---|---|
| Create | volumes + anchor create + clone/bind + web container create |
| Start | anchor start → web start → health checks |
| Sleep | web stop (SIGTERM→timeout→kill) → anchor stop; volumes/data intact |
| Restart web | web container restart only |
| Delete | containers + volumes + certs + gateway route + browser partition removed; reclaimed bytes reported |

Container stop kills the whole in-room process tree by construction — §21.1(7) orphan guarantee. Crash recovery: on app boot, reconcile all `devhotel.room` labeled containers against the store; stop/remove strays.

## Decision 3 — Gateway, domains, HTTPS

- Node reverse proxy inside the main process (no external binary): HTTP on `127.0.0.1:80`, TLS on `443`, fallback to `8080`/`8443` if occupied (URLs then include the port; health check explains why).
- Routing table: `<slug>.localhost` → room's ephemeral loopback port. `*.localhost` resolves to loopback in Chromium and Windows 11's resolver — no hosts-file edits for default domains (§10.4). WebSocket/HMR upgrade passthrough implemented (dev servers require it).
- HTTPS: local CA generated with `node-forge` (pure JS) in `userData/ca`; per-domain leaf certs via SNI (`SNICallback`). Enabling HTTPS on a room = leaf cert + gateway route + HTTP→HTTPS redirect, as one undoable change.
- Trust: embedded browser trusts via `app.on('certificate-error')` pinned to our CA fingerprint (scoped, no OS change). Trusting in external browsers is an **explicit, separate** action (`certutil -user -addstore Root`) with a matching removal action (§10.5) — never bundled silently into another change.

## Decision 4 — State store: SQLite (better-sqlite3), manifest as generated YAML

- `userData/devhotel.db`, WAL mode, synchronous transactions — transactional, crash-safe, queryable history (§18.4).
- Tables: `schema_migrations`, `rooms`, `changes` (journal: actor, title, component, before/after JSON, steps, verify result, undo strategy/state, raw-log ref), `checks` (history), `settings`.
- The human-readable Room manifest (§18.3) is **generated** to `userData/rooms/<id>/manifest.yaml` after every committed change — DB is the source of truth; YAML is the readable/exportable projection.
- better-sqlite3 is native → pinned prebuilds via `electron-builder` rebuild; vitest runs it under plain Node without issue.

## Decision 5 — Change transaction engine

Each Quick Change is a `ChangeDefinition`:

```text
plan(ctx)      → human title, affected components, before/after
preflight(ctx) → cheap validity checks
capture(ctx)   → scoped safety capture (e.g. record old image+volume ids, old route, old command)
apply(ctx)     → backend/gateway/store operations
verify(ctx)    → targeted checks (container up, port listening, HTTP 200/3xx/4xx-but-alive)
undo(entry)    → inverse using captured state; declares capability upfront
```

Engine wraps them: journal entry `pending → applied → verified | rolled-back`, auto-rollback when verify fails and rollback is safe, actor attribution (`user | devhotel | agent`). MVP change set: Node version, start command, domain, HTTPS toggle, deps install / clean reinstall (clean reinstall's safety = fresh volume, old volume kept for rollback), plus internal-port change (needed by detection corrections). Fixes from Easy Check reuse the same definitions (§14.1).

## Decision 6 — Detection engine

Pure functions over a file-access interface (works on host folders pre-create and could later read volumes): `package.json` (+`engines`, `packageManager`, `scripts`), lockfiles, `.nvmrc`, `.node-version`, Volta, `.env.example`, framework configs (Next/Vite/Astro/Nuxt/Remix/CRA) for default ports. Priority exactly per §8.2. Output = `RoomPlan` (runtime, PM, start command, internal port, domain suggestion, warnings). Fully unit-tested; no network required (known Node LTS majors bundled).

## Decision 7 — Checks & diagnostics

Ordered pipeline per §14 (backend → metadata/storage → source → runtime → PM → deps → env → services → start command → process → internal port → gateway route → DNS/HTTPS → HTTP response). Each step: `healthy | warning | broken | unknown` + evidence + optional `fixChangeId`. Diagnostic bundle (§14.2 format) built from store + last logs, passed through the redactor (password/token/secret/key/authorization/cookie patterns, all `.env`-style values masked by name, user-defined patterns from settings) — redactor is unit-tested against fixtures before anything ships (§14.3, §23).

## Decision 8 — UI

- **Lobby**: card grid (project, nickname, thumbnail, status dot, one stack line, last-used) + `+ New Room`. No CPU/RAM/container IDs (§7.1).
- **New Room**: GitHub URL / Local Folder / Empty → detect → single Room Plan confirmation screen (editable fields inline) → Check In. ≤3 interactions happy path (§23).
- **Room view**: browser bar (← Lobby, back/forward, reload, domain, health dot, start/stop/restart, panel toggle, open-external) + `WebContentsView` preview (partition `persist:room-<id>`) + collapsible right panel with Overview / Stack / Services / Logs / Changes / Diagnostics tabs (§7.3–7.4). Thumbnails via `capturePage()` on a timer + on sleep.
- **Console** (§7.5): Room Terminal = `docker exec -it` PTY bridged to xterm.js; raw log viewer; open generated config (manifest.yaml, gateway route, container args); copy command / copy diagnostic.
- Renderer↔main over typed IPC (zod-validated contract in `packages/shared`). UI text in English (open-source default).

## Decision 9 — Desktop basics

Tray (open Lobby, running rooms list, Sleep All, backend health, quit), `app.setLoginItemSettings` startup toggle, close-to-tray. Single-instance lock. `electron-updater` GitHub provider: checks on start + daily, downloads silently, applies on user confirmation; updates never modify room stacks (§4.6) — nothing in the updater path touches room state, and boot reconciliation only re-asserts what the store says.

## Decision 10 — MCP

- Main process hosts a **control API**: HTTP on `127.0.0.1:<random>`, bearer token; `{port, token}` written to `userData/control.json` on boot.
- `packages/mcp` → `devhotel-mcp` bin (stdio, `@modelcontextprotocol/sdk`) reading `control.json`; clear error if the app isn't running. Tools: `list_rooms`, `create_room`, `start_room`, `sleep_room`, `inspect_room`, `run_in_room` (exec inside container — never host), `check_room`, `apply_quick_change`, `undo_change`, `copy_diagnostic`. All mutations run through the change engine with `actor: agent` (§20 policy), so they appear in Changes and are undoable from the UI.

## Decision 11 — Open source & release

MIT license. `README.md` (product pitch, install, quick start, architecture sketch), `CONTRIBUTING.md`, `docs/` carries goal.md and this spec. CI: `ci.yml` (windows-latest: install, lint, typecheck, unit tests, package without publishing), `release.yml` (tag `v*` → electron-builder NSIS x64 → GitHub Release with `latest.yml` for auto-update). Local testing loop: `pnpm build:installer` → install NSIS locally → run against local Docker (task-verified per goal.md §21.1 before the first tag).

## Error handling principles

- Backend absent/stopped → Lobby shows a single actionable state (start Docker / install guidance), never a stack trace (§4.3: jargon stays out of the primary UI; details live in Diagnostics).
- Every orchestrator command logs to the room's orchestration log; failures map to Check results, not modals, wherever the room can still limp (Needs Attention vs Broken per §6).
- Change failures auto-rollback when the captured state allows; otherwise the journal marks the room Needs Attention with the failing step attached.

## Testing strategy

- Unit (vitest, plain Node): detection priorities, redaction, change journal state machine, gateway routing table, manifest generation, undo capability matrix.
- Integration (manual + scripted against local Docker): pod lifecycle, two-rooms-both-3000, sleep/resume, orphan cleanup — executed as the §21.1 vertical-slice verification with recorded evidence before any release tag.
- CI runs unit tests on every push; integration stays local (needs Docker + WSL2).
