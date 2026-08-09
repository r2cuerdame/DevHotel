# Vertical Slice Verification — 2026-08-10

Target: goal.md §21.1 vertical slice + §24 North Star demo, on the **locally installed NSIS build** (`DevHotel Setup 0.1.0.exe` → `%LOCALAPPDATA%\Programs\...\DevHotel.exe`), Windows 11, Docker Desktop 29.2.1 (WSL2). Driven through the loopback control API (the same surface the MCP server uses) plus the desktop UI.

| # | goal.md requirement | Result | Evidence |
|---|---|---|---|
| 1 | Windows에서 DevHotel 설치 | ✅ | NSIS silent install (`/S`), app runs from Programs; auto-update wired to GitHub Releases |
| 2 | Local folder로 Node web Room 생성 | ✅ | `hello-a` created via detection (npm / Node 22 / `npm run dev` / port 3000, all source-attributed) |
| 3 | Room이 내부 3000 포트로 실행 | ✅ | pod = socat anchor (ephemeral 127.0.0.1 publish) + web container in shared netns |
| 4 | `project.localhost` 브라우저 preview | ✅ | Gateway on :80/:443 routes Host `hello-a-dev.localhost` → HTML; embedded Chromium resolves `*.localhost` natively |
| 5 | 두 번째 Room도 내부 3000 동시 사용 | ✅ | `hello-a` + `hello-b` both `ready`, both internal 3000, both answered through their domains simultaneously |
| 6 | Sleep 후 재개 시 환경/상태 유지 | ✅ | Sleep → both containers exited, status `sleeping`; wake → new ephemeral port, HTTP 200. Rooms survived dev→installed app switch and app restarts (SQLite + volumes) |
| 7 | Room process tree 확실 종료 | ✅ | After sleep: `docker ps --filter label=devhotel.room=<id>` empty; boot reconcile stops strays and sleeps zombie-running rooms |
| 8 | 호스트 전역 Node/npm 불필요 | ✅ | Rooms use `node:<major>-bookworm` images; host Node used only to develop DevHotel itself |

## North Star demo (§24)

- Node 22 → 24 on Room B: dependency install into a **separate per-major volume**, web container recreated on `node:24-bookworm` → verify OK; page and `node --version` report v24.19.0.
- **Undo: Node 22 → 24 → completed in 0.7 s** (volume swap — `deps-node22` and `deps-node24` coexist); container back on v22.23.2.
- Failure path (start-command changed to `node missing-file.js`): apply OK → verify FAILED (`web process exited`) → change stays `applied` + undoable, room drops to Needs Attention → Undo → HTTP 200 again.
- HTTPS toggle on Room A: local CA leaf issued, TLS 200 via SNI, HTTP → 308 redirect; CA trust is an explicit user action (Windows confirmation dialog observed in UI).
- Checks: 14-step pipeline all-healthy on a running room; runtime step reads the real in-container version (`Node 22.23.2`); missing-route self-heal verified in unit tests.
- Diagnostic bundle: §14.2 format, secrets redacted (unit-tested: env values, tokens, connection strings, PEM keys, custom patterns).
- MCP: stdio handshake → 10 tools (`list_rooms` … `copy_diagnostic`) → `list_rooms` returned live room data; server bundled at `resources/mcp/index.js`; agent mutations attributed `actor: agent` in the Changes list.

## Known limitations (v0.1.0)

- `*.localhost` resolves in Chromium-family browsers (embedded preview, Chrome, Edge) but not in the Windows OS resolver — `curl`/raw Node need a Host header or `--resolve`. Documented; custom `.test` domains with explicit hosts entries are a post-MVP item.
- Install directory is `%LOCALAPPDATA%\Programs\@devhoteldesktop` (cosmetic — NSIS uses the package name); shortcut and exe are named DevHotel.
- Room terminal is stream-mode (`docker exec -i`, local echo) — no full PTY; node-pty is a candidate later.
- PostgreSQL/Redis service adapters are post-MVP (§21.3); the pod netns model already reserves in-room `5432`/`6379`.
