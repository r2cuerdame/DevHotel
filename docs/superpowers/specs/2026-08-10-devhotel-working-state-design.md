# DevHotel Room Working State / Sync / Build Design

**Status:** Core product invariant / target architecture

**Scope:** Local-first Windows product, Web Room first

**Implementation status:** Partial vertical slice. New Local Folder Rooms import into revisioned Room-owned source volumes and explicit Host sync stages an atomic replacement; existing direct-bind Rooms remain quarantined as `legacy-host-bind`. Android Clean Build briefly captures a complete owned source snapshot, executes with a pinned image and disposable SDK/Gradle state, and verifies Room-owned APK/provenance output without mutating the live Room. It remains an in-process Change, not a durable daemon Job, so new REST/MCP Room mutations wait for its operation lock. Incremental/COW sync, Room-to-Host Apply/Export, shared Web Build/Test revisions, independent daemon recovery, and complete Host/Room Agent context permissions are still design targets.

## 1. Decision

> **Every Room owns the state it executes.**

Host folders, Git remotes, archives and future cloud workspaces are sources and destinations. They are not a Room's live execution filesystem. A Room imports or incrementally synchronizes source into Hotel-owned storage, then runs only against that Room-owned working state.

Data leaves a Room only through an explicit operation such as **Apply to Host**, **Export** or **Commit**. Merely opening, starting, syncing or checking into a Room never grants an implicit Room-to-Host write path.

Build and test Jobs do not read a moving Room head. A Job consumes an immutable `StateRevision`, so the Room can continue to change while the Job runs and the result still has an exact, explainable input.

Clone, action-based Undo and Suite execution use the same capture/fork/restore primitive. Snapshotting is an implementation mechanism; users continue to work with actions, Rooms, Jobs and results rather than managing timestamped machine snapshots.

## 2. Product invariants

1. A Room is the sole owner of its executable workspace, runtime configuration, dependencies, generated state and service data.
2. No Room process receives a Host source folder as its live working-directory bind mount.
3. Host-to-Room synchronization is an explicit, observable ingress operation, even when the user enables automatic watching.
4. Room-to-Host writes happen only through an explicit Apply, Export or Commit operation and a scoped Host grant.
5. A build or test Job records and consumes exactly one immutable `StateRevision`.
6. Capturing a revision briefly coordinates with Room mutation; running the Job does not lock the mutable Room.
7. Job output never silently writes back into the Room or Host. Applying output is another guarded mutation.
8. Clone, Undo and Suite use the same revision catalog and snapshot semantics rather than separate copy systems.
9. Every result can answer which source, environment, optional service data and Job produced it.
10. The contract is independent of Docker volumes, WSL distributions, VM disks or a particular filesystem snapshot feature.

These are correctness boundaries, not optimizations. A backend without copy-on-write or native snapshots may be slower, but it must preserve the same behavior with verified copies and immutable manifests.

## 3. Terms and ownership

### 3.1 Working State

`WorkingState` is a Room's mutable head. It is a logical object and may be backed by several physical stores.

It includes:

- the Room-owned source workspace;
- runtime, package-manager, startup and network configuration;
- dependency and tool layers;
- generated files and caches according to policy;
- Room Service configuration and mutable data, such as PostgreSQL or Redis;
- opaque references to authorized environment and secret versions;
- the current parent revision and change generation.

Browser profile, logs, thumbnails and diagnostic history remain Room-owned but are normally outside build inputs. A capture scope must say explicitly whether these auxiliary components are included. They are not copied merely because a generic "snapshot" was requested.

Hotel Service package binaries, their process placement, shared credentials and live permission grants are not part of `WorkingState`. A Room may retain an opaque binding or policy reference, but a capture or Clone does not duplicate GitHub/MCP/Skills installations or silently copy Host/secret/remote-mutation grants. This differs from Room Services such as PostgreSQL, Redis, Web, Build/Test, local HTTPS and backup: their declared configuration, mutable data and consistency metadata are Room-owned and may participate in a scoped capture.

### 3.2 Source Endpoint and Sync Link

A `SourceEndpoint` is external to the Room. Initial endpoint kinds include a Git remote, an approved Host folder, an archive and an empty source.

A `SyncLink` connects one Room-owned workspace to one endpoint. It stores:

- an opaque link ID and owning Room ID;
- endpoint kind and canonical endpoint identity;
- granted direction and operations;
- include/exclude and file-normalization policy;
- the last common per-path base manifest;
- last observed endpoint and Room digests;
- conflict records and the last completed sync operation;
- actor, grant, timestamps and audit references.

A Host path is never persisted as an unchecked command argument. It is resolved through its scoped grant, canonicalized again for each operation and kept outside revision manifests intended for sharing.

### 3.3 StateRevision

A `StateRevision` is a sealed, immutable description of a consistent Room input. It references immutable objects rather than mutable paths or volume names.

A composed revision has at least:

- `stateRevisionId`;
- `workspaceRevisionId` and content-tree digest;
- `environmentRevisionId` and resolved environment-manifest digest;
- optional service-data revision IDs, each with a declared consistency level;
- parent revision IDs and originating Room generation;
- source provenance, including Git commit when present and a dirty-tree digest;
- capture operation, actor, lease/fencing token and timestamps;
- storage format/schema versions and integrity hashes.

An ID is opaque to clients. A backend may derive internal object keys from content hashes, but API consumers must not infer filesystem paths from IDs.

### 3.4 Job

A `Job` is a durable execution record. It references an immutable input revision and produces logs, events and artifacts with their own immutable IDs.

At minimum it records:

- `jobId`, type, owning Room and requested command or Suite case;
- `inputStateRevisionId`;
- actor, origin, capability grant and idempotency key;
- executor/runtime identity and fencing token;
- queued, running, succeeded, failed, cancelled or interrupted state;
- artifact IDs, output digests and result provenance;
- creation, start and completion times.

### 3.5 Hotel Service Context

Hotel Service installation is Hotel-owned shared state, separate from Room working state and authorization. **GitHub Service** is the first concrete service; MCP and Skills are later categories rather than Room installs. Host Agents and Room Agents may use Hotel Services with `hotel | host-project | room` context, so a Room is optional. Every connection still carries Agent identity, origin, optional Room ID and explicit resource/credential grant; Room-free use never implies ambient Host access.

A Job that uses a Hotel service records the logical service/tool identity, resolved version and authorization reference needed for provenance. It does not record a physical executable path, process/VM placement, privileged endpoint or reusable secret. Execution reauthorizes the context when the Job starts or resumes.

A `StateRevision` or Clone may carry a non-secret desired service binding, but it does not copy the shared package or active Host/secret grants. The destination context must satisfy current policy before the binding becomes usable. This keeps reproducibility metadata separate from authority and makes runtime topology an internal backend decision.

For GitHub use, provenance may record service/version, repository identity, observed commit/ref and authorization reference without reimplementing the native command schema. It never embeds the Hotel-managed `gh` credential or reusable token. Room lease/fencing protects changes to Room-owned state; remote authority remains a separate credential/grant concern even when initiated from the current writer Room.

CLI placement follows ownership. Project-versioned Node, pnpm, Vite, Prisma and compilers remain in the Room/environment revision. A CLI such as `gh`—and later `glab`, `aws`, `gcloud`, `vercel` or `kubectl`—may back a Hotel CLI Service only when it brokers shared external infrastructure/credentials. The Agent adapter exposes that service's native convention while the Gateway owns only scoped connection and authorization.

## 4. State model

```text
External source endpoint
        │ explicit import / inbound sync
        ▼
Room-owned mutable WorkingState ── capture ──► immutable StateRevision
        │                                          │
        │ explicit Apply / Export / Commit         ├─► Build Job
        ▼                                          ├─► Test Job / Suite cases
Approved destination                               ├─► Clone fork
                                                   └─► scoped Undo restore
```

The Room head has a monotonic `generation` or resource version. Every mutation declares the generation it observed. Sync, Apply, revision capture, Clone and Undo use compare-and-swap semantics so a stale operation cannot overwrite a newer head.

The last captured revision is not necessarily the current head. UI and API responses must distinguish:

- mutable Room generation;
- most recent durable `StateRevision`;
- revision used by each running or completed Job.

## 5. Host source is ingress, not execution storage

### 5.1 Initial import

Selecting a local folder creates a scoped Host-source grant and an import plan. DevHotel then:

1. validates the canonical root and grant;
2. scans for path escapes, unsupported entries and case collisions;
3. copies allowed source into a staging tree in Hotel-owned storage;
4. verifies file metadata and content digests;
5. atomically publishes a Room working-tree reference;
6. records the initial common sync base;
7. starts the Room only after confirming that no Host source path is mounted into its execution boundary.

The import never installs dependencies or runs project code on the Host. Untrusted source is first executed only inside the Room boundary.

Git metadata is handled through a Git-aware importer or a verified repository transfer. `.git` internals are not continuously file-synchronized. Dependency directories, caches, DevHotel metadata and configured secrets are excluded from source sync by default.

### 5.2 Inbound sync

Host-to-Room sync may be manual or watcher-assisted. A watcher is only a latency hint; missed events, overflow and sleep/resume require a digest-based reconciliation scan before declaring `In sync`.

Each sync is an operation with plan, preconditions, staged content, verification and a committed journal entry. A batch is published to the Room only if the expected Room generation still matches. Otherwise it is replanned or reported as a conflict.

Automatic inbound sync may apply non-conflicting Host changes. It must never imply automatic outbound writes.

### 5.3 Explicit outbound operations

Room changes leave the isolation boundary through one of three user-visible actions:

- **Apply to Host** — three-way apply selected Room changes to the granted Host source root.
- **Export** — write a patch, source bundle or selected artifacts to an explicitly approved destination.
- **Commit** — create a Git commit from the Room-owned tree. Sending that commit to a Host repository or remote branch is a separate explicit, authorized ref update.

An Agent may invoke these actions only with a matching scoped capability such as `host-source.apply:<syncLinkId>`. A general Room lease, terminal access or inbound-sync grant is insufficient.

Before an Apply, DevHotel shows the destination, changed/deleted files, conflicts, ignored files and whether Host backups are required. Branch or ref updates use expected-old-value compare-and-swap; they never force-update a changed Host ref by default.

## 6. Incremental sync and conflict model

Sync is a three-way comparison among:

- `B`: the last state known to be common for a path;
- `H`: the current Host endpoint state;
- `R`: the current Room state.

The common base is tracked per path so independent inbound and outbound changes can advance without pretending the entire trees are identical.

| Host since B | Room since B | Result |
|---|---|---|
| unchanged | unchanged | no operation |
| changed | unchanged | stage and apply Host change into Room |
| unchanged | changed | keep Room change; show `Room changes` |
| same resulting content | same resulting content | coalesce and advance the base |
| changed | changed differently | record conflict; overwrite neither side |

Deletion versus modification is a conflict. Directory/file type changes, ambiguous renames, Windows case-only collisions and unsupported links are conflicts unless a provider has a proven safe rule. Rename detection may improve the presentation but must not be required for correctness.

Conflict resolution is explicit:

- **Keep Room** updates the Room side and leaves Host untouched until a later Apply.
- **Take Host** imports the Host version into the Room as a recorded mutation.
- **Merge** edits a Room-owned merge result and verifies it before advancing the base.
- **Skip** leaves the conflict open and pauses automatic sync for that path.

Conflict records reference content IDs, not temporary Host paths. Resolving one path does not discard unrelated pending changes.

## 7. Capturing immutable revisions

`capture(roomId, scope, expectedGeneration)` is the shared primitive.

```text
Acquire short Room mutation barrier
→ validate expected generation and capture policy
→ flush/stage workspace objects
→ resolve environment and dependency identities
→ quiesce or checkpoint requested service data
→ write and verify immutable objects
→ commit the revision manifest and references
→ release barrier
```

A revision is visible only after every required object is durable and verified. A failed capture leaves no published partial revision. Staged unreferenced objects are safe for later garbage collection.

Any mutable dependency, tool or generated-input layer included in the environment is sealed or copied into an immutable object before publication. A version label, lockfile or pointer to the live Room dependency volume is not a sufficient Job input.

Capture scope is explicit:

- `workspace` — source and configured generated inputs;
- `environment` — resolved runtime/tool/dependency/config identities;
- `services: none | configuration | data`;
- optional named auxiliary state when a feature requires it.

Service data must state its consistency contract, for example `application-consistent`, `quiesced`, `crash-consistent` or `configuration-only`. DevHotel must not label a multi-service capture atomic when a backend only copied independent live stores. A Job may reject a revision whose consistency is weaker than the Job policy.

Secret values are not embedded in revision manifests. The manifest carries an opaque secret reference and version. A worker materializes only secrets authorized for that Job, and result provenance records the version reference without exposing the value.

## 8. Build and test while the Room changes

Accepting a build or test request performs or selects a revision before execution:

1. validate Room lease/capabilities and the requested head generation;
2. capture or reuse an exact `StateRevision`;
3. durably create the Job referencing that revision;
4. release the Room mutation barrier;
5. materialize a read-only revision base plus Job-private copy-on-write scratch;
6. run independently while the Room continues to change.

The worker must not mount the live Room workspace or dependency layer writable. Test fixtures, compiler output and dependency side effects go to Job-private scratch or artifact storage. Optional database/Redis inputs use isolated instances restored from the revision; a Job does not mutate the live Room service.

Results remain correct even when stale relative to the current Room. The UI says, for example:

```text
Test #284 passed on rev_01J…
Room has changed to rev_01K…                       [Run again]
```

Applying a generated file or fix from a Job is a new Room mutation guarded by the revision and expected current generation. If the same path changed since the Job input, DevHotel opens a conflict instead of overwriting it.

Multiple Jobs may consume one revision in parallel subject to resource policy. This is the basis of a Build/Test Suite matrix without sharing mutable workers.

## 9. One primitive for Clone, Undo and Suite

### Clone

Clone captures the selected source scopes and forks a new mutable `WorkingState` from the sealed revision. Source mutation can resume after capture; the target never follows later source changes implicitly.

A Clone receives new Room identity, domain, credentials, lease state and browser profile. Host Sync Links and Host write grants are not inherited by default. The user must explicitly attach an endpoint and grant to the new Room.

### Undo

Before a supported Change, DevHotel captures the affected scopes and stores the revision ID in the pending Change record. Undo restores only those scopes through a guarded mutation and then verifies the action outcome.

Undo remains action-based in the UI: `Undo Node 24 Upgrade`, not `Restore snapshot at 14:32`. If later Room changes overlap the captured scope, Undo replans, reports a conflict or becomes unavailable; it never silently rewinds unrelated state.

### Suite / Clean Run

A Suite captures one revision and starts independent Job instances or ephemeral Suite Rooms from it. Each instance gets a read-only base and private writable layer. Runtime variants create distinct environment revisions while retaining source provenance.

Artifacts and logs survive worker cleanup. The ephemeral instance is an execution detail; the durable product objects are the input revision, Job, result and artifacts.

## 10. Provenance

Every Job result and exported artifact must support this chain:

```text
Project/source endpoint
→ source import or sync operation
→ workspaceRevisionId
   + environmentRevisionId
   + optional serviceDataRevisionIds
→ stateRevisionId
→ jobId and executor identity
→ result/artifact IDs and digests
```

For Git sources, provenance includes repository identity, commit ID, submodule/large-file policy and a digest of uncommitted Room changes. A Git commit alone is not sufficient when the working tree is dirty.

For environment provenance, friendly selections such as `Node 22` are insufficient. The record includes resolved component/image/tool-layer identity, dependency lock/content digest, startup configuration, relevant non-secret environment references and migration/schema version.

Logs and diagnostics show short IDs for humans and expose full opaque IDs through copy/details. They do not expose Host absolute paths, secret values or backend physical volume names.

## 11. UX state

Runtime, working-state sync and Job state are separate dimensions. A single `Running` badge cannot represent all three.

Suggested working-state/sync labels:

- **In sync** — Room and endpoint match for all tracked paths.
- **Room changes** — durable Room changes have not been applied/exported/committed outward.
- **Host changes available** — endpoint changes are observed but not yet imported.
- **Syncing** — an inbound batch is staged or being verified.
- **Conflicts** — at least one path needs resolution; no conflicting path was overwritten.
- **Sync paused** — endpoint/grant is unavailable or policy paused the link.
- **Legacy linked** — Preview-only direct-bind Room that has not been migrated.
- **Needs Attention** — interrupted capture/apply or integrity verification requires recovery.

Suggested Job presentation:

- `Queued · rev_01J…`
- `Testing · rev_01J…`
- `Passed · Current revision`
- `Passed · Room changed since run`
- `Failed · rev_01J…`
- `Interrupted · recovery available`

The Lobby stays simple. Detailed sync conflicts, revision provenance and artifact lineage belong in a contextual panel. The default UX emphasizes `Sync`, `Apply`, `Run again` and action-based `Undo`, not snapshot administration.

## 12. Concurrency and consistency

- One Room writer lease and fencing token govern mutable head changes.
- Sync, Apply, capture, Undo and applying Job results also acquire a Room mutation barrier and validate `expectedGeneration`.
- Capturing should minimize the barrier duration; slow Job execution occurs after it is released.
- A stale Agent, watcher event or worker cannot publish after a newer fencing token or generation.
- The revision catalog is append-only. Published revision objects are never modified in place.
- Service capture either coordinates a declared quiesce boundary or records a weaker consistency level.
- Host endpoint writes validate expected per-path hashes immediately before replace. A changed Host file becomes a conflict.

## 13. Crash safety and durability

Metadata and content publication use a durable operation journal.

```text
planned → staging → verified → committing → committed
                              ↘ failed / recovery-required
```

Required behavior:

- objects are written to unique staging locations, flushed where supported, hashed and only then referenced by a committed manifest;
- Room head, sync base and operation state advance transactionally or through an idempotent recoverable protocol;
- restart reconciles unfinished operations before allowing conflicting mutation;
- revision and artifact garbage collection considers Room heads, Jobs, Changes, Clones, exports and recovery records;
- deletion is reference-aware and never removes an object still reachable from a durable record;
- interrupted service capture is not published as a valid data revision;
- retry uses operation/idempotency IDs and cannot duplicate an outbound apply or ref update.

A general Host filesystem does not provide a multi-file transaction. Apply therefore stages new files, records expected hashes and per-path commit progress, uses atomic file replacement where available, and keeps recovery material until completion is verified. After a crash DevHotel must offer deterministic completion or rollback when possible and otherwise mark `Needs Attention`; it must not claim a partially applied tree is synchronized.

## 14. Security boundary

Host source and destinations remain outside the Room trust boundary.

- A Host operation requires a canonical, user-approved, narrow grant and matching capability.
- Drive roots, user-profile roots, DevHotel's own control/data roots and other broad scopes are denied by default.
- Every traversal revalidates symlink, junction and reparse behavior; canonical containment is not checked only once at grant creation.
- Absolute paths, `..` traversal, alternate data streams, reserved device names, unsafe case collisions and unsupported special entries are rejected or surfaced for explicit handling.
- A replaced endpoint, changed filesystem identity or expanded reparse target invalidates the operation until re-approved.
- Room code cannot directly invoke the privileged sync/apply implementation or receive Host credentials.
- A Hotel Service invokes sync/apply or remote repository operations only through the Agent Gateway with the caller's Host/Room context and matching grant; its installation, credential availability or process placement gives it no ambient Host authority.
- Apply/Export/Commit plans redact secrets and do not export ignored secret material by default.
- Audit records include actor, origin, grant, operation, affected logical paths and outcome without recording secret contents.

The Room may read imported untrusted source, but Host sync code treats filenames and metadata as hostile input. It never executes project hooks on the Host during scan, import, Git inspection or export.

## 15. Storage-backend contract

The architecture depends on semantic interfaces rather than a storage product:

- `WorkingTreeStore` — mutable Room-owned tree with generations and guarded publish;
- `ImmutableObjectStore` — content/object write, verify, read and reference-aware GC;
- `SnapshotProvider` — capture, materialize read-only, fork copy-on-write and scoped restore;
- `RevisionCatalog` — immutable manifests and provenance queries;
- `ServiceCheckpointProvider` — declared consistency capture and isolated materialization;
- `SyncAdapter` — endpoint scan, staged transfer, conflict and guarded apply;
- `ArtifactStore` — immutable Job logs/results with retention policy.

A provider advertises capabilities such as native snapshot, reflink, block clone, quiesce, portable export and atomic replace. The coordinator chooses a strategy but preserves the contract:

1. native snapshot or reflink when ownership and durability are verified;
2. content-addressed copy or archive when native primitives are unavailable;
3. explicit unsupported result when the requested consistency cannot be guaranteed.

Room manifests and public APIs use Room/revision/object IDs. Docker volume names, WSL paths, VHD identifiers and VM snapshot IDs remain backend-private ownership metadata.

## 16. Migration from current `linked-folder`

New Local Folder Rooms in the current Preview import the selected Host folder through a short-lived read-only mount into Room-owned source storage and execute only that imported state. Existing Rooms created by the earlier direct-bind implementation remain explicitly labelled `legacy-host-bind`: their edits can still mutate Host source immediately, they have no independent sync base, and Agent mutation/Clone stays blocked until migration. General Web build/test commands still observe the mutable Room workspace when they read it; Android Clean Build is the bounded exception that consumes a complete Room-owned source snapshot with disposable SDK/Gradle state.

Migration is an explicit, recoverable conversion rather than a silent metadata flip:

1. label existing Rooms `Legacy linked` and show that Host writes are immediate;
2. require the Room to Sleep and stop all processes that can write the bind mount;
3. revalidate the existing canonical Host grant and inventory the source safely;
4. import to a new Hotel-owned staged working tree and verify digests;
5. create the initial Sync Link and common per-path base;
6. update the Room manifest to the owned working-state backend;
7. recreate the execution environment with no Host source bind;
8. verify mount tables, start the Room and run source/runtime health checks;
9. retain migration recovery metadata until the user confirms the new Room works.

No migration step deletes or rewrites the Host source. If cutover fails, DevHotel keeps the imported staging data for diagnosis and leaves the previous Room stopped or resumes the clearly labelled compatibility mode only with user choice. It never reports the Room as migrated until execution-mount verification succeeds.

For rollout:

- new local-folder Rooms should use import plus Sync Link once the feature exists;
- existing direct-bind Rooms remain an explicitly limited compatibility mode during migration;
- Agent checkout and unattended execution should be disabled or strongly restricted for legacy direct-bind Rooms;
- the direct-bind creation path is removed only after Apply/Export/Commit and conflict recovery meet acceptance gates.

## 17. Acceptance gates

This design is not complete until tests demonstrate all of the following:

1. Editing a running Room cannot change its linked Host source before an explicit outbound action.
2. Room process mount inspection finds no Host source path.
3. Incremental Host import preserves Room-only changes and reports same-path conflicts without overwrite.
4. Interrupted import and Host Apply recover without falsely advancing the sync base.
5. A test Job continues on one immutable revision while the Room is edited, and its result reports that exact revision.
6. Two parallel Jobs from one revision cannot mutate one another or the live Room.
7. Clone, Undo and Suite exercise the same revision capture/materialization implementation.
8. Revision provenance identifies source, dirty tree, resolved environment, service consistency and Job.
9. Host path traversal, junction/reparse escape, endpoint replacement and stale grants are rejected.
10. The same behavior passes on the managed runtime backend and any compatibility backend, regardless of snapshot optimization.
11. Capture and Clone neither duplicate a Hotel Service installation nor transfer active Host/secret/GitHub-mutation grants; a service call in the destination is authorized again for that Agent context.
12. GitHub fetch/read provenance can be recorded without persisting reusable credentials, and remote mutations fail without their own explicit grant even when the caller holds the Room writer lease.

Until these gates pass, documentation and UI must describe Room-owned working state and immutable Job inputs as target architecture, not shipped behavior.
