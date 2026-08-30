/**
 * Which ADB operations may run without owning the phone.
 *
 * The split is not "read vs write" in the file sense — it is "would another
 * project notice". Selected non-identifying properties are harmless; installing
 * an APK, clearing data, sending a key event or launching an activity all reach
 * into the run somebody else is watching. Host-wide and identity-revealing
 * operations are forbidden even to a lease holder. Anything else this
 * classifier is not sure about needs the exclusive device lease.
 */

export interface AdbClassification {
  interfering: boolean
  /** Host-wide or identity-revealing operations never become safe with a lease. */
  forbidden?: boolean
  /** Human phrase naming the operation, used verbatim in refusal messages. */
  reason: string
}

/** Operations owned by the Host broker, never by a Room or its device lease. */
const FORBIDDEN_VERBS = new Map<string, string>([
  ['devices', 'listing raw Host ADB transports'],
  ['track-devices', 'tracking raw Host ADB transports'],
  ['track-devices-l', 'tracking raw Host ADB transports'],
  ['get-serialno', 'reading the raw hardware serial'],
  ['get-devpath', 'reading the Host transport path'],
  ['start-server', 'starting the shared ADB server'],
  ['kill-server', 'stopping the shared ADB server'],
  ['connect', 'changing Host ADB connections'],
  ['disconnect', 'changing Host ADB connections'],
  ['pair', 'pairing a Host ADB connection'],
  ['forward', 'changing or listing shared Host ADB forwards'],
  ['reverse', 'changing shared Host ADB reverse forwards'],
  ['push', 'reading a Host file for a device transfer'],
  ['pull', 'writing a device file onto the Host'],
  ['sync', 'reading Host files for device synchronization'],
  ['restore', 'reading a Host backup'],
  ['sideload', 'reading a Host package'],
  ['bugreport', 'writing a device report onto the Host'],
  ['keygen', 'writing an ADB key onto the Host']
])

/** Top-level adb verbs that always change the device or its app state. */
const INTERFERING_VERBS = new Map<string, string>([
  ['install', 'installing an APK'],
  ['install-multiple', 'installing APKs'],
  ['install-multi-package', 'installing APKs'],
  ['uninstall', 'uninstalling an app'],
  ['reboot', 'rebooting the device'],
  ['root', 'restarting adbd as root'],
  ['unroot', 'restarting adbd'],
  ['remount', 'remounting device partitions'],
  ['disable-verity', 'changing device verity'],
  ['enable-verity', 'changing device verity'],
  ['emu', 'sending an emulator console command'],
  ['tcpip', 'switching the device transport'],
  ['usb', 'switching the device transport']
])

/** Top-level adb verbs that only observe. */
const SAFE_VERBS = new Set([
  'get-state',
  'version',
  'features',
  'jdwp'
])

/** `adb shell <cmd>` programs that only report. */
const SAFE_SHELL_COMMANDS = new Set([
  'df',
  'ps',
  'pidof',
  'id',
  'whoami',
  'uptime',
  'echo',
  'printf',
  'top',
  'free'
])

/** Public, non-unique properties needed by health checks and Android builds. */
const SAFE_GETPROP_KEYS = new Set([
  'ro.build.version.release',
  'ro.build.version.sdk',
  'ro.product.manufacturer',
  'ro.product.model',
  'sys.boot_completed'
])

/** Commands whose read modes can bypass identity/output policy despite a lease. */
const FORBIDDEN_SHELL_COMMANDS = new Map<string, string>([
  ['dd', 'reading arbitrary protected device bytes with `dd`']
])

/** `adb shell <cmd>` programs that always change something. */
const INTERFERING_SHELL_COMMANDS = new Map<string, string>([
  ['am', 'driving activities with `am`'],
  ['input', 'injecting input events'],
  ['monkey', 'running monkey'],
  ['svc', 'changing device services'],
  ['settings', 'changing device settings'],
  ['content', 'writing through a content provider'],
  ['setprop', 'setting a system property'],
  ['reboot', 'rebooting the device'],
  ['stop', 'stopping the Android runtime'],
  ['start', 'starting the Android runtime'],
  ['rm', 'deleting files on the device'],
  ['mv', 'moving files on the device'],
  ['mkdir', 'writing files on the device'],
  ['touch', 'writing files on the device'],
  ['chmod', 'changing device file modes'],
  ['chown', 'changing device file ownership'],
  ['kill', 'killing a process on the device'],
  ['killall', 'killing processes on the device'],
  ['bmgr', 'driving the backup manager'],
  ['ime', 'changing the input method'],
  ['locksettings', 'changing lock settings'],
  ['device_config', 'changing device config'],
  ['uiautomator', 'driving UI automation']
])

/** `pm` and `cmd` subcommands split further: `pm list` observes, `pm clear` does not. */
const SAFE_PM_SUBCOMMANDS = new Set(['list', 'path', 'dump', 'get-install-location', 'has-feature'])

function stripGlobalFlags(argv: string[]): string[] {
  const rest = [...argv]
  while (rest.length > 0) {
    const head = rest[0]!
    if (head === '-s' || head === '-t' || head === '-H' || head === '-P' || head === '-L') {
      rest.splice(0, 2)
      continue
    }
    if (head === '-d' || head === '-e' || head === '-a') {
      rest.shift()
      continue
    }
    break
  }
  return rest
}

/** Tokens that let one shell word smuggle a second command past the check. */
const SHELL_CHAINING = /[;&|<>]|\$\(|`|[\r\n]/

function classifyWm(words: string[]): AdbClassification {
  const subcommand = words[1]
  // With no value these two forms only report the current override. `reset`,
  // `WxH`, and a numeric density all mutate the shared display.
  if ((subcommand === 'size' || subcommand === 'density') && words.length === 2) {
    return { interfering: false, reason: `\`wm ${subcommand}\`` }
  }
  return { interfering: true, reason: `changing display state with \`wm${subcommand ? ` ${subcommand}` : ''}\`` }
}

function classifyDumpsys(words: string[]): AdbClassification {
  const service = words[1]
  // Keep the unauthenticated surface deliberately small. These exact forms are
  // observations; services such as `battery set`, `deviceidle force-idle`, and
  // vendor extensions are commands despite living behind `dumpsys`.
  if (service === 'battery') {
    return words.length === 2
      ? { interfering: false, reason: '`dumpsys battery`' }
      : { interfering: true, reason: 'changing battery state with `dumpsys battery`' }
  }
  if (service === 'package' && words.length <= 3 && words.every((word) => !word.startsWith('-'))) {
    return { interfering: false, reason: '`dumpsys package`' }
  }
  return {
    interfering: true,
    forbidden: true,
    reason: service ? `reading the unapproved \`dumpsys ${service}\` service` : 'dumping every Android system service'
  }
}

function classifyLogcat(words: string[]): AdbClassification {
  // A tiny read-only surface is easier to keep honest than mirroring logcat's
  // evolving option parser. In particular -c, -G, -P and -f mutate shared
  // buffers or device storage; unfamiliar variants therefore need a lease.
  if (words.length === 1 || (words.length === 2 && (words[1] === '-d' || words[1] === '--dump'))) {
    return { interfering: false, reason: '`logcat`' }
  }
  return { interfering: true, reason: 'the unrecognised or mutating `logcat` operation' }
}

function classifyGetprop(words: string[]): AdbClassification {
  const property = words[1]
  if (words.length === 2 && property && SAFE_GETPROP_KEYS.has(property)) {
    return { interfering: false, reason: `\`getprop ${property}\`` }
  }
  return {
    interfering: true,
    forbidden: true,
    reason: property ? `reading the protected Android property \`${property}\`` : 'dumping protected Android properties'
  }
}

function classifyShell(words: string[]): AdbClassification {
  const flagless = words.filter((word) => !word.startsWith('-'))
  const program = flagless[0]
  if (!program) {
    return { interfering: true, forbidden: true, reason: 'running an interactive device shell' }
  }

  if (words.some((word) => SHELL_CHAINING.test(word))) {
    return { interfering: true, forbidden: true, reason: 'running a compound device shell command' }
  }

  const forbidden = FORBIDDEN_SHELL_COMMANDS.get(program)
  if (forbidden) return { interfering: true, forbidden: true, reason: forbidden }

  const interfering = INTERFERING_SHELL_COMMANDS.get(program)
  if (interfering) return { interfering: true, reason: interfering }

  if (program === 'getprop') return classifyGetprop(words)
  if (program === 'wm') return classifyWm(words)
  if (program === 'dumpsys') return classifyDumpsys(words)
  if (program === 'screencap') {
    return words.length === 1 || (words.length === 2 && words[1] === '-p')
      ? { interfering: false, reason: '`screencap`' }
      : { interfering: true, reason: 'writing a screenshot onto device storage' }
  }
  if (program === 'screenrecord') return { interfering: true, reason: 'recording the shared screen' }
  if (program === 'logcat') return classifyLogcat(words)
  if (program === 'date') {
    return words.length === 1
      ? { interfering: false, reason: '`date`' }
      : { interfering: true, reason: 'changing or invoking an unrecognised `date` operation' }
  }

  if (program === 'pm' || program === 'cmd' || program === 'appops') {
    const sub = flagless[1]
    if (program === 'pm' && sub && SAFE_PM_SUBCOMMANDS.has(sub)) return { interfering: false, reason: `\`pm ${sub}\`` }
    if (program === 'cmd' && sub === 'package' && flagless[2] && SAFE_PM_SUBCOMMANDS.has(flagless[2])) {
      return { interfering: false, reason: `\`cmd package ${flagless[2]}\`` }
    }
    if (program === 'cmd' && (sub === 'device_identifiers' || sub === 'phone')) {
      return { interfering: true, forbidden: true, reason: `reading protected identifiers with \`cmd ${sub}\`` }
    }
    return { interfering: true, reason: `\`${program}${sub ? ` ${sub}` : ''}\`` }
  }

  if (SAFE_SHELL_COMMANDS.has(program)) return { interfering: false, reason: `\`${program}\`` }
  return {
    interfering: true,
    forbidden: true,
    reason: `the unrecognised device command \`${program}\``
  }
}

export function classifyAdbCommand(argv: string[]): AdbClassification {
  const rest = stripGlobalFlags(argv.filter((arg) => arg.length > 0))
  const verb = rest[0]
  if (!verb) return { interfering: true, reason: 'an empty adb command' }

  const forbidden = FORBIDDEN_VERBS.get(verb)
  if (forbidden) return { interfering: true, forbidden: true, reason: forbidden }

  const interfering = INTERFERING_VERBS.get(verb)
  if (interfering) return { interfering: true, reason: interfering }

  if (verb === 'shell' || verb === 'exec-out') return classifyShell(rest.slice(1))

  if (verb === 'logcat') {
    return classifyLogcat(rest)
  }
  if (SAFE_VERBS.has(verb)) return { interfering: false, reason: `\`adb ${verb}\`` }
  return {
    interfering: true,
    forbidden: true,
    reason: `the unrecognised Host ADB command \`${verb}\``
  }
}
