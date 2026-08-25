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

## Recheck — 2026-08-25, after the first child branches opened

R2C-7 is an umbrella: it does not implement, it states whether the global
acceptance criteria hold. Five child branches have opened since the pass above,
so this section re-runs the baseline and adds what the umbrella owes on top of
it — which candidate now covers which criterion, and in what order those
candidates can land.

Re-verified against the same installed DevHotel **0.4.3** and against `main` at
`1399fef`, which has not moved: none of the child branches is merged.

### The table is unchanged

Every ❌/⚠️ above was re-checked at the source, not carried forward:

- Criteria 1–2: Room `cgwwdje7` reproduces identically. `seq 129`
  `sync-from-host` (`2026-08-22T06:34:37Z`), then `seq 130`/`131` `android-run`
  with no source edit between them, and `inspect_room` today still returns
  `syncStatus: "modified"` with `lastSyncedAt` unchanged and fingerprint
  `f24eaaf9…`. The five `reset-sync-baseline` → `sync-from-host` pairs (R2C-9)
  are still the last thing in that history.
- Criterion 3: `startRoomLocked` (`orchestrator.ts:806`) is still one awaited
  call, `start_room` (`mcp/src/tools.ts:89`) still returns a fixed string, and
  `ControlClient.req` (`mcp/src/client.ts:47`) still calls `fetch` with no
  timeout.
- Criterion 4: `crlf|dos2unix|lineEnding|line-ending` over `packages/*/src` and
  `apps/*/src` is still **0** matches.
- Criterion 5: `runDocker` (`backend/cli.ts:142`) still accumulates `stdout` and
  `stderr` into unbounded strings with no cap and no truncation flag. New
  evidence from the live Room: every `android-run` entry in `cgwwdje7`'s history
  carries `rawLogPath: null`, so the Gradle output of a real build is not
  retained anywhere after the call returns.
- Criterion 8: `redactSecrets` still has exactly one caller,
  `diagnostics/bundle.ts:81`.
- Criterion 9: suite green — `pnpm test` → 53 files (52 passed, 1 skipped),
  **414 passed / 6 skipped**, exit 0.

One correction to the pass above: `syncStatus: 'modified'` is written in *two*
places, not one — `orchestrator.ts:1268` (lazy discovery at sync time, the gap
criteria 1–2 describe) and `orchestrator.ts:1764` `markWorkspaceModified`, the
explicit path used when the Room itself is mutated (quick changes, apply, undo).
The criterion 1–2 verdict is unaffected: the build-only flip goes through 1268.

Also still true, and still unowned by any criterion: `hotel_status` reports
`cgwwdje7`, `9x4uvxhz` and `ild7bey9` as `status: "ready"` with `emulator:
"exited"`. That is R2C-177, filed out of the previous pass.

### Candidate coverage

Each open branch was checked for the primitive its criterion needs, plus tests
covering it. This is a coverage check, not a review — approving the change is
the child issue's own gate.

| # | Criterion | Child | PR | Head | Primitive on the branch |
|---|-----------|-------|----|------|--------------------------|
| 1–2 | build outputs / real source drift | R2C-8 | [#8](https://github.com/r2cuerdame/DevHotel/pull/8) | `bff1b47877d9` | `packages/core/src/workspaceDrift.ts` + `workspaceDrift.test.ts`, `backend.workspace-drift.smoke.test.ts` |
| 3 | trackable startup | R2C-10 | [#4](https://github.com/r2cuerdame/DevHotel/pull/4) | `effc3ee6bace` | `packages/core/src/operations.ts` + `roomStart.operations.test.ts`, `controlApi.operations.test.ts` |
| 4 | CRLF scripts | R2C-11 | [#5](https://github.com/r2cuerdame/DevHotel/pull/5) | `352c26dcb8bc` | `checks/lineEndings.ts` + `changes/definitions/lineEndings.ts`, covered by `checks.test.ts`/`changes.engine.test.ts` |
| 5 | long output / retained logs | R2C-12 | [#6](https://github.com/r2cuerdame/DevHotel/pull/6) | `08630f79ac2c` | `packages/core/src/runOutput.ts` + `runOutput.test.ts`, `exec.output.test.ts` |
| 6 | acceptance session evidence | R2C-17 | — | — | not started |
| 7 | locale screenshot matrix | R2C-14 | — | — | not started |
| 8 | secret-safe pairing | R2C-16 | — | — | not started |
| — | Room input isolation (related) | R2C-6 | [#7](https://github.com/r2cuerdame/DevHotel/pull/7) | `f74b2f8cf490` | `shared/src/hostInput.ts`, `main/hostInputProbe.ts`, `roomSessionPolicy.ts` + `hostInputBoundary.test.ts`, `docs/host-input-isolation.md` |

So four of the five open branches carry a named primitive and dedicated tests
for the criterion they own; criteria 6, 7 and 8 have no candidate at all yet.

### Merge order is the umbrella's real risk

All five branches report `MERGEABLE` against `main` today, which is misleading:
they were all cut from the same `1399fef` and they overlap heavily with each
other, not with `main`. Every pair among them touches
`packages/core/src/orchestrator.ts`, `packages/mcp/src/tools.ts` and
`docs/control-api.md` — all ten pairs, without exception. The heaviest pairs are
R2C-10 × R2C-12 and R2C-12 × R2C-8 at ten shared files each.

The consequence: exactly one of them merges cleanly, and the other four need a
rebase before they can. The rotation gate already fixes which one that is —
R2C-8 is the single DevHotel gate, so #8 lands first and #4/#5/#6/#7 rebase onto
it. Nothing here needs deciding; it needs to be known before the second merge is
attempted.

### What this pass did not do

No product code was touched, and no child work was started or duplicated — R2C-7
holds no implementation lane of its own. Criteria 6 and 7 still need a full
emulator acceptance session on Room `had1yar3`, which stayed asleep; that is
R2C-17/R2C-14 work.
