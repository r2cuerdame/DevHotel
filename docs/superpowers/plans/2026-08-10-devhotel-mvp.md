# DevHotel MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **This session:** autonomous goal mode — hybrid execution: coherence-critical core inline, isolated modules + reviews via Workflow subagents (ultracode). This file is the durable source of truth for names/interfaces across context compaction.

**Goal:** Ship DevHotel v0.1.0 — an Electron desktop app giving each web project an isolated, persistent, domain-routed local dev server ("Room") with quick changes, checks, undo, an MCP server, and a GitHub-Releases pipeline.

**Architecture:** pnpm monorepo. `packages/core` (plain Node/TS) hosts the orchestrator: OCI room-pod backend over the docker CLI, loopback reverse-proxy gateway with `*.localhost` + SNI TLS, better-sqlite3 store, change-transaction engine with per-change undo, ordered check pipeline. `apps/desktop` (electron-vite) hosts core in the main process, React renderer, WebContentsView preview per room partition. `packages/mcp` is a thin stdio client of the app's token-authed loopback control API.

**Tech Stack:** Electron + electron-vite + React 19 + TypeScript strict, better-sqlite3, node-forge, js-yaml, zod, @xterm/xterm + node-pty (terminal), @modelcontextprotocol/sdk, electron-builder (NSIS) + electron-updater, vitest, GitHub Actions.

## Global Constraints

- Windows 11 first; isolation via Docker Engine (Docker Desktop/WSL2 on dev machine); never hard-require Docker Desktop specifically (CLI-compatible surface only).
- Primary UI never shows container IDs/port mappings/backend jargon (goal.md §4.3); Console/Diagnostics may.
- Rooms are persistent by default; Sleep ≠ Delete (§4.1, §6).
- App auto-update must never mutate room stacks (§4.6).
- Local-first: no accounts, no telemetry, no required network beyond image pulls (§4.7).
- All room mutations go through the change engine (journal + undo capability declared honestly — no fake Undo buttons, §18.2).
- Diagnostic copy always redacted (§14.3).
- License MIT; all UI copy English.
- Package manager: pnpm; Node ≥ 22 for the repo itself.

## Naming Conventions (fixed, used everywhere)

- roomId: 8-char lowercase alphanumeric nanoid. Room number: 200 + creation ordinal (`201`, `202`, …) — cosmetic only.
- Containers: `dh-<roomId>-anchor`, `dh-<roomId>-web`. Labels: `devhotel.room=<roomId>`, `devhotel.role=anchor|web`, `devhotel.managed=1`.
- Volumes: `dh-<roomId>-src`, `dh-<roomId>-deps-node<major>`, `dh-<roomId>-cache`.
- Default domain: `<slug(project)>-<slug(nickname)>.localhost`.
- App data (`userData` = `%APPDATA%/DevHotel`): `devhotel.db`, `ca/` (rootCA.pem, rootCA.key), `rooms/<roomId>/{manifest.yaml,logs/{web.log,orchestrator.log},thumb.png}`, `control.json`.
- Web image: `node:<major>-bookworm`. Anchor image: `alpine:3.20`.

---

### Task 1: Monorepo scaffold + Electron shell boots

**Files:**
- Create: root `package.json` (private, scripts: `dev`, `build`, `test`, `lint`, `typecheck`, `build:installer`), `pnpm-workspace.yaml` (`apps/*`, `packages/*`), `tsconfig.base.json` (strict, ES2023, moduleResolution bundler), `.gitignore`, `.npmrc` (`shamefully-hoist=false`), `LICENSE` (MIT), `README.md` (skeleton), `CONTRIBUTING.md` (skeleton)
- Create: `packages/shared/{package.json,tsconfig.json,src/index.ts}` (name `@devhotel/shared`)
- Create: `packages/core/{package.json,tsconfig.json,src/index.ts}` (name `@devhotel/core`, deps: shared, better-sqlite3, js-yaml, node-forge, zod, nanoid)
- Create: `apps/desktop/{package.json,electron.vite.config.ts,electron-builder.yml,src/main/index.ts,src/preload/index.ts,src/renderer/{index.html,src/main.tsx,src/App.tsx}}`
- Create: `packages/mcp/{package.json,tsconfig.json,src/index.ts}` (bin `devhotel-mcp`)

**Interfaces:** none yet — deliverable is `pnpm i && pnpm dev` opening an Electron window titled "DevHotel" rendering `<App/>` with placeholder Lobby text, and `pnpm -r typecheck` green.

- [ ] Step 1: Write all config files + minimal sources; `pnpm install`.
- [ ] Step 2: `pnpm dev` → window opens (manual verify), `pnpm -r typecheck` passes.
- [ ] Step 3: Commit `chore: scaffold pnpm monorepo with electron-vite desktop shell`.

### Task 2: Shared types + IPC/control contracts

**Files:**
- Create: `packages/shared/src/{rooms.ts,changes.ts,checks.ts,ipc.ts,control.ts,index.ts}`
- Test: `packages/shared/src/__tests__/schemas.test.ts` (zod round-trips)

**Interfaces (Produces — the spine; later tasks must match exactly):**

```ts
// rooms.ts
export type RoomStatus = 'preparing'|'running'|'ready'|'sleeping'|'attention'|'broken';
export type SourceType = 'managed-git'|'linked-folder'|'empty';
export interface RoomRecord {
  id: string; project: string; nickname: string; roomNumber: number;
  provider: 'web'; sourceType: SourceType; sourceRef: string; // git URL or host path
  runtime: { kind: 'node'; version: string };          // "22" (major) — resolved minor recorded in extra
  packageManager: { kind: 'npm'|'pnpm'; version?: string };
  startCommand: string; internalPort: number;
  domain: string; https: boolean;
  status: RoomStatus; hostPort: number|null;
  createdAt: string; lastUsedAt: string; thumbPath: string|null;
}
export interface RoomPlan { // detection output shown in New Room
  project: string; framework: string|null;
  runtime: { kind:'node'; version: string; source: string };       // source = which rule decided
  packageManager: { kind:'npm'|'pnpm'; version?: string; source: string };
  startCommand: { value: string; source: string };
  internalPort: { value: number; source: string };
  domain: string; https: boolean; warnings: string[];
}
export interface CreateRoomInput { sourceType: SourceType; sourceRef: string; nickname: string; planOverrides?: Partial<Pick<RoomRecord,'startCommand'|'internalPort'|'domain'|'https'>> & { runtimeVersion?: string; pmKind?: 'npm'|'pnpm' }; actor: Actor }
export type Actor = 'user'|'devhotel'|'agent';

// changes.ts
export type QuickChange =
  | { kind:'node-version'; version: string }
  | { kind:'start-command'; command: string }
  | { kind:'domain'; domain: string }
  | { kind:'https'; enabled: boolean }
  | { kind:'internal-port'; port: number }
  | { kind:'deps-install'; clean: boolean };
export interface ChangeEntry {
  id: string; roomId: string; seq: number; title: string; actor: Actor;
  component: string; before: unknown; after: unknown; steps: string[];
  verify: { ok: boolean; detail: string }|null;
  undoable: boolean; undoStrategy: string; status: 'pending'|'applied'|'verified'|'rolled-back'|'undone'|'failed';
  rawLogPath: string|null; createdAt: string; undoneAt: string|null;
}

// checks.ts
export type CheckStatus = 'healthy'|'warning'|'broken'|'unknown';
export interface CheckResult { step: CheckStep; status: CheckStatus; summary: string; detail?: string; fix?: QuickChange|{kind:'restart-web'}|{kind:'start-services'} }
export type CheckStep = 'backend'|'metadata'|'source'|'runtime'|'package-manager'|'dependencies'|'env'|'services'|'start-command'|'process'|'port'|'gateway'|'https'|'http';
export interface CheckReport { roomId: string; ranAt: string; results: CheckResult[]; overall: CheckStatus }
```

`ipc.ts`: `IpcApi` interface — every renderer-callable op: `rooms.list/plan/create/start/sleep/delete/restartWeb/inspect/rename`, `changes.list/apply/undo`, `checks.run`, `diag.copy`, `logs.tail(roomId, kind)`, `console.openTerminal/execCapture`, `settings.get/set`, `gateway.status`, `app.version/updateStatus`, `ca.trust/untrust/status`. `control.ts`: zod schemas for the HTTP control API mirroring MCP tool needs (same op names as ipc where applicable).

- [ ] Step 1: failing test importing schemas → implement → vitest green.
- [ ] Step 2: Commit `feat(shared): room/change/check types and ipc+control contracts`.

### Task 3: State store + manifest projection

**Files:**
- Create: `packages/core/src/store/{db.ts,migrations.ts,roomsRepo.ts,changesRepo.ts,checksRepo.ts,settingsRepo.ts}`, `packages/core/src/manifest.ts`
- Test: `packages/core/src/__tests__/{store.test.ts,manifest.test.ts}` (temp-dir DB)

**Interfaces (Produces):**

```ts
openDb(dir: string): Db                       // runs migrations, WAL
roomsRepo(db): { create(r: RoomRecord): void; get(id): RoomRecord|null; list(): RoomRecord[]; update(id, patch: Partial<RoomRecord>): void; delete(id): void; nextRoomNumber(): number }
changesRepo(db): { append(e: Omit<ChangeEntry,'seq'>): ChangeEntry; list(roomId): ChangeEntry[]; get(id): ChangeEntry|null; setStatus(id, status, patch?): void; lastUndoable(roomId): ChangeEntry|null }
checksRepo(db): { saveReport(r: CheckReport): void; latest(roomId): CheckReport|null }
settingsRepo(db): { get(k: string): string|null; set(k, v): void }
generateManifestYaml(room: RoomRecord): string   // §18.3 shape
writeManifest(userDataDir, room): Promise<void>
```

Schema (v1 migration, exact): tables `schema_migrations(version int pk)`, `rooms`, `changes(room_id+seq unique)`, `checks`, `settings` — columns per shared types (JSON columns for before/after/steps/verify/extra).

- [ ] Step 1: failing tests (create/list/update room; journal append+seq; manifest snapshot) → implement → green.
- [ ] Step 2: Commit `feat(core): sqlite state store with migrations and manifest projection`.

### Task 4: Detection engine

**Files:**
- Create: `packages/core/src/detect/{detector.ts,nodeVersion.ts,packageManager.ts,startCommand.ts,port.ts,framework.ts,sourceReader.ts}`
- Test: `packages/core/src/__tests__/detect.test.ts` + `fixtures/` (next-pnpm, vite-npm, nvmrc-override, engines-only, empty)

**Interfaces (Produces):**

```ts
interface SourceReader { readFile(rel: string): Promise<string|null>; exists(rel): Promise<boolean> }
fsSourceReader(rootDir: string): SourceReader
detectProject(src: SourceReader, opts: { project: string; nickname: string }): Promise<RoomPlan>
slugifyDomain(project: string, nickname: string): string   // "<slug>-<slug>.localhost"
```

Priorities exactly goal.md §8.2 (runtime: override>config>volta/.nvmrc/.node-version>engines>LTS default "22"; PM: lockfile>packageManager field>user>npm; start: override>config>scripts.dev>scripts.start>ask). Port: framework config → script flags (`-p`, `--port`) → framework default (next/vite/astro/nuxt/remix/cra map) → 3000 + warning.

- [ ] Step 1: failing fixture tests per priority rule → implement → green.
- [ ] Step 2: Commit `feat(core): project detection engine with §8.2 priorities`.

### Task 5: OCI backend (room pod)

**Files:**
- Create: `packages/core/src/backend/{types.ts,ociCli.ts,naming.ts,cli.ts}` (`cli.ts` = promisified spawn with timeout/log capture)
- Test: `packages/core/src/__tests__/backend.naming.test.ts` (pure parts); integration deferred to Task 13 script

**Interfaces (Produces):**

```ts
interface IsolationBackend {
  health(): Promise<{ok: boolean; detail: string}>
  createRoomPod(spec: PodSpec): Promise<{hostPort: number}>
  startRoomPod(roomId): Promise<{hostPort: number}>       // anchor+web start; re-reads ephemeral port
  stopRoomPod(roomId): Promise<void>                       // web stop → anchor stop
  restartWeb(roomId): Promise<void>
  recreateWeb(roomId, spec: WebSpec): Promise<void>        // node-version / command / port changes
  recreateAnchor(roomId, spec: AnchorSpec): Promise<{hostPort: number}>
  deleteRoomPod(roomId, opts:{volumes: boolean}): Promise<{reclaimedBytes: number}>
  execInRoom(roomId, cmd: string[], opts?): Promise<{code: number; stdout: string; stderr: string}>
  webState(roomId): Promise<'running'|'exited'|'missing'>
  listManagedContainers(): Promise<{roomId: string; role: string; state: string}[]>
  cloneIntoVolume(volume: string, gitUrl: string, log: (s:string)=>void): Promise<void>
  volumeSizes(roomId): Promise<Record<string,number>>
}
interface PodSpec { roomId; internalPort: number; nodeMajor: string; sourceType: SourceType; sourceRef: string; startCommand: string; env?: Record<string,string> }
```

Key docker invocations (exact): anchor `docker run -d --name dh-<id>-anchor -l devhotel.room=<id> -l devhotel.role=anchor -l devhotel.managed=1 -p 127.0.0.1:0:<internalPort> alpine:3.20 sleep infinity`; web `docker create --name dh-<id>-web --network container:dh-<id>-anchor -l ... -v <srcMount> -v dh-<id>-deps-node<major>:/workspace/node_modules -v dh-<id>-cache:/cache -e npm_config_cache=/cache/npm -e PNPM_HOME=/cache/pnpm -e CI=false -w /workspace node:<major>-bookworm sh -lc "corepack enable && exec <startCommand>"`; ephemeral port read via `docker port dh-<id>-anchor <internalPort>/tcp`. Managed source: volume `dh-<id>-src` mounted at `/workspace`; linked: host path bind. Web stop: `docker stop -t 8`. Logs: `docker logs -f --tail 200 dh-<id>-web` pumped by Task 8.

- [ ] Step 1: naming/arg-builder unit tests → implement backend → typecheck green.
- [ ] Step 2: Smoke script `packages/core/scripts/smoke-backend.mjs` (create pod with `npx http-server` style command, curl via hostPort, stop, delete) run manually against local Docker.
- [ ] Step 3: Commit `feat(core): oci room-pod backend over docker cli`.

### Task 6: Gateway + CA/HTTPS

**Files:**
- Create: `packages/core/src/gateway/{gateway.ts,proxy.ts,ca.ts,routes.ts}`
- Test: `packages/core/src/__tests__/{gateway.routes.test.ts,ca.test.ts}` (route table pure logic; CA issue/verify with node-forge)

**Interfaces (Produces):**

```ts
class Gateway {
  constructor(opts: { caDir: string })
  start(): Promise<GatewayStatus>            // binds 80/443, falls back 8080/8443
  stop(): Promise<void>
  setRoute(domain: string, target: {host:'127.0.0.1'; port:number}, https: boolean): Promise<void>  // https ⇒ ensure leaf cert
  removeRoute(domain: string): void
  status(): GatewayStatus                    // {httpPort, httpsPort, routes: RouteInfo[]}
}
ensureCa(caDir): Promise<{certPem, fingerprint256: string}>
issueLeafCert(caDir, domain): Promise<{keyPem, certPem}>
caTrustStatus(): Promise<'trusted'|'untrusted'>          // certutil -user -verifystore Root <fp>
trustCaInWindows(caDir): Promise<void>                    // certutil -user -addstore Root
untrustCaInWindows(caDir): Promise<void>
```

Proxy: `http.createServer` + `https.createServer({ SNICallback })`; route by `Host` header (strip port); proxy via `http.request` to target incl. `upgrade` event for WebSockets (pipe raw sockets); unknown host → 404 branded page; https-enabled room over http → 308 redirect.

- [ ] Step 1: failing tests (route resolution, host parsing, CA chain verify) → implement → green.
- [ ] Step 2: Commit `feat(core): loopback gateway with localhost domains, SNI TLS, local CA`.

### Task 7: Change engine + definitions

**Files:**
- Create: `packages/core/src/changes/{engine.ts,types.ts}`, `packages/core/src/changes/definitions/{nodeVersion.ts,startCommand.ts,domain.ts,https.ts,internalPort.ts,deps.ts,restartWeb.ts}`
- Test: `packages/core/src/__tests__/changes.engine.test.ts` (fake backend/gateway: happy, verify-fail→rollback, undo, non-undoable path)

**Interfaces (Produces):**

```ts
interface ChangeCtx { room: RoomRecord; backend: IsolationBackend; gateway: Gateway; repos: Repos; log: (s:string)=>void; userData: string }
interface ChangeDefinition<P> {
  kind: string
  plan(ctx, p: P): { title: string; component: string; before: unknown; after: unknown; undoable: boolean; undoStrategy: string }
  preflight?(ctx, p): Promise<void>            // throw to abort
  capture?(ctx, p): Promise<unknown>           // returned blob stored in entry.before context
  apply(ctx, p): Promise<void>
  verify(ctx, p): Promise<{ok: boolean; detail: string}>
  undo?(ctx, entry: ChangeEntry): Promise<void>
}
class ChangeEngine { execute<P>(def, ctx, p, actor: Actor): Promise<ChangeEntry>; undo(roomId, changeId, actor): Promise<ChangeEntry> }
```

Undo strategies (exact): node-version → swap back image+deps volume (`volume-swap`); start-command/domain/https/internal-port → reapply captured previous value (`inverse-apply`); deps-install clean → previous deps volume kept as `dh-<id>-deps-node<major>-bak-<seq>`, undo = swap back (`volume-swap`); plain deps-install → `undoable: false` honestly.

- [ ] Step 1: failing engine tests with fakes → implement engine + definitions → green.
- [ ] Step 2: Commit `feat(core): change transaction engine with scoped undo strategies`.

### Task 8: Orchestrator facade + logs + reconcile

**Files:**
- Create: `packages/core/src/{orchestrator.ts,logs.ts,reconcile.ts,index.ts}` (index exports the public core API)
- Test: `packages/core/src/__tests__/orchestrator.test.ts` (fakes: create→start→sleep→resume state transitions; reconcile stray handling)

**Interfaces (Produces — consumed by IPC, control API, MCP):**

```ts
class RoomOrchestrator {
  constructor(opts: { userData: string; backend; gateway; db })
  init(): Promise<void>                                  // reconcile + gateway start + route re-add
  listRooms(): RoomSummary[]
  planRoom(input: {sourceType; sourceRef; nickname; project?}): Promise<RoomPlan>
  createRoom(input: CreateRoomInput): Promise<RoomRecord>   // preparing → ready (deps install as first change)
  startRoom(id, actor): Promise<void>; sleepRoom(id, actor): Promise<void>
  restartWeb(id, actor): Promise<void>; deleteRoom(id, actor): Promise<{reclaimedBytes}>
  inspectRoom(id): RoomInspection                        // record + latest check + recent changes + urls
  applyChange(id, change: QuickChange, actor): Promise<ChangeEntry>
  undoChange(id, changeId, actor): Promise<ChangeEntry>
  runChecks(id): Promise<CheckReport>
  execInRoom(id, cmd: string[]): Promise<{code,stdout,stderr}>
  getDiagnostic(id): Promise<string>
  onEvent(cb: (e: OrchestratorEvent)=>void): () => void   // status/log/check/change events for UI push
}
```

`logs.ts`: `LogPump` attaching `docker logs -f` → `rooms/<id>/logs/web.log` (rotate 5MB) + emit lines; orchestrator log via same channel. `reconcile.ts`: label-scan vs store → stop strays, fix statuses, report.

- [ ] Step 1: failing tests → implement → green.
- [ ] Step 2: Commit `feat(core): room orchestrator with log pump and crash reconcile`.

### Task 9: Checks + diagnostics + redaction

**Files:**
- Create: `packages/core/src/checks/{engine.ts,steps.ts}`, `packages/core/src/diagnostics/{redact.ts,bundle.ts}`
- Test: `packages/core/src/__tests__/{checks.test.ts,redact.test.ts}` (redaction fixtures: env values, tokens, Authorization headers, connection strings, custom patterns)

**Interfaces:** `runChecks(ctx: CheckCtx): Promise<CheckReport>` step order per shared `CheckStep`; `redactSecrets(text: string, customPatterns: string[]): string`; `buildDiagnostic(ctx): Promise<string>` (§14.2 template, ends with the "Question" line). Wire into orchestrator (`runChecks`, `getDiagnostic` replace stubs).

- [ ] Step 1: failing tests (esp. redaction — every fixture secret absent from output) → implement → green.
- [ ] Step 2: Commit `feat(core): ordered check pipeline, diagnostic bundle, secret redaction`.

### Task 10: Desktop main process wiring (IPC, preview, control API)

**Files:**
- Create: `apps/desktop/src/main/{bootstrap.ts,ipc.ts,previewManager.ts,controlApi.ts,certTrust.ts}`; Modify `src/main/index.ts`, `src/preload/index.ts`
- Test: manual (`pnpm dev`) + `apps/desktop/src/main/__tests__/controlApi.test.ts` (token auth 401/200 against orchestrator fake)

**Interfaces:** preload exposes `window.devhotel: IpcApi` (contextBridge, invoke/handle per channel map from shared). `previewManager`: `attach(roomId, bounds)`, `detach()`, `capture(roomId): Promise<Buffer>` using `WebContentsView` with `partition: 'persist:room-<id>'`; `certificate-error` handler pins CA fingerprint. `controlApi.ts`: `startControlApi(orch, userData): {port, token}` + writes `control.json`; routes = control.ts schemas; every mutation takes `actor:'agent'` unless header says otherwise.

- [ ] Step 1: implement; manual verify app boots with orchestrator init (Docker running) and control API answers `GET /rooms` with token.
- [ ] Step 2: Commit `feat(desktop): main-process wiring — ipc bridge, room preview views, control api`.

### Task 11: Renderer UI (Lobby, New Room, Room view, panel, console)

**Files:**
- Create under `apps/desktop/src/renderer/src/`: `App.tsx` (router: lobby|room), `lobby/{Lobby.tsx,RoomCard.tsx,NewRoomWizard.tsx}`, `room/{RoomView.tsx,BrowserBar.tsx,DetailPanel.tsx,tabs/{Overview,Stack,Services,Logs,Changes,Diagnostics}.tsx,Terminal.tsx}`, `components/{StatusDot.tsx,Modal.tsx}`, `state/useStore.ts` (zustand or context+reducer — pick zustand), `styles.css`
- Test: renderer logic kept thin; unit-test `state/selectors.ts` if logic accrues

Design: dark, calm, browser-like; frontend-design skill consulted for the visual pass. Preview area = main-process WebContentsView positioned under the renderer layout (renderer reports bounds via ResizeObserver → `preview.setBounds`).

- [ ] Step 1: Lobby + New Room flow (plan screen with source-attributed values, single confirm) against IPC.
- [ ] Step 2: Room view: browser bar actions, panel tabs bound to inspect/changes/checks/logs streams, Undo buttons on undoable changes, Copy Diagnostic.
- [ ] Step 3: Terminal tab via node-pty `docker exec -it dh-<id>-web sh` bridged over IPC to xterm.js.
- [ ] Step 4: Commit per step (`feat(ui): lobby and new-room wizard`, `feat(ui): room view with detail panel`, `feat(ui): room terminal`).

### Task 12: Tray, startup, updater

**Files:**
- Create: `apps/desktop/src/main/{tray.ts,updater.ts}`; Modify `bootstrap.ts`
- Test: manual; updater config validated by electron-builder schema

Tray: open Lobby, per-running-room "Open", Sleep All, Backend health line, Start with Windows toggle (`app.setLoginItemSettings`), Quit (sleeps all rooms first). Close-to-tray default with first-time toast. `electron-updater`: GitHub provider, `autoDownload: true`, install on explicit user confirm; never touches rooms.

- [ ] Step 1: implement + manual verify tray/menu; Commit `feat(desktop): tray, windows startup, auto-updater`.

### Task 13: MCP package

**Files:**
- Create: `packages/mcp/src/{index.ts,client.ts,tools.ts}`; `packages/mcp/README.md`
- Test: `packages/mcp/src/__tests__/tools.test.ts` (tool schemas; client against mocked control API)

Tools (names fixed, §20): `list_rooms,create_room,start_room,sleep_room,inspect_room,run_in_room,check_room,apply_quick_change,undo_change,copy_diagnostic`. stdio server via `@modelcontextprotocol/sdk`; reads `control.json` (path override via `DEVHOTEL_CONTROL_FILE`); friendly error when app closed. All mutations `actor: 'agent'`.

- [ ] Step 1: failing schema/client tests → implement → green; Commit `feat(mcp): devhotel-mcp stdio server over control api`.

### Task 14: CI + release pipeline + docs

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/release.yml`; finalize `README.md` (features, install from Releases, MCP setup, local build, architecture), `CONTRIBUTING.md`, `docs/` index; `electron-builder.yml` publish config (`provider: github`)

ci.yml: windows-latest, pnpm cache, install → lint → typecheck → `vitest run` → `electron-builder --dir` (no publish). release.yml: on tag `v*`: build NSIS x64, publish Release (draft:false) with `latest.yml` — `GITHUB_TOKEN`.

- [ ] Step 1: author workflows + docs; Commit `ci: build and github-release pipelines; docs: readme + contributing`.

### Task 15: Vertical-slice verification (goal.md §21.1) + fixes

**Files:** `docs/verification/2026-08-10-vertical-slice.md` (evidence log + screenshots)

- [ ] Step 1: `pnpm build:installer` → install NSIS locally → launch installed app.
- [ ] Step 2: Create Room A (local folder fixture, internal 3000) → `https?://<a>.localhost` renders in embedded view.
- [ ] Step 3: Create Room B (second fixture, also internal 3000) → both run simultaneously.
- [ ] Step 4: Sleep A → verify zero `devhotel.room=A` processes/containers running → reopen → session/data persist.
- [ ] Step 5: Quick Change A Node 22→24 → verify; Undo → verify instant volume-swap recovery.
- [ ] Step 6: HTTPS toggle + CA trust flow; Copy Diagnostic redaction spot-check.
- [ ] Step 7: Record evidence doc; fix every defect found (each fix its own commit); Commit `test: vertical slice verification evidence`.

### Task 16: Review pass + v0.1.0 tag readiness

- [ ] Step 1: /code-review style multi-agent review (ultracode workflow) over the full diff; fix confirmed findings.
- [ ] Step 2: Version 0.1.0 across packages, CHANGELOG.md, final commit. (Tag/push only with user's remote setup — note in summary if no remote configured.)

## Self-Review (done at planning time)

- Spec coverage: §21.1/21.2 all mapped (installer→T14/15, tray/startup/update→T12, lobby/new-room→T11, run/persist/isolate→T5/8, quick changes→T7, checks/diag→T9, undo→T7, console→T11, MCP→T13, release→T14). Services/PG/Redis intentionally deferred per design doc.
- No placeholder steps; interfaces pinned in Tasks 2/5/6/7/8 and reused verbatim.
- Type consistency: `QuickChange` kinds match change definitions; `IpcApi` ops match orchestrator facade; MCP tool list matches §20.
