# Host input isolation

> A test running inside a Room must not move the Host cursor, change Host
> keyboard state, or take the Host foreground window.

A Room is supposed to be a place an Agent can act freely without the Host
paying for it. The real mouse, the real keyboard and the foreground window are
Host resources like any other: if running a Room's tests takes over the
desktop, the isolation promise is broken no matter how well the filesystem and
the network are separated.

This document is the contract, the audit behind it, and the platform limits it
cannot remove. The contract is also expressed in code, in
`packages/shared/src/hostInput.ts`, and enforced by
`apps/desktop/src/main/hostInputBoundary.test.ts`.

## The rule

1. **Prefer control paths that need no UI input at all** — an API, an
   accessibility interface, `adb`, or a browser automation protocol.
2. **If UI input is required, inject it inside the Room**: the Room's own
   `adb`, the Room's browser, or the Room's virtual display. Every one of these
   ends up as a command executed *in* the Room, not as a synthetic event on the
   Host desktop.
3. **Direct Host input is a capability, never a default.** Every path that can
   take the Host cursor, keyboard or foreground window is named in
   `HOST_INPUT_CAPABILITIES`, is reachable only by an explicit user action, and
   writes a line to the Room log when it is used.
4. **Existing workflows keep working.** Nothing here asks a user to hand over
   their desktop to run a test.

## Audit — every input and focus path, and where it lands

| Path | Where the input actually happens | Host input? |
| --- | --- | --- |
| `run_in_room` / `exec` / Room terminal | `docker exec` inside the Room's container | No |
| Android phone strip (Back / Home / Recents / Rotate) | in-Room `adb -s emulator-5554 shell input keyevent …` (`apps/desktop/src/main/androidInput.ts`) | No |
| `android_run`, `android_screenshot` | in-Room `adb`, or an `x11grab` of the emulator's own X display inside the container | No |
| Android emulator display | Xvfb + openbox **inside** the emulator container; the window manager only ever moves the guest's own windows | No |
| Room web preview | an Electron `WebContentsView` on a Room-scoped session with every permission denied | No |
| Windows (VMware) Room lifecycle | `vmrun start … nogui` — the VM runs headless, with no console window | No |
| Windows (VMware) Room commands and terminals | rejected outright (`Windows Room commands require the forthcoming guest agent`) — there is no Host fallback | No |
| **Open in VMware Workstation console** | a real Host window that grabs the Host cursor and keyboard when focused | **Yes — modeled capability** |
| DevHotel window raise (tray click, second launch) | `win.show()` / `win.focus()` on DevHotel's own window | Foreground only, user-initiated |

### Why the Room web preview cannot take the Host cursor

Pointer Lock, Keyboard Lock and fullscreen are the three ways a web page takes
the real cursor, the real keyboard and the foreground window — and all three
arrive through the same permission surface as harmless-sounding requests. The
Room preview session therefore denies the surface as a whole rather than
maintaining an allow-list with holes (`apps/desktop/src/main/roomSessionPolicy.ts`).
`HOST_INPUT_PERMISSIONS` enumerates the ones whose denial is load-bearing, and
each is regression-tested by name.

## The one remaining Host-input capability

`host-input:vmware-console` — **Open a Windows Room in the VMware Workstation
console**.

A Windows Room normally runs headless. Opening its console is a real Host
window; while it has focus, the guest holds the Host cursor and keyboard, and
opening it takes the foreground. That is the point of the feature, so it is
modeled rather than hidden:

- **User-only.** `RoomOrchestrator.openWindows` rejects any actor other than
  `user`. There is no control-API route and no MCP tool for it, so an Agent
  cannot reach it at all.
- **Observable.** Every use appends the capability's audit line to the Room's
  orchestrator log, visible in the Room's Logs tab and in the diagnostic
  bundle.
- **Reversible by the user.** Closing or unfocusing the VMware window returns
  the cursor and keyboard; VMware's own ungrab shortcut (`Ctrl+Alt`) does it
  without closing anything.

## Regression coverage

| Test | What it proves |
| --- | --- |
| `hostInputBoundary.test.ts` → "ships no API that can move the Host cursor…" | No shipped source file references `robotjs`, nut.js, `SendInput`, `keybd_event`, `SetCursorPos`, `SetForegroundWindow`, `SendKeys`, `xdotool`, `pyautogui`, AutoHotkey, `setAlwaysOnTop`, `setKiosk`, `setFullScreen`, or any other Host input/foreground API — outside two explicitly listed, user-initiated window-raise sites |
| …→ "keeps the Host foreground exemption list exact" | A stale exemption cannot silently pre-approve the next Host-focus call added to that file |
| …→ "depends on no Host input-synthesis package" | No workspace manifest pulls in a mouse/keyboard synthesis package |
| …→ "denies every permission that would hand Room content the Host cursor…" | The Room preview session denies Pointer Lock, Keyboard Lock, fullscreen, display capture, window management, idle detection, HID, serial and USB — and everything else |
| …→ "drives the Android phone strip through in-Room adb" | Room UI input is an in-Room `adb` argv against the Room's own emulator serial, with no Host screen coordinates |
| `windows.lifecycle.test.ts` → "treats the VMware console as a user-only, journaled Host-input capability" | An Agent is refused; a user's use is written to the Room log |
| `controlApi.security.test.ts` → "exposes no Host-input operation to Agents" | The Agent-facing REST surface has no console/input/focus route |
| `hostInputProbe.test.ts` | The drift detector retains mouse, focus and keyboard activity after every endpoint is restored; treats button/wheel activity with no cursor move as drift; and exposes only activity/injection booleans and pressed-key counts, never mouse-message or key identities. On every ordinary Windows test run it also compiles, starts and stops the native helper. |

### Live check on a real desktop

The tests above prove DevHotel has no API that *can* move the Host cursor. To
prove it *did not*, on the machine the suite actually ran on, run the suite
under the live probe. One hidden, read-only Windows helper stays alive from
global setup through teardown. Its low-level mouse hook latches every delivered
mouse event, including button and wheel events that do not move the cursor. A
low-level keyboard hook observes key transitions, a Windows event hook observes
foreground-window changes, and a 10 ms state poll independently checks cursor,
foreground and physical key state. A change is latched, so clicking without
moving, moving away and back, pressing and releasing a key, or taking and
returning focus still fails even when the final snapshot equals the initial
one. No mouse-message or key identity leaves the helper: the wire report keeps
only generic mouse/keyboard activity, whether any such activity was injected,
the first changed cursor/focus value, and endpoint pressed-key counts. The
helper compares an in-memory key-state bitmap only while it is alive so the
independent poll can detect equal-count key substitutions; it never reports or
logs that bitmap.

The helper treats observation health as part of the assertion. Windows can
silently remove a low-level hook whose owner does not service it within
`LowLevelHooksTimeout`; the helper wakes every 10 ms and fails closed if its
message-pump gap reaches that configured timeout (capped at Windows' 1000 ms
maximum, with a conservative 300 ms fallback). That clock starts before the
first low-level hook is installed, so the complete arming interval must pass
the same health check before `READY`; queued events older than the ready
boundary are ignored. At `STOP` it captures the final snapshot and a monotonic
cutoff, keeps the owner thread pumping for a bounded 250 ms drain, accepts
delayed foreground/input callbacks only when their event timestamp is at or
before the cutoff, and then removes every hook on that same owner thread:

```powershell
$env:DEVHOTEL_HOST_INPUT_PROBE='1'; pnpm --filter devhotel test
```

The whole-suite policy assertion is opt-in because it measures the physical
machine: a human who uses the mouse or keyboard while it runs produces an event
the run cannot tell apart from a regression. Run it on an idle desktop. The
ordinary Windows unit suite still compiles, starts and stops the helper so its
native code and protocol cannot rot behind the option. The helper announces
readiness only after every hook is installed. The run fails rather than
claiming isolation if the interactive desktop is unavailable, a hook cannot be
installed, its message pump becomes untrustworthy, the helper exits early, or
teardown does not receive its final report.

## Platform limitations

- **The VMware console cannot be made Room-local.** VMware Workstation's
  console is a Host application window; there is no in-Room rendering of it.
  The capability model is the answer, not a technical fix.
- **The live probe is Windows-only**, matching the supported Host OS. Its
  low-level hooks observe all mouse activity and physical-key transitions, and
  `EVENT_SYSTEM_FOREGROUND` observes foreground changes; `GetCursorPos`,
  `GetForegroundWindow` and `GetAsyncKeyState` provide read-only baseline,
  final and periodic health samples.
- **The live probe observes the current interactive desktop and session.** A
  secure-desktop switch, locked desktop, inaccessible window station, or hook
  failure makes the result inconclusive and therefore fails the run. It does
  not attribute events to DevHotel, which is why the machine must be idle.
- **Keyboard state means physical key up/down state.** The observer latches a
  generic low-level key transition and independently polls the high bit from
  `GetAsyncKeyState`; it reports only the number of keys down at each endpoint,
  never which keys. Per-thread layout, IME, or lock-key toggle state is not a
  Host key press and is outside this probe.
- **The stop drain is intentionally bounded.** It gives already-issued,
  pre-cutoff asynchronous foreground notifications 250 ms to reach the owner
  thread while excluding post-cutoff input. An OS notification delayed longer
  than that after the cutoff cannot be proven by the hook; endpoint snapshots
  remain the backstop for state that was not restored.
- **DevHotel cannot police what a Room's own test code does to a Host it can
  reach.** Isolation here is structural: container Rooms have no Host display
  or input device, and Windows Rooms have no exec path at all. A user who
  grants a Room something more is outside this contract.
- **Full-screen guest software inside the Android emulator** affects only the
  emulator's X display inside the container, never the Host screen.

## If you add a new input path

1. Make it Room-local. Something that ends as a command executed in the Room
   satisfies the contract by construction.
2. If it genuinely cannot be — add it to `HOST_INPUT_CAPABILITIES` with what
   the Host surrenders, `requiresActor: 'user'`, and an audit line; gate the
   call site on the actor; and journal it with `olog`.
3. If you need one of the banned APIs at a user-initiated site, add an entry to
   `EXEMPTIONS` in `hostInputBoundary.test.ts` explaining why a Room, a Job, an
   Agent and a test can never reach it.
