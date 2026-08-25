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

## Long operations

Waking a Room can take longer than a client is willing to wait: an emulator
image pull, fresh service containers, then up to 90 s of asking whether the
site answers. So `POST /v1/rooms/:id/start` does not report an outcome — it
reports an **operation**, and the operation is what carries the outcome.

```json
{
  "operation": {
    "id": "9d2a2c30-9c9a-4a2e-9b8b-0f6a2f1d5f01",
    "kind": "room-start",
    "roomId": "room1abc",
    "actor": "agent",
    "status": "running",
    "stage": "container-start",
    "stages": [
      { "key": "preparing", "label": "Prepare the Room record", "status": "done",
        "detail": null, "startedAt": "…", "endedAt": "…" },
      { "key": "container-start", "label": "Start the Room containers", "status": "running",
        "detail": null, "startedAt": "…", "endedAt": null }
    ],
    "error": null,
    "startedAt": "…", "updatedAt": "…", "finishedAt": null
  }
}
```

- `status` is `running`, `succeeded` or `failed`. **`running` is an answer, not a
  failure** — your call timing out says nothing about the wake, which is still
  going. Come back with the ID.
- `error` is `{ stage, message }` and is set only on `failed`.
- Stage `status` is `running`, `done`, `failed`, or `skipped` — *skipped* means
  the stage did not complete but deliberately did not stop the operation (the
  Room was already awake; the emulator has no KVM). `detail` says which.
- Stage order: Web `preparing → container-start → services-start → web-start →
  verify → complete`; Android `preparing → container-start → emulator-boot →
  web-start → verify → adb-ready → complete`; Windows `preparing → vm-start →
  complete`.
- `adb-ready` is a single question, not a wait: a fresh emulator is normally
  still booting, which is reported as `skipped`. The Room is usable for builds
  meanwhile, and `android-run` waits for the device itself.

Operations are **idempotent to ask about and idempotent to start**. Reading one
never starts work. Starting a Room whose wake is already running returns that
same operation instead of queueing a second wake.

The ID is durable: records live in the Room database, so it still answers after
a reconnect. An operation left running by a killed app is reported `failed`
("DevHotel restarted while this operation was running") at the next start rather
than being polled forever.

| Method & path | Body / query | Result |
|---|---|---|
| `POST /v1/rooms/:id/start` | `{ waitMs? }` — how long the call may hold before answering (default `10000`, max `600000`, `0` = answer at once) | `{ operation }` |
| `GET /v1/operations/:operationId` | `?waitMs=` (default `0`) | `{ operation }`, `404` if unknown |
| `GET /v1/rooms/:id/operations` | `?limit=` (default 20, max 200) | `{ operations }`, newest first |

`waitMs` is a convenience, not a requirement: with `waitMs=0` on both calls you
can drive the whole thing by polling.

## Endpoints

### Hotel

| Method & path | Result |
|---|---|
| `GET /v1/ping` | `{ version }` |
| `GET /v1/operations/:operationId` | `{ operation }` — see [Long operations](#long-operations) |
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
| `POST /v1/rooms/:id/start` | `{ waitMs? }` | `{ operation }` — see [Long operations](#long-operations) |
| `POST /v1/rooms/:id/sleep` | | `204` |
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
| `GET /v1/rooms/:id/operations` | `?limit=` | `{ operations }` — this Room's recent long operations, newest first |
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
