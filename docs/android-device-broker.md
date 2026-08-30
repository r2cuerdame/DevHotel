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

### One handset, multiple ADB transports

Android Wireless Debugging can expose the same handset twice at once: once by
its USB serial and again by a TLS/mDNS service name. Inventory probes a stable
Host-private hardware identity on every ready physical transport, immediately
turns it into an install-keyed HMAC, and groups all matching transports before
persisting or granting anything. Raw identity-probe output is never logged,
returned, or stored in the correlation column; the selected ADB transport
serial remains in the Host-private row under the existing broker contract.
Thus USB and wireless routes share one opaque device ID, one queue, and one
database-enforced lease domain.

When both routes are healthy and no lease exists, USB is preferred. An active
lease remains pinned to its exact transport and opaque ID so an in-flight
operation never changes serial underneath its fence; if that route disappears,
the lease is revoked before an alternate route can be selected. A ready route
whose identity cannot be verified makes the physical inventory unavailable
instead of being admitted as a second, independently leasable device.

## Queue

A request for a busy phone **queues** rather than failing. A project that
cannot see its place in line has no way to tell "taken for thirty seconds"
apart from "broken".

- FIFO by default, with an integer `priority` so an urgent release gate can go
  ahead of routine smoke runs.
- One waiting entry per Room — an identical retry rejoins its own place, while
  a changed request explicitly replaces the previous durable row instead of
  leaving a stale request that can acquire another phone later.
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
  restores the old owner** — the queue decides who gets it next. The former
  Room keeps a sticky failed-physical target until it explicitly releases, so
  an acceptance run cannot silently fall back to its emulator after unplug.
- Every reclaim promotes the next queued Room automatically.

## ADB isolation — no lease, no writes

Commands are classified by *whether another project would notice*, not by
whether they write files.

- **Interfering** (needs a live lease): `install`, `uninstall`,
  approved mutating `shell am` / `shell pm` subcommands, `shell input`, and
  `shell monkey`.
- **Shared** (no lease): a deliberately small bounded set such as `get-state`,
  selected non-identifying `getprop` keys, and exact `wm size` / `wm density`
  queries.
- **Broker-only** (always refused): Host-wide server/connection/inventory verbs
  such as `kill-server`, `start-server`, `connect`, `devices`, raw transport
  queries such as `get-serialno`, unapproved `getprop` keys, caller-supplied
  target selectors, Host-path reads such as `push` / `pull`, Host SDK path
  disclosure through `adb version`, transport/runtime restart operations such
  as `reboot`, `root`, `tcpip`, `usb`, `shell svc`, and `shell setprop`, raw
  shared-configuration surfaces including `shell settings`, `shell content`,
  `shell device_config`, and `shell cmd`, runtime-stopping `shell am hang` /
  `shell am restart`, and cross-app or large-output reads including `logcat`,
  `dumpsys`, `exec-out`, `pm list/path/dump`, `ps`, `top`, `jdwp`, raw
  `screenrecord`, and `wm` modes other than the two exact queries.
  A physical lease does not make those shared configuration surfaces safe.
  Screen capture and tracked-app checks are available only through their
  high-level operations, which build the argv internally.
- **Anything unrecognised fails closed.** An unknown Host verb or shell program
  is categorically refused rather than made safe by a lease, and a "safe"
  program that smuggles a second command, remote expansion, or glob after `;`,
  `&&`, `$( )`, `$VAR`, or `*` is refused too. Shared commands accept only
  their documented exact arity.

A refusal is structured, not a generic error — `no-lease`,
`lease-held-by-another-room`, `lease-expired`, `device-unhealthy`,
`device-unknown`, `adb-command-forbidden` — and it names the current owner so the caller can explain
itself.

## No hand-written serials

`resolveAdbTarget(roomId)` answers where a Room's Android automation should
point: the leased phone when one is attached, otherwise the Room's own
emulator. Attaching a device changes what a Room's screenshots and automation
drive, with nothing in the caller changing and no serial ever written by hand.
Once attached, an offline/unauthorized phone or unavailable Host ADB fails that
physical run; DevHotel never silently reports emulator results as physical proof.

## Secure wireless pairing with explicit desktop consent

Pairing is Host-owned and is **not** an agent operation. Core polls the
Host's `_adb-tls-pairing._tcp` mDNS services, but it keeps every resolved
address, port and service name in process memory. A trusted desktop flow sees
only a random UUID candidate, a discovery generation, a generic label and a
short expiry. A refresh invalidates the prior generation only when no trusted
pairing prompt is active; while a prompt is visible, refresh returns the fixed
`capture-busy` result and preserves its generation and guards. Expiry clears
the private values, and a valid candidate is consumed before the asynchronous
ADB attempt, so concurrent retries cannot reuse it.

The pairing code is accepted only after a trusted code-capture session begins.
It is validated as six digits and written to the stdin of `adb pair <internally
discovered endpoint>`; it is never an argv value. Raw pairing stdout/stderr is
discarded because ADB echoes transport details. The durable event is only the
fixed fact that secure pairing succeeded or failed.

The Lobby's **Pair Android device** dialog is the only pairing entry point. A
user must select a currently advertised opaque candidate and check a fresh
confirmation box before the broker creates a prompt-scoped UUID. The expiry
countdown and single-use rule remain visible beside both the consent and code
steps. The six-digit code lives only in an uncontrolled password input: the
renderer reads it for one IPC invocation, clears the DOM immediately, and does
not put it in React state, settings, history, or a diagnostic message. The IPC
adapter copies an explicit allowlist of result fields and replaces every error
with a fixed, secret-free code and message.

Closing the dialog, clicking its backdrop, expiry, hiding the main window, or
losing the renderer consumes the prompt, clears the broker's capture/redaction
scope, and makes the opaque capability unusable. If `adb pair` is already in
flight, the renderer input still clears immediately while the broker keeps its
guard until that command settles (with the core TTL as the crash fallback), so
dismissal cannot create an unguarded in-flight interval. A completed attempt is
also single-use; retrying always starts with a newly discovered candidate and
a new explicit confirmation. Success and failure evidence contains only the
fixed outcome, fixed code, timestamp, and optional candidate count.

While the trusted prompt is active, Android pixel capture fails closed: a
pairing dialog or code cannot be made safe by text redaction. Text and
structured values share one redactor at the log, device-event, diagnostic and
Control API serialization boundaries. Pairing-context code/port/token fields
and the exact active in-memory service values are masked before persistence or
MCP output. A pairing attempt consumes its candidate immediately, but the
capture guard remains held until the trusted prompt explicitly clears and
dismisses its code field; expiry is the crash fallback.

There is intentionally no Control API route or MCP tool for this flow. Agents
cannot discover candidates, submit an endpoint or code, or invoke pairing
through raw ADB; `adb pair` remains a broker-only forbidden verb. The desktop
IPC handlers accept calls only from DevHotel's trusted main frame and never
widen the Room/Host boundary.

## Observability

`GET /v1/status` and the `android_devices` MCP tool answer "why can I not use
the test phone" directly: every connected device with nickname, health,
connection type, current owner (project, Room, purpose, lease age, last
heartbeat), queue depth with the waiting projects, and a recent event history
including grants, releases and stale recoveries.

Devices are addressed publicly by a **nickname** and a persisted random opaque
device ID that contains no serial-derived material. Status, queue and attach
responses do not return the raw hardware serial or the private heartbeat/cancel
capability IDs of other Rooms; serial-returning commands are refused and any
matching serial text in otherwise allowed ADB output or screenshot errors is
redacted. Only the Host broker retains the serial to execute an authorized ADB
command. Host ADB output is byte-capped and a process that crosses the cap is
terminated with an explicit error rather than buffered into the desktop process.

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
  rejects links/non-regular/escaped/empty/oversized staging objects (512 MiB
  per APK, 1 GiB per install), rechecks the exact lease, maps any echoed temp
  path back to its Room path, installs, and removes the temp afterwards.
  `android-run` targets the Room emulator by default and automatically follows
  an exclusive physical-device attachment for the final proof.
