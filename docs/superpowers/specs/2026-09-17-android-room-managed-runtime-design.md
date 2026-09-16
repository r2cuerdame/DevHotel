# Android Rooms on the managed runtime (#108)

Status: **implemented** (execution path wired; end-to-end acceptance blocked on clean
Windows 11 VM, tracked in #111). §§ 3–4 are done and landed on the managed-wire branch.
The blockers listed in §1 are resolved — see the updated table below.

Supersedes nothing. Extends
[the managed-runtime design](2026-08-10-devhotel-managed-runtime-design.md)
(which stops at Stage B — Web Rooms) and
[the Android Room provider design](2026-08-10-android-room-provider-design.md).

## 1. Original blockers (now resolved)

#108 said "run Android Rooms directly in the managed runtime". The managed
runtime could not run *any* Room when this spec was first written.

- The guest is an Alpine `virt` ISO booted read-only from a Generation 2 SCSI
  DVD, configured by an apkovl overlay. Its entire private protocol is one
  command: `managedRuntimeGuestOverlay.ts` accepts `health:*` and nothing else.
  There is no container engine, no exec, no file transfer, no image store, no
  networking ownership and no persistent package installation in the guest.
- `docs/managed-runtime-hyperv.md` states it plainly: the runtime "is not yet
  the selected Room executor", and lists the Hyper-V guest boot itself among
  the **still unproven — release blockers**.
- The Room executor is still `OciCliBackend`, which shells out to `docker`.
  `backend/cli.ts` resolves `docker.exe`; nothing else implements `Backend`.

| Issue | What it must deliver first | State |
|---|---|---|
| #106 | managed runtime healthy on a real Hyper-V VM | ✅ landed (#107 unblocked) |
| #107 | Room create/start/stop/exec/logs/file-transfer/ingress on it | ✅ merged |
| #109 | managed-runtime networking, storage, caches, Room lifecycle | ✅ merged |
| #110 | runtime update / hot-swap path | ✅ merged |
| **#108** | **Android emulator on top — this branch** | ✅ **wired** |

### The KVM dependency is not guaranteed

The emulator needs `/dev/kvm` in the guest, which needs Hyper-V nested
virtualization, which `docs/managed-runtime-hyperv.md` records as **requested
but optional** — "Hyper-V refuses it on hosts that cannot nest", and the answer
is written into the provider marker precisely because nothing else distinguishes
a refusal from a host nobody asked. A managed Android Room therefore has a
first-class "this Host will not nest" outcome that docker-android never had, and
§6 specifies it rather than leaving it to fail at boot.

### This host cannot test it

Recorded from `probe-managed-runtime` during the core suite on 2026-09-17:

```json
{"supported":true,"code":"virtualization-ready","hypervisorPresent":true,
 "virtualizationFirmwareEnabled":true,"slat":false,
 "hyperVPowerShellAvailable":false,"hyperVManagementAccessible":false}
```

`Get-VM` is not a recognized cmdlet here and `%APPDATA%\DevHotel` has no managed
runtime directory: the managed runtime has never run on this machine. #108's
acceptance ("works with Docker Desktop absent") is therefore not merely
unimplemented, it is currently **unobservable** — see §8.

## 2. What docker-android is actually providing

Removing an image means owning everything it did. `budtmo/docker-android:emulator_14.0`
supplies, and DevHotel currently depends on:

| Concern | Today | Referenced from |
|---|---|---|
| SDK, emulator binary, system image | baked into the image | `emulatorImage()` |
| AVD creation, with a config.ini append | image entrypoint reads `EMULATOR_CONFIG_PATH` | `EMULATOR_AVD_OVERRIDE_PATH` |
| Guest budget and boot args | `EMULATOR_ADDITIONAL_ARGS` | `emulatorBudget()`, `buildEmulatorArgs()` |
| Panel geometry / orientation | `SCREEN_*` + the AVD override | `emulatorScreen()`, `emulatorAvdOverride()` |
| X server, openbox, x11vnc, websockify on 6080 | image supervisord stack | `EMULATOR_SCREEN_PORT` |
| Frameless fullscreen phone window | DevHotel's own openbox rc + `fit-emulator.py`, copied in | `ociCli.ts` |
| adb server, auth disabled | `-skip-adb-auth` | `EMULATOR_ADB_SERIAL` |
| uid 1300 (`androidusr`) | image user | fenced helper `--user` |
| Screen capture for artifacts | X11 grab inside the container | `captureEmulatorScreen()` |

Everything in the "DevHotel's own" rows already belongs to us and ports across
unchanged. The rest becomes §3 and §4.

## 3. Pinned provisioning

The managed runtime's existing artifact discipline
(`managedRuntimeArtifact.ts`: exact host, no off-host redirect, bounded bytes,
SHA-256 **and** SHA-512, atomic publish, re-verify before reuse) is the contract
these artifacts must meet too.

Pin four artifacts, each by an immutable build-numbered URL from
`https://dl.google.com/android/repository/`:

1. `commandlinetools-linux-<build>_latest.zip` — `sdkmanager`, `avdmanager`
2. `platform-tools_r<rev>-linux.zip` — `adb`
3. `emulator-linux_x64-<build>.zip` — the emulator binary
4. `x86_64-<api>_r<rev>-linux.zip` — `system-images;android-<api>;google_apis;x86_64`

`repository2-3.xml` and the `sys-img` manifests are the index that names them.

**Implemented**: `packages/core/src/backend/androidSdkPin.ts` carries the pinned
set, its verifier, and the known-version/unpinned-image distinction.
`pnpm --filter @devhotel/core pin:android-sdk` is the maintainer task that
captures the digests.

### Google publishes SHA-1 only

Verified against the live manifest on 2026-09-17: every entry carries
`<checksum type="sha1">`, and the string `sha256` does not appear in
`repository2-3.xml` at all. SHA-1 is not a verification this project accepts as
its only integrity proof.

The pin is therefore two-step, mirroring how the Alpine ISO is handled:

- at **pin time** (a maintainer task, reviewable in the diff), fetch each
  artifact, confirm the upstream SHA-1, and record DevHotel's own SHA-256,
  SHA-512 and exact byte length in the release manifest;
- at **provision time**, verify only DevHotel's recorded digests. The upstream
  SHA-1 is never the runtime gate.

A manifest whose digests were not captured this way must fail the release, not
downgrade to SHA-1.

### Licensing

DevHotel currently redistributes none of this — the third-party images do. Once
DevHotel fetches these itself, the Android SDK licence acceptance becomes
DevHotel's to obtain and record, and the release-level SBOM/NOTICE gate from the
managed-runtime design applies to all four artifacts. Provisioning also needs
network on first use; a fully offline first Android Room is out of scope and
must say so rather than hang.

### Only one Android version is pinned

The Stack tab offers Android 14.0, 13.0, 12.0 and 11.0, and docker-android has
a system image for each. DevHotel pins **API 34 (Android 14.0)** only — the
Room default. `ANDROID_API_LEVELS` maps all four, so a managed Android Room on
13.0 fails with `UnpinnedAndroidSystemImageError` (a DevHotel migration gap the
Room can be told about) rather than `UnknownAndroidVersionError`. That
distinction is why docker-android stays the default until the two tables agree:
removing it earlier would silently drop three offered versions.

### Where they live

Under the runtime state disk (never the disposable seed, never the read-only
ISO), content-addressed by digest and shared across Rooms, with the per-Room
AVD kept separate — that separation is what makes §5 possible.

## 4. Launching the emulator directly

Replace the image's env-var interface with an argv this repo owns and tests, as
`buildEmulatorArgs` already does for `docker create`:

```
emulator -avd <room-avd> -no-window -gpu swiftshader_indirect \
  -cores <budget.cores> -memory <budget.memoryMB> -noaudio \
  -no-boot-anim -skip-adb-auth -no-snapshot-save ...
```

**Implemented**: `packages/core/src/backend/androidEmulatorLaunch.ts` produces
the argv, the environment, and the `avdmanager create avd` plan with its
`config.ini` content. Every option was verified against the pinned emulator
build's own option table rather than recalled — including that `-accel` takes
`on|off|auto` and that `-ports` is `<consoleport>,<adbport>`.

Three absences are deliberate and tested:

- **no `-no-window`** — the emulator must map a real window into Xvfb or the
  Room preview is permanently black;
- **no snapshot flags** — the default quickboot save/load is what lets a warm
  Room keep its AVD state, which is the half of #78 this unblocks;
- **no `-gpu host` / `--gpus`** — #104 measured llvmpipe selection and
  `VK_ERROR_INCOMPATIBLE_DRIVER`; software rendering is the supported setup.

`-accel on` rather than `auto` is what turns a Host that refused nested
virtualization into a loud failure instead of a Room that looks alive and never
finishes booting (§6).

`emulatorBudget()` (landed for #104) already produces `cores`/`memoryMB` from
the Room's own limits and is backend-neutral — it moves across unchanged, and is
the reason this spec does not re-derive a budget.

`emulatorAvdOverride()` likewise already emits the `hw.lcd.*` /
`hw.initialOrientation` lines. Against a directly-owned AVD these stop being an
append the image performs at creation and become lines DevHotel writes into
`config.ini` itself, which removes `EMULATOR_AVD_OVERRIDE_PATH` and the
`/home/androidusr` assumption with it.

The preview stack (Xvfb, openbox with DevHotel's existing frameless rc and
`fit-emulator.py`, x11vnc, websockify on `EMULATOR_SCREEN_PORT` 6080) becomes
DevHotel-owned processes inside the Room. The relay contract does not change:
the screen is still the Room's "site" on 6080 through the anchor.

### Contracts that must not move

These are the acceptance surface and must be byte-identical across the
migration, not merely "equivalent":

- `EMULATOR_ADB_SERIAL` stays `emulator-5554`, reached by console-port
  auto-detection. Never `adb connect localhost:5555` — that registers one device
  under two serials and runs Gradle instrumentation twice.
- Private ADB fencing: the fenced helper still joins the **exact proved**
  emulator network namespace, still proves image content identity and immutable
  container ID before and after every command, still refuses selectors, and
  still bounds output. `-skip-adb-auth` remains justified only by there being no
  Host port and no Room-network path to that transport.
- The locale matrix contract (`docs/android-locale-matrix.md`): app-scoped
  `cmd locale set-app-locales --user <n>`, never `adb root`, never a device
  locale change, always restored and re-proved.
- Acceptance reports, their sealing, and artifact receipts.

## 5. Warm state and reuse (#78)

docker-android forced recreation: the AVD lived in the container, so
`removeEmulator` + `createEmulator` on every wake was the only correct move.
Owning the AVD directory removes that constraint, which is precisely what #78
asks for.

- The AVD, its userdata and snapshot live in Room-owned storage, outside the
  emulator process's lifetime.
- Warm wake reuses the proved runtime instead of recreating it, and a disposable
  Android Room reaches ADB-ready inside 60s.
- The tracked install receipt is **re-proved** against package, user and
  incarnation after boot rather than trusted — a restored snapshot is exactly
  the case where a blindly-trusted receipt is wrong.
- Non-reusable state takes an explicit recreation path, and any recovery fence
  still blocks unsafe recreation.

**#78 has its own unmet dependency**: it states that #61 must first define safe
dead-workload recovery, and #61 is open. The AVD persistence above is the part
#108 enables; the reuse *decision* is #78's and gated on #61.

## 6. When the Host will not nest

If the provider marker records nested virtualization as refused, an Android Room
must not attempt the emulator and must not present this as a crash:

- the Room still opens and still builds APKs — the existing "emulator
  unavailable, room continues build-only" path is already the right behaviour
  and already tested;
- checks report the missing screen with the Host reason, not a KVM error;
- Settings → Managed Linux runtime already surfaces the granted/refused/unknown
  answer, so the user can see the cause in the one place they can read it.

Physical-device automation through the device broker is unaffected by any of
this and remains the path that works on a non-nesting Host.

## 7. Migration order

1. #107/#109 land Room execution on the managed runtime.
2. Provisioning (§3) lands with its manifest and digests, unit-proven, behind a
   flag, with external Docker still the default.
3. Direct launch (§4) lands, with the fenced-ADB and locale contracts ported and
   their existing tests run unchanged against the new backend.
4. Warm state (§5) lands once #61 defines the recovery fence.
5. Only then is docker-android removed, and `emulatorImage()` with it.

Reordering step 5 earlier removes the only working Android path in exchange for
an unproven one.

## 8. Acceptance

#108 closes on evidence, not on a green unit suite:

- a clean Windows 11 machine with **no Docker Desktop installed** — not merely
  stopped — creates an Android Room, builds, installs, launches and previews;
- the noVNC screen renders and phone controls work;
- fenced ADB, the locale matrix and the acceptance-report contracts pass
  unchanged;
- a warm wake reuses AVD state within the #78 budget;
- a Host that refuses nesting produces §6's outcome, not a failure.

None of this is observable on the current development host (§1). The evidence
has to come from the clean Windows 11 VM that #111 already owns, and #108 should
be closed from that run, not from this one.
