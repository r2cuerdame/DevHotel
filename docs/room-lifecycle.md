# Room lifecycle policy

DevHotel tracks Room activity separately from display-oriented `lastUsedAt`. The durable `lastActivityAt` clock drives a small desktop sweep with these defaults:

- idle Rooms sleep after 1 hour;
- clean eligible Rooms enter `expired` grace after 7 days;
- expired Rooms are deleted after a further 24-hour grace period.

The three durations are configurable through `RoomOrchestrator`'s `lifecyclePolicy` option. Waking or using a Room resets `lastActivityAt` and cancels expiry grace.

Automatic deletion is fail-closed. A Room is retained when it is pinned, modified, has tracked activity beyond its clean import, contains Postgres or Redis data, uses a non-Web provider, or does not have a clean managed-Git workspace. Pinning does not prevent idle sleep; it prevents expiry and deletion.

Automatic sleep, expiry, grace cancellation, and pin changes are written to Room history. Deletion begins with a final lifecycle journal entry, although deleting the Room also removes its Room-scoped history as part of normal cleanup.
