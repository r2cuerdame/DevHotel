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
- **it is an Android Room.** See below.

Ownership is the one thing that is not a fallback condition: a foreign container
wearing a Room's name still fails the wake rather than being quietly worked
around. A warm start that fails partway stops whatever it started, so the caller
always gets back the same stopped pod it had.

Because nothing is recreated on the warm path, an Android Room's tracked installs
would survive it. They are not trusted on that basis: every tracked install is
re-proved against package, user and incarnation before it is used again.

### Why Android Rooms always recreate

A retained `budtmo/docker-android` emulator container cannot be restarted, so
Android Rooms refuse the warm path before starting anything rather than spend a
doomed emulator boot on every wake.

Stopping the container is always a SIGKILL — its PID 1 does not forward SIGTERM,
so `docker stop` times out and the container exits 137. Xvfb therefore never
releases `:0` and leaves a read-only `/tmp/.X0-lock` behind. On the next start
the image's one-shot KVM bootstrap also fails, because it deletes the root
`/etc/passwd` entry it needs for `sudo chown /dev/kvm`; DevHotel repairs that
identity, and with it repaired qemu does relaunch and reports
`CPU Acceleration: working`. It then dies anyway:

```
INFO | Warning: could not connect to display :0 (:0, )
INFO | Fatal: This application failed to start because no Qt platform plugin
       could be initialized.
```

No Docker CLI operation can delete a file inside a stopped container, so the
stale lock cannot be cleared from outside, and the image offers no way to shut
the emulator down cleanly first. The warm Android path belongs to the managed
runtime (#108), which owns the emulator process directly and can stop it
gracefully.
