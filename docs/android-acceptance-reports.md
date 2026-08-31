# Android acceptance reports

Android acceptance reports are immutable, Room-scoped receipts assembled from
evidence DevHotel can reverify. They are not a transcript and never contain raw
commands, log text, adb serials, lease capabilities, source paths, or Host
paths.

## Stages

- `development` always uses the Room emulator. Omitting `target` selects that
  emulator; a physical or automatic target is rejected.
- `final-physical` requires an explicit opaque physical `deviceId` and the
  exact active device lease whose purpose is `acceptance`. There is no emulator
  fallback.

Both stages authenticate the digest-pinned build image, the exact tracked APK
installed by a verified `android_run`, its sealed Room-generation provenance,
and every cited evidence object. Installation-local HMAC identities
authenticate private source, environment, lease, retained-log, and report
material without publishing those inputs. An empty app-locale list explicitly
means the app follows the system locale.

Development acceptance may launch and crash the managed Room emulator. It
captures a strictly read-only API 33+ app-locale/install/runtime seed, then
atomically owns a durable emulator-only reservation before even the initial
screen-witness log marker. After acquisition it re-proves every seed and fence
before entering that witness. A synchronous `reserved` to `mutating` CAS lands
immediately before the first recoverable runtime pause; only the latter phase
requires locale/runtime recovery. A provably dead `reserved` owner is released
after startup proves stale jobs absent, without launching, restoring, pausing,
or otherwise writing the emulator/runtime. Development acceptance restores the
exact locale and runtime after a `mutating` phase, and
requires the same bounded foreground/install/user/API/PID proof before
publication. Startup recovery restarts only the exact retained emulator and
keeps an unproven intent attention-gated.

Development acceptance, locale matrices, and artifact export claim their
Room-mutating recovery intents with one SQLite write that requires all three
intent keys to be absent. Process-local preflight reads are advisory: if a
second DevHotel process wins a different intent after those reads, the loser
performs no target or runtime mutation.

Final physical acceptance is observation-only. It starts no Room pause or
source-copy/fingerprint helper and sends no locale setter/restorer, launch,
force-stop/crash, screen-witness/log marker, install, or other target writer.
After a read-only snapshot seals the install/user/API/locale fence,
`proveAppLocaleFinalState` runs an initial and final composite proof; each proof
uses two complete release pulses for the exact lease, installed APK bytes and
incarnation, Android user, live API, locale list, foreground owner, and stable
PID set. Every value and both PID sets must remain unchanged. Consequently the
receipt records `process.restarted=false`, `crash=null`, and `restored=true` as
"observed unchanged", not as evidence that DevHotel wrote the locale. A final
physical request with `includeCrashScenario=true` is rejected by the shared
request schema before lease, backend, session, or recovery work begins.

Because Room locks are process-local, physical proof also acquires a durable
device-wide read-only proof nonce. Every mutating Host ADB gateway first records
one device-unique writer intent and refuses to start while that nonce exists;
the proof refuses to start while any writer intent remains. A writer intent
survives process death and lease replacement because an orphan ADB child cannot
be assumed stopped; manual target remediation is required. A proof nonce is
safe to remove only when its owner process is provably dead, because proof
commands are restricted to exact typed read argv.

## Evidence

Each caller step must be `pass` or `fail` and cite at least one immutable
screenshot artifact or completed retained Room run. Screenshot metadata must
match the report's Room generation, target, API, application, APK, install
receipt, its own locale-bearing capture, and time window. Locale-matrix
screenshots may intentionally span several app locales; the report preserves
each artifact's durable locale receipt without inventing transient per-capture
readiness. Retained runs are bounded and authenticated over their exact stored
bytes. Pruning holds the same SQLite `BEGIN IMMEDIATE` exclusion used by final
log verification, report insertion, and run pinning. Thus prune-first makes the
final verification fail with no report, while report-first makes pruning see
the committed pin. A busy pruner skips that pass without deleting files or
failing the completed command. Pinned runs remain exempt until the Room is
deleted.

For development acceptance only, an optional `am-crash` scenario records
bounded process-termination and package-scoped log accounting. DevHotel always
relaunches, reapplies the exact original app-locale list, and reproves locale
service readiness, the same PID set twice, foreground application, tracked
install, active user, and emulator target before publication. A failed
verification triggers one explicit restoration attempt; an unproven
restoration dominates the original failure and publishes no report or run
pins.

Final physical publication uses one `BEGIN IMMEDIATE` transaction to recheck
the exact active `purpose=acceptance` lease, proof nonce, Room revisions,
tracked install receipt and `android_run` provenance, and every retained-log
byte. It then inserts the report and pins and removes that exact proof nonce.
Any lease, Room, install, provenance, log, or nonce race commits none of them.

Detailed reads recheck the report seal, every screenshot byte/receipt, and
every pinned retained-log byte. A changed or missing object invalidates the
read instead of returning a partial report.

## API and MCP

| Surface | Operation |
|---|---|
| Control API | `POST /v1/rooms/:id/android/acceptance-reports` |
| Control API | `GET /v1/rooms/:id/android/acceptance-reports?limit=1..20` |
| Control API | `GET /v1/rooms/:id/android/acceptance-reports/:reportId` |
| MCP | `android_create_acceptance_report` |
| MCP | `list_android_acceptance_reports` |
| MCP | `get_android_acceptance_report` |

Creation and detailed reads return strict JSON plus bounded GitHub-ready
Markdown. The Markdown uses Room artifact retrieval descriptors. It does not
invent repository image links: an exported file becomes a repository image
only when a separate verified export receipt exists and the caller supplies a
real repository/ref URL.

Example creation body:

```json
{
  "applicationId": "com.example.app",
  "stage": "development",
  "steps": [
    {
      "id": "login-screen",
      "status": "pass",
      "screenshotArtifactIds": ["11111111-2222-4333-8444-555555555555"]
    }
  ]
}
```

Reports are intentionally bounded per Room by receipt count/bytes, pinned run
count/bytes, screenshot bytes/pixels, and referenced log bytes. Delete the Room
when its retained acceptance history is no longer required.
