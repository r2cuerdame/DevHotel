# Room lifecycle policy

DevHotel tracks Room activity separately from display-oriented `lastUsedAt`. The durable `lastActivityAt` clock drives a small desktop sweep with these defaults:

- idle Rooms sleep after 1 hour;
- clean eligible Rooms enter `expired` grace after 7 days;
- expired Rooms are deleted after a further 24-hour grace period.

The three durations are configurable through `RoomOrchestrator`'s `lifecyclePolicy` option. Waking or using a Room resets `lastActivityAt` and cancels expiry grace.

Automatic deletion is fail-closed. A Room is retained when it is pinned, modified, has tracked activity beyond its clean import, contains Postgres or Redis data, uses a non-Web provider, or does not have a clean managed-Git workspace. Pinning does not prevent idle sleep; it prevents expiry and deletion.

Automatic sleep, expiry, grace cancellation, and pin changes are written to Room history. Deletion begins with a final lifecycle journal entry, although deleting the Room also removes its Room-scoped history as part of normal cleanup.

## Warm wake

Sleeping a Room stops its containers; it does not remove them. Waking one takes
the warm path first: if every retained container is still the exact owned
container the Room went to sleep with, and its configuration still matches what
the Room record asks for now, DevHotel restarts them in place instead of
recreating them. A warm Web Room answers again in about 4 seconds and keeps its
running process state, its Room Services' data, and its cache volume.

Reuse is fail-closed. The backend answers with a refusal — never an exception —
and the wake falls back to the ordinary recreation path, recording the reason on
the `container-start` stage so a Room that silently recreates every wake is
visible rather than merely slow. A Room is not reused when:

- **its relay credential is gone.** The anchor's relay verifier is fixed when the
  anchor is created and the raw capability is only ever held in memory, so a
  retained anchor from an earlier app run cannot be opened again. Restarting
  DevHotel therefore always recreates anchors, by design.
- **a participant is missing, or is not cleanly stopped.**
- **the Room changed while it slept** — its image, start command, environment,
  relayed port, workspace/deps/cache volumes, or a Room Service version. Changes
  made to a sleeping Room are materialized by recreating its containers, so
  drift has to refuse.

Ownership is the one thing that is not a fallback condition: a foreign container
wearing a Room's name still fails the wake rather than being quietly worked
around. A warm start that fails partway stops whatever it started, so the caller
always gets back the same stopped pod it had.

Because nothing is recreated on the warm path, an Android Room's tracked installs
survive it. They are not trusted on that basis: every tracked install is
re-proved against package, user and incarnation before it is used again.

## Golden profiles and warm allocation

Room acquisition is ordered deliberately: DevHotel first returns an existing
compatible Room, then wakes a compatible hibernated Room, and allocates a new
Room only when neither exists. A display nickname is not identity. Source,
project, provider, requested runtime profile and task/issue identity are.

For new Linux-backed Rooms, the immutable OCI image is the golden baseline and
the engine's overlay/reflink snapshotter is the copy-on-write clone mechanism.
DevHotel never copies an unpacked root filesystem in JavaScript. After an exact
profile reaches app-ready, the process records bounded ready claims for that
baseline. The default bounds are two claims per profile, four profiles globally,
and 30 minutes idle. Claims are consumed before allocation, replenished only by
a successful readiness proof, and least-recently-used profiles are evicted when
the global bound is reached.

A profile includes provider, runtime and package-manager versions, start command,
internal port, OS resources/environment, and Android device/OS/display settings.
Its snapshot version hashes that complete profile together with the Warm Room
schema and DevHotel runtime version. Any change therefore takes the cold path
until the new profile reaches ready; stale versions are never silently reused.

Android stays on the Android-native path: KVM-backed AVD Quickboot plus the
existing shared SDK/Gradle caches and immutable OCI layers. Firecracker is not
introduced. Sleeping keeps the per-Room AVD snapshot, so a compatible Room wake
reuses the booted emulator rather than provisioning it again. The pool never
shares mutable AVD state between Rooms.

Every `acquire_room` result contains benchmark telemetry with its `reuse`,
`warm`, or `cold` path and three monotonic durations:

- acquire to boot-ready;
- boot-ready to app-ready;
- acquire to app-ready.

It also reports the profile key, explicit snapshot version, and clone strategy.
The orchestrator retains the newest 200 samples in memory for local benchmark
reporting; source URLs and workspace contents are not included.
