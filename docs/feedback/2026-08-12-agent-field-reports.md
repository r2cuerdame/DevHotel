# Agent field reports — 2026-08-12

Five agents used DevHotel Android/Web rooms for real work (app testing, WebView
audits, parallel code analysis, billing/preview verification). Their verbatim
pain points, deduplicated and triaged. Items marked **[shipped]** were fixed the
same day; the rest are the working backlog, roughly in leverage order.

## Fixed immediately **[shipped]**

- No unified "is DevHotel ready / what is connected" signal → `hotel_status` MCP tool + `GET /v1/status` (backend health, gateway, all rooms with provider/status/domain).
- Capture required host `adb` hunting, file pulls, even GitHub round-trips → `android_screenshot` returns the phone screen as an MCP image directly (in-room `adb exec-out screencap`, no noVNC margins, no host SDK).
- Install→run→verify was N manual steps → `android_run` MCP tool: build, install **all** built module APKs, launch a chosen `applicationId`, return the result plus a screenshot in one call.
- `android-run` only handled the first APK (multi-module apps needed manual adb) → installs every built module, `applicationId` selects the launch target.
- No official file in/out → `room_pull_file` / `room_push_file` MCP tools (base64 over the room exec channel, workspace paths only).
- "Samsung Galaxy S10" reads as One UI verification → device selector and hints now state it is an AOSP emulator matching screen/profile only.

## Backlog (leverage order)

1. **Exclusive room lease / one-writer enforcement** (goal.md §4.12 exists as design; agents saw concurrent jobs share a device). Includes: file-level "who is editing/building" visibility, per-workspace Gradle build queue to stop cache corruption from parallel builds, cancellation that reliably kills child process trees (Gradle daemons outlive timeouts).
2. **Clean snapshot / baseline reset.** One-click reset of package state, permissions, IME, rotation, accessibility between test runs (AVD snapshot or data-wipe fast path). Related: Host↔Room sync needs a "accept current Room state as new baseline" reset instead of refusing on fingerprint drift; read-only commands should not flip rooms to `modified`.
3. **Live output for long commands.** `run_in_room` buffers until exit; agents cannot tell hung from busy, and the control API connection can drop mid-Gradle. Needs streamed/chunked exec output and resumable job handles (ties into goal.md §5.10 durable Jobs).
4. **Failure diagnostics bundle.** On test/app failure, auto-capture screen + current Activity + IME state + logcat tail into one retained artifact.
5. **Immutable artifact receipts.** Auto-seal run outputs (commit SHA, APK hashes, device fingerprint, logs, screenshots, run ID) — agents currently assemble hundreds of evidence files by hand. Android Clean Build's provenance manifest is the seed; extend to test runs. Include: test results persisted per-run instead of overwritten.
6. **Report versioning for parallel analysis.** Every agent-visible result should carry its base commit SHA and a stale-marker when the workspace moved on.
7. **Android room clone** (clone is Web-only today) — per-agent isolated worktrees are the sanctioned answer to shared-worktree conflicts.
8. **Newer images.** API 35/36 system images and current WebView; document the WebView version per Android version. Multiple browser channels (Samsung Internet/Firefox) likely stay out of scope (emulator has no Play/Galaxy Store).
9. **noVNC ergonomics.** Auto-connect/fullscreen already on; accessibility-node exposure is out of DevHotel's control, but a stable input API (tap/swipe/type via adb, exposed over MCP) would remove coordinate-on-noVNC automation.
10. **GitHub Service onboarding.** managed-git rooms need the Hotel GitHub credential connected once in the app; agents hit this as "auth not connected". Surface the fix path in errors (`hotel_github_status` now reports it).

## Explicitly not DevHotel bugs (kept for context)

- `orca emulator list` ENOENT — Orca-side bug.
- One UI behavior, real haptics, perceived latency, Play-signed billing flows — need physical/Play devices (Hotel Device Service direction).
- IME show/hide races, UiAutomator occluded nodes, `connectedDebugAndroidTest` uninstalling the app-under-test — Android framework behavior; DevHotel can only make diagnosis faster (items 2/4).
