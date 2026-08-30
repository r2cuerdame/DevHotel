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
  ['version', 'reading the Host ADB SDK installation path'],
  ['start-server', 'starting the shared ADB server'],
  ['kill-server', 'stopping the shared ADB server'],
  ['connect', 'changing Host ADB connections'],
  ['disconnect', 'changing Host ADB connections'],
  ['pair', 'pairing a Host ADB connection'],
  ['tcpip', 'switching the shared device transport to TCP/IP'],
  ['usb', 'switching the shared device transport to USB'],
  ['root', 'restarting shared adbd as root'],
  ['unroot', 'restarting shared adbd with different privileges'],
  ['remount', 'remounting shared device partitions'],
  ['disable-verity', 'changing shared device verity'],
  ['enable-verity', 'changing shared device verity'],
  ['emu', 'sending a Host-owned emulator console command'],
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
  ['reboot', 'rebooting the device']
])

/** Top-level adb verbs that only observe. */
const SAFE_VERBS = new Set([
  'get-state',
  'features'
])

/** `adb shell <cmd>` programs that only report. */
const SAFE_SHELL_COMMANDS = new Set([
  'df',
  'id',
  'whoami',
  'uptime',
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
  ['dd', 'reading arbitrary protected device bytes with `dd`'],
  ['dumpsys', 'dumping cross-app Android service state through raw ADB'],
  ['echo', 'expanding arbitrary remote-shell data with `echo`'],
  ['logcat', 'reading the shared device log through raw ADB'],
  ['pidof', 'querying arbitrary app process state through raw ADB'],
  ['ps', 'listing cross-app processes through raw ADB'],
  ['printf', 'expanding arbitrary remote-shell data with `printf`'],
  ['screencap', 'streaming binary screenshots through raw ADB'],
  ['top', 'listing cross-app process activity through raw ADB'],
  ['uiautomator', 'reading or driving arbitrary UI hierarchy through raw ADB'],
  ['bmgr', 'reading or driving cross-app backup state through raw ADB']
])

/** `adb shell <cmd>` programs that always change something. */
const INTERFERING_SHELL_COMMANDS = new Map<string, string>([
  ['am', 'driving activities with `am`'],
  ['input', 'injecting input events'],
  ['monkey', 'running monkey'],
  ['svc', 'changing device services'],
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
  ['locksettings', 'changing lock settings']
])

/** App-discovery reads belong to tracked high-level operations, never raw ADB. */
const PM_APP_READ_SUBCOMMANDS = new Set([
  'dump',
  'get-install-location',
  'has-feature',
  'list',
  'path',
  'query-activities',
  'query-receivers',
  'query-services',
  'resolve-activity'
])

const PM_MUTATING_SUBCOMMANDS = new Set([
  'clear', 'default-state', 'disable', 'disable-until-used', 'disable-user', 'enable',
  'grant', 'hide', 'reset-permissions', 'revoke', 'set-install-location', 'suspend',
  'trim-caches', 'unhide', 'unsuspend'
])
const AM_MUTATING_SUBCOMMANDS = new Set([
  'broadcast', 'clear-debug-app', 'force-stop', 'hang', 'idle-maintenance', 'instrument',
  'kill', 'kill-all', 'profile', 'restart', 'screen-compat', 'set-debug-app', 'set-watch-heap',
  'start', 'start-activity', 'start-foreground-service', 'startservice', 'stopservice'
])
const SETTINGS_MUTATING_SUBCOMMANDS = new Set(['put', 'delete', 'reset'])
const CONTENT_MUTATING_SUBCOMMANDS = new Set(['insert', 'update', 'delete'])
const IME_MUTATING_SUBCOMMANDS = new Set(['set', 'enable', 'disable', 'reset'])
const DEVICE_CONFIG_MUTATING_SUBCOMMANDS = new Set(['put', 'delete', 'reset'])
const APPOPS_MUTATING_SUBCOMMANDS = new Set(['set', 'reset'])

/** A caller-supplied selector could override the serial inserted by the Host. */
const TARGETING_GLOBAL_FLAGS = new Set(['-s', '-t', '-d', '-e', '-a', '-H', '-P', '-L', '--one-device'])

/** Shell expansion/chaining tokens are never accepted from raw argv. */
const SHELL_META = /[;&|<>$`*?[\]{}~]|[\r\n]/

function classifyWm(words: string[]): AdbClassification {
  const subcommand = words[1]
  // With no value these two forms only report the current override. `reset`,
  // `WxH`, and a numeric density all mutate the shared display.
  if ((subcommand === 'size' || subcommand === 'density') && words.length === 2) {
    return { interfering: false, reason: `\`wm ${subcommand}\`` }
  }
  return {
    interfering: true,
    forbidden: true,
    reason: `running the unapproved or cross-app \`wm${subcommand ? ` ${subcommand}` : ''}\` operation`
  }
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

function classifyMutatingSubcommand(
  program: string,
  words: string[],
  allowed: ReadonlySet<string>
): AdbClassification {
  const subcommand = words[1]
  if (subcommand && allowed.has(subcommand)) {
    return { interfering: true, reason: `\`${program} ${subcommand}\`` }
  }
  return {
    interfering: true,
    forbidden: true,
    reason: subcommand
      ? `running the unapproved or read-capable \`${program} ${subcommand}\` operation`
      : `running \`${program}\` without an approved mutating subcommand`
  }
}

function classifyShell(words: string[]): AdbClassification {
  const flagless = words.filter((word) => !word.startsWith('-'))
  const program = flagless[0]
  if (!program) {
    return { interfering: true, forbidden: true, reason: 'running an interactive device shell' }
  }

  if (words.some((word) => SHELL_META.test(word))) {
    return { interfering: true, forbidden: true, reason: 'using shell expansion or compound device commands' }
  }

  const forbidden = FORBIDDEN_SHELL_COMMANDS.get(program)
  if (forbidden) return { interfering: true, forbidden: true, reason: forbidden }

  if (program === 'am') return classifyMutatingSubcommand(program, words, AM_MUTATING_SUBCOMMANDS)
  if (program === 'settings') return classifyMutatingSubcommand(program, words, SETTINGS_MUTATING_SUBCOMMANDS)
  if (program === 'content') return classifyMutatingSubcommand(program, words, CONTENT_MUTATING_SUBCOMMANDS)
  if (program === 'ime') return classifyMutatingSubcommand(program, words, IME_MUTATING_SUBCOMMANDS)
  if (program === 'device_config') return classifyMutatingSubcommand(program, words, DEVICE_CONFIG_MUTATING_SUBCOMMANDS)

  const interfering = INTERFERING_SHELL_COMMANDS.get(program)
  if (interfering) return { interfering: true, reason: interfering }

  if (program === 'getprop') return classifyGetprop(words)
  if (program === 'wm') return classifyWm(words)
  if (program === 'screenrecord') {
    return { interfering: true, forbidden: true, reason: 'streaming the shared screen through raw ADB' }
  }
  if (program === 'date') {
    return words.length === 1
      ? { interfering: false, reason: '`date`' }
      : { interfering: true, forbidden: true, reason: 'changing or invoking an unapproved `date` operation' }
  }

  if (program === 'pm' || program === 'cmd' || program === 'appops') {
    const trailing = flagless.slice(1)
    const readSub = trailing.find((word) => PM_APP_READ_SUBCOMMANDS.has(word))
    if (program === 'pm' && readSub) {
      return { interfering: true, forbidden: true, reason: `reading arbitrary app state with \`pm ${readSub}\`` }
    }
    if (program === 'pm') {
      return classifyMutatingSubcommand(program, words, PM_MUTATING_SUBCOMMANDS)
    }
    if (program === 'cmd') {
      return { interfering: true, forbidden: true, reason: 'reading or driving Android services through raw `cmd`' }
    }
    return classifyMutatingSubcommand(program, words, APPOPS_MUTATING_SUBCOMMANDS)
  }

  if (SAFE_SHELL_COMMANDS.has(program)) {
    return words.length === 1
      ? { interfering: false, reason: `\`${program}\`` }
      : { interfering: true, forbidden: true, reason: `passing unapproved arguments to \`${program}\`` }
  }
  return {
    interfering: true,
    forbidden: true,
    reason: `the unrecognised device command \`${program}\``
  }
}

export function classifyAdbCommand(argv: string[]): AdbClassification {
  const rest = argv.filter((arg) => arg.length > 0)
  const leading = rest[0]
  if (
    leading &&
    (TARGETING_GLOBAL_FLAGS.has(leading) || leading.startsWith('--one-device=') || /^-[stHPL].+/.test(leading))
  ) {
    return {
      interfering: true,
      forbidden: true,
      reason: 'overriding the Host-selected ADB transport or server'
    }
  }
  const verb = rest[0]
  if (!verb) return { interfering: true, reason: 'an empty adb command' }

  const forbidden = FORBIDDEN_VERBS.get(verb)
  if (forbidden) return { interfering: true, forbidden: true, reason: forbidden }

  const interfering = INTERFERING_VERBS.get(verb)
  if (interfering) return { interfering: true, reason: interfering }

  if (verb === 'exec-out') {
    return {
      interfering: true,
      forbidden: true,
      reason: 'streaming unbounded or binary device output through raw `exec-out`'
    }
  }
  if (verb === 'shell') return classifyShell(rest.slice(1))

  if (verb === 'logcat') {
    return { interfering: true, forbidden: true, reason: 'reading the shared device log through raw ADB' }
  }
  if (verb === 'jdwp') {
    return { interfering: true, forbidden: true, reason: 'listing cross-app debuggable processes through raw ADB' }
  }
  if (SAFE_VERBS.has(verb)) {
    return rest.length === 1
      ? { interfering: false, reason: `\`adb ${verb}\`` }
      : { interfering: true, forbidden: true, reason: `passing unapproved arguments to \`adb ${verb}\`` }
  }
  return {
    interfering: true,
    forbidden: true,
    reason: `the unrecognised Host ADB command \`${verb}\``
  }
}
