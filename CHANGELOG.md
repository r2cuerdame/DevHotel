# Changelog

## Unreleased

### Your desktop stays yours while a Room's tests run

An audit of every input and focus path DevHotel owns, turned into an enforced contract: **a test running inside a Room must not move the Host cursor, change Host keyboard state, or take the Host foreground window.**

- The audit found no Host-input injection anywhere in the product — Room commands and terminals are `docker exec`, the Android phone strip is in-Room `adb input`, the emulator draws on its own X display inside the container, Windows Rooms boot `vmrun … nogui`, and Windows Room commands are refused outright rather than falling back to the Host. What was missing was anything that *keeps* it that way.
- **A boundary test now enforces it.** The shipped source is scanned for every API that can drive the real mouse, keyboard or foreground window — robotjs, nut.js, `SendInput`, `keybd_event`, `SetCursorPos`, `SetForegroundWindow`, `SendKeys`, `xdotool`, `pyautogui`, AutoHotkey, `setAlwaysOnTop`, `setKiosk`, `setFullScreen` — and the workspace manifests are scanned for input-synthesis packages. Two user-initiated window-raise sites (tray click, second launch) are listed as exemptions with their reason, and a stale exemption fails the test too.
- **The Room preview cannot take the Host cursor.** Pointer Lock, Keyboard Lock and fullscreen are the three ways a page seizes the real cursor, keyboard and foreground, and all three arrive through the same permission surface as harmless requests — so the Room session's blanket denial moved into its own policy module and is regression-tested permission by permission.
- **The one path that does take the Host desktop is now a named capability.** Opening a Windows Room in the VMware Workstation console is a real Host window that grabs the cursor and keyboard while focused. It is user-only (an Agent asking for it is refused, and the Agent REST surface has no route for it) and every use is journaled to the Room's log, so the takeover is visible afterwards.
- **A live check for the machine itself**: `DEVHOTEL_HOST_INPUT_PROBE=1` keeps read-only mouse, keyboard and foreground observers armed throughout the desktop suite, latching even temporary and non-move mouse activity after endpoints are restored. Reports keep only activity/injection booleans and endpoint key counts, not mouse-message or key identities. A periodic keyboard-state check, low-level-hook message-pump watchdog, and cutoff-aware stop drain make observation failures fail closed. The full-machine assertion remains opt-in because it measures human activity too, while every ordinary Windows test run now compiles, starts and stops the helper.
- MCP guidance now tells agents where UI input belongs: `adb -s emulator-5554 shell input …` through `run_in_room`, never Host automation aimed at the DevHotel preview window.
- New: [Host input isolation](./docs/host-input-isolation.md) — the contract, the full audit table, the capability model, the regression coverage, and the platform limits it cannot remove.

### CRLF scripts from a Windows Host are named, not guessed at

Reported from an AppDied Android Room: a `gradlew` imported from a Windows
folder failed with `not found`, which reads as a broken Gradle install. It was
never Gradle — the kernel was looking for an interpreter called `/bin/sh\r`.

- **A `line-endings` check step.** Room checks now scan the workspace for CRLF
  in the files Linux actually executes — `gradlew`, `mvnw`, `*.sh` and anything
  with a shebang — and report them by path with a Fix button. Generated and
  vendored trees, symlinks and files over 1 MB are skipped.
- **Build and Build & Run refuse before they waste your time.** Either Android
  action stops a CRLF `gradlew` or `mvnw` in preflight with the real reason
  instead of a Gradle-shaped failure minutes later. A command that fails for
  any other reason re-scans the exact workspace it used, so a Gradle task that
  shelled out to a CRLF helper script is attributed correctly rather than left
  ambiguous.
- **`normalize-line-endings`, and only when asked.** A new Quick Change rewrites
  CRLF to LF in the Room's copy of those scripts. It runs on a copy of the
  workspace and publishes it as a new generation, so it is undoable like a
  package install. Nothing normalizes as a side effect of import, sync, wake or
  build. Intermediate files are created exclusively under the container's
  `/tmp`, never at a predictable workspace-controlled path.
- **Host files are still never written.** The change is refused for Rooms bound
  to a Host folder, and the diagnostic also names the Host-side fix — a
  `.gitattributes` rule such as `* text=auto eol=lf` — for people who would
  rather fix the source of the problem.

## 0.4.3 — 2026-08-16

### Reset Room — housekeeping without checking out

A Room can now be handed back clean while staying the same Room. **Reset clears what the Room can rebuild by itself; it keeps what only you could have made.**

- **Kept**: room number, nickname, project, domain, HTTPS, runtime and package manager, start command, source code and its Host link, environment variables, change history, safety backups and build artifacts.
- **Reset**, each an option: dependencies (reinstalled into a *fresh* generation — the live layer is never wiped), download caches (SDK/Gradle caches on Android Rooms), Room App data (`Keep data` / `Fresh data` / `Remove apps`), and the Room browser profile. The stale thumbnail always goes, so the Lobby card cannot show a picture of the Room before the reset.
- **Safety**: every Room App is dumped to a backup before its data is destroyed, and the change refuses to roll back destructively until that dump exists — the same interlock the service-version change uses. Resetting app data therefore needs an awake Room.
- Honest about undo: a reset is **not** undoable (cleared caches and browser data have no inverse), so it never offers one. Room App data is recoverable from the safety backup through Restore in Room Apps.
- Legacy Host-bound Rooms are refused — their workspace is a bind mount to your real folder. The same rule now guards `room_pull_file` / `room_push_file`, which could otherwise have read and written a legacy Room's real Host folder.
- Caches are emptied in place rather than by deleting their volume: the Room's containers mount those volumes for the Room's whole life, so a delete would be refused mid-reset. Android Rooms have no dependency layer, so reinstalling dependencies there is refused instead of writing into the source tree.
- Surfaces: the Room's ☰ menu (`Reset Room…`, confirmation by typing the nickname), and the `reset_room` MCP tool. Source code is deliberately out of scope, per goal.md §13.3; restoring code stays Sync from Host / Git.

### Unservable providers fail loudly instead of impersonating a Web Room

A feasibility review of adding a Windows provider found the placeholder was riskier than the missing feature.

- A stored `provider` value was cast through unvalidated, and every runtime branch reads "android, else web" — so a Room row naming a provider this build cannot serve would have booted as a Node/Debian Web Room, with Web checks and Web change kinds. Hydration now rejects an unknown provider, and `webSpecFor` — the one path every Room container is built through — refuses a known-but-unavailable provider with the registry's own reason.
- The New Room wizard renders roadmap providers from the registry, so the disabled "Windows Room" tile states its real availability and disappears by itself once the provider reports available. `windowsProvider.ts` claimed to be "visible on the roadmap, never faked in the UI" while nothing rendered it at all.
- Windows Rooms themselves remain unbuilt, and the creation contracts (`zProviderKind`) stay `web | android`.

### Host sync no longer dead-ends after a build

Reported by an agent whose Android Room could never sync again: the room went `modified` at its first `android-run` and refused every later sync, with no way back from any surface.

- **The workspace fingerprint is content identity, not a filesystem snapshot.** Generated trees (`build`, `dist`, `node_modules`, `.next`, `coverage`, `.gradle`, `.git/objects`) are now pruned *including their own directory entry* — previously the excluded directory's entry still counted, so a first build permanently looked like Room-side drift — and mtime no longer participates, so touching a file without changing it is not an edit. Deleting build output now genuinely restores the fingerprint.
- **Reset baseline**: accept the Room's current files as the comparison point when they *have* legitimately changed. Nothing is copied and no Host file is read; the change is journaled with its actor. Available in the room's Working state card, as `POST /v1/rooms/:id/sync-baseline`, and as the `reset_sync_baseline` MCP tool. The sync it unblocks still needs its own explicit user action (and, for agents, the approval dialog).
- The refusal message now names the way out instead of only stating the problem.

Existing rooms carry fingerprints computed the old way, so their first sync after updating still reports drift once — Reset baseline (or any successful sync) re-anchors them.

### Phone-first Android rooms

- noVNC's own chrome — the pull-out control bar, its handle and status toasts — is hidden in the Room preview. The Room shows a phone screen; DevHotel's strip drives it.
- **Rotate** joins Back / Home / Recents in the phone strip, stepping the device through its four orientations over adb. The emulator screen keeps the size the Room was created with, so a rotated device is letterboxed inside it — Quick change › Orientation resizes the screen itself for a full-size landscape Room.
- **Landscape Rooms are actually landscape.** Setting Orientation rotated the X screen but left the guest portrait: `hw.initialOrientation` alone does not turn the device, because Android reads its orientation from the panel and qemu keeps the panel's aspect ratio. The AVD panel axes are now swapped for landscape Rooms (at every resolution preset, native included), so the device boots landscape and fills the screen instead of standing narrow in a wide frame with the emulator toolbar and the docker-android wallpaper showing beside it.
- The letterbox around the phone is black in every case: openbox runs the image's wallpaper autostart alongside ours, so the fit daemon now paints the root window itself rather than assuming our autostart replaced it.
- The Android room bar shows the device (profile · Android version · AOSP) instead of a meaningless vnc URL; browser back/forward hide, reload stays.
- Screen orientation (portrait/landscape) joins device/OS/resolution in Quick change, undoable and settable over MCP.
- One emulator no longer appears as two adb serials: DevHotel targets the auto-detected `emulator-5554` and never `adb connect`s, so Gradle instrumentation runs once.
- `android_screenshot` gained mode `'screen'`: an X-display grab that also captures FLAG_SECURE apps; `'auto'` prefers the sharper guest-side screencap. Both are served by `GET /v1/rooms/:id/screenshot`.

### The MCP setup command actually works

- The one-line Claude Code command in Settings was rejected by the CLI: `--env` is variadic, so `--env ELECTRON_RUN_AS_NODE=1 devhotel` made it read the server name as another environment variable and abort. The command is now `claude mcp add devhotel -s user -e ELECTRON_RUN_AS_NODE=1 -- "<exe>" "<script>"` — name first, user scope so every project sees the Hotel, still absolute paths.

### MCP survives app restarts

- The bundled MCP server cached its first control-API connection forever, so restarting the DevHotel app (which rotates the loopback port and token) made every tool fail until the whole MCP session was restarted. The client now detects the stale connection, re-reads `control.json`, and retries once — long-lived agent sessions keep working across app restarts and updates.

### Documented control API

- `docs/control-api.md` publishes the loopback REST contract (discovery via `control.json`, bearer auth, all `/v1` endpoints with agent semantics) so external agents can collaborate without an MCP session. Runtime kinds beyond node/jdk (Go/Rust/Python) and a Room-owned Container Service (Docker-in-Room for Compose e2e) join the backlog from the seventh field report.

### Agent field-report fixes (docs/feedback/2026-08-12-agent-field-reports.md)

- **`hotel_status`** MCP tool + `GET /v1/status`: one call for app version, backend health, gateway ports/routes, and every room with provider/status/domain/URL and live emulator state.
- **`android_screenshot`**: the phone screen returned directly as an MCP image — captured with in-room `adb screencap`, so no host SDK, no noVNC letterboxing, no upload round-trips.
- **`android_run`**: one-shot build → install **all** built module APKs → launch a chosen `applicationId` → screenshot of the running app. The `android-run` quick change itself now installs every module (multi-APK apps like app+crash-lab no longer need manual adb) and accepts `applicationId`.
- **`room_pull_file` / `room_push_file`**: official file egress/ingress for room workspaces (base64, 16MB cap, `/workspace`-only paths, docker-cp transport — no more temp-HTTP/wget workarounds). Pushing marks the working state modified.
- Device selector honesty: hints now state profiles mimic screen size/shape only — the runtime is an AOSP emulator, not Samsung One UI or a physical device.
- The full five-agent feedback triage (exclusive lease, snapshot reset, streamed exec output, failure bundles, artifact receipts, android clone, Gradle queue, newer images…) is recorded as the working backlog.

### Host sync is a standing Room grant, not a popup

The modal that interrupted every agent sync is gone. Its job is done by a persisted, revocable grant instead — closer to goal.md §5.11, which describes grants with scope, actor and revocation rather than per-call prompts.

- **No dialog.** `sync_from_host` runs under the Room's inbound-sync grant. The human already chose that folder when creating the Room, sync re-reads only `room.sourceRef` (agents can neither supply a path nor create linked-folder Rooms), and it never writes to the Host.
- **Revocable per Room**: "Agents may sync from Host" in the Working state card. Revoked ⇒ `403` for agents, while the user's own sync button keeps working. The toggle is journaled.
- **Honest audit**: agent syncs are recorded as actor `agent`. They were previously journaled as `user` because the dialog had approved them — the trail said a person acted when an agent did.
- **Recoverable**: a successful sync used to delete the workspace generation it replaced, taking Room-side edits and `.git` with it. The replaced generation is now retained until the following sync, so exactly one spare stays available for recovery.
- Moving a legacy Host-bound Room into the Hotel stays user-only — it rewires where the Room executes.

## 0.4.2 — 2026-08-11

### Android emulator preview restored

- Android Rooms are served Rooms again: a Room-owned KVM-backed emulator sidecar joins the anchor netns and its noVNC screen is routed as the Room's site, pinned to the phone's 540×1140 aspect in the preview.
- **Build & run** builds the debug APK in the Room, waits for the emulator to boot, installs over the shared-netns `adb`, and launches the app on the visible screen; **Build APK** keeps the immutable provenance snapshot build.
- Emulator device/OS selection is back in Stack with action-level Undo; checks probe the relayed emulator screen, gateway route, and HTTP response.
- No Host SDK or Host `adb` is used; shared physical devices remain a later Hotel Device Service.
- Emulator screen-resolution presets in Stack: Balanced (75%, new default), Fast (50%), and Native. The guest LCD is scaled at AVD creation, which is the biggest speed lever since the room emulator renders in software (no GPU passthrough); boot animation is skipped too. Device and Android OS version (11–14) stay selectable alongside, all undoable.
- The phone screen is genuinely edge to edge now: window rules, a black backdrop, and a tiny libX11 fit daemon are staged into the *created* emulator container before its first start. The daemon keeps the qemu window at the full 540×1140 X screen (qemu ignores WM geometry rules at map time and its `-scale` flag is obsolete), openbox strips decorations at map, the toolbar stays hidden behind the full-screen phone, and stray qemu chrome (the floating collapsed-toolbar button) is swept off-screen.

### Everything drivable over MCP

- The control API and `devhotel-mcp` now cover the full room surface: `delete_room`, `restart_web`, `clone_room`, `rename_room`, `list_changes`, `room_components`, and `room_logs` (web/orchestrator tails) join the existing create/start/sleep/inspect/exec/check/change/undo/diagnostic tools.
- Agents can create Android Rooms (`create_room` with `provider: 'android'`) and drive `android-build`, `android-run`, and `emulator-config` as quick changes.
- Hotel Services reach agents read-safely: `hotel_github_status` and `hotel_github_install` provision the pinned `gh`; connecting a credential stays a human action in the app.

### Fixes

- The MCP setup card (Claude Code one-liner and `mcpServers` config with copy buttons) is back in Settings — the 0.4.1 renderer rewrite dropped it while the main-process API remained.

### Manual, draggable Web preview split

- The desktop/mobile split is now a manual toolbar toggle instead of always-on; each Room remembers whether it is split.
- The divider between the two panes is draggable; the ratio is clamped to 15–85 % and persisted per Room.
- The preview backdrop (letterboxing and gutter) is black on both the renderer and the native panes.

## 0.4.1 — 2026-08-10

### Dual responsive Web preview

- Web Rooms now show a synchronized 62/38 split preview: a selectable PC/tablet viewport on the left and a tall mobile viewport on the right.
- Each Room remembers its selected viewport presets. Both panes share the Room browser session while retaining independent render state.
- F12 remains an explicit toolbar toggle for the left preview; while DevTools is open it temporarily occupies the mobile pane and restores it on close.
- The single Room hamburger still switches to the full-screen Config surface. Menus, Config and modals hide both native previews without discarding their page/session state.
- Preview navigation, popup, download and browser permission boundaries are hardened; other Rooms, Host loopback and private-LAN targets are blocked from the preview session.

## 0.4.0 — 2026-08-10

### Agent-first product direction

- Core Philosophy is now **Give AI a room, not your computer**: inside the Room an Agent can work freely; Host, shared resources and other Rooms require explicit permission.
- The target architecture is a stable local daemon/API with Room check-in, one-writer lease and fencing, durable Jobs, capability grants and GUI/CLI/MCP adapters over the same state.
- Added managed-runtime and sandbox research ADRs. These are release targets, not claims about this preview: the independent daemon, Room Key/lease, durable Jobs, Full Agent microVM backend and zero-prerequisite installer are not implemented yet.
- Added a backend-neutral Runtime Provider capability contract and a three-way Windows prototype bake-off: Docker Sandboxes adapter, DevHotel-managed Hyper-V Linux VM, and hardened WSL2/containerd compatibility baseline.
- Added the Room Working State design: Host source is an ingress/sync endpoint, while immutable `StateRevision` inputs unify Build/Test Jobs, Clone, Undo and Suite execution without locking the evolving Room.
- Web remains the primary served-site provider. User-approved Desktop creation now also offers an honest Android **build-only** Room: JDK/Android SDK/Gradle run inside the Room without KVM, emulator, preview, Host SDK, or Host `adb`. Agent control and MCP creation remain Web-only until device permissions and durable Jobs exist.
- The bundled experimental MCP adapter can launch through DevHotel's Electron/Node runtime instead of requiring a separate Host Node installation.

### Room-owned Working State

- New Local Folder Rooms no longer execute through a writable Host bind. DevHotel imports the selected folder read-only into a revisioned Room-owned source volume; Room commands and package installation mutate only that owned state.
- **Sync from Host** stages a new generation, fingerprints it, publishes only after verification, and refuses to overwrite Room-side drift. Existing direct-bind Rooms are visibly quarantined as `legacy-host-bind` until the user chooses **Move into Hotel**.
- Clone copies Room-owned source and dependency state without inheriting a Host link. Agent control and diagnostics redact Host source paths.
- Current sync is an honest full staged copy; incremental/COW sync, Room-to-Host Apply/Export, and durable daemon-owned Jobs remain milestones. Android Clean Build now takes an owned source snapshot, runs with the pinned image and disposable caches, and exports APKs with input/environment/artifact SHA-256 provenance; general Web Build/Test Jobs do not yet share this path.

### Room App Store

- **+ Add app** opens a Room App Store instead of exposing separate PostgreSQL/Redis add buttons. PostgreSQL and Redis are installable Room Services with supported-version validation.
- npm packages can be discovered by exact name search or browsed through curated Frontend, Backend, Testing, Tooling, and Data shelves with pagination, bounded Registry requests, caching, and lifecycle-script warnings.
- npm/pnpm installs pin the selected exact version and are allowed only for Hotel-owned project workspaces; Host-bound and Empty Rooms fail closed. Installation forks a workspace generation plus fresh dependency generation, publishes both pointers atomically, cleans failed staging, and provides action-level Undo without risking later Room edits.

### Hotel Services foundation

- Lobby now has a full-screen Hotel Services surface, independent of any Room. Installation/availability, assignment, permission, and use are separate concepts: **Hotel prepares and maintains. The guest decides and uses.**
- GitHub is the first concrete Hotel Service. Packaged builds include a pinned `gh` 2.97.0 archive verified by exact size and SHA-256, provision it atomically under Hotel-owned storage, and never depend on Host `gh` or Host PATH.
- GitHub Connect validates an explicitly supplied fine-grained token through the pinned executable and stores only Electron `safeStorage` ciphertext under Hotel-owned data; it does not use `gh auth login`, Windows GitHub CLI keyring state, or Room files.
- The official MCP Registry can be browsed and searched as discovery-only catalog data. MCP/Skills installation, assignment, and Agent-native injection remain visibly unavailable rather than silently installing runtimes on the Host.

### Browser-first Room UX and Clone

- The running site is again the main Web Room view; the single hamburger opens Quick Change, Room Apps, Changes, Check and Console as a full-window configuration surface instead of a narrow drawer.
- The old hamburger/ellipsis split is gone. Sleep, Clone, viewport and an explicit F12 DevTools toggle share one Room menu while backend/port noise stays hidden.
- Clone a Web Room with a new nickname, isolated domain and fresh browser profile; optionally copy the managed workspace, active dependency volume and PostgreSQL/Redis data, or start services empty/excluded.
- Live Clone quiesces the source through code, dependency and service backups; the target web process starts only after restore completes. PostgreSQL backup/restore streams through atomic files and fails on the first SQL error.

### Compatibility-backend isolation and ownership

- Every Room now owns a labeled bridge network with inter-container communication disabled. Adversarial live smoke coverage verifies that Room web/Redis endpoints cannot be reached directly from another Room while same internal ports still work.
- Docker 29's cross-network published-port path is closed by a fresh per-Room 256-bit relay capability: only the Host Gateway holds the raw token, anchors receive only its verifier, malformed/partial requests fail closed, and Wake/Clone rotates the capability.
- Container, volume and network deletion now requires exact ownership labels, recorded Room identity and post-delete verification. Failed cleanup preserves retryable metadata instead of orphaning untracked data.
- The external Docker context and engine identity are pinned; mutation/destruction is rejected after context drift. Legacy DevHotel volumes are adopted only through a constrained, non-destructive migration check.
- Docker executable resolution is shared by lifecycle, logs and terminal paths, including Docker Desktop installations whose CLI is absent from `PATH`.
- Buffered exec, interactive Terminal and live Logs all pin the Docker engine, verify exact Room ownership labels, and operate on the inspected immutable container ID; a same-named foreign container cannot capture a Room command.
- **Security boundary:** this developer-preview bridge blocks direct Room-to-Room traffic, but not all Host gateway/private-LAN egress. It is not yet the final Full Agent Room boundary for untrusted autonomous Agents.

### Lifecycle and removal safety

- Create, Clone, Change, shutdown, update and complete removal share a mutation gate; shutdown/removal drains admitted work and blocks new mutations.
- Interrupted preparing/cloned Rooms and pending Changes reopen as Broken/Needs Attention with safety metadata preserved, never as apparently healthy Rooms.
- Renderer mutations now require the trusted main frame and strict runtime schemas. Local Folder access is an exact, in-memory grant created only by the native folder picker; Agent control/MCP cannot request arbitrary Host bind mounts.
- Database restore accepts only an opaque backup ID resolved to a verified regular file inside that Room's backup directory, never an Agent-supplied Host path.
- App updates attempt every Room/gateway cleanup, install only after all graceful sleeps succeed, and abort replacement with a native error if any stop fails; the tray refreshes when an update becomes ready.
- Complete removal owns a process-wide gate through Room deletion, CA cleanup and helper launch, so Tray Quit or Update cannot terminate or race the sequence; canceling native confirmation also restores the Settings UI.
- Complete removal requires a trusted main-window native confirmation, exact canonical ownership manifest/path validation and verified Room cleanup. Junction/path swaps or failed runtime cleanup stop deletion and retain recovery metadata.

### Current preview requirement

- The installer still uses an external Docker-compatible runtime. It is an honest transition build for testing the Web Room model, not the completed **One Installer. Zero Prerequisites.** product.
- Container writable-layer tool installs are not yet a durable/cloneable Room component, and compatibility images are not yet pinned to recorded immutable digests. The Full persistent Agent Room guarantee remains a managed-runtime milestone.
- New Local Folder Rooms import through a short-lived read-only Host mount into a revisioned Room-owned source volume. Host sync stages a complete replacement generation and publishes it only after import/fingerprint success; Room-to-Host writes are not implicit.
- Existing Local Folder Rooms remain explicit `legacy-host-bind` compatibility records: Agent mutations and accidental Clone sharing are blocked until the user chooses **Move into Hotel**. Sync rejects Room tree drift instead of merging or overwriting it.
- Host import currently performs a full staged copy (dependency/build caches excluded), not incremental journal/COW sync. `.git` and project environment files remain part of the imported working state. Android Clean Build consumes an immutable source snapshot, but it is still an in-process Change rather than a durable Job: new REST/MCP Room mutations wait for the operation lock, and Web Build/Test still lacks the shared immutable Job primitive.

## 0.2.2 — 2026-08-10

- **Installed programs** in Stack: every room lists its programs with live in-room versions; switch Node/npm↔pnpm/PostgreSQL/Redis versions in place, undo per component. Service version switches back up the data, recreate the service, and restore it.
- Database lifecycle (add · version · backup · restart · remove · restore) lives in Stack; Overview is a clean summary.
- Android rooms: the phone screen now fills its frame edge to edge (phone-aspect preview, frameless main window only, tool windows minimized).

## 0.2.1 — 2026-08-10

### Android rooms run your app on screen
- KVM-backed emulator joins the room's network; the **Site page shows the phone screen** (frameless, phone-sized, auto-connected) — a browser for your Android app.
- **Build & run**: one click builds the APK, waits for boot, installs over in-room adb, and launches the app.
- Device (Galaxy/Nexus) and Android version (11–14) selectable per room, undoable; latest-build card with an open-APK-folder jump.

### Services
- Backups are listed in Overview with time/size and a one-click **Restore** (safety-backed-up and undoable).

### Stack & Health
- Package manager (npm ↔ pnpm) is now a quick change with Undo; Health shows the live in-room npm/pnpm version.

## 0.2.0 — 2026-08-10

### Android build rooms (provider v1)
- Create a room from any Gradle/Android project: containerized JDK 17 + Android SDK (digest-pinned image, licenses pre-accepted), per-room Gradle caches and a persistent SDK volume — nothing installed on the host.
- One-click **Build APK** as a verified change; in-room terminal; adapted health checks. Emulator + preview is the designed v2.

### Per-room services with real backups
- Add PostgreSQL 17 / Redis 8 into a room's private network (`localhost:5432/6379` in-room, no host clashes).
- Backup / restart / remove from Overview; destructive operations capture an **automatic safety backup**, and undoing a removal restores the service *and its data*. `db-restore` guards itself with a pre-restore backup too.

### Full-page room view
- The site and the room pages (Overview · Stack · System · Activity · Health · Console) each cover the whole window, browser-style; sleeping rooms home on Overview and navigate to the site on wake; browser-style ⋯ menu.

### Room System page
- Per-room control panel: environment variables, CPU/memory limits (docker-enforced), timezone — one undoable change.

### Browser-grade preview tools
- Docked Chrome DevTools (F12 or the `</>` button) beside the site; viewport presets (desktop/laptop/tablet/phone) via device emulation.

### Host cleanliness
- Settings → Host footprint: exactly what's on the host, open-folder buttons, autostart toggle, and **Uninstall & remove everything** (deletes all rooms/volumes, CA trust, autostart, app data, then launches the uninstaller).

## 0.1.0 — 2026-08-10

First working release of DevHotel — every project gets its own room.

### Rooms & isolation
- Room = OCI pod: socat anchor container owning the network namespace + web container (`node:<major>-bookworm`); two rooms can both use internal port 3000 simultaneously.
- Create rooms from a GitHub URL (cloned into a managed volume via containerized git), a linked local folder (with `node_modules` kept in a managed volume), or empty.
- Auto-detection per goal.md §8.2: runtime (volta/.nvmrc/.node-version/engines), package manager (lockfiles/packageManager), start command, port (script flags + framework defaults), with source attribution in the Room Plan.
- Sleep/wake with full process-tree teardown, persistent volumes, boot-time reconcile (stray container cleanup, zombie rooms → sleeping).

### Gateway & domains
- Loopback reverse proxy on :80/:443 (fallback 8080/8443); `<project>-<nickname>.localhost` domains; WebSocket/HMR passthrough.
- One-toggle HTTPS: local CA (node-forge), SNI leaf certs, HTTP→308; embedded preview pins the CA per room partition; OS trust is an explicit certutil flow with removal.

### Changes & undo
- Change transactions: plan → preflight → capture → apply → verify → journal; auto-rollback where safe; failed verifies stay applied with prominent Undo (North Star demo).
- Quick changes: Node version (per-major dependency volumes — undo in under a second), start command, domain, HTTPS, internal port, deps install / clean reinstall (generation volumes).
- Every change journaled with actor (user / devhotel / agent), before/after, steps, verify result, undo strategy.

### Checks & diagnostics
- 14-step check pipeline (backend → … → HTTP) with one-click fixes and route self-heal.
- Copy Diagnostic: §14.2 bundle with secret redaction (env values, tokens, connection strings, private keys, custom patterns).

### Desktop
- Card lobby with live thumbnails, browser-style room view (per-room Chromium partition), collapsible detail panel (Overview / Stack / Services / Logs / Changes / Diagnostics / Console), in-room terminal.
- Tray (running rooms, sleep all, backend health, start with Windows), close-to-tray, auto-update from GitHub Releases (never touches rooms).
- Settings: copyable MCP setup (Claude command + mcpServers JSON), CA trust, language.

### MCP
- `devhotel-mcp` stdio server (bundled in the app, also in `packages/mcp`): list_rooms, create_room, start_room, sleep_room, inspect_room, run_in_room, check_room, apply_quick_change, undo_change, copy_diagnostic — all over a token-authed loopback control API, attributed as agent changes.

### UI & languages
- Detail panel redesign: status hero with URL pill and big actions, brass undo card, five icon tabs (Overview / Stack / Activity / Health / Console), room rename.
- 9 languages: English, 한국어, 日本語, 简体中文, Español, Français, Deutsch, Português (Brasil), Русский — auto-detected, switchable in Settings.

### Providers
- Room provider abstraction (goal.md §18.1) with the Web provider implemented and an honest Android stub — Android Rooms are designed (see docs) and arrive after Web Rooms are rock-solid.

### Project
- pnpm monorepo (desktop / core / mcp / shared), 125 unit tests + live Docker smoke, GitHub Actions CI + tag-triggered GitHub Releases, MIT.
