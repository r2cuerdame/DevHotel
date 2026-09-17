# Android Room runtime performance

What actually moves the needle for an Android Room, and what the numbers behind
the current settings are. Reproduce anything here with the probe method at the
bottom before changing a setting on the strength of a recalled figure.

## The one lever that works: guest LCD size

The emulator has no GPU passthrough in a Room. SwiftShader renders in software,
so the guest's pixel count is the dominant cost. Shrinking the AVD panel is the
single biggest speed lever, which is why `emulatorAvdOverride` exists and why
`fast` (540x1140 for the default phone) is the default profile.

Shipped in 0.5.4 and re-confirmed here: guest screen capture is ~298 ms at
540x1140 against ~919 ms at the native 1080x2280.

## The emulator CPU/RAM/audio budget

`buildEmulatorArgs` passes `-cores 4 -memory 4096 -noaudio`, clamped by
`emulatorBudget` to the Room's own System-tab CPU and memory selections
([#104](https://github.com/r2cuerdame/DevHotel/issues/104)). The clamp is the
part that is doing real work: before it, a Room capped at 1 CPU / 1 GB still
asked for a 4-core, 4096MB emulator.

**The 4-core / 4096MB ceiling itself is not supported by measurement on current
`main`, and should be revisited rather than treated as a tuned value.** The
figures it was chosen from (adb input ~355 ms -> ~230 ms, screencap
~873 ms -> ~639 ms) predate 0.5.4. They were taken before the `fast` resolution
profile became the default, so the improvement they captured is the one 0.5.4
already shipped by shrinking the panel — this document's baseline screencap of
283-350 ms brackets the ~298 ms the 0.5.4 changelog reports.

Ten emulator boots at 540x1140, medians per run, alternating order across rounds:

| flags (on top of `-no-boot-anim -skip-adb-auth`) | boot to adb-ready | adb input | screencap |
| --- | --- | --- | --- |
| none | 32.6 / 35.5 / 39.8 / 46.4 s | 17 / 17 / 21 / 28 ms | 283 / 297 / 331 / 350 ms |
| `-noaudio` | 32.5 / 35.6 s | 17 / 21 ms | 288 / 292 ms |
| `-memory 4096` | 33.0 / 52.5 s | 17 / 25 ms | 325 / 602 ms |
| `-cores 4 -memory 4096 -noaudio` | 38.9 / 48.8 s | 26 / 36 ms | 308 / 448 ms |

Read the spread, not the best number in each row. Run-to-run variance with no
flags at all spans 32.6-46.4 s of boot and 283-350 ms of screencap, and no
configuration here beats that noise floor.

Flag by flag:

- **`-cores 4` is a no-op.** A code fact rather than a measurement: the image's
  AVD already ships `hw.cpu.ncore = 4` in `/home/androidusr/emulator/config.ini`,
  so the flag restates the default. It still matters as a *ceiling*, because
  `emulatorBudget` lowers it for a Room that asked for fewer CPUs.
- **`-noaudio` is neutral.** No measured gain and no measured harm. The AVD has
  `hw.audioInput`/`hw.audioOutput` on, but nothing in a Room ever opens them.
- **`-memory 4096` is unpredictable rather than faster.** One run landed in the
  normal range and the other took 52.5 s to boot with 602 ms screencaps. The
  AVD's `hw.ramSize = 2G` is matched with `vm.heapSize = 512M`; raising only the
  guest's physical RAM leaves that pair inconsistent and makes qemu back twice
  the guest physical memory inside the engine VM. There is no run in which it
  bought anything.

## Not available: hardware GPU acceleration

DevHotel does not claim, and must not request, hardware GPU acceleration for the
emulator. `--gpus all` together with `-gpu host` makes the emulator select
llvmpipe and Vulkan then fails with `VK_ERROR_INCOMPATIBLE_DRIVER`; forcing Mesa
d3d12 fails emulator startup outright. `-gpu` stays at the image's
`swiftshader_indirect`, and `-accel on` (KVM) is what keeps the CPU fast.

## Reproducing

Run a disposable emulator container with the same wiring `buildEmulatorArgs`
produces — `--device /dev/kvm`, `EMULATOR_DEVICE`, `EMULATOR_NO_SKIN`, the
`SCREEN_*` triple, and the staged `avd-override.ini` — varying only
`EMULATOR_ADDITIONAL_ARGS`.

Two details decide whether the numbers mean anything:

- **Let the guest settle.** Measure at least 45 s after `sys.boot_completed`
  turns 1. Sampling earlier measures boot-time background work, not steady
  state, and inflates every number several-fold.
- **Alternate the order across rounds.** Back-to-back emulator runs drift
  measurably slower as the host warms, so a single A-then-B pass will credit the
  first configuration. Run A/B and then B/A, and compare medians rather than
  means — a single slow sample moves a mean a long way.

Verify the flags actually reached qemu before trusting a row:

```
docker exec <container> bash -lc "ps -eo args | grep -m1 '[q]emu-system'"
```
