# R2C-7 acceptance baseline — 2026-08-25

R2C-7 ("AppDied real-world DevHotel feedback and acceptance workflow") carries an
execution rule: *reproduce each issue against the current implementation before
fixing it*. This is that reproduction pass. It records, per global acceptance
criterion, whether current `main` already satisfies it and what the evidence is,
so the child issues (R2C-8 … R2C-17) start from verified facts rather than from
the original field report.

Environment: Windows 11, DevHotel **0.4.3** (installed build, matching `main` at
`1399fef`), Docker Engine 29.2.1, driven through the loopback control API via the
bundled MCP server. Repo baseline: `pnpm test` → **52 files, 414 passed, 6
skipped, exit 0**.

Nothing in this pass changes product behaviour. It is a status record.

## Result per global acceptance criterion

| # | Criterion | Status | Owner |
|---|-----------|--------|-------|
| 1 | A build-only Room does not become source-modified because of build outputs | ❌ not met | R2C-8 |
| 2 | Source drift reports exact changed files/conflicts | ❌ not met | R2C-8 |
| 3 | Room startup returns a final status or a trackable async operation ID; client timeout is not reported as task failure | ❌ not met | R2C-10 |
| 4 | Windows linked-folder projects can run Linux `gradlew`/shell scripts without manual CRLF repair | ❌ not met | R2C-11 |
| 5 | Large UIAutomator/logcat output is never silently lost; full logs remain retrievable | ⚠️ workaround only | R2C-12 |
| 6 | One acceptance session produces crash + report evidence end to end | ❌ not met | R2C-17 |
| 7 | Nine locale screenshots without manual `adb root`/system restart | ❌ not met | R2C-14 |
| 8 | Pairing codes, ports and tokens are not persisted in plaintext in MCP responses, logs, or artifacts | ⚠️ partial | R2C-16 |
| 9 | Room isolation, explicit host-folder permissions and recoverable sync generations remain intact | ✅ met | — |

## Evidence

### 1–2 — build outputs still flip a Room to `modified`, and drift names no path

Reproduced live on Room `cgwwdje7` (SafePrivew, Android, linked-folder). Its own
change history is the reproduction:

- seq 129 `sync-from-host` at `2026-08-22T06:34:37Z` — Room becomes `synced`,
  baseline fingerprint stored.
- seq 130, 131 `android-run` (Gradle `assembleDebug` + install + launch). No
  source edit is recorded between them.
- Current `inspect_room`: `syncStatus: "modified"`, `lastSyncedAt` still
  `2026-08-22T06:34:37.194Z`.

So a build-only sequence alone re-flags the Room. Partial mitigation already
exists — `fingerprintWorkspace` (`packages/core/src/backend/ociCli.ts:782`)
prunes `node_modules`, `.next`, `dist`, `build`, `coverage`, `.gradle` and
excludes mtime — but the Android/Gradle tree still produces drift outside that
set, and mode/uid/gid changes still count. Classifying the residual paths is
R2C-8's job and is deliberately not done here.

`modified` is written in exactly one place, `syncFromHost`
(`packages/core/src/orchestrator.ts:1268`): it is *lazily discovered at sync
time* by comparing the current fingerprint to the stored baseline, and the
refusal message names no file:

> Room files changed since the last Host sync. Export or commit them first, or
> accept the current Room files as the new baseline (Reset baseline) and sync
> again.

The user therefore cannot tell a stray build artifact from a real edit — which is
criterion 2, and the direct cause of the R2C-9 pain below.

### R2C-9 — the two-step baseline dance, observed five times

The same Room's history contains five consecutive `reset-sync-baseline` →
`sync-from-host` pairs (seq 118/119, 120/121, 123/124, 125/126, 128/129), all
`actor: agent`, each within seconds of the other. That is the manual loop R2C-9
asks to collapse into one explicit operation, recorded in real usage rather than
inferred.

### 3 — startup is synchronous end to end, with no operation handle

`startRoomLocked` (`packages/core/src/orchestrator.ts:806`) runs anchor recreate →
emulator create → web recreate → `verifyWebUp(..., { timeoutMs: 90_000 })` in one
awaited call. `POST /v1/rooms/:id/start` returns `204` with no body, and the MCP
`start_room` tool returns a fixed string. `ControlClient.req`
(`packages/mcp/src/client.ts:47`) calls `fetch` with no timeout, so the only
timeout is the caller's: when it fires, the caller sees a failure while the Room
keeps progressing to `ready`. There is no operation ID, no stage reporting, and
no way to re-query. Confirmed by reading the code path; no async/job primitive
exists for it (`operationId`/`jobId` today only name Android build snapshots and
volumes).

Related truthfulness gap found during this pass: `hotel_status` reported
`cgwwdje7`, `9x4uvxhz` and `ild7bey9` as `status: "ready"` while their containers
were gone. Room status is persisted at wake time and never re-validated, so
`run_in_room` failed with the raw engine string rather than a DevHotel
diagnostic:

```
Error response from daemon: container 9f49e58… is not running
```

This belongs with R2C-10: "final status" must mean the Room is actually up.

### 4 — no CRLF handling exists anywhere

`grep -rn` for `crlf|CRLF|dos2unix|lineEnding|line ending` across
`packages/` and `apps/` returns no product code. `importHostFolder`
(`ociCli.ts:724`) streams the Host tree in through `tar` byte for byte, so a
Windows-checked-out `gradlew` reaches the Linux Room with CRLF intact and fails
as `\r: not found`. Nothing detects or explains it.

### 5 — output is buffered, uncapped, and preserved only by user convention

`execInRoom` (`ociCli.ts:493`) delegates to `runDocker`
(`packages/core/src/backend/cli.ts:142`), which accumulates `stdout`/`stderr` as
unbounded strings and resolves only on `close`. There is no server-side cap,
no truncation flag, no artifact retention and no filter option — the whole
result is returned inline and is then truncated by the *client's* message limit,
which is where evidence is lost. The current mitigation is documentation only:
the `run_in_room` tool description tells agents to redirect to a file and fetch
it with `room_pull_file`, and `docs/feedback/2026-08-12-agent-field-reports.md`
lists real streaming as open backlog item 3. Marked ⚠️ rather than ❌ because the
workaround does preserve the bytes when an agent remembers to use it.

### 8 — redaction exists but does not cover this surface

`redactSecrets` (`packages/core/src/diagnostics/redact.ts`) covers keyed values,
bearer tokens, connection strings, PEM blocks, well-known token shapes and env
lines. Two gaps against criterion 8: it is invoked from exactly one place,
`diagnostics/bundle.ts:81`, so MCP responses and Room logs are not redacted at
all; and it has no pattern for ADB pairing output (`adb pair host:port` and the
six-digit code). Partial, not absent.

### 9 — the existing safety guarantees still hold

Verified by the suite rather than by assertion: host-folder boundary
(`apps/desktop/src/main/hostBoundary.test.ts`), control-API authorization
(`controlApi.security.test.ts`), Room volume ownership and naming
(`backend.identity.test.ts`, `backend.naming.test.ts`), and staged workspace
generations with failed-stage cleanup and rollback (`workingState.test.ts`). All
pass on `main`. Every change made for R2C-8 … R2C-17 must keep them passing.

## Not covered by this pass

- The AppDied Room `had1yar3` was left asleep. Criteria 6 and 7 need a full
  emulator acceptance session (build + install + forced crash + locale matrix),
  which is R2C-17/R2C-14 work, not baseline reproduction.
- Criterion 1's residual drift paths were not enumerated; that classification is
  R2C-8's first task and is in progress on its own branch.
