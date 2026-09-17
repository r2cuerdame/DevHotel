# Control-plane retention and crash staging

What bounds DevHotel's own bookkeeping on a Host: the SQLite control plane
under `<userData>/devhotel.db` and the Host-private staging directories under
`<userData>/tmp` (#76). Everything here is about DevHotel's records of Rooms,
never Room data: workspaces, dependencies, caches and volumes are governed by
[the Host footprint](./host-footprint.md) and [volume GC](./volume-gc.md).

## Contention budget

`openDb` opens the database with `PRAGMA busy_timeout=5000` and then reads the
pragma back; a connection whose budget did not land, or a caller asking for a
zero budget, is refused at initialization (`packages/core/src/store/db.ts`).
The desktop, its control API and the device sweeper share this file, so a
second writer waits up to five seconds for the first transaction to finish
and then fails with `SQLITE_BUSY` rather than either failing immediately or
blocking forever. Repository transactions are short by design; a wait that
long means something is wedged, and a bounded failure is the honest answer.

`synchronous` is left at SQLite's WAL default. Lowering it is a durability
trade that has not been benchmarked on this workload and is deliberately not
part of this contract.

## Bounded tables

Every table below is pruned on the same write that grows it, inside one
transaction, so a soak of repeated writes stays inside the declared window
without a separate sweeper. Only the oldest prefix is ever removed: the newest
rows, and any sequence numbers derived from them, are untouched.

| table | window | order | never pruned |
|---|---|---|---|
| `checks` | 20 per Room (`CHECKS_RETAINED_PER_ROOM`) | `ran_at` | — |
| `changes` | 500 per Room (`CHANGES_RETAINED_PER_ROOM`) | `seq` | `pending` entries; entries anchoring an `android_app_installs` receipt |
| `android_device_events` | 2 000 across the Hotel (`ANDROID_DEVICE_EVENTS_RETAINED`); detail capped at 2 048 characters | `at` | — |
| `operations` | 50 per Room (`RETAINED_PER_ROOM`) | `started_at` | `running` operations; idempotency records with a `request_key` |

The two `changes` exclusions are lifecycle guarantees, not display
preferences. A `pending` change is an interrupted operation the next startup
must settle (`markInterruptedChanges`), and a tracked Android install is
re-proved against its originating change before acceptance
(`change.status === 'verified'`, `installedAt >= change.createdAt`); pruning
either would turn a recoverable state into an unexplained one. When a Room is
deleted, `roomsRepo.delete` removes all of its rows regardless of window.

Byte budgets follow from the row windows: a check report is a fixed set of
steps, a device event's detail is capped on write, and a change carries the
`before`/`after`/`captured` JSON of one operation. The soak tests in
`packages/core/src/__tests__/store.retention.test.ts` assert both the row count
and the summed column bytes against these windows.

## Crash-leftover staging

Four operations stage bytes in a fresh directory under `<userData>/tmp`,
work, and remove it in a `finally`:

| family | operation |
|---|---|
| `pull-<8 lowercase alnum>` | `pullRoomFile` |
| `push-<8 lowercase alnum>` | `pushRoomFile` |
| `device-adb-<6 alnum>` | physical-device `adb install` staging |
| `android-sealed-install-<6 alnum>` | sealed emulator APK install |

A process that dies between the `mkdir` and the `finally` leaves that directory
behind, and nothing revisited it. Startup now runs `sweepStaleStaging`
(`packages/core/src/lifecycle/stagingSweep.ts`) once, after interrupted-export
settlement and before Room reconciliation:

- **Exact names only.** An entry is considered only when its name matches one
  of the four families exactly. Artifact export staging (`artifact-export-*`)
  has its own quarantine sweep and is not touched here.
- **Live stages are retained.** Each operation registers its directory in the
  orchestrator's `liveStaging` set for its lifetime, so a repeated `init()` in
  the same process cannot remove a stage that is still being written.
- **Nothing is followed.** The root must be a regular directory whose canonical
  path is `<userData>/tmp`; otherwise the sweep reports `rootOk: false` and
  touches nothing. A family-named junction or symlink is retained. A stage is
  removed only if every child is a regular file; one holding a link or a
  nested directory is not something DevHotel wrote and is retained as well.
  Files are unlinked one by one after an `lstat` re-check, then the directory
  is removed with `rmdir` — there is no recursive delete.
- **Failures are counted, not thrown.** A file that cannot be unlinked leaves
  its stage in place and increments `failed`. `init()` continues with
  operations, gateway and Room reconciliation regardless.

The result is published as `startup.stagingSweep` on `startupStatus()` and
`hotelStatus()`: `{ rootOk, removed, retained, failed }`. Counts only — the
Host-private paths never leave the process, matching the existing export
staging policy. A second startup over the same directory reports zero removals
and the same retained set, which is what the idempotence tests check.
