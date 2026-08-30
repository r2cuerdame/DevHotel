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
- Errors are JSON `{ "error": "…" }` with 4xx/5xx status. Stable DevHotel
  contract failures also include `code` and `recoveryHint`; engine-specific
  diagnostics are not exposed as the public error contract.

## Agent semantics

Mutations through this API run as actor `agent` and appear (undoably) in the
room's Changes list. Host boundaries hold:

- Linked-folder rooms: `sourceRef` reads as `[Host folder hidden]`, inspection
  `dataDir` as `[Hotel data hidden]`; agents cannot create linked-folder rooms
  or delete Host-linked ones.
- Agent mutations on `legacy-host-bind` rooms are refused until the user moves
  the room into the Hotel.
- `safe-resync-from-host` (and the lower-level `sync-from-host`) runs under the Room's **inbound-sync grant**: the human
  linked that folder when creating the Room and can revoke agent sync per Room
  ("Agents may sync from Host" in the Working state card) — revoked returns
  `403`. It re-reads only `room.sourceRef`, never a path from the request, is
  journaled as `agent`, and retains the replaced workspace generation so a
  wrong sync stays recoverable. Moving a legacy Room into the Hotel remains
  user-only.
- The Host's mouse, keyboard and foreground window are not on this API. UI
  input belongs inside the Room — for an Android Room, `exec` an
  `adb -s emulator-5554 shell input …` command rather than automating the Host
  desktop against the DevHotel preview window. See
  [Host input isolation](./host-input-isolation.md).

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
- A stage can carry `warnings` when an advisory progress update could not be
  persisted. The Room work continues and its terminal `status` still reports
  the wake itself; the next successful progress or terminal write preserves
  the warning for later polling.
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
| `POST /v1/rooms/:id/start` | `{ waitMs? }` — how long the call may hold before answering (default `0`, max `600000`; opt into a wait for an inline terminal result) | `{ operation }` |
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
| `GET /v1/status` | `{ version, backend: { ok, detail }, gateway: { running, httpPort, httpsPort, routes[] }, rooms: [{ id, project, nickname, provider, status, domain, url, emulator, runtimeStatus }] }` — each Room is revalidated without starting or repairing it. `runtimeStatus` keeps the recorded lifecycle status beside live `main`/`emulator` component states and reports `running`, `degraded`, `dead`, `stopped`, or `unknown`. A recorded-ready dead Room is returned as `broken`; a partially available or unknown Room is returned as `attention`. |
| `GET /v1/hotel/github` | GitHub Service status (provision + credential state) |
| `POST /v1/hotel/github/install` | Provision the pinned `gh` build (no credentials) |

### Rooms

| Method & path | Body / query | Result |
|---|---|---|
| `GET /v1/rooms` | | `RoomRecord[]` with the same read-only `runtimeStatus` overlay and effective status used by Room inspection |
| `POST /v1/rooms` | `{ sourceType: 'managed-git'\|'empty', sourceRef, project, nickname, provider?: 'web'\|'android', planOverrides? }` | created `RoomRecord` |
| `GET /v1/rooms/:id` | | inspection: room, `runtimeStatus`, urls, backups, stack line, latest check, recent changes. Runtime liveness is revalidated read-only; dead/degraded runtimes do not expose an app URL. |
| `DELETE /v1/rooms/:id` | | `{ reclaimedBytes }` — irreversible; `403` for Host-linked rooms |
| `POST /v1/rooms/:id/start` | `{ waitMs? }` | `{ operation }` — see [Long operations](#long-operations) |
| `POST /v1/rooms/:id/sleep` | | `204` |
| `POST /v1/rooms/:id/restart-web` | | change entry |
| `POST /v1/rooms/:id/clone` | `{ nickname, copyDependencies, services: 'copy'\|'empty'\|'exclude' }` | cloned `RoomRecord` |
| `POST /v1/rooms/:id/rename` | `{ nickname }` | `204` |
| `POST /v1/rooms/:id/exec` | `{ cmd: string[], timeoutMs?, output? }` | `{ code, stdout, stderr, output }` — bounded; see [Command output](#command-output). A dead runtime is rejected before exec with HTTP 409, `code: "ROOM_RUNTIME_NOT_RUNNING"`, and a recovery hint. If liveness cannot be verified, HTTP 503 uses `code: "ROOM_RUNTIME_STATUS_UNAVAILABLE"`. |
| `GET /v1/rooms/:id/runs` | | `{ runs[] }` — commands running now, plus finished runs whose full output the Room still holds |
| `GET /v1/rooms/:id/runs/:runId/output` | `?stream=&offsetBytes=&encoding=&maxBytes=&maxLines=&mode=&include=&exclude=&ignoreCase=` | a window of one retained stream, with `nextOffset`/`eof` for paging |
| `POST /v1/rooms/:id/checks` | | 15-step check report (includes `line-endings`) |
| `POST /v1/rooms/:id/changes` | `{ change: QuickChange }` | verified/undoable change entry (`node-version`, `deps-install`, `normalize-line-endings`, `service-*`, `android-build`, `android-run`, `emulator-config`, …) |
| `POST /v1/rooms/:id/undo` | `{ changeId }` | change entry |
| `POST /v1/rooms/:id/sync-from-host` | | human-approved inbound sync; `403` if declined; common generated outputs are ignored and real drift returns `409` with `conflictReason` plus exact `changedPaths` |
| `POST /v1/rooms/:id/safe-resync-from-host` | `{ confirmDiscardRoomChanges?: boolean }` | preferred inspect/refuse-or-confirm/reset/resync operation. With meaningful or unprovable drift and no confirmation, returns `409` with `status: 'confirmation-required'`, exact Room-relative paths when available, before facts, and recovery guidance without importing anything. Explicit confirmation is bound to that inspected snapshot; a later edit aborts the staged import. Success returns structured before/after facts and the retained recovery generation. |
| `POST /v1/rooms/:id/sync-baseline` | | accept the Room's current files as the sync baseline (no copy, journaled) — clears a `modified` state that would otherwise refuse every sync |
| `GET /v1/rooms/:id/changes` | | full change journal |
| `GET /v1/rooms/:id/components` | | installed programs with live versions |
| `GET /v1/rooms/:id/operations` | `?limit=` | `{ operations }` — this Room's recent long operations, newest first |
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

## Command output

`exec` answers with a **bounded** view of the command's output — never a silent
truncation, and never the whole of a 400MB logcat inlined into one response.

`output` on the request selects what comes back inline. Every field is optional:

| field | meaning |
|---|---|
| `maxBytes` | inline budget **per stream** (default `64000`, min `256`, max `4000000`) |
| `maxLines` | inline budget per stream, in lines |
| `mode` | `tail` (default) or `head` — which end to keep when it does not fit |
| `include` | keep only lines containing this literal UTF-8 substring |
| `exclude` | drop lines containing this literal UTF-8 substring |
| `ignoreCase` | match ASCII letters in `include`/`exclude` case-insensitively |

Filters are literal strings of at most 200 characters. Regex metacharacters
have no special meaning. Matching uses a streaming, non-backtracking algorithm
whose memory is bounded by the filter length, so an Agent cannot stall the
Electron main thread with a catastrophic regular expression.

Returned text preserves the selected raw line terminators exactly, including
CRLF, a final newline, and newline-only output. Byte counts describe the raw
bytes selected, not a newline-normalized reconstruction.

`output` on the response reports what happened:

```json
{
  "code": 1,
  "stdout": "…last 64000 bytes…",
  "stderr": "…",
  "output": {
    "runId": "9f2c…",
    "retained": true,
    "stdout": { "bytes": 41235904, "lines": 380112, "returnedBytes": 63988,
                "returnedLines": 611, "truncated": true, "filtered": false, "retained": true },
    "stderr": { "bytes": 0, "lines": 0, "returnedBytes": 0, "returnedLines": 0,
                "truncated": false, "filtered": false, "retained": false },
    "notes": ["stdout: returned 63988 of 41235904 bytes (611 of 380112 lines); complete raw output retained as run 9f2c… — read it with read_run_output"]
  }
}
```

Whenever the response could not carry everything — truncated, or narrowed by a
filter — the **complete raw output is retained under the Room** and read back
by run id. When the response did carry everything, nothing is retained and
`runId` refers to a run that is already gone: there is nothing left to fetch.

Retention lives in Hotel storage beside the Room's logs and artifacts, is
deleted with the Room, and is bounded — a Room keeps its most recent 20
retained runs, up to 256MB. The just-finished run named by an exec response is
never immediately pruned; if that single run exceeds 256MB it remains readable
and all older retained runs are evicted.

### Reading a run

`GET /v1/rooms/:id/runs/:runId/output` takes the same selection fields plus
`stream` (`stdout` | `stderr`, default `stdout`), `offsetBytes`, and `encoding`
(`utf8` | `base64`, default `utf8`). It returns the window plus `bytes` (size
of the retained stream), `nextOffset`, `eof`, `scannedBytes`, `scannedLines`
and the same truncation flags. Base64 reads leave `text` empty and return the
selected bytes in `contentBase64`, so arbitrary non-UTF-8 output is recoverable
exactly.

- **Page through everything**: reads default to `mode=head`; pass each
  response's `nextOffset` back as `offsetBytes` until `eof` is true. Decode and
  concatenate `contentBase64` pages when byte-for-byte recovery is required.
- **Search it**: pass `include`; `nextOffset` resumes after the last returned
  line, so paging stays exact even when the filter skipped the lines between.
  Filtered reads are head-paged and deliberately reject a single logical line
  over 4MiB; page that stream without `include`/`exclude` instead.

Each synchronous read scans at most 4MiB forward. A filtered continuation may
also inspect at most 4MiB backward to find and re-evaluate its line boundary.
This fixed work bound protects Electron's main thread; a response can therefore
return no matching text with `eof=false` and a larger `nextOffset`, which the
caller should continue paging normally.

Reading takes no Room lock, so a run is readable **while it is still running** —
`GET /v1/rooms/:id/runs` lists active runs with the bytes and lines they have
produced so far, which is how a caller tells "hung" from "busy" and how a
dropped connection is picked back up.

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
