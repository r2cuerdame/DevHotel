# Android Room Provider — Design

Date: 2026-08-10
Status: Groundwork only. Per goal.md §4.8, §21.4 and §26-15, Android arrives **after** Web Rooms are rock-solid. This document fixes the architecture so the provider seam shipped today is honest, and so Android work can start later without re-deciding fundamentals. Nothing here changes the current build priority: Web first.

## 0. What ships today (provider v0)

Code: `packages/core/src/providers/` — `RoomProvider` interface, `WebRoomProvider` (delegates to the existing detection engine and mirrors the orchestrator's web-spec construction), `AndroidRoomProvider` stub, and a registry (`providers()`, `getProvider(kind)`).

Nothing user-facing. The Android provider reports `available: false` with a reason, `detect()`/`buildSpec()` throw, and `components()` returns `[]` — goal.md §18.2: unsupported features are never faked, not even in metadata.

### Why the seam is exactly `detect` + `buildSpec` + `components`

goal.md §18.1 lists a broad expected interface (lifecycle, changes, checks, console, diagnostics). We deliberately do **not** abstract those yet:

- Lifecycle (create/start/sleep/delete), the change transaction engine, checks persistence, gateway routing and the journal are *shared services* — they are provider-independent by design. Splitting them per provider now, with one real implementation, would produce a speculative interface shaped by guesses; the classic wrong abstraction.
- The only places `RoomOrchestrator` is genuinely web-shaped today are: (1) the `detectProject` call sites (`planRoom`, `createRoom`), (2) `webSpecFor` (container spec construction), (3) the stack/components summary. Those three are the seam. Orchestrator delegation to `getProvider('web')` can land later as a pure refactor with zero behavior change — `buildWebSpec` intentionally mirrors `webSpecFor`'s output shape, taking the deps-volume override as a parameter instead of reading settings, so the provider stays free of store access.
- `buildSpec` returns `WebSpec` because `IsolationBackend` only knows `WebSpec` today. Generalizing the spec type with one real provider would be fiction. When Android v1 lands, `WebSpec` generalizes into a per-provider spec union and `IsolationBackend` grows the Android container shapes; that migration is mechanical and typecheck-guided.
- `RoomRecord.provider` stays the literal `'web'` in `@devhotel/shared` until an Android room can actually be created. Widening the persisted type before the feature exists would let unfinishable records into the store.

## 1. Android Room이란 무엇인가

Web Room과 같은 계약이다: **하나의 프로젝트가 살아가는, 오래 유지되는 격리 환경.** 격리 대상만 다르다.

An Android Room is the same room-pod model (anchor container owning the network namespace; role containers joining it), holding:

- **Per-room JDK** — as a container image tag (`eclipse-temurin:<major>`), exactly how Web Rooms key runtime on `node:<major>`.
- **Per-room Android SDK** — cmdline-tools, platform-tools, build-tools, `platforms;android-<level>`, system images — installed by `sdkmanager` into a named volume (`dh-<room>-sdk`). License acceptance is an explicit, journaled action, not a hidden `yes | sdkmanager`.
- **Per-room Gradle caches** — `~/.gradle` (wrapper distributions, dependency cache, build cache) in `dh-<room>-gradle`. Rooms never share caches: isolation beats disk economy, same trade the web deps volumes already made.
- **One AVD per room** — the AVD definition plus its data image (`userdata-qemu.img`, snapshots) in `dh-<room>-avd`. The AVD data image is the Android analog of the browser profile (§10.6): app data, accounts, settings live there and belong to this room only.
- **adb keyed per room** — an adb server *inside the room's netns*, published to an ephemeral loopback port by the anchor (like the web port relay). DevHotel never runs a global host adb on 5037; a global server would see every room's emulator and reintroduce exactly the cross-contamination Rooms exist to prevent.

Deleting the room deletes containers + volumes and reports reclaimed bytes — the §23 isolation criteria apply unchanged.

## 2. Components (§5.6 mapping)

| Web Room component | Android Room component | Keyed by |
|---|---|---|
| Node.js | JDK | container image major (17, 21, …) |
| npm / pnpm | Gradle (wrapper-first) | `gradle-wrapper.properties` in source |
| — | SDK / build-tools level | `dh-<room>-sdk` volume contents |
| Web process | App process (debug APK on the AVD) | applicationId |
| Dependency volume | Gradle caches | `dh-<room>-gradle` |
| Browser profile | AVD data image | `dh-<room>-avd` |
| Domain / internal port | adb endpoint + preview stream | anchor ephemeral loopback port |
| Preview (WebContentsView) | Emulator display stream | scrcpy-style H.264 over adb |

Detection produces the same `Detected<T>` + source-attribution plan UI (§8.2 discipline): Gradle version from `gradle/wrapper/gradle-wrapper.properties` (`distributionUrl`), compile/target/min SDK and AGP version from `build.gradle(.kts)` / version catalogs, required JDK derived from AGP (AGP 8.x → JDK 17+), `applicationId`, module list from `settings.gradle(.kts)`.

## 3. Preview — 브라우저형 UX 유지 (§4.2)

The user must still see the app first, full-bleed, in the same browser-like 2-way view (§7.3). The emulator window itself is never shown; its display is streamed into the room view.

- **Transport: scrcpy-style.** Push the scrcpy server jar over adb, receive the raw H.264 stream through the adb tunnel (which already terminates at the room's published loopback port). Latency is proven at 35–70 ms; the same path works for physical devices later.
- **Rendering:** decode in the renderer with WebCodecs (Chromium hardware H.264 decode) onto a canvas occupying the region the `WebContentsView` uses for web rooms — or a dedicated view; either way the browser-bar chrome (health dot, restart, panel toggle) is identical. Input: pointer events map to touch through the scrcpy control channel.
- **Rejected alternative:** the emulator's gRPC endpoint (`-grpc`) offers screenshots/streaming + input, but raw-frame streaming is heavier than H.264 and device support is emulator-only. scrcpy's protocol is battle-tested and device-portable.
- Browser-bar semantics translate honestly: back button → Android back, reload → app restart, the address slot shows `applicationId` instead of a domain. No fake URL bar.

## 4. Windows reality — emulator와 가상화

The emulator needs hardware virtualization. Two viable shapes on Windows 11:

**Option A — emulator in a container under WSL2, using KVM (recommended).**
WSL2 exposes `/dev/kvm` via nested virtualization (default-on for Win11 on most modern CPUs). The emulator container joins the room pod with `--device /dev/kvm`, runs headless with `-no-window`, GPU as `swiftshader_indirect` (software) initially.

- Pros: preserves the product's core promises — §10.7 host footprint (nothing installed on the host), per-room versioning of emulator + system images, room deletion reclaims everything, crash recovery via the same label reconciliation.
- Cons: software GPU rendering (adequate for dev preview, not games), no audio, a real perf tax, and `/dev/kvm` availability varies (CPU age, corporate Hyper-V policy, Docker Desktop configuration).

**Option B — host-installed emulator (WHPX/AEHD), DevHotel manages per-room `ANDROID_AVD_HOME` directories.**

- Pros: best performance, GPU acceleration, Google's officially supported Windows path.
- Cons: violates §10.7 (SDK + emulator installed host-globally), emulator/system-image versions become shared across rooms (only AVD *data* stays per-room), cleanup and reclaim reporting get murky, and the isolation story stops being invisible (§4.3).

**Recommendation: Option A as the target architecture**, with the availability question handled honestly rather than papered over: an Easy Check step probes nested virt / `/dev/kvm` and, when absent, the emulator feature reports *unavailable with a reason* (§18.2) — it does not silently fall back to Option B. The fallback for users without KVM is the v1 posture: build in the container, install to a device/emulator the user provides. This is also why staging puts build-only rooms first — build containers need no virtualization, so the riskiest dependency is deferred until the rest of the room proves out.

## 5. Quick Changes와 Undo 전략

Same grammar as web (§11: Add · Change · Check · Undo), same transaction engine (§12):

| Quick Change | Apply | Undo strategy |
|---|---|---|
| JDK version | swap build/emulator container image | image swap back (identical to node-version: instant, provably scoped) |
| SDK / build-tools level | `sdkmanager` install into the sdk volume | remove installed packages; capture = installed-package list before/after |
| Gradle version | edits `gradle-wrapper.properties` — **this is source** (§13.3) | offered only as an explicitly labeled source-touching change; capture+restore of that one file, scope shown before apply |
| AVD reset | recreate the data image | volume-swap, like deps clean-reinstall and browser-profile reset: old data image kept until history is pruned |
| App reinstall | `adb uninstall` + `install` of the debug APK | reinstall the previously captured APK artifact |
| Emulator restart / cold boot | container restart, `-no-snapshot-load` for cold | not undoable — labeled as such (§13.4) |

The Gradle row is the one real boundary case: unlike Node version (pure environment), Gradle version lives in the repo. DevHotel does not silently edit source; the change is either declined or clearly marked as crossing the source boundary, mirroring the §13.3 lockfile precedent.

## 6. Easy Check pipeline (§14 adapted)

Same ordered pipeline, same `healthy | warning | broken | unknown` + evidence + one-click fixes where safe:

1. Isolation backend
2. Room metadata & storage (volumes present)
3. Source availability
4. JDK (container image, `java -version` matches plan)
5. SDK licenses & packages (`sdkmanager --licenses` state; missing platform → fix: install)
6. Gradle (wrapper resolvable, distribution cached, daemon startable)
7. Build (`assembleDebug` output present / last build result)
8. Virtualization (nested virt & `/dev/kvm` — gates everything below, honest unavailability)
9. Emulator boot (`sys.boot_completed=1`)
10. adb (room's adb server answering, device visible)
11. App installed (`pm list packages` contains applicationId)
12. App responding (process alive + top resumed activity is the app)

Known fixes (§14.1 analogs): accept licenses, restart adb server, cold-boot emulator, reinstall app, gradle `--stop` stale daemons. Unknown problems flow into the same redacted diagnostic copy (§14.2–14.3).

## 7. Staging — 무엇을 언제 출시하는가

- **v0 (this change): provider seam only.** No UI surface, no promises. Registry lists Android as unavailable with the reason. Exit criterion for even starting v1: Web Rooms meet the §23 success criteria in real daily use (§21.4: "Android는 Web Room이 실제로 매일 사용 가능한 수준이 된 뒤 시작한다").
- **v1: build-only Android Rooms.** Containerized JDK + SDK + Gradle running `assembleDebug` in the room pod; install the APK over adb to a *user-provided* device or emulator. Checks 1–7 + 10–11. No managed emulator, no preview, and the room card says exactly that. Zero virtualization risk; proves detection, volumes, changes, checks on the Android stack.
- **v2: managed emulator + preview.** KVM/WSL2 emulator container, scrcpy-style stream in the room view, AVD reset quick change, full check pipeline, per-room adb end-to-end.

## 8. Non-goals 재확인 (§22)

Unchanged and re-affirmed for the Android provider specifically:

- No Android IDE — editing stays in the user's tools; DevHotel manages the environment.
- No Play Store publishing, signing pipelines, or release management (production hosting/deployment clause).
- No device farm, no cloud devices (local-first; hosted Android Rooms are the long-term commercial list in §25, not this design).
- No CI runner (CI validation Rooms are a separate §21.4 item).
- No iOS — not in goal.md at all.
- **No Web + Android 동시 구현** (§22 explicit): this document exists precisely so that no Android implementation pressure leaks into the Web MVP. The stub refusing loudly is the feature.

빈 방을 미리 그럴듯하게 꾸미지 않는다. Android Room은 Web Room이 매일 쓰이는 도구가 된 다음에 짓는다.
