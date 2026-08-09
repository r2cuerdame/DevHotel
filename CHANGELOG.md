# Changelog

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
