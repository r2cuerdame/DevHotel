# Golden-path verification — 2026-08-31

Target: GitHub #11 (R2C-238), exercised on Windows 11 against the locally installed DevHotel 0.4.3 control plane and Docker Desktop 29.2.1. Every Room action in this run used the loopback Control API, the same contract exposed by DevHotel MCP. No desktop, Host mouse/keyboard, Host ADB, or direct Docker command was used.

The fixtures intentionally cover both a reused Room and a newly provisioned Hotel-owned Room for Web and Android. Private device serials, pairing material, tokens, Host paths, and source contents are omitted.

## Result matrix

| Path | Fixture | Result | Durable evidence |
|---|---|---:|---|
| Web reused | ADisAD, existing Hotel Room | PASS | Exact allowlisted source upload, install, 154 tests, restart, stable-domain HTTP and application health |
| Web clean | QNote, fresh managed-git Room #220 | PASS | Managed clone, source checks, stable-domain page, sleep/wake byte identity, lossless retained output |
| Runtime liveness | Disposable Web Room | PASS | Recorded `ready` became observed `dead`/effective `broken`; command rejected with stable code and recovery hint; durable wake recovered |
| Android reused | AppDied, existing Hotel Room | PASS | Gradle tests, provenance APKs, emulator install/launch/PID/UI hierarchy/screenshot, lossless retained output |
| Android clean | AppDied, fresh Hotel Room #218 | PASS | CRLF diagnosis/normalization, healthy checks, Gradle tests, provenance build, emulator install/launch, app-scoped UI and screenshot evidence |
| Physical acceptance | AppDied debug-ID build on shared USB device | PASS | Exclusive lease/queue handoff, non-destructive final install/launch, physical screenshot, and release with app retained |

## Web — reused ADisAD Room

- Uploaded an explicit 65-file allowlist (`package.json`, lockfile, `bin/`, `src/`, `test/`) into the Room without modifying the dirty Host working tree.
- Host and Room aggregate manifests matched exactly: SHA-256 `7c5aa89256c26a925b99c7eab7489109ec5c3dc1183fff9cbfffdace4caab86f` over 1,233,161 bytes.
- `npm ci`: exit 0, 24 packages.
- `npm test`: exit 0, 154 passed, 0 failed.
- `restart-web`: verified; checks reported healthy.
- Stable domain returned the real application page (HTTP 200, 62,525 bytes), not the Empty Room fallback. `/api/health` reported `ok: true` and `ledgerNetsToZero: true`.

## Web — clean managed-git Room

- Created Room #220 directly through the Control API from the public `PurpleShipHub/QNote` repository (`sourceType: managed-git`, `workspaceMode: hotel`). It reached recorded/effective `ready`, live runtime/main `running`, and source `synced`.
- Checked the real source with `node --check` for both application scripts and non-empty HTML/CSS assertions: exit 0.
- Stable domain returned HTTP 200 and the real page title `QNote - Open Collaborative Notes`.
- Before sleep: 9,856 bytes, SHA-256 `745f393abc75900345ded56e7682b0271ca586d975932cc59316b5dee090e395`.
- Sleep inspection reported expected `sleeping`/`stopped`. Durable wake operation finished `succeeded` at stage `complete`.
- After wake: the page was the same 9,856 bytes with the same SHA-256, while runtime/main returned to `running` and effective status returned to `ready`.

## Lossless long output

The deterministic probe wrote 10,000 lines to each stream. Each stream was 370,000 bytes. The immediate response was deliberately limited to 256 bytes and correctly marked both streams truncated and retained. Each retained stream was recovered in two base64 pages (200,000 + 170,000 bytes, final `eof: true`).

Expected and recovered hashes matched on reused Web, clean Web, reused Android, and clean Android Rooms:

- stdout: `afa01321b276150f7592219cff461b39b7dfb2edfc02e67e541ddb0ec9ad42ff`
- stderr: `0d4b86d75e7f55530516b2ca66fb5d3bf65321db4ad6c1b9a0fce66ba28be52c`

This proves response bounding does not silently discard raw output and paging is byte-exact.

## Runtime liveness and recovery

The disposable Web fixture began recorded/effective `ready` with observed runtime/main `running`. Its app process was then terminated from inside the Room through the Control API.

- Two consecutive read-only inspections kept the recorded value visible as `ready` but reported runtime `dead`, main `exited`, and effective status `broken`.
- Detail: `The recorded Room is ready, but its runtime is exited.`
- Recovery hint: `Start or restart the Room, then retry.`
- A subsequent command was rejected before backend execution with HTTP 409 and `ROOM_RUNTIME_NOT_RUNNING`; no raw Docker/container error appeared.
- Repeated inspection did not start or repair the Room.
- Durable start finished `succeeded`/`complete`; runtime/main and effective status returned to `running`/`ready`.

The evidence is also recorded on and closes GitHub #12.

## Android — reused AppDied Room

- `sh ./gradlew test --no-daemon --console=plain`: exit 0; `BUILD SUCCESSFUL in 48s`, 71 actionable tasks.
- Provenance build change verified and exported:
  - `app-debug.apk`: 81,658,493 bytes, SHA-256 `ab8aafbcaf5c9a5ae66738746ba70b2ad87e2e5c81229123c6fd93be697383ec`
  - `crashsample-debug.apk`: 2,647,871 bytes, SHA-256 `c33ae1285b3cebb82bfc70ad58347cab312a8961fdfae693369a436df2ff4b7e`
  - provenance SHA-256 `14e4018b5a71c4817a47de82c88409f51376f9b19bac99ed38224aee48ace77e`
- `android-run` verified `com.purpleship.appdied running on the Room emulator` after build, emulator readiness, both APK installs, launcher resolution, and launch.
- Bounded in-Room UI proof found a live PID, a 10,271-byte UIAutomator hierarchy (SHA-256 `8c90c922f262e2125fcce77b1d92100a6ea424a75dcccf0b31ec8623f788384f`), and 29 nodes owned by the expected application package.
- Control-API screen capture returned a 540×1140 PNG, 129,278 bytes, SHA-256 `604e2c11f5cde760f692caa2b41dd2b143f6e20695b4c7c76a4fd178d888444b`.

## Android — fresh Room and Windows/Linux boundary

The fresh Hotel-owned Android Room started synchronized with a live build runtime and emulator. Its `gradlew` initially used LF and had SHA-256 `2a600b8e3fb8947dc2b9335f53a7e7ee28e11ff86e65b72b829190b602afb81c`. A CRLF copy was injected only into the Room through the file API to exercise the real Windows-to-Linux failure.

- Checks identified `Windows line endings (CRLF) in ./gradlew` and offered `normalize-line-endings`.
- `android-build` failed with an explicit line-ending attribution, named `./gradlew`, explained that this was not a Gradle/build failure, and offered both the Room-local change and `.gitattributes` recovery. No raw Docker error was used as the contract.
- Normalization published a new workspace generation and restored the exact original LF hash. Subsequent checks were fully healthy, including line endings, Gradle wrapper, build runtime, emulator port, gateway, and HTTP.
- The independent normalization verifier printed its clean sentinel immediately but the Android image's long-running ENTRYPOINT kept the one-shot container alive until the ten-minute timeout. PR #35 now overrides image ENTRYPOINT for one-shot jobs; exact-head CI and Codex review passed and the fix is merged on main.

- `sh ./gradlew test --no-daemon --console=plain`: exit 0; cold-cache `BUILD SUCCESSFUL in 5m 23s`, 71 actionable tasks.
- Provenance build change verified and exported:
  - `app-debug.apk`: 81,583,993 bytes, SHA-256 `539650fb30a23632440570cd989803d556ff0e8b0d3b92962e16530e0cf59421`
  - `crashsample-debug.apk`: 2,647,871 bytes, SHA-256 `8e91d6557fc0db1932a91e514fd294149c803e26fc5dfe9a85dfc9826eba21a5`
  - provenance SHA-256 `296b044ac1a3ab67562c8faa2c40dd4267e1583219a7cf413946b2a0a1b33893`
- `android-run` verified build, both emulator installs, launcher resolution, and `com.purpleship.appdied` launch.
- The newly booted emulator presented a real System UI ANR dialog. A bounded Room-internal recovery acknowledged `Wait`; the app process remained live and its launcher stayed top-most. This was an observed emulator state, not a false DevHotel timeout or a desktop-control action.
- The recovered UIAutomator hierarchy was 9,587 bytes, SHA-256 `c50b2afa257a6a16436d63ed9e11931d4c7f1d3d69f9256f3f6dc7b59a01eab6`, with all 27 nodes owned by the expected application package.
- Control-API screen capture returned a 540×1140 PNG, 135,729 bytes, SHA-256 `4dbec7ecf553aec87a59c6ef726045cc3f0289c8e0018f2f960f19db8b5e19a3`.

For the final physical stage, the Room-only debug build was given an `.devhotel` application-ID suffix. This avoids replacing or deleting the differently signed protected copy already on the test phone while proving the same source and UI as an independently installable final acceptance build.

- Final debug-ID provenance build verified:
  - `app-debug.apk`: 81,584,021 bytes, SHA-256 `ddcc4f39473c1d764303635390972efae2befc542311c4e01318dd15f5b3ab2a`
  - `crashsample-debug.apk`: 2,647,875 bytes, SHA-256 `b1713ea547bd01a4fdc408159e48eef69f36d7086ed7c20919aa16276ac70a81`
  - provenance SHA-256 `46266974d47b74d93ef3618a5a95c876835135cd249a96e2d77a563503fcc7ea`
- The exact debug-ID build first passed emulator install and launch. Its UI hierarchy was 9,830 bytes, SHA-256 `c68084938adac1a8e7deae0fc099a645a77a47bffdd9cbd4ea0540cc159221c3`, with all 27 nodes owned by `com.purpleship.appdied.devhotel`.
- The corresponding emulator screenshot was 540×1140, 135,714 bytes, SHA-256 `5c584938c4567b4072e7c2d533320b161ba71836f9a30e6ae5e137fad8ae6944`.

## Physical acceptance

The broker reported one ready USB target, no owner, and an empty queue before the test. The competition fixture then exercised the real queue without exposing its serial or lease capabilities:

1. The reused AppDied Room received the exclusive lease.
2. The fresh Room requested the same constraints and entered position 1 while inventory reported one owner and one waiter.
3. Releasing the reused Room atomically promoted the fresh Room; queue depth and waiter count returned to zero while ownership remained exclusive.

The first install attempt correctly failed with Android's `INSTALL_FAILED_UPDATE_INCOMPATIBLE` because the protected existing AppDied package had a different signing key. DevHotel surfaced the exact install stage and Android reason. The lease was immediately released; no uninstall, data clear, downgrade, or signature bypass was attempted.

After the debug-ID build passed the emulator, the fresh Room reacquired the lease and `android-run` verified all five physical steps: build, exclusive-lease use, both APK installs, launcher resolution, and launch. The Control API then captured the foreground physical display with `source: adb`: 1080×2340 PNG, 227,254 bytes, SHA-256 `f752732cc0ec56165cecc1b9f28b410873f2274e3d602287861ac9a75e2133e5`. The lease was released and the final debug-ID app was deliberately left installed on the phone.

## Safety invariants

- Existing protected Rooms and applications were preserved; no Room was deleted or reset.
- No Host source was rewritten, including the dirty ADisAD working tree and AppDied checkout.
- No Host ADB command or direct Docker lifecycle command was used.
- Physical-device identifiers and all pairing/authorization material remain redacted.
- The pre-existing differently signed AppDied and keyboard applications were never uninstalled, cleared, downgraded, or overwritten.
- Long-output evidence records byte counts, page boundaries, and hashes rather than embedding retained content.
