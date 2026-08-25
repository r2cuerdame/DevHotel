# DevHotel Control API (v1)

The loopback REST API every DevHotel client uses: the bundled MCP server is a
thin adapter over it, and external agents may call it directly — no MCP
session required. This contract is stable within a minor version; breaking
changes bump the path version (`/v1/`).

## Discovery & auth

While the DevHotel app runs, it writes `%APPDATA%\DevHotel\control.json`:

```json
{ "port": 6084, "token": "…48 hex chars…", "pid": 12345, "version": "0.4.2" }
```

- Base URL: `http://127.0.0.1:<port>` — loopback only, never remote.
- Every request needs `Authorization: Bearer <token>`.
- The port and token change on every app start: re-read the file on
  connection errors, and treat a missing file as "DevHotel is not running".
- Errors are JSON `{ "error": "…" }` with 4xx/5xx status.

## Agent semantics

Mutations through this API run as actor `agent` and appear (undoably) in the
room's Changes list. Host boundaries hold:

- Linked-folder rooms: `sourceRef` reads as `[Host folder hidden]`, inspection
  `dataDir` as `[Hotel data hidden]`; agents cannot create linked-folder rooms
  or delete Host-linked ones.
- Agent mutations on `legacy-host-bind` rooms are refused until the user moves
  the room into the Hotel.
- `sync-from-host` runs under the Room's **inbound-sync grant**: the human
  linked that folder when creating the Room and can revoke agent sync per Room
  ("Agents may sync from Host" in the Working state card) — revoked returns
  `403`. It re-reads only `room.sourceRef`, never a path from the request, is
  journaled as `agent`, and retains the replaced workspace generation so a
  wrong sync stays recoverable. Moving a legacy Room into the Hotel remains
  user-only.

## Endpoints

### Hotel

| Method & path | Result |
|---|---|
| `GET /v1/ping` | `{ version }` |
| `GET /v1/status` | `{ version, backend: { ok, detail }, gateway: { running, httpPort, httpsPort, routes[] }, rooms: [{ id, project, nickname, provider, status, domain, url, emulator }] }` — `emulator` is `running/exited/missing` for awake Android rooms, else `null` |
| `GET /v1/hotel/github` | GitHub Service status (provision + credential state) |
| `POST /v1/hotel/github/install` | Provision the pinned `gh` build (no credentials) |

### Rooms

| Method & path | Body / query | Result |
|---|---|---|
| `GET /v1/rooms` | | `RoomRecord[]` |
| `POST /v1/rooms` | `{ sourceType: 'managed-git'\|'empty', sourceRef, project, nickname, provider?: 'web'\|'android', planOverrides? }` | created `RoomRecord` |
| `GET /v1/rooms/:id` | | inspection: room, urls, backups, stack line, latest check, recent changes |
| `DELETE /v1/rooms/:id` | | `{ reclaimedBytes }` — irreversible; `403` for Host-linked rooms |
| `POST /v1/rooms/:id/start` · `/sleep` | | `204` |
| `POST /v1/rooms/:id/restart-web` | | change entry |
| `POST /v1/rooms/:id/clone` | `{ nickname, copyDependencies, services: 'copy'\|'empty'\|'exclude' }` | cloned `RoomRecord` |
| `POST /v1/rooms/:id/rename` | `{ nickname }` | `204` |
| `POST /v1/rooms/:id/exec` | `{ cmd: string[], timeoutMs? }` | `{ code, stdout, stderr }` — buffered until exit; redirect long output to a file |
| `POST /v1/rooms/:id/checks` | | 14-step check report |
| `POST /v1/rooms/:id/changes` | `{ change: QuickChange }` | verified/undoable change entry (`node-version`, `deps-install`, `service-*`, `android-build`, `android-run`, `emulator-config`, …) |
| `POST /v1/rooms/:id/undo` | `{ changeId }` | change entry |
| `POST /v1/rooms/:id/sync-from-host` | | human-approved inbound sync; `403` if declined; common generated outputs are ignored and real drift returns `409` with `conflictReason` plus exact `changedPaths` |
| `POST /v1/rooms/:id/sync-baseline` | | accept the Room's current files as the sync baseline (no copy, journaled) — clears a `modified` state that would otherwise refuse every sync |
| `GET /v1/rooms/:id/changes` | | full change journal |
| `GET /v1/rooms/:id/components` | | installed programs with live versions |
| `GET /v1/rooms/:id/logs` | `?kind=web\|orchestrator` | `{ lines[] }` tail |
| `GET /v1/rooms/:id/diagnostic` | | `{ text }` secret-redacted bundle |
| `GET /v1/rooms/:id/screenshot` | `?mode=auto\|screen` | `{ png: base64, source }` — Android rooms; `screen` captures the display (FLAG_SECURE included) |
| `GET /v1/rooms/:id/file` | `?path=/workspace/…` | `{ path, size, contentBase64 }` (16MB cap) |
| `PUT /v1/rooms/:id/file` | `{ path: '/workspace/…', contentBase64 }` | `{ path, size }` — creates parents, marks workspace modified |

Room source drift ignores generated directory segments such as `build`,
`.gradle`, `.kotlin`, `.cxx`, `dist`, `target`, and `node_modules`, plus APK/AAB
files. A project that intentionally tracks generated input can add exact
Room-relative files or directory prefixes (one per line, `#` comments allowed)
to `.devhotel-sync-include`; globs, absolute paths, backslashes, and `..` are
rejected, as is any entry whose parent directory resolves outside the linked
folder through a symlink. Included generated paths participate in the baseline
and are copied during linked-folder import. A real conflict response has the shape
`{ error: "workspace_drift", message, conflictReason: "room-source-modified", changedPaths: [{ path, reason }] }`.

## MCP registration note

Register the bundled MCP server by **absolute executable path** (the Settings
card and this repo's docs already do): agents launched before a PATH change
never see bare-name commands, so `devhotel-mcp` by name fails for them while
`"C:\…\DevHotel.exe" "C:\…\resources\mcp\index.js"` always resolves.

For Claude Code the server **name must come before the options**, because
`-e/--env` is variadic and otherwise consumes the name:

```
claude mcp add devhotel -s user -e ELECTRON_RUN_AS_NODE=1 -- "C:\…\DevHotel.exe" "C:\…\resources\mcp\index.js"
```

`-s user` registers it once for every project. Registration only takes effect
for agent sessions started afterwards — a running session must reconnect.
