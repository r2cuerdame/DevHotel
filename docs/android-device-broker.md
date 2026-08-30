# Android Device Broker — one phone, many Rooms

A USB Android phone plugged into the Host is the one development resource
DevHotel cannot give each Room a private copy of. `adb` has no notion of
ownership: two projects that both run `adb install` reach the same device, and
the second one silently overwrites the first one's app, foreground activity and
logcat. The test that fails afterwards looks like a product bug.

The Device Broker makes that phone a **Hotel Service** — shared infrastructure
DevHotel owns once and lends out — and gives it to exactly one Room at a time.

```text
Projects / Rooms  →  DevHotel Android device queue  →  Physical USB devices
```

## Emulator first — the phone is for the last mile

Every Android Room already owns a private KVM emulator in its own network
namespace. That emulator is **not** brokered and never enters the queue,
because it belongs to one Room already.

That split is the operating rule, not just an implementation detail:

- **Development iteration** — build, install, UI checks, screenshots, ordinary
  instrumentation — runs on the Room's own emulator, with no lease at all.
- **A physical device is requested only for final acceptance / release
  verification**, or for behaviour an emulator cannot reproduce: notifications,
  keyboard/IME, background execution, sensors, battery, OEM-specific behaviour,
  permission and store integration.
- Those exception runs state their purpose, take a short lease, and release it
  immediately.

The contract a test plan should follow is `emulator PASS → physical device
final PASS`. One phone must not become the standing bottleneck for every
project's inner loop.

### What stays on the phone afterwards

After a physical-device verification the **verified build stays installed**.
The broker runs no `adb uninstall`, no `pm clear`, and no data wipe on release
or on stale recovery — not for the Room that finishes, and not for the Room
that picks the phone up next. A human can pick the phone up and open the app
that was just verified.

Cleaning up is therefore an explicit act of a specific test contract, never
something the broker does on its own.

## Leases

A lease is exclusive and records who has the phone and why:

| Field | Why it exists |
|---|---|
| `deviceId`, `roomId`, `project` | who is holding it, in the words a waiting project understands |
| `issueRef`, `runId`, `workerId` | which run this is, and whose process to check for liveness |
| `purpose` | `smoke`, `acceptance`, `notification`, `keyboard`, `background`, `sensor`, `battery`, `other` |
| `acquiredAt`, `heartbeatAt`, `activityAt` | age, liveness, and whether the phone is actually being worked |
| `ttlMs`, `maxDurationMs` | when silence becomes suspicious, and the hard ceiling |

Exclusivity is enforced by a partial unique index on the lease table, not by
careful callers: at most one `active` lease can exist per device.

## Queue

A request for a busy phone **queues** rather than failing. A project that
cannot see its place in line has no way to tell "taken for thirty seconds"
apart from "broken".

- FIFO by default, with an integer `priority` so an urgent release gate can go
  ahead of routine smoke runs.
- One waiting entry per Room per device — a retrying agent rejoins its own
  place instead of stacking duplicates ahead of everyone else.
- A waiting request can be cancelled.
- Waiters see the current owner, their position, and the reason.
- With several phones connected, a request that names no specific device takes
  whichever matching one frees up first.

```text
Pixel-USB-01
OWNER: Movit / R2C-194
STATE: testing
QUEUE:
1. MiracleKeyboard
2. WakePhone
3. AppDied
```

## Heartbeats and stale recovery

A worker that is killed must not park the phone forever — and a worker that is
merely busy must not lose it.

- The owner heartbeats; `busy: true` marks real device activity.
- **A missed heartbeat alone is not an immediate reclaim.** After the TTL, a
  known-live `pid:<process id>` worker keeps its lease. A deleted, sleeping or
  broken Room, a dead PID, or an opaque worker that remains silent through the
  grace period is reclaimed, so an unobservable crashed agent cannot park the
  phone forever. Opaque worker IDs therefore must heartbeat.
- Past `maxDurationMs`, a lease still reporting activity gets a warning, not a
  reclaim — a long `connectedAndroidTest` or a stuck OS dialog is real work.
  A lease that overran with no device activity is reclaimed.
- Unplugging the phone revokes the lease immediately, and **replugging never
  restores the old owner** — the queue decides who gets it next.
- Every reclaim promotes the next queued Room automatically.

## ADB isolation — no lease, no writes

Commands are classified by *whether another project would notice*, not by
whether they write files.

- **Interfering** (needs a live lease): `install`, `uninstall`, `push`,
  `reboot`, `shell am`, `shell pm clear`, `shell input`, `shell monkey`,
  `shell settings`, `shell setprop`, `uiautomator`, instrumentation,
  `logcat -c`, …
- **Shared** (no lease): a deliberately small read-only set such as `devices`,
  `get-state`, `shell getprop`, exact query forms of `dumpsys` / `wm`,
  `shell pm list`, `exec-out screencap -p`, and `logcat -d`.
- **Anything unrecognised fails closed.** A command DevHotel has never seen is
  treated as interfering rather than allowed through, and a "safe" program that
  smuggles a second command after `;`, `&&`, or `$( )` is refused too.

A refusal is structured, not a generic error — `no-lease`,
`lease-held-by-another-room`, `lease-expired`, `device-unhealthy`,
`device-unknown` — and it names the current owner so the caller can explain
itself.

## No hand-written serials

`resolveAdbTarget(roomId)` answers where a Room's Android automation should
point: the leased phone when one is attached, otherwise the Room's own
emulator. Attaching a device changes what a Room's screenshots and automation
drive, with nothing in the caller changing and no serial ever written by hand.

## Observability

`GET /v1/status` and the `android_devices` MCP tool answer "why can I not use
the test phone" directly: every connected device with nickname, health,
connection type, current owner (project, Room, purpose, lease age, last
heartbeat), queue depth with the waiting projects, and a recent event history
including grants, releases and stale recoveries.

Devices are addressed publicly by a **nickname** and a short opaque device ID
derived from the serial. Status, queue and attach responses do not return the
raw hardware serial; only the Host broker retains it to execute an authorized
ADB command.

## Surfaces

| Surface | Operations |
|---|---|
| Control API | `GET /v1/devices`, `POST /v1/devices/refresh`, `POST /v1/devices/heartbeat`, `POST /v1/devices/cancel`, `POST /v1/rooms/:id/device/attach`, `/device/release`, `/device/adb` |
| MCP | `android_devices`, `attach_android_device`, `release_android_device`, `heartbeat_android_device`, `cancel_android_device_request`, `android_device_adb` |
| Core | `RoomOrchestrator.attachAndroidDevice / releaseAndroidDevice / adbOnDevice / resolveAdbTarget / androidDeviceStatus / reapAndroidDevices` |

A Room releases its phone automatically when it sleeps or is deleted, and the
desktop app sweeps discovery plus stale recovery on its own timer — an owner
that died will never call anything again.

## Requirements and current limits

- The broker drives a **Host-side `adb`**. It is resolved from
  `DEVHOTEL_ADB_PATH`, then `PATH`, then the conventional
  `platform-tools` location under `ANDROID_SDK_ROOT` / `ANDROID_HOME` /
  `%LOCALAPPDATA%\Android\Sdk`. With no usable `adb`, the broker reports
  itself unavailable and lists no physical devices; Room emulators are
  unaffected. Shipping a Hotel-owned pinned `adb`, the way the GitHub Service
  ships a pinned `gh`, is still to come.
- Scope is deliberately **one Host with a few devices**. Device-farm SaaS,
  remote multi-host scheduling, and an iOS broker are out of scope.
- Physical-device ADB runs on the Host through the broker
  (`/device/adb`), not from inside the Room container: a USB phone is on the
  Host's bus, not in the Room's network namespace. APK paths are accepted only
  under `/workspace`; DevHotel copies their bytes into a private Host temp,
  rechecks the lease, installs from that temp, and removes it afterwards.
  `android-run` targets the Room emulator by default and automatically follows
  an exclusive physical-device attachment for the final proof.
