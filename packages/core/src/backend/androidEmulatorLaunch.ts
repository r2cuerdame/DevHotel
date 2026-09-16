import {
  EMULATOR_DEFAULT_DEVICE,
  EMULATOR_DEFAULT_VERSION,
  emulatorAvdOverride,
  emulatorBudget,
  emulatorName,
  emulatorScreen,
  androidAvdVolume,
  type EmulatorLimits,
  type EmulatorOpts
} from './naming'
import { androidApiLevel, ANDROID_SYSTEM_IMAGES, UnpinnedAndroidSystemImageError } from './androidSdkPin'

/**
 * The direct `emulator` launch plan for a managed Android Room (#108).
 *
 * `budtmo/docker-android` takes its configuration as environment variables
 * (`EMULATOR_DEVICE`, `EMULATOR_ADDITIONAL_ARGS`, `SCREEN_*`, …) and builds the
 * command line itself. Owning the emulator means owning that argv, so this
 * module produces it directly from the same Room inputs `buildEmulatorArgs`
 * uses today. It is deliberately backend-neutral and free of Docker: whatever
 * executes it — the external compatibility backend today, the managed runtime
 * once #107/#109 land — only has to run the argv.
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
}

/**
 * `docker create` args for a managed Android emulator container (#108).
 *
 * This is the managed-path equivalent of `buildEmulatorArgs` in `naming.ts`.
 * Where `buildEmulatorArgs` uses `budtmo/docker-android`'s env-var interface
 * (so the image's supervisord sets up the AVD and launches the emulator itself),
 * this function produces a `docker create` command that overrides the entrypoint
 * with a DevHotel-owned shell script that:
 *
 * 1. Writes the DevHotel openbox rc.xml and fit-emulator.py into `/root/.config/`
 *    (embedded as base64 in the script — no `docker cp` staging step needed).
 * 2. Creates the AVD from the pinned system image if `ANDROID_AVD_HOME/<name>.avd`
 *    does not yet exist (idempotent on warm restarts).
 * 3. Appends the DevHotel config.ini overrides (resolution, orientation) to the
 *    freshly-created or existing AVD's `config.ini`.
 * 4. Starts Xvfb, openbox, x11vnc and websockify exactly as docker-android does,
 *    then launches the emulator with the direct argv from `androidEmulatorLaunch`.
 *
 * `budtmo/docker-android` is still used as the base image because it already
 * ships the complete X11/VNC/openbox stack — removing that dependency is a
 * separate step after the managed path is running.
 *
 * The per-Room AVD is mounted from `androidAvdVolume(roomId)` at
 * `ANDROID_AVD_HOME`, so its quickboot snapshot persists across container
 * recreations — the precondition for #78 warm-Room reuse.
 */
export function buildManagedEmulatorContainerArgs(
  roomId: string,
  plan: AndroidAvdPlan,
  launch: AndroidEmulatorLaunch,
  lifecycle: ManagedEmulatorContainerLifecycle,
  imageRef: string
): string[] {
  const { networkNamespace, networkAuthoritySandboxId, networkAuthorityStartedAt, abortToken, limits, openbox } = lifecycle

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
   * Runs inside the container image (which ships Xvfb, openbox, x11vnc,
   * websockify, python3, ffmpeg, base64, libX11 — all from docker-android).
   * Does NOT rely on the image's supervisord or any docker-android env vars.
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
    // Per-Room persistent AVD volume: the booted snapshot survives restarts.
    '-v',
    `${androidAvdVolume(roomId)}:${ANDROID_AVD_HOME}`,
    // Emulator guest memory + overhead for Xvfb/x11vnc/openbox/adb server.
    '--memory',
    `${budget.memoryMB + 1024}m`,
    // The entrypoint is replaced: no supervisord, no docker-android env vars.
    '--entrypoint',
    'sh',
    imageRef,
    '-c',
    script
  ]
}
