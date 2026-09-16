import {
  EMULATOR_DEFAULT_DEVICE,
  EMULATOR_DEFAULT_VERSION,
  emulatorAvdOverride,
  emulatorBudget,
  emulatorName,
  emulatorScreen,
  androidAvdVolume,
  androidSdkVolume,
  type EmulatorLimits,
  type EmulatorOpts
} from './naming'
import { androidApiLevel, ANDROID_SYSTEM_IMAGES, UnpinnedAndroidSystemImageError } from './androidSdkPin'
import { MANAGED_EMULATOR_PREVIEW_IMAGE_REF } from './managedEmulatorPreviewImage'

/**
 * The direct `emulator` launch plan for a managed Android Room (#108).
 *
 * DevHotel owns the entire emulator launch pipeline: it provisions the SDK and
 * system image from pinned artifacts (see `androidSdkPin.ts`), manages the
 * per-Room AVD directory on a named volume, and runs the emulator directly
 * against the managed runtime's KVM instead of delegating to docker-android.
 *
 * Every option below was verified against the pinned emulator build's own
 * option table rather than recalled, including that `-accel` takes `on|off|auto`
 * and that `-ports` is `<consoleport>,<adbport>`.
 *
 * Design: docs/superpowers/specs/2026-09-17-android-room-managed-runtime-design.md
 */

/** Where the Room's SDK and AVD live inside the runtime. Room-owned, not `/home/androidusr`. */
export const ANDROID_SDK_ROOT = '/opt/devhotel/android-sdk'
export const ANDROID_AVD_HOME = '/opt/devhotel/android-avd'
/** The X display the emulator window is mapped into and x11vnc exports. */
export const ANDROID_EMULATOR_DISPLAY = ':0'

/**
 * DevHotel-owned managed emulator preview container image.
 *
 * Provides the X11/VNC preview runtime (Xvfb, openbox, x11vnc, novnc/websockify,
 * python3/python3-xlib, ffmpeg, curl, unzip, openjdk-17-jre-headless) without
 * any Android SDK baked in — the SDK is provisioned from pinned artifacts and
 * mounted as a volume at {@link ANDROID_SDK_ROOT}.
 *
 * This is NOT docker-android, and as of #111 it is no longer pulled from a
 * registry either. It is built inside the managed runtime from the Dockerfile
 * this repository carries, so a machine with no GitHub credential can reach it;
 * see `managedEmulatorPreviewImage.ts` for why that matters and what the tag
 * proves. The reference is a local, content-addressed tag — there is nothing
 * to pull and nothing to publish.
 */
export const MANAGED_EMULATOR_PREVIEW_IMAGE = MANAGED_EMULATOR_PREVIEW_IMAGE_REF


/**
 * Fixed console/adb ports.
 *
 * `EMULATOR_ADB_SERIAL` is `emulator-5554` because adb names a local emulator
 * after its console port. Letting the emulator auto-allocate would let that
 * serial drift, and every fenced ADB command, install receipt and acceptance
 * report in this project is written against the constant. Pinning the pair is
 * what keeps the existing contract true rather than probable.
 */
export const ANDROID_EMULATOR_CONSOLE_PORT = 5554
export const ANDROID_EMULATOR_ADB_PORT = 5555

export interface AndroidAvdPlan {
  /** AVD name; also the directory under ANDROID_AVD_HOME. */
  name: string
  /** `sdkmanager` coordinate of the system image this AVD is created from. */
  systemImage: string
  /** `avdmanager create avd` argv, without the executable. */
  createArgs: string[]
  /**
   * Lines appended to the AVD's `config.ini`. docker-android performs this
   * append itself from `EMULATOR_CONFIG_PATH`; owning the AVD means writing
   * them, which is what removes the `/home/androidusr` staging path.
   */
  configIni: string
}

export function androidAvdName(roomId: string): string {
  return `dh-${roomId}`
}

/** How a managed Room's AVD is created, before any emulator is launched. */
export function androidAvdPlan(roomId: string, opts?: Partial<EmulatorOpts>): AndroidAvdPlan {
  const version = opts?.version ?? EMULATOR_DEFAULT_VERSION
  const apiLevel = androidApiLevel(version)
  const image = ANDROID_SYSTEM_IMAGES[apiLevel]
  if (!image) throw new UnpinnedAndroidSystemImageError(version, apiLevel)
  const name = androidAvdName(roomId)
  const device = opts?.device ?? EMULATOR_DEFAULT_DEVICE
  return {
    name,
    systemImage: image.sdkPackage,
    createArgs: [
      'create',
      'avd',
      '--name',
      name,
      '--package',
      image.sdkPackage,
      '--device',
      device,
      // A Room's AVD is created once and then owned; never silently replaced.
      '--force'
    ],
    configIni: emulatorAvdOverride(device, opts?.resolution ?? 'fast', opts?.orientation ?? 'portrait')
  }
}

export interface AndroidEmulatorLaunch {
  argv: string[]
  env: Record<string, string>
}

/**
 * The emulator command line and the environment it needs.
 *
 * Notable absences, each deliberate:
 *
 * - **no `-no-window`.** The Room's "site" is the phone screen: the emulator
 *   must map a real window into the Xvfb display so openbox can make it
 *   frameless and x11vnc can export it to noVNC on `EMULATOR_SCREEN_PORT`.
 *   A headless emulator would leave the preview permanently black.
 * - **no snapshot flags.** The emulator's default quickboot save/load is what
 *   makes a warm Room's AVD state survive, which is the half of #78 that owning
 *   the AVD directory unblocks. Passing `-no-snapshot-save` here would throw it
 *   away on every stop.
 * - **no `--gpus` / `-gpu host`.** Measured under #104: the Host selects
 *   llvmpipe and Vulkan fails with `VK_ERROR_INCOMPATIBLE_DRIVER`. Software
 *   rendering is the supported configuration and no hardware acceleration is
 *   claimed.
 */
export function androidEmulatorLaunch(
  roomId: string,
  opts?: Partial<EmulatorOpts>,
  limits?: EmulatorLimits
): AndroidEmulatorLaunch {
  const budget = emulatorBudget(limits)
  const screen = emulatorScreen(opts?.orientation)
  return {
    argv: [
      '-avd',
      androidAvdName(roomId),
      // Hold the serial contract: adb names this device emulator-5554.
      '-ports',
      `${ANDROID_EMULATOR_CONSOLE_PORT},${ANDROID_EMULATOR_ADB_PORT}`,
      // `on` rather than `auto`: without KVM the emulator is unusably slow, and
      // a Host that refused nested virtualization has to fail loudly here
      // instead of producing a Room that looks alive and never boots.
      '-accel',
      'on',
      '-gpu',
      'swiftshader_indirect',
      '-cores',
      String(budget.cores),
      '-memory',
      String(budget.memoryMB),
      '-noaudio',
      '-no-boot-anim',
      // ADB authentication is disabled only for this managed emulator: its ADB
      // transport has no Host port and no Room-network path, and immutable-ID
      // helpers can reach it only through the proved private control netns.
      '-skip-adb-auth'
    ],
    env: {
      ANDROID_SDK_ROOT,
      ANDROID_AVD_HOME,
      DISPLAY: ANDROID_EMULATOR_DISPLAY,
      // Xvfb is sized by the same function that sizes the docker-android
      // screen, so the preview geometry does not change across the migration.
      SCREEN_WIDTH: String(screen.width),
      SCREEN_HEIGHT: String(screen.height)
    }
  }
}

/**
 * Configuration for the openbox window manager and fit daemon embedded into the
 * managed emulator container's startup script.
 *
 * These are the same rules `OciCliBackend.createEmulator` stages via `docker cp`
 * for the docker-android container. On the managed path they are embedded in the
 * entrypoint script as base64 — no `docker cp` staging step needed.
 */
export interface ManagedEmulatorOpenboxConfig {
  /** Content of `/root/.config/openbox/rc.xml` (same as `openboxFramelessRc()`). */
  rcXml: string
  /** Content of `/root/.config/openbox/fit-emulator.py` (same as `fitEmulatorPy()`). */
  fitPy: string
}

/**
 * Options for {@link buildManagedEmulatorContainerArgs}.
 *
 * Mirrors the `lifecycle` parameter of `buildEmulatorArgs` so the managed and
 * compatibility paths share the same call-site shape in `createEmulator`.
 */
export interface ManagedEmulatorContainerLifecycle {
  /** Immutable container ID of the control anchor whose netns the emulator joins. */
  networkNamespace: string
  /** Exact sandbox ID of the running control anchor (fencing). */
  networkAuthoritySandboxId: string
  /** Docker StartedAt of the control anchor (fencing). */
  networkAuthorityStartedAt: string
  /** Token written into the abort label for cleanup on create failure. */
  abortToken: string
  limits?: EmulatorLimits
  /**
   * Openbox WM config — embedded in the entrypoint script so no staging is needed.
   * When omitted, openbox starts without a DevHotel rc (emulator window will not
   * be auto-fitted). Always pass this in production.
   */
  openbox?: ManagedEmulatorOpenboxConfig
  /**
   * Android API level — used to derive the shared SDK volume name.
   * Set from the Room's Android version via `androidApiLevel(version)`.
   */
  apiLevel: number
}

/**
 * `docker create` args for a managed Android emulator container (#108).
 *
 * This is the managed-path equivalent of `buildEmulatorArgs` in `naming.ts`,
 * except it uses the DevHotel-owned preview image instead of docker-android, and
 * mounts the SDK from a pre-provisioned shared volume rather than having it
 * baked into the image.
 *
 * The container entrypoint script:
 * 1. Writes openbox `rc.xml` + `fit-emulator.py` from embedded base64.
 * 2. Creates the AVD via `avdmanager` if the per-Room AVD directory is absent
 *    (idempotent on warm restarts — does not overwrite a saved quickboot snapshot).
 * 3. Appends DevHotel config.ini overrides (resolution/orientation).
 * 4. Starts Xvfb, openbox, x11vnc and websockify — same port 6080, same noVNC path.
 * 5. Execs the emulator directly using `androidEmulatorLaunch` argv.
 *
 * Two volumes are mounted:
 * - `androidSdkVolume(apiLevel)` → `ANDROID_SDK_ROOT` read-only: the shared,
 *   pre-provisioned Android SDK installation (cmdline-tools, platform-tools,
 *   emulator binary, and system image). Shared across all Rooms of the same
 *   Android version; provisioned once by a one-shot container before this call.
 * - `androidAvdVolume(roomId)` → `ANDROID_AVD_HOME` read-write: the per-Room
 *   AVD directory. Persists across container recreations so quickboot snapshots
 *   survive sleep/wake cycles (#78).
 */
export function buildManagedEmulatorContainerArgs(
  roomId: string,
  plan: AndroidAvdPlan,
  launch: AndroidEmulatorLaunch,
  lifecycle: ManagedEmulatorContainerLifecycle
): string[] {
  const { networkNamespace, networkAuthoritySandboxId, networkAuthorityStartedAt, abortToken, limits, openbox, apiLevel } = lifecycle

  // Shell-escape a string for embedding inside POSIX single quotes.
  const sq = (s: string): string => s.replace(/'/g, "'\\''")

  // The config.ini override is embedded literally; \\n is decoded by printf to a
  // real newline so the AVD config.ini gets real newlines.
  const configIni = plan.configIni.replace(/\\/g, '\\\\').replace(/'/g, "'\\''").replace(/\n/g, '\\n')
  const avdCreateArgs = plan.createArgs.map(sq).join("' '")
  const emulatorArgv = [
    `${ANDROID_SDK_ROOT}/emulator/emulator`,
    ...launch.argv
  ]
    .map((a) => `'${sq(a)}'`)
    .join(' ')

  // Openbox rc.xml and fit-emulator.py — embedded as base64 to safely transport
  // arbitrary file content through the shell entrypoint without escaping concerns.
  const rcXmlB64 = openbox ? Buffer.from(openbox.rcXml, 'utf8').toString('base64') : ''
  const fitPyB64 = openbox ? Buffer.from(openbox.fitPy, 'utf8').toString('base64') : ''

  /**
   * The managed emulator entrypoint.
   *
   * Runs inside the DevHotel-owned preview image (which ships Xvfb, openbox,
   * x11vnc, websockify/novnc, python3/xlib, ffmpeg, curl, unzip, JRE17).
   * The Android SDK is NOT in the image — it is mounted read-only from the
   * pre-provisioned shared SDK volume.
   *
   * Sequence:
   *   1. Write DevHotel openbox rc.xml + fit-emulator.py from embedded base64.
   *   2. Create the AVD if the directory is absent (idempotent on warm restarts).
   *   3. Append DevHotel config.ini overrides (resolution/orientation).
   *   4. Start Xvfb on DISPLAY=:0.
   *   5. Start openbox with the DevHotel rc.
   *   6. Start x11vnc → websockify pipeline on port 6080.
   *   7. Exec the emulator — container exits when the emulator exits.
   */
  const openboxSetup = openbox
    ? [
        'mkdir -p /root/.config/openbox',
        `printf '%s' '${rcXmlB64}' | base64 -d > /root/.config/openbox/rc.xml`,
        `printf '%s' '${fitPyB64}' | base64 -d > /root/.config/openbox/fit-emulator.py`,
        `printf '%s\\n' '# DevHotel: keep the emulator phone window filling the screen on a black desk' > /root/.config/openbox/autostart`,
        `printf '%s\\n' 'python3 "\\$HOME/.config/openbox/fit-emulator.py" >/dev/null 2>&1 &' >> /root/.config/openbox/autostart`
      ]
    : ['mkdir -p /root/.config/openbox']

  const openboxStartArg = openbox
    ? 'openbox --config-file /root/.config/openbox/rc.xml &'
    : 'openbox &'

  const script = [
    'set -eu',
    `export ANDROID_SDK_ROOT='${ANDROID_SDK_ROOT}'`,
    `export ANDROID_AVD_HOME='${ANDROID_AVD_HOME}'`,
    `export DISPLAY='${ANDROID_EMULATOR_DISPLAY}'`,
    `export PATH="$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/platform-tools:$ANDROID_SDK_ROOT/emulator:$PATH"`,
    ...openboxSetup,
    // Create the AVD on first boot; skip if the directory already exists (warm restart).
    `if [ ! -d '${ANDROID_AVD_HOME}/${sq(plan.name)}.avd' ]; then`,
    `  avdmanager '${avdCreateArgs}'`,
    // Append DevHotel's config.ini overrides — same content as EMULATOR_AVD_OVERRIDE_PATH.
    `  printf '%b' '${configIni}' >> '${ANDROID_AVD_HOME}/${sq(plan.name)}.avd/config.ini'`,
    'fi',
    // Xvfb: use the screen dimensions from the launch env.
    `Xvfb '${ANDROID_EMULATOR_DISPLAY}' -screen 0 '${launch.env.SCREEN_WIDTH}x${launch.env.SCREEN_HEIGHT}x24' &`,
    'sleep 1',
    openboxStartArg,
    // x11vnc + websockify: same port (6080) as docker-android, same noVNC URL path.
    'x11vnc -display :0 -nopw -forever -rfbport 5900 -shared -quiet &',
    'websockify --web /usr/share/novnc 6080 localhost:5900 &',
    // Exec the emulator directly: the process replaces this shell so the
    // container exits when the emulator exits (not a supervisor health check).
    `exec ${emulatorArgv}`
  ].join('\n')

  // Compute emulatorBudget so the managed container's --memory limit accounts
  // for both the emulator guest and the Xvfb/x11vnc/openbox/adb overhead.
  const budget = emulatorBudget(limits)

  return [
    'create',
    '--name',
    emulatorName(roomId),
    // Join the control anchor's network namespace (same as docker-android path).
    '--network',
    `container:${networkNamespace}`,
    '--cap-drop',
    'NET_RAW',
    // DevHotel ownership labels (same scheme as OciCliBackend).
    '-l',
    `devhotel.room=${roomId}`,
    '-l',
    'devhotel.role=svc-emulator',
    '-l',
    'devhotel.managed=1',
    '-l',
    `devhotel.network-authority-sandbox=${networkAuthoritySandboxId}`,
    '-l',
    `devhotel.network-authority-started-at=${networkAuthorityStartedAt}`,
    '-l',
    `devhotel.abort-token=${abortToken}`,
    // KVM access for hardware-accelerated emulation.
    '--device',
    '/dev/kvm',
    // Shared Android SDK volume: pre-provisioned, read-only.
    // All emulator containers of the same API level share this volume;
    // no Room can corrupt the SDK installation.
    '-v',
    `${androidSdkVolume(apiLevel)}:${ANDROID_SDK_ROOT}:ro`,
    // Per-Room persistent AVD volume: the booted snapshot survives restarts.
    '-v',
    `${androidAvdVolume(roomId)}:${ANDROID_AVD_HOME}`,
    // Emulator guest memory + overhead for Xvfb/x11vnc/openbox/adb server.
    '--memory',
    `${budget.memoryMB + 1024}m`,
    // The entrypoint is replaced; the DevHotel-owned preview image's CMD is a
    // safety-net only and should never run in production.
    '--entrypoint',
    'sh',
    MANAGED_EMULATOR_PREVIEW_IMAGE,
    '-c',
    script
  ]
}
