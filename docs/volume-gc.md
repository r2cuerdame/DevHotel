# Room-aware volume GC

How DevHotel decides which Docker volumes on a Host it may remove, why
`docker volume prune` is never the answer, and how to see the verdict for every
volume before anything is touched (#63).

Docker's `dangling=true` proves one thing: no container is attached right now.
It says nothing about whether a *sleeping* Room will need the volume on its
next wake, whether a recovery fence intends to come back for it, or whether an
undoable change still points at it. So the reconciler in
`packages/core/src/volumeGc.ts` starts from DevHotel's own registry and treats
Docker's view as one input among several. Everything it cannot prove, it keeps.

## The ownership contract

A volume is DevHotel's when its name is `dh-<roomId>-<suffix>` **and** it
carries the exact managed label set (`devhotel.managed=1`,
`devhotel.role=volume`, `devhotel.room=<roomId>`), or the engine-pinned legacy
adoption ledger records it. A name alone is a pattern, not proof: a name-only
match is classified `unowned` and refused. Anonymous and third-party volumes
are `external` and never enter a candidate list at all.

The suffix names the **purpose** and, where there is one, the **generation**:

| suffix | purpose | generation |
|---|---|---|
| `src`, `src-rN` | workspace | revision `N` (`src` is r0) |
| `src-build-<opId>` | workspace snapshot for one build operation | — |
| `deps-node<major>`, `deps-node<major>-gN` | dependencies for one Node major | generation `N` (bare is g0) |
| `cache`, `sdk` | download / Android SDK caches | — |
| `svc-<postgres\|redis>-data` | Room Service data | — |

## Liveness classes

Every volume gets exactly one class, a `safeToDelete` verdict and a sentence
saying why. Only the `orphaned-*` classes can ever be safe, and each of them
still has to pass the same four gates: exact ownership proof, known size,
attachment count known **and** zero, and no undo or recovery reference.

| class | meaning |
|---|---|
| `retained-current` | the Room's published workspace revision |
| `retained-active` | an awake Room's state, or state a running operation is using |
| `retained-sleeping` | a sleeping Room's caches, SDK, service data, current dependencies |
| `retained-recovery` | held by a retained generation, an undoable change, or unavailable history (fail-closed) |
| `fenced` | the Room has a durable recovery intent; nothing of it moves |
| `orphaned-deleted-room` | the Room is gone from the registry **and** from disk |
| `orphaned-stale-generation` | a workspace revision below the current one that nothing can undo back to |
| `orphaned-stale-snapshot` | a build snapshot whose operation is no longer running |
| `orphaned-stale-deps` | a dependency generation nothing points at, or a Node major the Room no longer runs and no Node switch can undo back to |
| `orphaned-removed-service` | data for a service the Room no longer declares and no undoable change names |
| `unowned` | a DevHotel-pattern name without ownership proof, or a Room that exists on disk but not in the registry |

### Fences are intents, not statuses

A Room is fenced by a durable record that something wrote because it intends
to return to the Room's state: `androidLocaleRestorePending`,
`androidAcceptanceRestorePending`, `artifactExportPending`,
`androidLocaleRecoveryDiagnostic`, or an explicit fence handed to the
reconciler. The `attention` status is deliberately **not** a fence — it is what
any awake Room becomes when a verify probe fails, and fencing on it would hide
exactly the stale generations a long-lived attention Room accumulates. The
#61 recovery Rooms stay fenced through their pending-restore records, which is
what the host dry-run below confirms.

### The package-install retention rule

A package install stages a new workspace generation and a new dependency
generation and publishes both pointers together. Its undo only works while the
Room still points at the generations it staged; once a later install or reset
publishes past them, `undo` refuses ("no longer matches either side") and
nothing that row names is reachable through it again. So a **superseded**
package-install row — one whose `nextWorkspaceGeneration` is no longer the
Room's published revision — retains nothing. Its previous generations are held
only if a still-live row references them. Without this rule every install a
Room ever made would pin one more workspace copy and one more `node_modules`
forever. The rule is `isPackageInstallSuperseded` / `undoReferences` in
`volumeGc.ts`, and it is the only place history retention is decided.

### Generations are reserved before they exist

`deps-install` (clean), `room-reset` (reinstall) and `package-install` write
the `depsGenMax` high-water mark **before** creating the fresh volume. A crash
anywhere after that leaves a spent number; the next attempt allocates above
it, so a half-written generation's name is never reused.

## A bounded pass

`RoomOrchestrator.gcVolumes` is dry by default. A real pass must bring:

- `maxVolumes` — removal **attempts**, successful or not (≤ 500);
- `maxBytes` — planned bytes; a candidate that would overshoot is skipped, never squeezed in;
- `deadlineMs` — a wall-clock budget (≤ 1 h); no candidate is attempted after it elapses.

One pass runs **one** `docker system df -v` inventory. Each candidate is then
re-proved under its Room lock from a single-volume observation
(`inspectVolumeUsage`: existence, labels, ownership, attachments) laid over
that inventory together with fresh Room, settings, operation and change state.
Anything that changed — the Room came back, a container attached, the volume
vanished — is an error line, not a removal. `docker volume rm` runs without
`--force`, so the engine gets the last word on a newly attached volume.

The result reports `deletedVolumes`, `errors`, `attemptedCount`,
`deadlineReached`, and `skipped[]` with the bound that stopped each
un-attempted candidate.

## Seeing the verdict on a Host

Read-only, against the live app database and one `df` pass:

```
DEVHOTEL_VOLUME_GC_REPORT=1 pnpm --filter @devhotel/core report:volume-gc
```

`DEVHOTEL_USER_DATA` overrides the app-data directory. The report prints
totals, per-class bytes, every candidate with its reason (smallest first),
every held DevHotel volume with its reason, and how much of Docker's
"reclaimable" figure is external storage DevHotel makes no claim about. The
same numbers are available from a running app through
`GET /v1/storage/volumes` and `POST /v1/storage/volumes/gc` (see
[control-api.md](control-api.md)).

Host run on 2026-09-17 (15 Rooms, 247 volumes, 68.41 GB): DevHotel owns 64
volumes / 35.18 GB; 10 (8.96 GB) fenced for the #61 Rooms `njfstb4z` and
`29c5e8ys` via their pending-restore records; 51 (26.06 GB) retained for
sleeping Rooms and undo; 3 (0.16 GB, deleted Room `a17wkjn5`) provably
orphaned. The remaining 183 volumes / 33.23 GB Docker calls reclaimable are
anonymous or third-party and are never touched.
