# Safe Android locale matrix contract

Issue #20 uses Android's app-scoped `LocaleManager` service instead of changing
the device locale. The safe path is available on Android API 33 and newer and
never runs `adb root`, restarts adbd/the framework, changes system properties, or
clears application data.

The composite operation is exposed as
`POST /v1/rooms/:id/android/locale-matrix` and the
`android_locale_screenshot_matrix` MCP tool. There is deliberately no public
persistent locale setter: every matrix restores and re-proves the original app
locale before returning. MCP returns durable artifact receipts only; callers
use `read_room_artifact` when they need pixels.

## Platform command boundary

The tracked session uses only typed argv with an explicit numeric user:

```text
shell cmd locale get-app-locales <applicationId> --user <userId>
shell cmd locale set-app-locales <applicationId> --user <userId> --locales <tag>
```

Omitting `--locales` restores the empty app override, which makes the app follow
the device locale. Application IDs, user IDs, locale tags, response sizes, and
both output streams are bounded before use. Locale tags are canonical BCP 47
tags; a matrix contains one to sixteen unique tags.

Android's shell implementation can catch an unknown-package or service error,
print it to stdout, and still return exit code zero. DevHotel therefore accepts
a set command only when both streams are exactly empty and then independently
reads back this exact package-and-user response:

```text
Locales for <applicationId> for user <userId> are [<canonical-tags>]
```

Any warning, extra line, wrong package/user, truncation, malformed tag, or
ambiguous response fails closed.

The command/output contract is defined by AOSP's Android 13+
[`LocaleManagerShellCommand`](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android13-release/services/core/java/com/android/server/locales/LocaleManagerShellCommand.java).

## Readiness and restoration

A transition is ready only after two consecutive observations agree on all of:

- ADB state is exactly `device`;
- LocaleManager returns the requested canonical locale list for the exact user;
- the tracked package owns that user's foreground activity; and
- the exact package process set is non-empty and stable.

The integration owns a bounded 1–120 second deadline. Failure diagnostics expose
only readiness booleans and attempt counts, never a foreign foreground package,
serial, lease capability, or raw command output.

Before the first mutation, the workflow double-reads the original locale around
its target/install/user proof, then durably records that locale together with
the exact managed-emulator target, package incarnation and user fence. The
durable record has a random operation capability and advances by compare-and-
swap before each set. One stage owns only its expected prior locale and the one
locale it is about to attempt; a later unattempted matrix locale is never
treated as DevHotel-owned. Every set checks the expected prior locale
immediately before mutation, and a fresh post-witness snapshot re-proves locale,
install, target, user, PID and lease identity before the stage can advance.
Success and failure paths restore that exact list and run the same readiness
proof.

If the DevHotel process stops mid-matrix, startup attempts managed-emulator
restoration only under the retained exact stage and fence. Before doing so it
removes every managed one-shot job, then performs a second inventory pass that
must prove the job role absent. Emulator helpers are created inert, inspected,
and topology-reproved before an immutable helper ID can be started; a helper
still visible after a crash is force-removed before the absence proof. A legacy
physical pending record is never auto-consumed: its exact lease remains
protected and the Room stays attention-gated for explicit recovery.
Until a fresh post-witness locale/install/PID proof succeeds and the exact
intent is released by compare-and-delete, the Room remains attention-gated
against further mutations. Shutdown and clean removal refuse to discard this
recovery authority. A changed target, install, user, lease, or outside locale is
never overwritten during recovery.

## Matrix publication gate

Every matrix stays inside one Room lock and one exact target session:

1. verify the tracked installed app/build and exact Android user;
2. apply one locale and pass bounded readiness;
3. capture with the active-user/foreground screen witness;
4. revalidate locale, foreground app, process, install incarnation, and target;
5. atomically publish the PNG artifact with live device/API, app-scoped locale,
   exact app and installed-build metadata;
6. restore and revalidate the original locale list before returning.

Artifacts use portable names such as `release-42-ko-kr.png`. A target/lease,
user, foreground app, installed build, or locale change during capture prevents
publication rather than downgrading the evidence.

Required explicit failures include unsupported API/service, unknown live API,
rejected mutation, bounded-readiness timeout, and unproven restoration. The
matrix uses the managed Room emulator only: callers may omit `target` or pass
`{"kind":"emulator"}`. Auto-selection and physical targets are rejected before
the session and durable intent are created. A valid tag does not prove the APK
ships translated resources for that locale; the captured UI remains the
authoritative result.
