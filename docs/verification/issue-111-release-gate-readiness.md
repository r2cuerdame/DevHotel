# Release-gate readiness — GitHub #111

**Status: the gate was not run. It cannot be run today, and the reason is not only the missing VM.**

This document records what was measured on 2026-09-17 against `main@a84a97e`, so
the next attempt starts from facts instead of re-deriving them. It is a
readiness assessment, not gate evidence, and nothing in it should be read as a
passing row in `issue-106-clean-windows-acceptance.md` or
`issue-107-managed-web-rooms.md` — every row in both of those is still blank.

## The short version

#111's eleven claims split into two groups, and they need different work:

- **Seven are blocked only by the environment.** The code exists and is
  host-side tested; it has simply never been exercised against a real Hyper-V
  guest, because no machine here can host one.
- **Four were blocked by missing implementation.** No environment produces
  evidence for a code path that does not exist, so building the clean VM first
  would have spent hours to arrive at four rows that still could not pass.

**Two of those four were closed in this session** (`b0a6bf3`): low disk and
offline/retry now have behaviour and unit evidence, so they are environment-
blocked like the rest rather than unbuildable. That leaves **B1 (Android)** as
the one row no environment can produce, and **B4 (enterprise policy)** partial.

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

## Group B — blocked by missing implementation

### B1. Android build / install / launch / preview without Host adb, Android Studio or Docker

**Not implemented.** The Android execution path is still entirely
`budtmo/docker-android`:

- `packages/core/src/backend/naming.ts:119` returns
  `budtmo/docker-android:emulator_${version}` as the emulator image.
- `packages/core/src/backend/ociCli.ts` still carries the docker-android
  workarounds — the KVM `chown` through `sudo` (`:4998`), the
  cannot-be-restarted emulator (`:1992`), the wallpaper-aware fit daemon
  (`:947`).
- `androidEmulatorLaunch()` and `androidSdkPin` (#128, #129) have **zero call
  sites** outside their own modules and `packages/core/src/index.ts`. They are
  a pinned-artifact table and a launch *plan*; nothing invokes them. Their
  tests (`backend.androidEmulatorLaunch.test.ts`, 7 tests;
  `backend.androidSdkPin.test.ts`, 6 tests) assert the shape of the plan, not
  an emulator that started.
- `managedRoomBackend.ts` contains no Android, emulator or KVM handling at all.

So a clean Windows 11 VM with Docker absent cannot run an Android Room by any
path. This is #108's remaining work, and #108 is open.

### B2. Low disk — **closed in `b0a6bf3`**

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

### B3. Offline / retry — **closed in `b0a6bf3`**

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

Steps 1–5 land on seven of eleven claims. The other four (B1–B4) stay red.

## Recommended order

1. ~~Finish B2 and B3 first.~~ **Done** — `b0a6bf3`.
2. **Close B4's enterprise case**, or narrow #111's wording to the
   nested-virtualization refusal that is actually implemented.
3. **Then take the reboot**, on a host with no active agent work, and run #106
   + #107 in the clean VM. That settles Group A and claim 7, and gives B2/B3
   their live rows.
4. **B1 (Android) is #108's remaining implementation**, not a gate run. It
   needs `androidEmulatorLaunch()` wired to the managed backend and `naming.ts`
   stopped from naming a Docker Hub image. Until then no environment can
   produce that row, and #111 cannot close.

Nothing above was mocked, and nothing above is a gate pass.

## What this session changed

| Commit | What |
|---|---|
| `ea1627e`, `57fc3f4` | this document |
| `b0a6bf3` | B2 + B3: free-space precondition, resumable download with bounded transport retry |

Suites after the change: core 1679 passed / 12 skipped, shared 52, mcp 56,
desktop 203 / 4 skipped. Workspace typecheck clean. Lint 0 errors, 4
pre-existing warnings.
