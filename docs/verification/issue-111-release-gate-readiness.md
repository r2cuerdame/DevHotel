# Release-gate readiness — GitHub #111

**Status: the gate was not run. It cannot be run today, and the reason is not only the missing VM.**

This document records what was measured on 2026-09-17 against `main@a84a97e`, so
the next attempt starts from facts instead of re-deriving them. It is a
readiness assessment, not gate evidence, and nothing in it should be read as a
passing row in `issue-106-clean-windows-acceptance.md` or
`issue-107-managed-web-rooms.md` — every row in both of those is still blank.

**Revised against `main@06fbb46`**, which lands #135. That PR changed B1's
facts, so the B1 section below has been corrected rather than left to age; the
rest of the measurements are unchanged and still carry their original date.

**Revised again on 2026-09-17 against `main@1181428`**, which lands #136. Two
things changed that the earlier revisions could not have known, and both are
recorded in *What the second attempt found* at the end of this document: the
managed Android image is published but **not publicly pullable**, and the
Windows feature gate was **never actually reading the feature state**. The
second is a defect no clean VM would have fixed, and it would have failed the
fresh-install and reboot rows on the first try.

## The short version

#111's eleven claims split into two groups, and they need different work:

- **Seven are blocked only by the environment.** The code exists and is
  host-side tested; it has simply never been exercised against a real Hyper-V
  guest, because no machine here can host one.
- **Four were blocked by missing implementation.** No environment produces
  evidence for a code path that does not exist, so building the clean VM first
  would have spent hours to arrive at four rows that still could not pass.

**Two of those four were closed in this session** (`bf6ce55`): low disk and
offline/retry now have behaviour and unit evidence, so they are environment-
blocked like the rest rather than unbuildable.

**B1 (Android) was partially closed on `main` by #135**, which wired the managed
emulator path. It is no longer the empty code path this document first recorded
— but it still pulls a `budtmo/docker-android` base image, still covers only one
of the four Android versions the product offers, and has never been booted. So
it is not an environment-blocked row either: it is a third state, *implemented
but not yet independent of docker-android*. **B4 (enterprise policy)** stays
partial.

## Group A — blocked only by the environment

| # | #111 claim | Where the implementation is |
|---|---|---|
| 1 | Fresh install | `managedRuntimeManager.ts`, `managedHyperVRuntime.ts` |
| 2 | Upgrade | `managedRuntimeUpdate.ts` — `ManagedRuntimeUpdateLedger`, `fromVersion`/`toVersion` |
| 3 | Rollback | same ledger; "what the install had verified before the update, for an exact rollback" (`managedRuntimeUpdate.ts:33`) |
| 4 | Reboot | `managedRuntimeWindowsFeature.ts` boot-identity resume; `managedRuntimeManager.ts:347` |
| 5 | Runtime crash / recovery | `managedRuntimeManager.ts` `repair()` paths (`:399`, `:406`, `:576`, `:590`) |
| 6 | Complete uninstall | `managedRuntimeManager.ts:284` removes everything this install provisioned; `:102` app-only is the honest half |
| 7 | North Star Web without external Docker/Node/DB | `managedRoomBackend.ts`, `roomRuntimeSelection.ts`, `managedRuntimeGuestAgent.ts` |

Claim 7 is the one with the largest gap between "implemented" and "proven".
#107's own closing comment is explicit that the guest half has never been
booted, and the host-side tests exercise an in-process implementation of the
frame protocol rather than a guest.

The host-side baseline was re-run here rather than taken on trust:

```
@devhotel/core      92 files passed,  5 skipped   1666 passed, 12 skipped
@devhotel/shared     5 files passed                  52 passed
devhotel-mcp         3 files passed                  56 passed
devhotel (desktop)  35 files passed                 203 passed,  4 skipped
                                                   ----------------------
                                                   1977 passed, 16 skipped
```

Green — and that is exactly the point. A green suite is what #108's comment
warned against closing a gate from. The suite's own probe test prints the
host's real capability, and it agrees with everything below:

```
MANAGED_RUNTIME_PROBE {"support":{"supported":true,"code":"virtualization-ready",
  "hypervisorPresent":true,"virtualizationFirmwareEnabled":true,"slat":false,
  "hyperVPowerShellAvailable":false,"hyperVManagementAccessible":false}}
```

Room-data persistence and one-Room-cannot-affect-another isolation also sit in
this group: the per-Room network, subnet allocation and owned-volume-generation
rules were deliberately reused rather than reimplemented (#107, `350675d`), so
they are as implemented as the compatibility backend — and equally unproven on
a managed guest.

## Group B — blocked by implementation, not only by the environment

### B1. Android build / install / launch / preview without Host adb, Android Studio or Docker

**Corrected on 2026-09-17 against `main@06fbb46`.** An earlier revision of this
document recorded that `androidEmulatorLaunch()` and `androidSdkPin` had **zero
call sites**, that `managedRoomBackend.ts` had no emulator handling at all, and
that therefore no Android Room could run by any path. **#135 made all three of
those statements false**, and they are corrected here rather than left to age.

What #135 wired:

- `ManagedRoomBackend.createEmulator()` (`managedRoomBackend.ts:208`) routes a
  pinned Android version through `androidAvdPlan()`, `androidEmulatorLaunch()`
  and `buildManagedEmulatorContainerArgs()`, replacing the container's
  entrypoint so the emulator binary is exec'd directly and docker-android's
  `supervisord` never runs.
- `androidAvdVolume()` (`naming.ts:135`) names the per-Room persistent AVD
  volume, and `startExistingEmulatorForRecovery()` is overridden to document
  that the docker-android `passwd` repair does not apply on the managed path.
- `backend.managedRoomBackend.androidEmulator.test.ts` — 18 tests over the
  generated `docker create` argv and entrypoint script.

**This does not make the row claimable, and #135 does not claim it either.** Its
own description records that end-to-end acceptance is tracked in #111 and that
the image dependency is deliberate for now. What still blocks the row:

- **The base image is still `budtmo/docker-android`.** `createEmulator()`
  resolves `imageRef` via `emulatorImage(version)` and pulls it, because the
  managed path reuses docker-android's X11 / VNC / openbox stack;
  `naming.ts:119` still returns `budtmo/docker-android:emulator_${version}`. A
  DevHotel-owned managed emulator base image is the **active #108 follow-up**,
  and until it lands, a managed Android Room still depends on an unpinned
  third-party Docker Hub image — which is the opposite of what this claim
  asserts.
- **Only Android 14.0 is pinned.** `ANDROID_SYSTEM_IMAGES` holds API 34 alone,
  so `pinnedAndroidVersions()` returns a single version. The other three the
  Stack tab offers — 13.0, 12.0, 11.0 — fall through to `super.createEmulator`,
  i.e. the unmodified docker-android compatibility path.
- **The compatibility path's workarounds are untouched.** `ociCli.ts` still
  carries the KVM `chown` through `sudo` (`:4998`), the emulator that cannot be
  restarted (`:1992`) and the wallpaper-aware fit daemon (`:926`, `:960`).
- **Nothing has been booted.** The 18 new tests assert argv and script text. No
  emulator has started under the managed runtime on any machine, and the managed
  guest itself has never booted under Hyper-V at all (Group A, claim 7).

So B1 moved from *no code path exists* to *a code path exists, has never run,
and is not yet free of docker-android*. **#108's live acceptance and #111's
Android row are both still unsatisfied.** #108 was auto-closed by `Fixes: #108`
in #135; the base-image removal is the follow-up that has to land before any
clean Windows VM can produce this row.

### B2. Low disk — **closed in `bf6ce55`**

It was not implemented: no free-space probe, no `ENOSPC` handling and no
disk-budget refusal existed anywhere in `packages` or `apps`. Provisioning
staged a ~150 MB artifact and created disks beside it with no precondition on
available space, so the first symptom of a full volume was a truncated file
that the digest check then reported as a corrupt download.

`managedRuntimeDiskSpace.ts` now asserts the size before the first byte is
written and names what is free against what is needed. A platform that will not
report free space is recorded as `availableBytes: null` and allowed to proceed,
because refusing to provision on a filesystem Node cannot measure would break
installs that would have worked.

### B3. Offline / retry — **closed in `bf6ce55`**

`downloadManagedRuntimeArtifact()` issued a single `fetch`: no retry, no
resumed `Range` request, no backoff, no offline classification. A connection
dropping at 90% failed the whole provision.

It now resumes from the bytes it already holds, restarts rather than
concatenating when an origin ignores `Range`, and retries only transport
failures — an integrity failure is not retried, because a retry cannot make a
bad pin true.

The guest-side package cache #107 describes remains a different claim: it makes
the *second* guest boot offline-capable, which is row 4 of the #107 matrix, and
it does nothing for the Host's artifact fetch.

Both still need their gate row run against a real full volume and a real
dropped network in the clean VM. Unit evidence is what makes that row possible;
it is not that row.

### B4. Enterprise virtualization-policy failure

**Partial.** Nested-virtualization refusal is handled honestly —
`managedHyperVRuntime.ts:493` wraps `Set-VMProcessor
-ExposeVirtualizationExtensions` in a `try` and records `nestedVirtualization`
as `true | false | null` rather than assuming. `managedRuntimeWindowsFeature.ts`
distinguishes `enabled` / `pending` / `disabled` / `absent` and refuses Home
editions.

What is absent is the enterprise case the gate names: a policy-managed host
where `Enable-WindowsOptionalFeature` is denied by policy rather than by
elevation, or where Hyper-V is present but administratively blocked. Those
surface today as a generic `failed` stage carrying a DISM error string.

## Why this host cannot supply the environment

Measured, not assumed:

```
Edition                : Microsoft Windows 11 Pro (26200)
CPU                    : AMD Ryzen 7 9800X3D          -> nested virt capable
Elevated               : False
HypervisorPresent      : True                          (VBS / WSL2)
hvax64.exe             : present
vmms.exe               : ABSENT                        <- VM Management Service
Hyper-V PS module dir  : ABSENT
New-VM / Get-VM        : not recognised
Free space on C:       : 462 GB
```

`Microsoft-Hyper-V-All` is **not installed**. Enabling it needs elevation *and*
a Host restart, and `scripts/acceptance/issue-106/New-CleanWindowsAcceptanceVm.ps1`
refuses to run without it by design.

The host is also disqualified as the gate target regardless of Hyper-V, because
the gate's premise is a machine with none of this on it:

```
docker      29.2.1   C:\Program Files\Docker\Docker\resources\bin\docker.exe
wsl         Ubuntu-24.04 (Running, v2), docker-desktop (Running, v2)
node        v24.13.1        pnpm 10.33.0        npm 11.8.0
java        openjdk 17.0.20
Android SDK C:\Users\recue\AppData\Local\Android  (present)
```

No managed runtime has ever been provisioned here: `%APPDATA%\DevHotel\runtime`
holds only `docker-engine.json`, `legacy-volume-adoptions.json`,
`network-recovery-attestations/` and a stale August `vmware/` directory. There
is no `managed-linux` root and no `windows-feature.json`.

## The reboot question, answered with the host's actual state

Enabling Hyper-V here would require restarting a machine that is mid-flight:

- 8 `DevHotel` processes running, the oldest since 2026-09-16 18:59.
- 27 `node` / `claude` / `orca` processes — a live multi-agent session.
- `csx-451-test-pg` **Up 10 hours** — another agent's running Postgres.
- 246 Docker volumes, including Room workspace and service state.

The dispatch authorised the milestone reboot *only when it will not corrupt
active work*. That precondition is not met, so the reboot was not taken.

It would also not be sufficient. The full path from here to a gate result is:

1. elevation + `Enable-WindowsOptionalFeature Microsoft-Hyper-V-All` + Host restart;
2. fetch the ~6 GB Windows 11 Enterprise Evaluation ISO and pin its SHA-256 (no
   Windows install media exists on this machine);
3. build the nested Gen 2 VM and run the unattended install;
4. install DevHotel in the guest and boot the Alpine runtime under Hyper-V —
   which has never been done, on any machine;
5. run #106 rows 1–15, then #107's 17-row matrix.

Those steps land on seven of eleven claims, and give B2 and B3 the live rows
their unit evidence cannot supply. B1 and B4 stay red regardless of the
environment — B1 until the #108 base-image follow-up lands, B4 until the
policy-denied case is handled.

## Recommended order

1. ~~Finish B2 and B3 first.~~ **Done** — `bf6ce55`.
2. ~~Wire `androidEmulatorLaunch()` to the managed backend.~~ **Done on `main`**
   — #135.
3. **Close B4's enterprise case**, or narrow #111's wording to the
   nested-virtualization refusal that is actually implemented.
4. **Then take the reboot**, on a host with no active agent work, and run #106
   + #107 in the clean VM. That settles Group A and claim 7, and gives B2/B3
   their live rows.
5. **B1 (Android) still needs the #108 follow-up before it needs a gate run.**
   `naming.ts` must stop naming a Docker Hub image — that means a DevHotel-owned
   managed emulator base image carrying the X11/VNC stack, and system-image pins
   for the remaining offered versions. Until that lands the managed path pulls
   docker-android, no clean Windows VM can produce this row, and #108 acceptance
   and #111 both stay open.

Nothing above was mocked, and nothing above is a gate pass.

## What this session changed

| Commit | What |
|---|---|
| `024d372`, `a3efb1c`, `b6577b3` | this document |
| `bf6ce55` | B2 + B3: free-space precondition, resumable download with bounded transport retry |
| *(this commit)* | rebased onto `main@06fbb46`; B1 corrected for #135 |

Commit hashes are post-rebase onto `main@06fbb46`. The pre-rebase equivalents
were `ea1627e`, `57fc3f4`, `92c32c5` and `b0a6bf3`.

Re-run after the rebase onto `main@06fbb46`, on this host, today:

```
@devhotel/core      94 files passed,  5 skipped   1697 passed, 12 skipped
@devhotel/shared     5 files passed                  52 passed
devhotel-mcp         3 files passed                  56 passed
devhotel (desktop)  35 files passed                 203 passed,  4 skipped
                                                   ----------------------
                                                   2008 passed, 16 skipped
```

Core is 1697 rather than the 1679 this branch measured before the rebase: the
extra 18 are #135's `backend.managedRoomBackend.androidEmulator.test.ts`, which
is the evidence that the wiring described in B1 is present on this branch.

`pnpm -r typecheck` clean across all four packages. `pnpm lint` 0 errors, 4
warnings — all pre-existing unused-import warnings in
`backend.network-lifecycle.test.ts`, none introduced here.

None of this is gate evidence. It is a host-side suite, which is exactly what
B1 says must not be mistaken for an Android row.

---

# What the second attempt found — 2026-09-17, `main@1181428`

The gate was dispatched a second time. It still did not run, and the
environment is still the reason it could not — but the environment was no
longer the *only* reason, and the two new blockers below are both ones that
building the VM first would have discovered the expensive way.

## The environment, re-measured rather than assumed

Nothing moved:

```
Edition               : Microsoft Windows 11 Pro (26200)
Elevated              : False
Microsoft-Hyper-V-All : InstallState 2 (Disabled) — vmms.exe absent, New-VM not recognised
Free space on C:      : 460.7 GB
Windows 11 ISO        : none on this machine
```

Two things were checked that the first attempt had not been explicit about:

- **`recue` *is* in `Administrators`.** So the block is not "this account
  cannot elevate". It is that `EnableLUA=1` with `PromptOnSecureDesktop=1`
  puts the consent prompt on the secure desktop, which an automated session
  cannot answer. Enabling Hyper-V needs a human to click it.
- **The host is still mid-flight**: 7 `DevHotel`, 14 `node`, 11
  `claude`/`orca` processes, and another agent's containers. The dispatch
  authorised the milestone reboot *only when it will not corrupt active work*.
  That precondition is still not met, so the reboot was again not taken.

## New blocker 1 — the managed Android image is published but not pullable

#136 removed `budtmo/docker-android` from the managed execution path and pinned
a DevHotel-owned image instead:

```
MANAGED_EMULATOR_PREVIEW_IMAGE =
  ghcr.io/r2cuerdame/devhotel-android-emulator-preview@sha256:6ca7fe38…
```

`ManagedRoomBackend.createEmulator()` pulls that digest before it creates
anything. Measured against GHCR today:

| Check | Result |
|---|---|
| Manifest by digest, **authenticated** | `HTTP 200` — the image exists |
| Manifest by digest, **anonymous** | `HTTP 403`; the anonymous token request returns no token |
| Package visibility | `visibility: private`, `repository: null` |
| Publish workflow on `main` (run `35154759623`) | **failure** — `denied: permission_denied: read_package` |
| Package version created | `2026-09-16T21:25:46Z` — *before* both workflow runs |

Read together these say one thing: the image was pushed **by hand**, not by CI.
The package was therefore created outside the repository, is not linked to it,
and the repo's `GITHUB_TOKEN` consequently has no access — which is exactly the
`read_package` denial the `main` run failed with. The
`org.opencontainers.image.source` label is already in the Dockerfile; it links
packages *created by* a workflow, and cannot retroactively adopt one that was
not.

**Why this fails the gate.** #111's Android claim is that a clean Windows 11 VM
builds, installs, launches and previews Android with no Host prerequisites. That
VM has no GitHub credentials. A pull of a private GHCR digest from it fails
before an emulator is ever created — so the row fails at its first step, for a
reason that has nothing to do with Hyper-V, Android or the code #136 wrote. The
managed path is no longer *dependent* on docker-android; it is currently
dependent on something worse, a registry only this account can read.

**This was not fixed here.** Making the package public is an outward-facing
publish on the user's GitHub account, and the fix also needs the package granted
to the repository so CI can republish it. Both were escalated rather than taken
unilaterally.

## New blocker 2 — the Windows feature gate was never reading the feature state

This one was found by running the harness's own PowerShell against this real
Host instead of against its test double, and it is the more serious of the two.

`inspect()` asked `Get-WindowsOptionalFeature -Online`. That is a DISM *online*
operation and **requires elevation**. DevHotel runs unelevated, so on this
machine the call fails with a COMException meaning "the requested operation
requires elevation", and `-ErrorAction SilentlyContinue` turned that refusal
into `Absent`. Measured, before the fix:

```
LIVE_INSPECT  features: { "Microsoft-Hyper-V-All": "absent" }
              ^ Windows itself reports InstallState 2 = Disabled
```

Two gate rows follow from that, and both would have failed on the first try in
the clean VM:

- **Reboot (claim 4) fails.** With a record saying `awaiting-restart` from an
  earlier boot, `observe()` on this real Host returned **`elevation-required`** —
  it asked for the approval again for work already done. The module's own
  contract says a user who defers the reboot is never asked to elevate twice for
  the same work. It was.
- **Fresh install (claim 1) fails.** An enabled feature also reads as `absent`,
  so `observe()` could never reach `completed` from the app at all. The gate
  would have sat at `elevation-required` on a machine where Hyper-V was already
  on.

No host-side test caught this, because the test double answers the DISM query
successfully — it models a Windows that always replies. That is the specific way
a green suite can be green about nothing, which is the warning this document
opened with.

**Fixed in `3aa08bf`.** `Win32_OptionalFeature` answers the same question
without elevation and is now the fallback; DISM is kept because it is the only
source that reports `EnablePending`. Verified unelevated against real Windows:

```
Microsoft-Hyper-V-All              Disabled     (was reported "absent")
Microsoft-Windows-Subsystem-Linux  Enabled
VirtualMachinePlatform             Enabled
Containers                         Disabled
```

Because the unelevated read cannot express `EnablePending`, it reports a feature
as enabled while the restart is still outstanding. The recorded boot identity
proves the restart instead, so that check now runs *before* the
features-are-enabled branch — otherwise the provider would be started against a
hypervisor that is not running yet, which is the failure the original code
commented on and then made possible by another route.

## B4 (enterprise virtualization-policy failure) — closed in `3aa08bf`

The gap this document recorded was that a policy-denied enablement surfaced as a
generic `failed` stage carrying a DISM string — with a retry button beside it
that could not change the outcome.

- The elevated child now returns the **HRESULT**, which is what separates an
  administrator forbidding the change from a download that failed; the message
  alone is localized and cannot carry that distinction.
- `0x800F0906`, `0x800F0954`, `0x800F081F` and `0x80070005`, plus the wording
  Windows uses for a policy refusal, classify it as a new **`blocked-by-policy`**
  stage.
- `inspect()` reads the servicing policy surface unelevated — `UseWUServer`,
  `RepairContentServerSource`, `LocalSourcePath` — so the refusal can say *why*.
  An unreadable policy surface is recorded as **no finding**, not as a managed
  Host: the same choice B2 made when a filesystem will not report free space.
- The manager reports a policy-blocked Host as `unsupported`, and Settings stops
  offering an approval that leads back to the same refusal.
- The raw Windows text stays in `failure`, which the renderer boundary already
  drops; the sentence the user reads is DevHotel's own.

It is worth being exact about what this is: **the enterprise policy row still
has to be run on a policy-managed Host.** What changed is that there is now a
behaviour to run it against, and a wrong answer would now be wrong in a way the
gate can see.

## Suites, re-measured on this branch

```
@devhotel/core      95 files passed,  5 skipped   1730 passed, 12 skipped
@devhotel/shared     5 files passed                  52 passed
devhotel-mcp         3 files passed                  56 passed
devhotel (desktop)  35 files passed                 203 passed,  4 skipped
                                                   ----------------------
                                                   2041 passed, 16 skipped
```

`pnpm -r typecheck` clean across all four packages. `pnpm lint` 0 errors, 4
warnings — the same pre-existing unused-import warnings in
`backend.network-lifecycle.test.ts`.

## Where #111 actually stands

| Group | Claims | State |
|---|---|---|
| A | fresh install, upgrade, rollback, reboot, crash/recovery, uninstall, North Star Web | Environment-blocked. Two of them (fresh install, reboot) were **also** code-blocked until `3aa08bf`. |
| B1 | Android without Host adb / Android Studio / Docker | **Blocked on a private registry**, and still only Android 14.0 is pinned; 13.0/12.0/11.0 fall through to docker-android. |
| B2 | Low disk | Behaviour landed (`bf6ce55`); needs its live row. |
| B3 | Offline / retry | Behaviour landed (`bf6ce55`); needs its live row. |
| B4 | Enterprise virtualization policy | Behaviour landed (`3aa08bf`); needs a policy-managed Host. |

The order has not changed, but one step has been added ahead of the reboot:

1. **Make the GHCR package publicly pullable and grant it to the repository**,
   then confirm the `main` workflow publishes. Until that is true, the Android
   row cannot pass from any machine that is not signed in to this account — and
   a machine that is signed in is not the clean VM the gate is about.
2. Pin the remaining three Android system images, or narrow the claim to the
   version that is pinned.
3. **Then take the reboot**, on a host with no active agent work, and run #106
   rows 1–15 and #107 17-row matrix in the clean VM.

Nothing above is a gate pass. Two of the reasons it is not are now smaller than
they were this morning, and one of them — the feature read — was a defect the
VM would have found for us at much greater cost.

---

# What the third attempt found — 2026-09-17, `main@cffc4d0`

The gate was dispatched a third time. It still did not run. What changed is that
the **registry blocker is gone from the code**, and the one environment
alternative this machine appeared to offer was measured and ruled out rather
than left as an open possibility.

## Blocker 1 is closed in code — the runtime builds the preview image

The second attempt escalated the private GHCR package as something only a human
could fix, because making a package public is an outward-facing, irreversible
publish. The coordinator's direction was to remove the dependency instead, and
that is what landed.

`ManagedRoomBackend.createEmulator()` no longer runs `docker pull` against
`ghcr.io/r2cuerdame/devhotel-android-emulator-preview@sha256:6ca7fe…`. It calls
`ensureEmulatorPreviewImage()`, which builds the image inside the managed
runtime from `images/android-emulator-preview/Dockerfile`.

| Property | How it is held |
|---|---|
| Runtime has no repository tree | The Dockerfile is embedded in `managedEmulatorPreviewImage.ts`; a test asserts it is byte-identical to the committed file, so the copy cannot drift from what a reviewer reads |
| One tag per Dockerfile, every platform | The digest is taken over the embedded LF string, not the file on disk — a `core.autocrlf` checkout would otherwise build a differently-tagged identical image |
| Cache across Rooms, rename across edits | The tag **is** the Dockerfile's SHA-256, so the second Room builds nothing and an edited Dockerfile is a different image rather than a stale one |
| A tag is not evidence | The build stamps the digest into a label; a cache hit is adopted only when the label agrees, and anything else on the tag is rebuilt over rather than trusted |
| A build that lies is caught early | The label is re-read after the build, so a build that exits 0 without leaving a usable image fails where the cause is visible, not at `docker create` |
| The boundary is crossed explicitly | The Dockerfile is staged into the guest with `putFile` — a Host path handed to the guest engine would have resolved inside the guest and found nothing — and discarded in a `finally` |
| No Host Docker | Everything above goes through `this.managedEngine`, the guest engine |
| Still not docker-android | Asserted directly; #136's contract is unchanged |

What crosses the network is the Ubuntu base layer, pinned by digest and served
anonymously by Docker Hub, and Ubuntu's own apt pool — the same bytes the GHCR
image was itself built from. **A clean Windows 11 VM now needs no GitHub
credential to reach a working emulator preview.**

`String.raw` in the embedding is load-bearing and has its own test. The
Dockerfile's line continuations are trailing backslashes; in a cooked template
literal a backslash-newline is a line continuation that *deletes* the newline,
which would collapse the `apt-get` block into one line that still looks correct
in the diff and is wrong in the container.

The publish workflow was repurposed rather than deleted. It no longer logs in,
no longer asks for `packages: write`, and no longer pushes — which also ends the
`permission_denied: read_package` failure that had been red on `main`. It builds
the Dockerfile and asserts that every tool the managed entrypoint calls by name
is present. That guard matters **more** now, not less: the build has moved onto
every user's machine, so a package leaving the Jammy apt pool would break every
fresh install rather than one release. It is also scheduled weekly, because the
apt pool moves without this repository changing.

**This is not the Android gate row.** It removes the reason that row could not
be attempted. The row still needs a clean Windows 11 VM, and the emulator still
has to actually boot — which has not happened on any machine.

## The VMware path — measured, and closed

Both earlier attempts recorded that this Host cannot supply the environment
because Hyper-V is absent. Neither noticed that **VMware Workstation 26.0.0 is
installed here**, with three existing Windows 11 guests under
`C:\Users\recue\Documents\Virtual Machines`. That looked like an environment
this gate could use without touching Hyper-V at all, so it was tested rather
than assumed.

A throwaway VM was created in the scratchpad with `vhv.enable = "TRUE"` — the
setting that exposes nested virtualization to the guest — and powered on
headless. VMware's own log:

```
IOPL_Init: Hyper-V detected by CPUID
Monitor Mode: ULM
[msg.cpuid.noVHVQuestion] Virtualized AMD-V/RVI is not supported on this platform.
```

The probe VM was destroyed afterwards; the three existing VMs were not touched.

Read in order, those three lines are the whole answer. The root Hyper-V
hypervisor is running — `VirtualMachinePlatform` is enabled, which is what WSL2
and Docker Desktop need — so VMware runs in **ULM** (user-level monitor) mode,
and ULM cannot expose AMD-V to a guest. A Windows 11 guest under VMware on this
Host therefore **cannot run Hyper-V**, and so cannot host DevHotel's managed
Linux runtime. The gate cannot be run from there.

The irony is worth recording because it closes the alternative properly rather
than by preference: making VMware able to host this gate would mean disabling
`VirtualMachinePlatform`, which is exactly what Docker Desktop and WSL2 run
on — the compatibility backend the other agents' Rooms are using right now. Both
paths, Hyper-V and VMware, converge on the same precondition: elevation, a
reboot, and a Host with no active work on it.

## The environment, re-measured a third time

```
Edition                : Microsoft Windows 11 Pro (26200)
Elevated               : False
Microsoft-Hyper-V-All  : InstallState 2 (Disabled) — vmms.exe absent, New-VM not recognised
VirtualMachinePlatform : InstallState 1 (Enabled)  — why VMware is stuck in ULM
HypervisorPlatform     : InstallState 2 (Disabled)
Free space on C:       : 457.6 GB
Windows 11 ISO         : none on this machine
Last boot              : 2026-09-16 18:57 — unchanged since the second attempt
```

The Host is still mid-flight, so the milestone reboot's precondition — that it
will not corrupt active work — is still not met:

```
8  DevHotel processes (oldest 2026-09-16 18:59)
14 node, 4 claude, 12 orca processes  — a live multi-agent session
csx-451-test-pg                     Up 13 hours   — another agent's Postgres
dh-njfstb4z-{anchor,svc-emulator}   Up 14 hours   — a live Room with a running emulator
dh-29c5e8ys-{anchor,svc-emulator}   Up 14 hours   — a second one
```

Rebooting would destroy two other agents' running Rooms and a third agent's
database. That is not a decision this dispatch can take on their behalf.

## Suites, re-measured on this branch

```
@devhotel/core      96 files passed,  5 skipped   1751 passed, 12 skipped
@devhotel/shared     5 files passed                  52 passed
devhotel-mcp         3 files passed                  56 passed
devhotel (desktop)  35 files passed                 203 passed,  4 skipped
                                                   ----------------------
                                                   2062 passed, 16 skipped
```

Core is 1751 rather than 1730: 21 of the new tests are
`backend.managedEmulatorPreviewImage.test.ts`. `pnpm -r typecheck` clean across
all four packages. `pnpm lint` 0 errors, 4 warnings — the same pre-existing
unused-import warnings in `backend.network-lifecycle.test.ts`.

One honest note on how that number was obtained: the first full-parallelism run
of the core suite reported four failures, three of which
(`artifacts.export`, `deviceBroker.room`, `roomStart.operations`) were
accompanied by vitest `Timeout calling "onTaskUpdate"` worker-RPC errors and
passed in isolation and at `--maxWorkers=4`. They are load flakes on a Host
running two emulators and a live agent fleet, not regressions. The fourth was
real and was this change's own: `backend.managedRoomBackend.androidEmulator`
still asserted the image ref contained `ghcr.io/...` and was digest-pinned. It
now asserts the opposite — that the ref names no registry at all.

## Where #111 stands after three attempts

| Group | Claims | State |
|---|---|---|
| A | fresh install, upgrade, rollback, reboot, crash/recovery, uninstall, North Star Web | Environment-blocked. Nothing else remains. |
| B1 | Android without Host adb / Android Studio / Docker | **No longer registry-blocked.** Still only Android 14.0 is pinned; 13.0/12.0/11.0 fall through to docker-android. Never booted. |
| B2 | Low disk | Behaviour landed (`bf6ce55`); needs its live row. |
| B3 | Offline / retry | Behaviour landed (`bf6ce55`); needs its live row. |
| B4 | Enterprise virtualization policy | Behaviour landed (`cffc4d0`); needs a policy-managed Host. |

The remaining order, with one item struck out and one added:

1. ~~Make the GHCR package publicly pullable and grant it to the repository.~~
   **Obsolete** — the runtime builds the image, so there is no package to grant.
2. Pin the remaining three Android system images, or narrow the claim to the
   version that is pinned. This is now the only code-side item left on B1.
3. **Then take the reboot**, on a Host with no active agent work, and run #106
   rows 1–15 and #107's 17-row matrix in the clean VM. That needs a human at the
   UAC prompt: `recue` is in `Administrators`, but `PromptOnSecureDesktop=1` puts
   the consent dialog on the secure desktop, which an automated session cannot
   answer.
4. Fetch the Windows 11 Enterprise Evaluation ISO (~6 GB); none exists here.

**Nothing above is a gate pass, and #111 is not acceptable on this evidence.**
Every row of `issue-106-clean-windows-acceptance.md` and
`issue-107-managed-web-rooms.md` is still blank.

---

## The fourth attempt — B1's last code item closed, and the media obtained

Measured against `main@d38ac04`, which lands #138 (the locally built emulator
preview image) and #139 (Android warm wake). This attempt deliberately did not
re-litigate the environment: the previous three established that the Host cannot
supply it, and re-measuring confirmed nothing had changed. It spent its time on
the two things that were still code and could be finished without a VM.

### 1. All four offered Android versions are pinned

The third attempt left exactly one code-side item on B1: *"Pin the remaining
three Android system images, or narrow the claim to the version that is
pinned."* The narrower option was not taken. `ANDROID_SYSTEM_IMAGES` now carries
API 34, 33, 32 and 30, so `pinnedAndroidVersions()` returns all four versions the
Stack tab offers and no Room reaches `super.createEmulator` — the branch that
pulls `budtmo/docker-android` through the guest engine.

The three new pins, each the highest `google_apis;x86_64` revision published in
`sys-img/google_apis/sys-img2-1.xml` when the pin was taken:

| Android | API | Revision | Bytes | Upstream SHA-1 |
|---|---|---|---|---|
| 13.0 | 33 | `r17` | 1,707,857,511 | `2b96f5bd…5d9711` |
| 12.0 | 32 | `r08` | 1,538,792,859 | `1b527946…eb8f1d` |
| 11.0 | 30 | `r16` | 1,438,186,618 | `6ae21030…3e787d` |

How they were produced matters more than the numbers, because Google publishes
`<checksum type="sha1">` and nothing stronger:

1. every `sizeBytes` and `upstreamSha1` above was read from Google's own
   manifest **first**, and the manifest's API 34 row was checked against the
   already-committed API 34 pin as a control — it matched byte-for-byte, which is
   what makes the other three rows trustworthy rather than merely plausible;
2. each artifact was then streamed and hashed, and DevHotel's SHA-256 and
   SHA-512 recorded in `androidSdkPin.ts` where a reviewer reads them;
3. `DEVHOTEL_PIN_ANDROID_SDK=1 pnpm --filter @devhotel/core pin:android-sdk`
   was then run as an **independent re-download** of all seven artifacts
   (~6.8 GB) and re-verified every checked-in digest. A second fetch is what
   distinguishes a recorded digest from a transient corruption recorded as one.

`pin:android-sdk` previously asserted only that Android 14.0's artifacts were
genuinely pinned. Checking one version is how the other three stayed unpinned
without anything going red, so it now iterates `pinnedAndroidVersions()` and
asserts that set equals `ANDROID_API_LEVELS` — the two tables can no longer
disagree silently.

`UnpinnedAndroidSystemImageError` was **kept**, not deleted with its last live
caller. It is what catches a fifth version added to `ANDROID_API_LEVELS` without
a pin, and `__tests__/androidPinTestSupport.ts` registers a synthetic version so
the branch keeps its coverage.

**This is still not the B1 gate row.** It removes the last reason the row could
not be attempted for three of the four versions. The emulator has not been
booted on any machine, on any version.

### 2. The Windows 11 Enterprise Evaluation ISO — obtained, and scripted

The third attempt listed *"Fetch the Windows 11 Enterprise Evaluation ISO
(~6 GB); none exists here"* as a remaining step. It is done, and there turned out
to be an official unauthenticated path, which the earlier attempts had assumed
there was not.

`scripts/acceptance/issue-106/Get-Windows11EvaluationIso.ps1` resolves the
Evaluation Center's own fwlink id (`2334167`, the en-US 64-bit Enterprise
evaluation ISO) hop by hop:

```
https://go.microsoft.com/fwlink/?linkid=2334167&clcid=0x409&culture=en-us&country=us
  -> https://aka.ms/Win11E-ISO-25H2-en-us
  -> https://software-static.download.prss.microsoft.com/dbazure/.../26200.6584.250915-1905.25h2_ge_release_svc_refresh_CLIENTENTERPRISEEVAL_OEMRET_x64FRE_en-us.iso
```

No account, no registration form, no cookie and no paid resource: the last hop
serves 7,092,807,680 bytes anonymously. Free, no licence key, 90-day evaluation —
the media the acceptance procedure already named, now fetched by a script rather
than by hand.

Four things are asserted rather than assumed, because this is the media the whole
gate's evidence rests on:

- **the redirect chain is walked manually** and every hop recorded, so the ISO's
  origin is evidence rather than "a redirect resolved to this". This needs
  `HttpClient` rather than `Invoke-WebRequest`: PowerShell 7 treats
  `-MaximumRedirection 0` as *redirect limit exceeded* and throws, so a 3xx and
  its `Location` header are unreachable through that cmdlet —
  `-SkipHttpErrorCheck` only suppresses 4xx/5xx;
- **the final origin must be a Microsoft download host**, or the fetch stops
  rather than caching a mirror;
- **the filename must contain `ENTERPRISEEVAL`**, so the script cannot be pointed
  at media that is not free to use for acceptance testing;
- **the digest is measured and recorded**, because Microsoft publishes none for
  this file. A `.provenance.json` sidecar carries the SHA-256, the SHA-512, the
  byte length, the fwlink id and the redirect chain; `-ExpectedSha256` re-verifies
  a cached copy and fails rather than silently re-fetching.

The download lands under `%LOCALAPPDATA%\DevHotel\acceptance-media` —
deliberately outside the repository, at 6.6 GB.

### 3. The environment, re-measured a fourth time

Unchanged, and still disqualifying:

```
Elevated               : False
Microsoft-Hyper-V-All  : InstallState 2 (Disabled) — vmms.exe absent
VirtualMachinePlatform : InstallState 1 (Enabled)  — why VMware stays in ULM
HypervisorPlatform     : InstallState 2 (Disabled)
Last boot              : 2026-09-16 18:57 — unchanged across all four attempts
Free space on C:       : 454 GB
```

The Host is still mid-flight, so the milestone reboot's precondition — that it
will not corrupt active work — is still not met:

```
9  DevHotel processes
18 node, 5 claude, 12 orca processes   — a live multi-agent session
csx-451-test-pg                    Up 15 hours   — another agent's Postgres
dh-njfstb4z-{anchor,svc-emulator}  Up 15 hours   — a live Room with a running emulator
dh-29c5e8ys-{anchor,svc-emulator}  Up 15 hours   — a second one
searxng                            Up 15 hours
```

### Where #111 stands after four attempts

| Group | Claims | State |
|---|---|---|
| A | fresh install, upgrade, rollback, reboot, crash/recovery, uninstall, North Star Web | Environment-blocked. Nothing else remains. |
| B1 | Android without Host adb / Android Studio / Docker | **Code-complete.** All four offered versions pinned and verified; no docker-android on any managed path. Never booted. |
| B2 | Low disk | Behaviour landed (`bf6ce55`); needs its live row. |
| B3 | Offline / retry | Behaviour landed (`bf6ce55`); needs its live row. |
| B4 | Enterprise virtualization policy | Behaviour landed (`cffc4d0`); needs a policy-managed Host. |

**There is no code-side item left on #111.** What remains is two things, neither
of which this dispatch can take:

1. ~~Pin the remaining three Android system images.~~ **Done.**
2. ~~Fetch the Windows 11 Enterprise Evaluation ISO.~~ **Done, and scripted.**
3. **Elevation + `Enable-WindowsOptionalFeature Microsoft-Hyper-V-All` + a Host
   restart.** This needs a human at the UAC prompt — `recue` is in
   `Administrators`, but `PromptOnSecureDesktop=1` puts the consent dialog on the
   secure desktop, which an automated session cannot answer — **and** a Host with
   no other agent's work on it. Right now a reboot would destroy two other
   agents' running Rooms and a third agent's database.
4. Then build the VM from the cached ISO and run #106 rows 1–15 and #107's
   17-row matrix in the guest.

**Nothing above is a gate pass, and #111 is not acceptable on this evidence.**
Every row of `issue-106-clean-windows-acceptance.md` and
`issue-107-managed-web-rooms.md` is still blank. The blocker is now exactly one
thing — an elevated, quiescent Host — where it used to be four.
