# The Host footprint

Everything DevHotel owns on a machine, in one list, once each — and the rules
that decide what may be reclaimed from it.

Before #109 the answer to "what is DevHotel costing this machine" was assembled
from an engine's own nouns: a volume list reasoned about in one place, a
container list in another, and a Host ingress port nowhere at all. That was
workable while Docker was the only engine. With Rooms running inside the
DevHotel-managed runtime there are two engines, the Host owns ports that belong
to neither, and "ask Docker" stopped being a complete answer.

## The nouns are DevHotel's

A **`HotelArtifact`** is one thing DevHotel owns. There are five kinds:

| kind | what it is |
|---|---|
| `room-network` | a Room's private isolation domain — why two Rooms can both serve port 3000 |
| `room-container` | a Room's namespace anchor, its web workload, its services |
| `room-disk` | a durable Room disk: workspace generation, dependencies, cache, SDK, service data |
| `shared-cache` | a Hotel-scoped disk deliberately shared by many Rooms |
| `ingress-route` | a Host port published so the Gateway can reach one Room |

Each carries a **scope** (`room` or `hotel`), an **ownership proof**, a
**reachability** verdict, and a single `collectable` flag derived from both.

Nothing in `packages/core/src/lifecycle/footprint.ts`, `gc.ts`, `quotas.ts` or
`reconcilePlan.ts` imports a backend, spawns a process, or knows the word
"docker". An engine adapter reports observations in the shapes in
`observations.ts`; everything above that is a pure function of one snapshot.

## Ownership is proved, never assumed

| proof | meaning | authorizes destruction |
|---|---|---|
| `managed-labels` | the engine reports DevHotel's complete ownership label set | yes |
| `ledger` | DevHotel's own durable record created it | yes |
| `name-only` | the name matches a DevHotel pattern and nothing corroborates it | **no** |
| `none` | nothing identifies it as ours | **no** |

A name is never a proof. `dh-`-prefixed is what a collision looks like.

## Reachability can be unknown, and unknown is not free

`reachable: false` and `known: false` are different answers, and the difference
is the whole safety property. An engine that could not report attachment state,
a Room whose operation history is unavailable, a disk whose size the engine
declined to compute — each leaves reachability *undetermined*, and an
undetermined artifact is never collected.

A shared cache has its own rule: it is reachable while **any** Room exists.
Deleting a Room says nothing about the Rooms still using it.

## Completeness gates everything downstream

`HostFootprint.complete` is false when an engine listing failed, an artifact was
reported twice, or the ingress ledger could not be read. An incomplete footprint
still renders — but it **cannot authorize a collection**, because unreachability
is a claim about everything that could reach a thing, and a partial list is not
everything. `planHostGc` refuses to plan at all and says why.

A quota verdict computed from an incomplete footprint reports
`conclusive: false` for the same reason: a partial inventory can only understate
usage, so a clean verdict from one is not evidence of headroom.

## GC has to pass four gates

```
collectable = ownership.proved
           && reachability.known
           && !reachability.reachable
           && sizeKnown
```

All four, none inferable from another. `sizeKnown` is in there because a bounded
pass cannot bound something whose cost nobody established.

A real pass additionally:

- requires explicit `maxArtifacts` and `maxBytes` — no unbounded sweep exists;
- takes the smallest artifacts first, so one huge disk cannot consume the byte
  budget and starve the pass;
- re-observes and re-proves each artifact under the Room lock immediately before
  removing it, because a plan describes the moment it was made and a Room can
  wake in between;
- records every refusal with the proof that was missing.

Room **disk** verdicts are not re-decided here. The existing fail-closed volume
reconciler owns them, carrying the recovery fences, undo retention and
sleeping-Room protections earned across several issues; the footprint translates
its verdict and ANDs its own gate onto it. This layer can only ever be more
conservative than the reconciler it inherits.

## Quotas refuse creation; they never delete

```
maxRoomBytes, maxRoomArtifacts, maxRoomWorkspaceGenerations,
maxHotelBytes, maxHotelArtifacts, maxIngressRoutes
```

A breach blocks one more of something and names the limit, the allowance and the
observed value. What to free is then a decision made with the footprint in hand,
and freeing it still goes through GC's proofs. A limit that deleted to stay under
itself would be reclaiming without proof — the exact thing this design rules out.

The defaults are deliberately generous. They exist to catch a runaway — a clone
loop, a Room staging generations it never publishes — not to ration ordinary use.

## Reconciliation is decided before it is done

`planReconciliation` is a pure function from an observed snapshot to an ordered
`ReconcileAction[]` plus a digest. The rules are the ones that were already
there, moved rather than rewritten.

Phases run in a fixed order — resume-delete, revoke-ingress, remove-container,
remove-network, adopt-network, mark-broken, stop-room, sleep-room, preserve —
and within a phase, targets are sorted by name. Two builds that agree on what a
restart owes the Rooms produce the same digest, so a change in recovery
behaviour shows up in a diff rather than in a user's Rooms.

Replanning against the state a plan produced yields no destructive actions.
What remains is `preserve`, `stop-room` and `adopt-network`, all convergent.

The plan is logged before anything acts on it:

```
reconcile: plan 4c4765c92ebf with 7 action(s)
```

## Ingress routes are artifacts too

Every other owned thing can be enumerated by asking the engine that holds it. A
Host ingress port cannot: no engine knows about it, and the Host's socket table
cannot say which Room it belonged to. Until #109 the only record was a `Map`
inside a running process, which is fine right up until the process does not exit
cleanly — and then a port is listening, a connection to it hangs against a
container that is gone, and nothing on the machine can attribute or reclaim it.

`IngressLedger` writes it down, atomically, under `<userData>/runtime/ingress.json`.
The record is written after the port binds and before the port is handed to the
Gateway. A damaged ledger reports damage and returns empty rather than throwing —
losing the inventory is not a reason to refuse to start — and the damage becomes
a footprint gap, which is where it matters.

## Shared caches

A Room's `/cache` stays per-Room; it holds things a Room can dirty. The Node
package store moves to a Hotel-scoped disk, `dh-shared-packages`, mounted at
`/shared-cache`, with `npm_config_cache` and `PNPM_HOME` pointing into it. The
contents are content-addressed, so the bytes are identical between Rooms by
construction and the per-Room copy only ever bought a second download.

`dh-shared-` cannot collide with `dh-<roomId>-`: a Room ID is exactly eight
lowercase alphanumerics and `shared` is six. The labels carry
`devhotel.scope=hotel` and deliberately no `devhotel.room`, so the Room volume
validator rejects one on sight and no Room-scoped deletion path can reach it.

Turn it off with `RoomOrchestrator`'s `sharedPackageCache: false`.

## Reading a real Host

```
DEVHOTEL_FOOTPRINT_REPORT=1 \
DEVHOTEL_FOOTPRINT_ROOMS="<roomId>:<status>,..." \
pnpm --filter @devhotel/core report:host-footprint
```

Read-only: it observes, plans, and removes nothing. It prints the footprint
totals per kind and the first refusals with their reasons, and asserts the two
invariants on live data — one artifact per observation, and every planned
collection carrying all four proofs.
