/**
 * Which ADB operations may run without owning the phone.
 *
 * The split is not "read vs write" in the file sense — it is "would another
 * project notice". Reading `getprop` off a phone somebody else is testing is
 * harmless; installing an APK, clearing data, sending a key event or launching
 * an activity all reach into the run somebody else is watching. Anything this
 * classifier is not sure about is treated as interfering, so a command DevHotel
 * has never seen fails closed rather than colliding silently.
 */

export interface AdbClassification {
  interfering: boolean
  /** Human phrase naming the operation, used verbatim in refusal messages. */
  reason: string
}

/** Top-level adb verbs that always change the device or its app state. */
const INTERFERING_VERBS = new Map<string, string>([
  ['install', 'installing an APK'],
  ['install-multiple', 'installing APKs'],
  ['install-multi-package', 'installing APKs'],
  ['uninstall', 'uninstalling an app'],
  ['push', 'pushing a file to the device'],
  ['sync', 'syncing files to the device'],
  ['reboot', 'rebooting the device'],
  ['root', 'restarting adbd as root'],
  ['unroot', 'restarting adbd'],
  ['remount', 'remounting device partitions'],
  ['disable-verity', 'changing device verity'],
  ['enable-verity', 'changing device verity'],
  ['restore', 'restoring a device backup'],
  ['emu', 'sending an emulator console command'],
  ['forward', 'claiming a device port forward'],
  ['reverse', 'claiming a device reverse forward'],
  ['tcpip', 'switching the device transport'],
  ['usb', 'switching the device transport'],
  ['connect', 'changing device connections'],
  ['disconnect', 'changing device connections'],
  ['kill-server', 'stopping the shared adb server'],
  ['pair', 'pairing the device']
])

/** Top-level adb verbs that only observe. */
const SAFE_VERBS = new Set([
  'devices',
  'get-state',
  'get-serialno',
  'get-devpath',
  'version',
  'features',
  'start-server',
  'bugreport',
  'jdwp'
])

/** `adb shell <cmd>` programs that only report. */
const SAFE_SHELL_COMMANDS = new Set([
  'getprop',
  'cat',
  'ls',
  'df',
  'ps',
  'id',
  'whoami',
  'uptime',
  'date',
  'echo',
  'printf',
  'wm',
  'dumpsys',
  'screencap',
  'screenrecord',
  'logcat',
  'top',
  'free',
  'stat',
  'md5sum',
  'sha256sum'
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
  ['dd', 'writing to device storage'],
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
const SHELL_CHAINING = /[;&|]|\$\(|`|\n/

function classifyShell(words: string[]): AdbClassification {
  const flagless = words.filter((word) => !word.startsWith('-'))
  const program = flagless[0]
  if (!program) return { interfering: true, reason: 'running an interactive device shell' }

  if (words.some((word) => SHELL_CHAINING.test(word))) {
    return { interfering: true, reason: 'running a compound device shell command' }
  }

  const interfering = INTERFERING_SHELL_COMMANDS.get(program)
  if (interfering) return { interfering: true, reason: interfering }

  if (program === 'pm' || program === 'cmd' || program === 'appops') {
    const sub = flagless[1]
    if (program === 'pm' && sub && SAFE_PM_SUBCOMMANDS.has(sub)) return { interfering: false, reason: `\`pm ${sub}\`` }
    if (program === 'cmd' && sub === 'package' && flagless[2] && SAFE_PM_SUBCOMMANDS.has(flagless[2])) {
      return { interfering: false, reason: `\`cmd package ${flagless[2]}\`` }
    }
    return { interfering: true, reason: `\`${program}${sub ? ` ${sub}` : ''}\`` }
  }

  if (SAFE_SHELL_COMMANDS.has(program)) return { interfering: false, reason: `\`${program}\`` }
  return { interfering: true, reason: `the unrecognised device command \`${program}\`` }
}

export function classifyAdbCommand(argv: string[]): AdbClassification {
  const rest = stripGlobalFlags(argv.filter((arg) => arg.length > 0))
  const verb = rest[0]
  if (!verb) return { interfering: true, reason: 'an empty adb command' }

  const interfering = INTERFERING_VERBS.get(verb)
  if (interfering) return { interfering: true, reason: interfering }

  if (verb === 'shell' || verb === 'exec-out') return classifyShell(rest.slice(1))

  if (verb === 'pull') return { interfering: false, reason: '`adb pull`' }
  if (verb === 'logcat') {
    // `logcat -c` wipes the buffer another project is reading from.
    return rest.includes('-c') || rest.includes('--clear')
      ? { interfering: true, reason: 'clearing the shared logcat buffer' }
      : { interfering: false, reason: '`adb logcat`' }
  }
  if (SAFE_VERBS.has(verb)) return { interfering: false, reason: `\`adb ${verb}\`` }
  return { interfering: true, reason: `the unrecognised adb command \`${verb}\`` }
}
