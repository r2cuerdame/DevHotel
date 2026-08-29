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
- The Host's mouse, keyboard and foreground window are not on this API. UI
  input belongs inside the Room — for an Android Room, `exec` an
  `adb -s emulator-5554 shell input …` command against its own emulator, or
  drive a leased physical phone through `POST /v1/rooms/:id/device/adb`, rather
  than automating the Host desktop against the DevHotel preview window. See
  [Host input isolation](./host-input-isolation.md).

## Endpoints

### Hotel

| Method & path | Result |
|---|---|
| `GET /v1/ping` | `{ version }` |
| `GET /v1/status` | `{ version, backend: { ok, detail }, gateway: { running, httpPort, httpsPort, routes[] }, rooms: [{ id, project, nickname, provider, status, domain, url, emulator }], devices }` — `emulator` is `running/exited/missing` for awake Android rooms, else `null`; `devices` is the shared-phone broker status below |
| `GET /v1/hotel/github` | GitHub Service status (provision + credential state) |
| `POST /v1/hotel/github/install` | Provision the pinned `gh` build (no credentials) |

### Shared Android devices

A physical Android phone is Hotel infrastructure lent to one Room at a time —
see [Android Device Broker](./android-device-broker.md). Room-owned emulators
are not brokered and never enter this queue.

| Method & path | Body | Result |
|---|---|---|
| `GET /v1/devices` | | `{ available, detail, devices: [{ id, nickname, model, androidVersion, apiLevel, connection, health, brokered, leaseOwner, queueDepth, waiters[] }], recentEvents[] }` |
| `POST /v1/devices/refresh` | | re-enumerate the Host's devices; returns the inventory |
| `POST /v1/devices/heartbeat` | `{ leaseId, busy? }` | the refreshed lease — `busy: true` marks real device activity so a long instrumentation run is warned about, not reclaimed |
| `POST /v1/devices/cancel` | `{ requestId }` | leave the queue |
| `POST /v1/rooms/:id/device/attach` | `{ purpose, workerId, issueRef?, runId?, priority?, ttlMs?, maxDurationMs?, constraints? }` | `{ state: 'granted', lease, device }` or `{ state: 'queued', requestId, position, owner, reason }`. `project` is taken from the Room and is rejected in the body. |
| `POST /v1/rooms/:id/device/release` | `{ reason? }` | the closed lease; promotes the next queued Room. Nothing is uninstalled or cleared. |
| `POST /v1/rooms/:id/device/adb` | `{ args: string[], timeoutMs? }` | `{ code, stdout, stderr }` — argv without `adb` or `-s <serial>`; the broker picks this Room's leased device. State-changing commands need a live lease and are otherwise refused with a structured reason. |

Development belongs on the Room emulator (`POST /v1/rooms/:id/exec`); request
a physical device for final acceptance/release verification and for behaviour an
emulator cannot reproduce, then release it.
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
| `POST /v1/rooms/:id/sync-from-host` | | human-approved inbound sync; `403` if declined |
| `POST /v1/rooms/:id/sync-baseline` | | accept the Room's current files as the sync baseline (no copy, journaled) — clears a `modified` state that would otherwise refuse every sync |
| `GET /v1/rooms/:id/changes` | | full change journal |
| `GET /v1/rooms/:id/components` | | installed programs with live versions |
| `GET /v1/rooms/:id/logs` | `?kind=web\|orchestrator` | `{ lines[] }` tail |
| `GET /v1/rooms/:id/diagnostic` | | `{ text }` secret-redacted bundle |
| `GET /v1/rooms/:id/screenshot` | `?mode=auto\|screen` | `{ png: base64, source }` — Android rooms; `screen` captures the display (FLAG_SECURE included) |
| `GET /v1/rooms/:id/file` | `?path=/workspace/…` | `{ path, size, contentBase64 }` (16MB cap) |
| `PUT /v1/rooms/:id/file` | `{ path: '/workspace/…', contentBase64 }` | `{ path, size }` — creates parents, marks workspace modified |

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
