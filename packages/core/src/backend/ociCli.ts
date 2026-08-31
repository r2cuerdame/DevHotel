import { createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { ANDROID_IMAGE } from '../providers/androidProvider'
import { isSafeWorkspacePath, type WorkspaceSnapshot, type WorkspaceSnapshotEntry } from '../workspaceDrift'
import { getPinnedDockerRuntime, runDocker, spawnDockerProcess } from './cli'
import {
  ANCHOR_IMAGE,
  EMULATOR_AVD_OVERRIDE_PATH,
  EMULATOR_IMAGE,
  RELAY_PORT,
  anchorName,
  androidControlNetworkName,
  androidRuntimeAnchorName,
  buildAndroidControlNetworkCreateArgs,
  buildAndroidRuntimeAnchorArgs,
  buildAnchorArgs,
  buildEmulatorArgs,
  buildOneShotArgs,
  buildRoomNetworkCreateArgs,
  buildServiceArgs,
  buildWebCreateArgs,
  cacheVolume,
  depsVolume,
  emulatorAvdOverride,
  emulatorImage,
  emulatorName,
  emulatorScreen,
  effectiveDepsVolume,
  imageFor,
  isJobName,
  jobName,
  parsePortOutput,
  roomNetworkName,
  srcVolume,
  svcImage,
  svcName,
  svcVolume,
  webName,
  workspaceSnapshotVolume,
} from './naming'
import type { AnchorSpec, ExecOpts, ExecOutputChunk, ExecResult, ExportedArtifact, IsolationBackend, ManagedNetwork, WebSpec } from './types'

const CLONE_IMAGE = 'alpine/git'
const DU_IMAGE = 'alpine'
const LONG_TIMEOUT_MS = 600_000
// Keep the controlled helper's hard screen bound local until the screenshot
// artifact package lands; the published artifact contract uses the same 16 MiB cap.
const SCREENSHOT_ARTIFACT_MAX_BYTES = 16 * 1024 * 1024
const SCREENSHOT_MAX_BASE64_BYTES = Math.ceil(SCREENSHOT_ARTIFACT_MAX_BYTES / 3) * 4
const SYNC_INCLUDE_FILE = '.devhotel-sync-include'
const GENERATED_SYNC_DIRS = [
  '.git',
  '.gradle',
  '.kotlin',
  '.next',
  '.dart_tool',
  '.cxx',
  '.externalNativeBuild',
  'node_modules',
  'build',
  'dist',
  'out',
  'target',
  'coverage'
] as const

function boundedCommandOutput(maxBytes: number): {
  push(chunk: ExecOutputChunk): Uint8Array | null
  text(): string
  readonly exceeded: boolean
} {
  const chunks: Buffer[] = []
  let bytes = 0
  let exceeded = false
  return {
    push(chunk) {
      if (exceeded) return null
      const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk)
      const remaining = Math.max(0, maxBytes - bytes)
      if (remaining > 0) {
        const captured = data.subarray(0, remaining)
        chunks.push(captured)
        bytes += captured.byteLength
      }
      if (data.byteLength > remaining) exceeded = true
      return remaining > 0 ? data.subarray(0, remaining) : null
    },
    text: () => Buffer.concat(chunks, bytes).toString('utf8'),
    get exceeded() { return exceeded }
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  const error = new Error('Fenced emulator operation was aborted')
  error.name = 'AbortError'
  throw error
}

function containsPrivateStageToken(
  value: unknown,
  tokens: readonly string[],
  seen = new Set<object>()
): boolean {
  if (typeof value === 'string') return tokens.some((token) => token.length > 0 && value.includes(token))
  if (value === null || typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  if (!(value instanceof Error)) return true
  if (tokens.some((token) => token.length > 0 && `${value.name}\n${value.message}\n${value.stack ?? ''}`.includes(token))) {
    return true
  }
  if ('cause' in value && containsPrivateStageToken(value.cause, tokens, seen)) return true
  if (value instanceof AggregateError) {
    return Array.from(value.errors).some((error) => containsPrivateStageToken(error, tokens, seen))
  }
  return false
}

const FENCED_EMULATOR_ADB_SCRIPT = `set -eu
state=$1
stdout_limit=$2
stderr_limit=$3
command_timeout=$4
shift 4
socket_path=$state/server.sock
socket=localfilesystem:$socket_path
adb=/opt/android-sdk/platform-tools/adb
rm -rf -- "$state"
mkdir -m 700 -p "$state/home" "$state/tmp"
run_adb() {
  env -i \
    HOME="$state/home" \
    TMPDIR="$state/tmp" \
    PATH=/opt/android-sdk/platform-tools:/usr/bin:/bin \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    ADB_SERVER_SOCKET="$socket" \
    "$adb" -L "$socket" "$@"
}
cleanup() {
  if [ -n "\${stdout_reader:-}" ]; then kill "$stdout_reader" >/dev/null 2>&1 || true; fi
  if [ -n "\${stderr_reader:-}" ]; then kill "$stderr_reader" >/dev/null 2>&1 || true; fi
  if [ -n "\${stdout_reader:-}" ]; then wait "$stdout_reader" >/dev/null 2>&1 || true; fi
  if [ -n "\${stderr_reader:-}" ]; then wait "$stderr_reader" >/dev/null 2>&1 || true; fi
  run_adb kill-server >/dev/null 2>&1 || true
  rm -rf -- "$state"
}
trap cleanup EXIT HUP INT TERM
[ ! -e "$socket_path" ] && [ ! -L "$socket_path" ] || exit 70
run_adb start-server >/dev/null 2>&1
[ -S "$socket_path" ] || exit 71
[ "$(stat -c %u "$socket_path")" = "$(id -u)" ] || exit 72
ready=0
i=0
while [ "$i" -lt 20 ]; do
  if [ "$(run_adb -s emulator-5554 get-state 2>/dev/null || true)" = device ]; then ready=1; break; fi
  i=$((i + 1))
  sleep 0.25
done
[ "$ready" -eq 1 ] || exit 73
stdout_pipe=$state/stdout.pipe
stderr_pipe=$state/stderr.pipe
mkfifo -m 600 "$stdout_pipe" "$stderr_pipe"
head -c "$((stdout_limit + 1))" < "$stdout_pipe" &
stdout_reader=$!
head -c "$((stderr_limit + 1))" < "$stderr_pipe" >&2 &
stderr_reader=$!
set +e
timeout -k 1 "$command_timeout" env -i \
  HOME="$state/home" \
  TMPDIR="$state/tmp" \
  PATH=/opt/android-sdk/platform-tools:/usr/bin:/bin \
  ANDROID_SDK_ROOT=/opt/android-sdk \
  ADB_SERVER_SOCKET="$socket" \
  "$adb" -L "$socket" -s emulator-5554 "$@" > "$stdout_pipe" 2> "$stderr_pipe"
status=$?
wait "$stdout_reader"
stdout_reader=
wait "$stderr_reader"
stderr_reader=
set -e
exit "$status"`

function appendSyncIncludePathsScript(output: string, entries: 'files' | 'all'): string {
  const findFilter = entries === 'files' ? "\\( -type f -o -type l \\) " : ''
  return [
    `include_file=${SYNC_INCLUDE_FILE}`,
    'if [ -f "$include_file" ]; then',
    '  while IFS= read -r include || [ -n "$include" ]; do',
    "    include=$(printf '%s' \"$include\" | tr -d '\\r')",
    "    case \"$include\" in ''|'#'*) continue ;; esac",
    '    case "$include" in /*|-*|*\\\\*|*:*|*\\**|*\\?*|*\\[*|*\\]*) echo "invalid .devhotel-sync-include path: $include" >&2; exit 2 ;; esac',
    '    include=${include%/}',
    '    case "/$include/" in */../*|*/./*|*//*) echo "invalid .devhotel-sync-include path: $include" >&2; exit 2 ;; esac',
    '    include_dir=${include%/*}',
    '    if [ "$include_dir" = "$include" ]; then include_dir=.; fi',
    '    include_probe=$include_dir',
    '    while [ ! -e "$include_probe" ] && [ ! -L "$include_probe" ]; do',
    '      include_parent=${include_probe%/*}',
    '      if [ "$include_parent" = "$include_probe" ]; then include_parent=.; fi',
    '      include_probe=$include_parent',
    '    done',
    '    include_root=$(realpath "$include_probe" 2>/dev/null) || include_root=',
    '    case "${include_root:-x}" in',
    '      /workspace|/workspace/*) ;;',
    '      *) echo "invalid .devhotel-sync-include path leaves the Room workspace: $include" >&2; exit 2 ;;',
    '    esac',
    '    if [ ! -e "$include" ] && [ ! -L "$include" ]; then continue; fi',
    '    if [ -L "$include" ] || [ -f "$include" ]; then',
    `      printf './%s\\0' "$include" >> "${output}"`,
    '    elif [ -d "$include" ]; then',
    '      include_root=$(realpath "$include" 2>/dev/null) || include_root=',
    '      case "${include_root:-x}" in',
    '        /workspace|/workspace/*) ;;',
    '        *) echo "invalid .devhotel-sync-include directory leaves the Room workspace: $include" >&2; exit 2 ;;',
    '      esac',
    `      find "./$include" ${findFilter}-print0 >> "${output}"`,
    '    fi',
    '  done < "$include_file"',
    'fi'
  ].join('\n')
}

export function importHostFolderScript(): string {
  const excludes = GENERATED_SYNC_DIRS
    .filter((name) => name !== '.git')
    .flatMap((name) => [`--exclude='./${name}'`, `--exclude='*/${name}'`])
    .concat(["--exclude='*.apk'", "--exclude='*.aab'"])
    .join(' ')
  return [
    'set -eu',
    `tar -C /source ${excludes} -cf - . | tar -C /workspace -xf -`,
    'cd /source',
    `include_file=${SYNC_INCLUDE_FILE}`,
    '[ -f "$include_file" ] || exit 0',
    'while IFS= read -r include || [ -n "$include" ]; do',
    "  include=$(printf '%s' \"$include\" | tr -d '\\r')",
    "  case \"$include\" in ''|'#'*) continue ;; esac",
    '  case "$include" in /*|-*|*\\\\*|*:*|*\\**|*\\?*|*\\[*|*\\]*) echo "invalid .devhotel-sync-include path: $include" >&2; exit 2 ;; esac',
    '  include=${include%/}',
    '  case "/$include/" in */../*|*/./*|*//*) echo "invalid .devhotel-sync-include path: $include" >&2; exit 2 ;; esac',
    // The lexical checks above cannot see where a path actually lands: tar
    // resolves intermediate components through symlinks, so an include entry
    // under a symlinked directory would dereference files outside the folder
    // the human linked and copy their contents into the Room. Canonicalise the
    // parent and require it to stay under /source. The final component is left
    // alone on purpose — tar stores it as a symlink, exactly like the base
    // import, so an opted-in link keeps pointing nowhere inside the Room.
    '  include_dir=${include%/*}',
    '  if [ "$include_dir" = "$include" ]; then include_dir=.; fi',
    '  include_probe=$include_dir',
    '  while [ ! -e "$include_probe" ] && [ ! -L "$include_probe" ]; do',
    '    include_parent=${include_probe%/*}',
    '    if [ "$include_parent" = "$include_probe" ]; then include_parent=.; fi',
    '    include_probe=$include_parent',
    '  done',
    '  include_root=$(realpath "$include_probe" 2>/dev/null) || include_root=',
    '  case "${include_root:-x}" in',
    '    /source|/source/*) ;;',
    '    *) echo "invalid .devhotel-sync-include path leaves the linked folder: $include" >&2; exit 2 ;;',
    '  esac',
    '  if [ ! -e "$include" ] && [ ! -L "$include" ]; then continue; fi',
    '  if [ -e "$include" ] || [ -L "$include" ]; then tar -C /source -cf - "$include" | tar -C /workspace -xf -; fi',
    'done < "$include_file"'
  ].join('\n')
}

export function workspaceSnapshotScript(): string {
  const generatedPrunes = GENERATED_SYNC_DIRS.map((name) => `-name '${name}'`).join(' -o ')
  return [
    'set -eu',
    'cd /workspace',
    'sync_paths=$(mktemp)',
    'sync_sorted=$(mktemp)',
    'sync_records=$(mktemp)',
    `find . -mindepth 1 \\( ${generatedPrunes} \\) -prune -o \\( -type f -o -type l \\) ! -name '*.apk' ! -name '*.aab' -print0 > "$sync_paths"`,
    appendSyncIncludePathsScript('$sync_paths', 'files'),
    'sort -zu "$sync_paths" > "$sync_sorted"',
    "while IFS= read -r -d '' raw_path; do",
    '  path=${raw_path#./}',
    "  metadata=$(stat -c '%f:%u:%g' \"$raw_path\")",
    '  if [ -L "$raw_path" ]; then kind=L; content_hash=$(readlink -n "$raw_path" | sha256sum); else kind=F; content_hash=$(sha256sum "$raw_path"); fi',
    '  content_hash=${content_hash%% *}',
    "  path_b64=$(printf '%s' \"$path\" | base64 | tr -d '\\n')",
    "  printf '%s\\t%s\\t%s\\t%s\\n' \"$kind\" \"$metadata\" \"$path_b64\" \"$content_hash\" >> \"$sync_records\"",
    'done < "$sync_sorted"',
    'fingerprint=$(sha256sum "$sync_records")',
    'fingerprint=${fingerprint%% *}',
    "printf 'fingerprint\\t%s\\n' \"$fingerprint\"",
    'cat "$sync_records"'
  ].join('\n')
}

/**
 * Identity used to guard staged workspace publication and Undo. Generated
 * trees are disposable, but Git refs, HEAD, and the index are not: publishing
 * a copied generation after any of those change would silently roll back
 * repository state. Git objects alone are pruned because they can be large and
 * refs/index carry the control-plane change that makes an object reachable.
 */
export function workspaceTransactionalFingerprintScript(): string {
  const generatedPrunes = GENERATED_SYNC_DIRS
    .filter((name) => name !== '.git')
    .map((name) => `-name '${name}'`)
    .join(' -o ')
  return [
    'set -eu',
    'transaction_paths=$(mktemp)',
    'transaction_sorted=$(mktemp)',
    'transaction_records=$(mktemp)',
    'cd /workspace',
    `find . -mindepth 1 \\( -type d \\( ${generatedPrunes} -o -path '*/.git/objects' \\) \\) -prune -o -print0 > "$transaction_paths"`,
    appendSyncIncludePathsScript('$transaction_paths', 'all'),
    'sort -zu "$transaction_paths" > "$transaction_sorted"',
    "while IFS= read -r -d '' path; do",
    "  path_hash=$(printf '%s' \"$path\" | sha256sum)",
    '  path_hash=${path_hash%% *}',
    "  metadata=$(stat -c '%f:%u:%g' \"$path\")",
    '  if [ -L "$path" ]; then',
    '    kind=L',
    '    content_hash=$(readlink -n "$path" | sha256sum)',
    '    content_hash=${content_hash%% *}',
    '  elif [ -f "$path" ]; then',
    '    kind=F',
    '    content_hash=$(sha256sum "$path")',
    '    content_hash=${content_hash%% *}',
    '  elif [ -d "$path" ]; then',
    '    kind=D',
    '    content_hash=-',
    '  else',
    '    echo "unsupported workspace object: $path" >&2',
    '    exit 2',
    '  fi',
    "  printf '%s %s %s %s\\n' \"$kind\" \"$metadata\" \"$path_hash\" \"$content_hash\" >> \"$transaction_records\"",
    'done < "$transaction_sorted"',
    'sha256sum "$transaction_records"'
  ].join('\n')
}

/**
 * Matched by class+type because at map time the qemu windows are still titled
 * plain "Emulator" — a title glob can never match there. The toolbar must not
 * be iconified: qemu groups its windows, and openbox would iconify the whole
 * group. decor applies reliably at map; geometry does not (qemu re-places
 * itself), so FIT_EMULATOR_PY below enforces the full-screen size and the
 * force-center rule snaps the frame back to 0,0 on that resize.
 */
function openboxFramelessRc(width: number, height: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
  <applications>
    <application class="Emulator" type="normal">
      <decor>no</decor>
      <position force="yes"><x>center</x><y>center</y></position>
      <size><width>${width}</width><height>${height}</height></size>
    </application>
    <application class="Emulator" type="utility">
      <decor>no</decor>
      <layer>below</layer>
      <position force="yes"><x>${width + 20}</x><y>0</y></position>
    </application>
  </applications>
</openbox_config>
`
}

/**
 * Runs in addition to the image's own autostart (openbox executes the system
 * one too, which paints the docker-android wallpaper) — so the fit daemon also
 * paints the root window black rather than relying on this file to replace it.
 */
const OPENBOX_AUTOSTART = `# DevHotel: keep the emulator phone window filling the screen on a black desk
python3 "$HOME/.config/openbox/fit-emulator.py" >/dev/null 2>&1 &
`

/**
 * The qemu window ignores WM size hints and per-app geometry at map time and
 * the emulator's -scale flag is obsolete, so this tiny libX11 client (python3
 * and libX11 ship in the image) forces the "Android Emulator*" window to the
 * full X screen; Qt then rescales the device content edge to edge.
 */
function fitEmulatorPy(width: number, height: number): string {
  return `import ctypes
import time

W, H = ${width}, ${height}

x11 = ctypes.CDLL("libX11.so.6")
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XDefaultRootWindow.restype = ctypes.c_ulong
x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x11.XQueryTree.argtypes = [
    ctypes.c_void_p, ctypes.c_ulong,
    ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong),
    ctypes.POINTER(ctypes.POINTER(ctypes.c_ulong)), ctypes.POINTER(ctypes.c_uint),
]
x11.XFetchName.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_char_p)]
x11.XFree.argtypes = [ctypes.c_void_p]
x11.XMoveResizeWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong] + [ctypes.c_int] * 2 + [ctypes.c_uint] * 2
x11.XRaiseWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XUnmapWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XSetWindowBackground.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong]
x11.XClearWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]


class XWindowAttributes(ctypes.Structure):
    _fields_ = [
        ("x", ctypes.c_int), ("y", ctypes.c_int),
        ("width", ctypes.c_int), ("height", ctypes.c_int),
        ("border_width", ctypes.c_int), ("depth", ctypes.c_int),
        ("visual", ctypes.c_void_p), ("root", ctypes.c_ulong),
        ("class_", ctypes.c_int), ("bit_gravity", ctypes.c_int),
        ("win_gravity", ctypes.c_int), ("backing_store", ctypes.c_int),
        ("backing_planes", ctypes.c_ulong), ("backing_pixel", ctypes.c_ulong),
        ("save_under", ctypes.c_int), ("colormap", ctypes.c_ulong),
        ("map_installed", ctypes.c_int), ("map_state", ctypes.c_int),
        ("all_event_masks", ctypes.c_long), ("your_event_mask", ctypes.c_long),
        ("do_not_propagate_mask", ctypes.c_long),
        ("override_redirect", ctypes.c_int), ("screen", ctypes.c_void_p),
    ]


x11.XGetWindowAttributes.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(XWindowAttributes)]


def children_of(dpy, window):
    root_ret = ctypes.c_ulong()
    parent_ret = ctypes.c_ulong()
    kids = ctypes.POINTER(ctypes.c_ulong)()
    count = ctypes.c_uint()
    if not x11.XQueryTree(dpy, window, ctypes.byref(root_ret), ctypes.byref(parent_ret), ctypes.byref(kids), ctypes.byref(count)):
        return []
    result = [kids[i] for i in range(count.value)]
    if kids:
        x11.XFree(kids)
    return result


def window_name(dpy, window):
    name = ctypes.c_char_p()
    if x11.XFetchName(dpy, window, ctypes.byref(name)) and name.value:
        value = name.value.decode(errors="replace")
        x11.XFree(name)
        return value
    return ""


def scan_windows(dpy, root):
    # openbox reparents clients one level under root frames
    phone = 0
    strays = []
    for frame in children_of(dpy, root):
        for win in [frame] + children_of(dpy, frame):
            name = window_name(dpy, win)
            if name.startswith("Android Emulator"):
                phone = phone or win
            elif name == "Emulator":
                strays.append(win)
    return phone, strays


IS_VIEWABLE = 2


def main():
    dpy = None
    while dpy is None:
        dpy = x11.XOpenDisplay(b":0")
        if dpy is None:
            time.sleep(2)
    root = x11.XDefaultRootWindow(dpy)
    while True:
        try:
            # the image paints a wallpaper on the root window; any letterboxing
            # around the phone should read as black, not as a docker logo
            x11.XSetWindowBackground(dpy, root, 0)
            x11.XClearWindow(dpy, root)
            phone, strays = scan_windows(dpy, root)
            if phone:
                attrs = XWindowAttributes()
                if x11.XGetWindowAttributes(dpy, phone, ctypes.byref(attrs)):
                    if attrs.width != W or attrs.height != H:
                        x11.XMoveResizeWindow(dpy, phone, 0, 0, W, H)
                        x11.XRaiseWindow(dpy, phone)
                        x11.XSync(dpy, 0)
            # qemu floats a small collapsed-toolbar button window ("Emulator",
            # ~300x30) over the phone; hide it and any similar stray chrome
            for stray in strays:
                attrs = XWindowAttributes()
                if not x11.XGetWindowAttributes(dpy, stray, ctypes.byref(attrs)):
                    continue
                if attrs.map_state == IS_VIEWABLE and 60 <= attrs.width <= 520 and attrs.height <= 80:
                    x11.XUnmapWindow(dpy, stray)
                    x11.XSync(dpy, 0)
        except Exception:
            pass
        time.sleep(3)


if __name__ == "__main__":
    main()
`
}

function must(result: ExecResult, what: string): ExecResult {
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim()
    throw new Error(`${what} failed (exit ${result.code}): ${detail}`)
  }
  return result
}

function isPathInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith(`..\\`) && !rel.startsWith('../') && !rel.includes(':')
}

function filesBelow(root: string): string[] {
  const files: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new Error(`artifact export contains a symbolic link or reparse point: ${entry.name}`)
      const canonical = realpathSync.native(path)
      if (!isPathInside(root, canonical)) throw new Error(`artifact export escaped its Hotel directory: ${entry.name}`)
      if (stat.isDirectory()) visit(path)
      else if (stat.isFile()) files.push(path)
      else throw new Error(`artifact export contains an unsupported filesystem object: ${entry.name}`)
    }
  }
  visit(root)
  return files
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolveHash(hash.digest('hex')))
  })
}

interface DockerVersionJson {
  Client?: { Version?: string } | null
  Server?: { Version?: string } | null
}

export interface OciCliBackendOptions {
  /** Durable engine-identity pin. Destructive operations refuse endpoint drift. */
  identityFile?: string
  /** Durable, non-destructive adoption record for pre-label Room volumes. */
  legacyVolumeAdoptionFile?: string
  /** Must confirm both the DB Room record and its on-disk Room manifest. */
  canAdoptLegacyVolume?: (roomId: string, name: string) => boolean
  /** Test seam; production uses a fresh 256-bit random token per anchor. */
  relayTokenFactory?: () => string
}

export class OciCliBackend implements IsolationBackend {
  private readonly identityFile: string | undefined
  private readonly legacyVolumeAdoptionFile: string | undefined
  private readonly canAdoptLegacyVolume: ((roomId: string, name: string) => boolean) | undefined
  private expectedEngineIdentity: EngineIdentity | null | undefined
  private legacyVolumeAdoptions: LegacyVolumeAdoptionRegistry | undefined
  private readonly relayTokenFactory: () => string
  private readonly relayTokens = new Map<string, string>()

  constructor(opts: OciCliBackendOptions = {}) {
    this.identityFile = opts.identityFile
    this.legacyVolumeAdoptionFile = opts.legacyVolumeAdoptionFile
    this.canAdoptLegacyVolume = opts.canAdoptLegacyVolume
    this.relayTokenFactory = opts.relayTokenFactory ?? (() => randomBytes(32).toString('hex'))
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    let result: ExecResult
    try {
      result = await runDocker(['version', '--format', 'json'], { timeoutMs: 15_000 })
    } catch (err) {
      return { ok: false, detail: `docker CLI not available: ${(err as Error).message}` }
    }
    let parsed: DockerVersionJson | null = null
    try {
      parsed = JSON.parse(result.stdout) as DockerVersionJson
    } catch {
      parsed = null
    }
    if (parsed?.Client?.Version && parsed?.Server?.Version) {
      try {
        await this.assertPinnedEngineIdentity()
      } catch (err) {
        return { ok: false, detail: (err as Error).message }
      }
      return { ok: true, detail: `client ${parsed.Client.Version}, server ${parsed.Server.Version}` }
    }
    const detail = result.stderr.trim() || 'docker daemon not reachable'
    return { ok: false, detail }
  }

  async createRoomPod(
    spec: WebSpec,
    opts: { initializeManagedSource?: boolean; startWeb?: boolean } = {}
  ): Promise<{ hostPort: number | null }> {
    await this.assertPinnedEngineIdentity()
    await this.adoptLegacyRoomVolumes(spec.roomId)
    const initializeManagedSource = opts.initializeManagedSource ?? true
    const startWeb = opts.startWeb ?? true
    if (!spec.standalone) await this.ensureImage(ANCHOR_IMAGE)
    await this.ensureImage(imageFor(spec))
    if (spec.workspaceMode === 'hotel') {
      if (initializeManagedSource && spec.sourceType === 'managed-git') await this.ensureImage(CLONE_IMAGE)
      await this.ensureRoomVolume(spec.roomId, srcVolume(spec.roomId, spec.workspaceVolumeRevision))
    }
    if (spec.sourceType !== 'empty' && !spec.noDepsVolume) {
      await this.ensureRoomVolume(spec.roomId, effectiveDepsVolume(spec))
    }
    if (!spec.noCacheVolume) await this.ensureRoomVolume(spec.roomId, cacheVolume(spec.roomId))
    for (const extra of spec.extraVolumes ?? []) {
      await this.ensureRoomVolume(spec.roomId, extra.volume)
    }
    if (spec.sourceType === 'managed-git' && initializeManagedSource) {
      await this.cloneIntoVolume(spec.roomId, spec.sourceRef, spec.workspaceVolumeRevision)
    }
    let relayToken: string | null = null
    try {
      await this.ensureRoomNetwork(spec.roomId)
      if (spec.androidRuntimeIsolation) await this.ensureAndroidControlNetwork(spec.roomId)
      if (!spec.standalone) {
        relayToken = this.newRelayToken()
        must(
          await runDocker(
            buildAnchorArgs(
              { roomId: spec.roomId, internalPort: spec.internalPort },
              createHash('sha256').update(relayToken).digest('hex'),
              spec.androidRuntimeIsolation ? androidControlNetworkName(spec.roomId) : roomNetworkName(spec.roomId)
            )
          ),
          'run anchor container',
        )
      }
      if (spec.androidRuntimeIsolation) await this.ensureAndroidRuntimeAnchor(spec.roomId)
      must(await runDocker(buildWebCreateArgs(spec)), 'create web container')
      if (startWeb) await this.startWeb(spec.roomId)
      const hostPort = spec.standalone ? null : await this.readHostPort(spec.roomId)
      if (relayToken) this.relayTokens.set(spec.roomId, relayToken)
      return { hostPort }
    } catch (error) {
      this.relayTokens.delete(spec.roomId)
      if (!spec.androidRuntimeIsolation) throw error
      try {
        await this.rollbackPartialAndroidTopology(spec.roomId)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Android Room creation and topology rollback both failed')
      }
      throw error
    }
  }

  async relayToken(roomId: string): Promise<string> {
    await this.assertPinnedEngineIdentity()
    const cached = this.relayTokens.get(roomId)
    if (cached) {
      await this.assertRelayAnchorAuthority(roomId)
      return cached
    }
    // The raw capability deliberately never enters a Room container, mount,
    // manifest, or docker-inspectable value. App startup reconciliation
    // recreates anchors before routing them, issuing a fresh in-memory token.
    throw new Error(`Room ${roomId} relay credential is not available; recreate its anchor`)
  }

  async startRoomPod(
    roomId: string,
    opts: { standalone?: boolean; androidRuntimeIsolation?: boolean } = {}
  ): Promise<{ hostPort: number | null }> {
    await this.assertPinnedEngineIdentity()
    if (!opts.standalone) {
      const anchor = await this.assertRoomContainer(roomId, anchorName(roomId), 'anchor')
      if (opts.androidRuntimeIsolation) {
        this.assertContainerNetworkMode(anchor, androidControlNetworkName(roomId), 'Android control anchor')
      }
      must(await runDocker(['start', anchorName(roomId)]), 'start anchor container')
    }
    if (opts.androidRuntimeIsolation) await this.ensureAndroidRuntimeAnchor(roomId)
    await this.startWeb(roomId)
    return { hostPort: opts.standalone ? null : await this.readHostPort(roomId) }
  }

  async startWeb(roomId: string): Promise<void> {
    await this.assertPinnedEngineIdentity()
    await this.assertRoomContainer(roomId, webName(roomId), 'web')
    must(await runDocker(['start', webName(roomId)]), 'start web container')
  }

  async stopRoomPod(roomId: string): Promise<void> {
    await this.assertPinnedEngineIdentity()
    const containers = await this.listRoomContainers(roomId)
    const active = containers.filter((container) => !isStoppedContainerState(container.state))
    const web = active.filter((container) => container.role === 'web').map((container) => container.id)
    const leaves = active
      .filter((container) => !['web', 'anchor', 'android-runtime-anchor'].includes(container.role))
      .map((container) => container.id)
    const runtimeAnchors = active
      .filter((container) => container.role === 'android-runtime-anchor')
      .map((container) => container.id)
    const controlAnchors = active.filter((container) => container.role === 'anchor').map((container) => container.id)
    if (web.length > 0) must(await runDocker(['stop', '-t', '8', ...web]), `stop Room ${roomId} web container`)
    if (leaves.length > 0) must(await runDocker(['stop', '-t', '5', ...leaves]), `stop Room ${roomId} leaf containers`)
    if (runtimeAnchors.length > 0) {
      must(await runDocker(['stop', '-t', '5', ...runtimeAnchors]), `stop Room ${roomId} runtime anchor`)
    }
    if (controlAnchors.length > 0) {
      must(await runDocker(['stop', '-t', '5', ...controlAnchors]), `stop Room ${roomId} control anchor`)
    }
    const notStopped = (await this.listRoomContainers(roomId)).filter(
      (container) => !isStoppedContainerState(container.state)
    )
    if (notStopped.length > 0) {
      throw new Error(`Room ${roomId} stop incomplete: ${notStopped.map((container) => container.name).join(', ')}`)
    }
  }

  async pauseWeb(roomId: string): Promise<void> {
    await this.assertPinnedEngineIdentity()
    await this.assertRoomContainer(roomId, webName(roomId), 'web')
    must(await runDocker(['pause', webName(roomId)]), 'pause web container')
  }

  async unpauseWeb(roomId: string): Promise<void> {
    await this.assertPinnedEngineIdentity()
    await this.assertRoomContainer(roomId, webName(roomId), 'web')
    must(await runDocker(['unpause', webName(roomId)]), 'unpause web container')
  }

  async webPaused(roomId: string): Promise<boolean> {
    await this.assertPinnedEngineIdentity()
    const container = await this.assertRoomContainer(roomId, webName(roomId), 'web')
    return container.State?.Paused === true
  }

  async restartWeb(roomId: string): Promise<void> {
    await this.assertPinnedEngineIdentity()
    await this.assertRoomContainer(roomId, webName(roomId), 'web')
    must(await runDocker(['restart', '-t', '8', webName(roomId)]), 'restart web container')
  }

  async recreateWeb(spec: WebSpec): Promise<void> {
    await this.assertPinnedEngineIdentity()
    await this.ensureImage(imageFor(spec))
    await this.ensureRoomNetwork(spec.roomId)
    if (spec.workspaceMode === 'hotel') {
      await this.ensureRoomVolume(spec.roomId, srcVolume(spec.roomId, spec.workspaceVolumeRevision))
    }
    if (spec.sourceType !== 'empty' && !spec.noDepsVolume) {
      await this.ensureRoomVolume(spec.roomId, effectiveDepsVolume(spec))
    }
    if (!spec.noCacheVolume) await this.ensureRoomVolume(spec.roomId, cacheVolume(spec.roomId))
    for (const extra of spec.extraVolumes ?? []) {
      await this.ensureRoomVolume(spec.roomId, extra.volume)
    }
    if (spec.androidRuntimeIsolation) await this.ensureAndroidRuntimeAnchor(spec.roomId)
    await this.removeRoomContainer(spec.roomId, webName(spec.roomId), 'web')
    must(await runDocker(buildWebCreateArgs(spec)), 'create web container')
    await this.startWeb(spec.roomId)
  }

  async recreateAnchor(spec: AnchorSpec): Promise<{ hostPort: number }> {
    await this.assertPinnedEngineIdentity()
    this.relayTokens.delete(spec.roomId)
    await this.adoptLegacyRoomVolumes(spec.roomId)
    await this.ensureImage(ANCHOR_IMAGE)
    await this.ensureRoomNetwork(spec.roomId)
    if (spec.androidRuntimeIsolation) {
      await this.ensureAndroidControlNetwork(spec.roomId)
      await this.ensureAndroidRuntimeAnchor(spec.roomId)
      await this.removeAndroidControlDependents(spec.roomId)
    }
    await this.removeRoomContainer(spec.roomId, anchorName(spec.roomId), 'anchor')
    const relayToken = this.newRelayToken()
    try {
      must(
        await runDocker(buildAnchorArgs(
          spec,
          createHash('sha256').update(relayToken).digest('hex'),
          spec.androidRuntimeIsolation ? androidControlNetworkName(spec.roomId) : roomNetworkName(spec.roomId)
        )),
        'run anchor container'
      )
      const hostPort = await this.readHostPort(spec.roomId)
      this.relayTokens.set(spec.roomId, relayToken)
      return { hostPort }
    } catch (error) {
      this.relayTokens.delete(spec.roomId)
      try {
        await this.removeRoomContainer(spec.roomId, anchorName(spec.roomId), 'anchor')
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'relay recreation and authority rollback both failed')
      }
      throw error
    }
  }

  async deleteRoomPod(roomId: string, opts: { volumes: boolean }): Promise<{ reclaimedBytes: number }> {
    await this.assertPinnedEngineIdentity()
    let reclaimedBytes = 0
    let ownedVolumes: string[] = []
    if (opts.volumes) {
      // Ownership is a preflight: a legacy/user collision must block before
      // any container or network is removed.
      ownedVolumes = await this.listRoomVolumes(roomId)
      try {
        const sizes = await this.volumeSizes(roomId)
        reclaimedBytes = Object.values(sizes).reduce((a, b) => a + b, 0)
      } catch {
        reclaimedBytes = 0
      }
    }
    const containers = await this.listRoomContainers(roomId)
    const existingNetwork = await this.inspectNetwork(roomNetworkName(roomId))
    if (existingNetwork) assertRoomNetwork(existingNetwork, roomId, roomNetworkName(roomId))
    const existingControlNetwork = await this.inspectNetwork(androidControlNetworkName(roomId))
    if (existingControlNetwork) {
      assertRoomNetwork(existingControlNetwork, roomId, androidControlNetworkName(roomId))
    }
    const controlAnchorIds = containers.filter((container) => container.role === 'anchor').map((container) => container.id)
    const runtimeAnchorIds = containers
      .filter((container) => container.role === 'android-runtime-anchor')
      .map((container) => container.id)
    const leafIds = containers
      .filter((container) => !['anchor', 'android-runtime-anchor'].includes(container.role))
      .map((container) => container.id)
    if (leafIds.length > 0) {
      must(await runDocker(['rm', '-f', ...leafIds]), `remove Room ${roomId} leaf containers`)
    }
    if (runtimeAnchorIds.length > 0) {
      must(await runDocker(['rm', '-f', ...runtimeAnchorIds]), `remove Room ${roomId} runtime anchor`)
    }
    if (controlAnchorIds.length > 0) {
      must(await runDocker(['rm', '-f', ...controlAnchorIds]), `remove Room ${roomId} control anchor`)
    }
    const remainingContainers = await this.listRoomContainers(roomId)
    if (remainingContainers.length > 0) {
      throw new Error(
        `Room ${roomId} container cleanup incomplete: ${remainingContainers.map((container) => container.name).join(', ')}`
      )
    }
    // Networks are persistent Room resources, but never survive Room deletion.
    // Containers must go first so Docker can release the bridge endpoint.
    await this.removeRoomNetwork(roomId)
    await this.removeAndroidControlNetwork(roomId)
    if (opts.volumes) {
      if (ownedVolumes.length > 0) {
        must(await runDocker(['volume', 'rm', '-f', ...ownedVolumes]), `remove Room ${roomId} volumes`)
      }
      const remainingVolumes = await this.listRoomVolumes(roomId)
      if (remainingVolumes.length > 0) {
        throw new Error(`Room ${roomId} volume cleanup incomplete: ${remainingVolumes.join(', ')}`)
      }
    }
    this.relayTokens.delete(roomId)
    return { reclaimedBytes }
  }

  async execInRoom(roomId: string, cmd: string[], opts?: ExecOpts): Promise<ExecResult> {
    await this.assertPinnedEngineIdentity()
    const container = await this.assertRoomContainer(roomId, webName(roomId), 'web')
    return runDocker(['exec', exactContainerId(container, roomId), ...cmd], {
      timeoutMs: opts?.timeoutMs,
      ...(opts?.onStdout ? { onStdout: opts.onStdout } : {}),
      ...(opts?.onStderr ? { onStderr: opts.onStderr } : {})
    })
  }

  async spawnInteractiveExec(roomId: string, cmd: string[]) {
    await this.assertPinnedEngineIdentity()
    const container = await this.assertRoomContainer(roomId, webName(roomId), 'web')
    return spawnDockerProcess(['exec', '-i', exactContainerId(container, roomId), ...cmd])
  }

  async followRoomLogs(roomId: string, tail = 50) {
    await this.assertPinnedEngineIdentity()
    if (!Number.isInteger(tail) || tail < 0 || tail > 10_000) throw new Error('invalid Room log tail count')
    const container = await this.assertRoomContainer(roomId, webName(roomId), 'web')
    return spawnDockerProcess(['logs', '-f', '--tail', String(tail), exactContainerId(container, roomId)])
  }

  async runOneShot(spec: WebSpec, cmd: string, log?: (line: string) => void): Promise<ExecResult> {
    await this.assertPinnedEngineIdentity()
    await this.ensureImage(imageFor(spec), log)
    await this.ensureRoomNetwork(spec.roomId)
    if (spec.workspaceMode === 'hotel') {
      await this.ensureRoomVolume(
        spec.roomId,
        spec.workspaceVolumeOverride ?? srcVolume(spec.roomId, spec.workspaceVolumeRevision)
      )
    }
    if (spec.sourceType !== 'empty' && !spec.noDepsVolume) {
      await this.ensureRoomVolume(spec.roomId, effectiveDepsVolume(spec))
    }
    if (!spec.noCacheVolume) await this.ensureRoomVolume(spec.roomId, cacheVolume(spec.roomId))
    for (const extra of spec.extraVolumes ?? []) {
      await this.ensureRoomVolume(spec.roomId, extra.volume)
    }
    return runDocker(buildOneShotArgs(spec, cmd, randomUUID()), { timeoutMs: LONG_TIMEOUT_MS, onLine: log })
  }

  async exportAndroidArtifacts(
    roomId: string,
    workspaceVolume: string,
    artifactsRoot: string,
    operationId: string
  ): Promise<ExportedArtifact[]> {
    await this.assertPinnedEngineIdentity()
    const expectedSnapshot = workspaceSnapshotVolume(roomId, operationId)
    if (workspaceVolume !== expectedSnapshot) throw new Error('artifact input is not this build operation snapshot')
    assertExpectedRoomVolumeName(roomId, expectedSnapshot)
    const volume = await this.inspectVolume(workspaceVolume)
    if (!volume) throw new Error(`workspace snapshot does not exist: ${workspaceVolume}`)
    await this.assertRoomVolumeOwnership(volume, roomId, workspaceVolume)

    const root = resolve(artifactsRoot)
    mkdirSync(root, { recursive: true })
    const canonicalRoot = realpathSync.native(root)
    const output = resolve(canonicalRoot, operationId)
    if (!isPathInside(canonicalRoot, output)) throw new Error('artifact directory escaped the Hotel artifact root')
    if (existsSync(output)) throw new Error('artifact directory already exists for this build operation')
    mkdirSync(output, { recursive: true })
    const canonicalOutput = realpathSync.native(output)
    if (!isPathInside(canonicalRoot, canonicalOutput)) throw new Error('artifact directory resolved outside the Hotel artifact root')
    await this.ensureImage(DU_IMAGE)
    try {
      must(
        await runDocker(
          [
            'run',
            '--rm',
            '--network',
            'none',
            '--cap-drop',
            'ALL',
            '--security-opt',
            'no-new-privileges',
            '-v',
            `${workspaceVolume}:/workspace:ro`,
            '-v',
            `${canonicalOutput}:/out`,
            DU_IMAGE,
            'sh',
            '-lc',
            "cd /workspace && find . -type f \\( \\( -path '*/build/outputs/apk/*' -name '*.apk' \\) -o -path '*/build/outputs/apk/*/output-metadata.json' \\) -exec sh -c 'for file do rel=${file#./}; mkdir -p \"/out/${rel%/*}\"; cp \"$file\" \"/out/$rel\"; done' sh {} +"
          ],
          { timeoutMs: LONG_TIMEOUT_MS }
        ),
        'export Android build artifacts'
      )

      if (realpathSync.native(output) !== canonicalOutput) throw new Error('artifact directory changed during export')
      const artifacts: ExportedArtifact[] = []
      for (const path of filesBelow(canonicalOutput)) {
        const relativePath = relative(canonicalOutput, path).replaceAll('\\', '/')
        const segments = relativePath.split('/')
        if (relativePath.endsWith('/output-metadata.json')) {
          const metadata = lstatSync(path)
          if (
            metadata.isSymbolicLink() ||
            !metadata.isFile() ||
            metadata.size < 2 ||
            metadata.size > 256 * 1024 ||
            !(relativePath.startsWith('build/outputs/apk/') || relativePath.includes('/build/outputs/apk/'))
          ) {
            throw new Error(`invalid exported Android output metadata: ${relativePath}`)
          }
          continue
        }
        if (
          relativePath.startsWith('/') ||
          segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
          !relativePath.endsWith('.apk') ||
          !(relativePath.startsWith('build/outputs/apk/') || relativePath.includes('/build/outputs/apk/'))
        ) {
          throw new Error(`invalid exported APK path: ${relativePath}`)
        }
        artifacts.push({ relativePath, size: statSync(path).size, sha256: await sha256File(path) })
      }
      artifacts.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
      if (artifacts.length === 0) rmSync(canonicalOutput, { recursive: true, force: true })
      return artifacts
    } catch (error) {
      rmSync(canonicalOutput, { recursive: true, force: true })
      throw error
    }
  }

  async webState(roomId: string): Promise<'running' | 'exited' | 'missing'> {
    const result = await runDocker(['inspect', '--format', '{{.State.Status}}', webName(roomId)])
    if (result.code !== 0) return 'missing'
    return result.stdout.trim() === 'running' ? 'running' : 'exited'
  }

  async listManagedContainers(): Promise<{ roomId: string; role: string; state: string; name: string }[]> {
    const result = must(
      await runDocker(['ps', '-a', '--filter', 'label=devhotel.managed=1', '--format', '{{json .}}']),
      'list managed containers',
    )
    const out: { roomId: string; role: string; state: string; name: string }[] = []
    for (const line of result.stdout.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      let row: { Names?: string; State?: string; Labels?: string }
      try {
        row = JSON.parse(trimmed) as { Names?: string; State?: string; Labels?: string }
      } catch {
        continue
      }
      const labels = new Map<string, string>()
      for (const pair of (row.Labels ?? '').split(',')) {
        const eq = pair.indexOf('=')
        if (eq > 0) labels.set(pair.slice(0, eq), pair.slice(eq + 1))
      }
      out.push({
        roomId: labels.get('devhotel.room') ?? '',
        role: labels.get('devhotel.role') ?? '',
        state: row.State ?? '',
        name: row.Names ?? '',
      })
    }
    return out
  }

  async removeManagedContainer(name: string): Promise<void> {
    await this.assertPinnedEngineIdentity()
    const container = await this.inspectContainer(name)
    if (!container) return
    const actualName = (container.Name ?? '').replace(/^\//, '')
    const labels = container.Config?.Labels ?? {}
    const roomId = labels['devhotel.room'] ?? ''
    const role = labels['devhotel.role'] ?? ''
    if (
      actualName !== name ||
      labels['devhotel.managed'] !== '1' ||
      !roomId ||
      !isExpectedRoomContainer(roomId, actualName, role)
    ) {
      throw new Error(`refusing to remove container not owned by DevHotel: ${name}`)
    }
    must(await runDocker(['rm', '-f', name]), `remove managed container ${name}`)
    if (await this.inspectContainer(name)) throw new Error(`container cleanup incomplete: ${name}`)
  }

  async listManagedNetworks(): Promise<ManagedNetwork[]> {
    const result = must(
      await runDocker([
        'network',
        'ls',
        '--filter',
        'label=devhotel.managed=1',
        '--filter',
        'label=devhotel.role=network',
        '--format',
        '{{json .}}'
      ]),
      'list managed networks'
    )
    const out: ManagedNetwork[] = []
    for (const line of result.stdout.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      let row: { Name?: string; Labels?: string }
      try {
        row = JSON.parse(trimmed) as { Name?: string; Labels?: string }
      } catch {
        continue
      }
      const labels = parseDockerLabels(row.Labels ?? '')
      out.push({ roomId: labels.get('devhotel.room') ?? '', name: row.Name ?? '' })
    }
    return out.filter((network) => network.name.length > 0)
  }

  async removeManagedNetwork(name: string): Promise<void> {
    await this.assertPinnedEngineIdentity()
    assertManagedNetworkName(name)
    const network = await this.inspectNetwork(name)
    if (!network) return
    const labels = network.Labels ?? {}
    const roomId = labels['devhotel.room'] ?? ''
    if (
      network.Name !== name ||
      labels['devhotel.managed'] !== '1' ||
      labels['devhotel.role'] !== 'network' ||
      !roomId ||
      (name !== roomNetworkName(roomId) && name !== androidControlNetworkName(roomId))
    ) {
      throw new Error(`refusing to remove network not owned by DevHotel: ${name}`)
    }
    assertRoomNetwork(network, roomId, name)
    must(await runDocker(['network', 'rm', name]), `remove network ${name}`)
    if (await this.inspectNetwork(name)) {
      throw new Error(`network cleanup incomplete: ${name}`)
    }
  }

  async cloneIntoVolume(
    roomId: string,
    gitUrl: string,
    workspaceVolumeRevision = 0,
    log?: (line: string) => void
  ): Promise<void> {
    await this.assertPinnedEngineIdentity()
    await this.ensureImage(CLONE_IMAGE, log)
    const target = srcVolume(roomId, workspaceVolumeRevision)
    await this.ensureRoomVolume(roomId, target)
    must(
      await runDocker(
        ['run', '--rm', '-v', `${target}:/workspace`, '-w', '/workspace', CLONE_IMAGE, 'clone', gitUrl, '.'],
        { timeoutMs: LONG_TIMEOUT_MS, onLine: log },
      ),
      `clone ${gitUrl}`,
    )
  }

  async importHostFolder(
    roomId: string,
    hostPath: string,
    workspaceVolumeRevision: number,
    log?: (line: string) => void
  ): Promise<void> {
    await this.assertPinnedEngineIdentity()
    if (workspaceVolumeRevision < 1) throw new Error('Host imports require a new workspace volume generation')
    const target = srcVolume(roomId, workspaceVolumeRevision)
    if (await this.inspectVolume(target)) throw new Error(`workspace generation already exists: ${target}`)
    await this.ensureImage(DU_IMAGE, log)
    await this.ensureRoomVolume(roomId, target)
    try {
      must(
        await runDocker(
          [
            'run',
            '--rm',
            '--network',
            'none',
            '--cap-drop',
            'ALL',
            '--security-opt',
            'no-new-privileges',
            '--mount',
            `type=bind,source=${hostPath},target=/source,readonly`,
            '-v',
            `${target}:/workspace`,
            DU_IMAGE,
            'sh',
            '-lc',
            importHostFolderScript()
          ],
          { timeoutMs: LONG_TIMEOUT_MS, onLine: log }
        ),
        'import Host folder into Room workspace'
      )
    } catch (err) {
      try {
        await this.removeRoomVolume(roomId, target)
      } catch (cleanupError) {
        throw new Error(
          `Host import failed and staged workspace cleanup is required for ${target}: ${
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          }`,
          { cause: err }
        )
      }
      throw err
    }
  }

  async fingerprintWorkspace(
    roomId: string,
    workspaceVolumeRevision: number,
    workspaceVolumeOverride?: string
  ): Promise<string> {
    await this.assertPinnedEngineIdentity()
    const source = workspaceVolumeOverride ?? srcVolume(roomId, workspaceVolumeRevision)
    assertExpectedRoomVolumeName(roomId, source)
    const volume = await this.inspectVolume(source)
    if (!volume) throw new Error(`workspace generation does not exist: ${source}`)
    await this.assertRoomVolumeOwnership(volume, roomId, source)
    await this.ensureImage(DU_IMAGE)
    const result = must(
      await runDocker([
        'run',
        '--rm',
        '--network',
        'none',
        '--cap-drop',
        'NET_RAW',
        '-v',
        `${source}:/workspace:ro`,
        DU_IMAGE,
        'sh',
        '-lc',
        workspaceTransactionalFingerprintScript()
      ]),
      'fingerprint transactional Room workspace'
    )
    const fingerprint = result.stdout.trim().split(/\s+/)[0] ?? ''
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
      throw new Error('workspace helper returned an invalid transactional fingerprint')
    }
    return fingerprint
  }

  async snapshotWorkspace(
    roomId: string,
    workspaceVolumeRevision: number,
    workspaceVolumeOverride?: string
  ): Promise<WorkspaceSnapshot> {
    await this.assertPinnedEngineIdentity()
    const source = workspaceVolumeOverride ?? srcVolume(roomId, workspaceVolumeRevision)
    assertExpectedRoomVolumeName(roomId, source)
    const volume = await this.inspectVolume(source)
    if (!volume) throw new Error(`workspace generation does not exist: ${source}`)
    await this.assertRoomVolumeOwnership(volume, roomId, source)
    await this.ensureImage(DU_IMAGE)
    const result = must(
      await runDocker([
        'run',
        '--rm',
        '--network',
        'none',
        '--cap-drop',
        'NET_RAW',
        '-v',
        `${source}:/workspace:ro`,
        DU_IMAGE,
        'sh',
        '-lc',
        // Content identity of the Room's meaningful sync source, not a full
        // transactional filesystem snapshot.
        // Generated trees stay out unless the project names a path in
        // .devhotel-sync-include; mtime and empty directories do not count.
        workspaceSnapshotScript()
      ]),
      'fingerprint Room workspace'
    )
    const lines = result.stdout.split(/\r?\n/)
    const header = lines.shift() ?? ''
    const [label, fingerprint = ''] = header.split('\t')
    if (label !== 'fingerprint') throw new Error('workspace helper returned an invalid snapshot header')
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('workspace helper returned an invalid fingerprint')
    const entries: WorkspaceSnapshotEntry[] = []
    for (const line of lines) {
      if (!line) continue
      const [rawKind, metadata, encodedPath, contentHash, ...extra] = line.split('\t')
      if (
        extra.length > 0 ||
        (rawKind !== 'F' && rawKind !== 'L') ||
        !/^[a-f0-9]+:[0-9]+:[0-9]+$/.test(metadata ?? '') ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(encodedPath ?? '') ||
        !/^[a-f0-9]{64}$/.test(contentHash ?? '')
      ) throw new Error('workspace helper returned an invalid path record')
      const pathBytes = Buffer.from(encodedPath!, 'base64')
      if (pathBytes.toString('base64') !== encodedPath || pathBytes.includes(0)) {
        throw new Error('workspace helper returned an invalid encoded path')
      }
      const path = pathBytes.toString('utf8')
      if (!isSafeWorkspacePath(path) || Buffer.from(path).compare(pathBytes) !== 0) {
        throw new Error('workspace helper returned an unsafe path')
      }
      entries.push({
        path,
        kind: rawKind === 'F' ? 'file' : 'symlink',
        identity: `${metadata}:${contentHash}`
      })
    }
    return { fingerprint, entries }
  }

  async fingerprintWorkspaceLegacy(roomId: string, workspaceVolumeRevision: number): Promise<string> {
    return this.fingerprintWorkspaceLegacyPolicy(roomId, workspaceVolumeRevision, false)
  }

  async fingerprintWorkspaceLegacyCurrentExclusions(
    roomId: string,
    workspaceVolumeRevision: number
  ): Promise<string> {
    return this.fingerprintWorkspaceLegacyPolicy(roomId, workspaceVolumeRevision, true)
  }

  private async fingerprintWorkspaceLegacyPolicy(
    roomId: string,
    workspaceVolumeRevision: number,
    currentGeneratedExclusions: boolean
  ): Promise<string> {
    await this.assertPinnedEngineIdentity()
    const source = srcVolume(roomId, workspaceVolumeRevision)
    const volume = await this.inspectVolume(source)
    if (!volume) throw new Error(`workspace generation does not exist: ${source}`)
    await this.assertRoomVolumeOwnership(volume, roomId, source)
    await this.ensureImage(DU_IMAGE)
    const originalGeneratedDirs = ['node_modules', '.next', 'dist', 'build', 'coverage', '.gradle']
    const generatedDirs = currentGeneratedExclusions
      ? GENERATED_SYNC_DIRS.filter((name) => name !== '.git')
      : originalGeneratedDirs
    const generatedPrunes = generatedDirs.map((name) => `-name ${name}`).join(' -o ')
    const generatedFiles = currentGeneratedExclusions ? " ! -name '*.apk' ! -name '*.aab'" : ''
    const result = must(
      await runDocker([
        'run',
        '--rm',
        '--network',
        'none',
        '--cap-drop',
        'NET_RAW',
        '-v',
        `${source}:/workspace:ro`,
        DU_IMAGE,
        'sh',
        '-lc',
        // Keep the old record format so a stored pre-path-baseline digest can
        // be compared directly. The fallback variant adds only today's
        // generated-output exclusions; it intentionally retains the legacy
        // Git control-state policy, so unrelated repository edits still fail
        // migration closed.
        `set -eu; legacy_sync_paths=$(mktemp); legacy_sync_sorted=$(mktemp); legacy_sync_records=$(mktemp); cd /workspace; find . -mindepth 1 \\( -type d \\( ${generatedPrunes} -o -path '*/.git/objects' \\) \\) -prune -o${generatedFiles} -print0 > "$legacy_sync_paths"; sort -z "$legacy_sync_paths" > "$legacy_sync_sorted"; while IFS= read -r -d '' path; do path_hash=$(printf '%s' "$path" | sha256sum); path_hash=\${path_hash%% *}; metadata=$(stat -c '%f:%u:%g' "$path"); if [ -L "$path" ]; then kind=L; content_hash=$(readlink -n "$path" | sha256sum); content_hash=\${content_hash%% *}; elif [ -f "$path" ]; then kind=F; content_hash=$(sha256sum "$path"); content_hash=\${content_hash%% *}; elif [ -d "$path" ]; then kind=D; content_hash=-; else echo "unsupported workspace object: $path" >&2; exit 2; fi; printf '%s %s %s %s\\n' "$kind" "$metadata" "$path_hash" "$content_hash" >> "$legacy_sync_records"; done < "$legacy_sync_sorted"; sha256sum "$legacy_sync_records"`
      ]),
      currentGeneratedExclusions
        ? 'fingerprint legacy Room workspace with current generated exclusions'
        : 'fingerprint legacy Room workspace'
    )
    const fingerprint = result.stdout.trim().split(/\s+/)[0] ?? ''
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('legacy workspace helper returned an invalid fingerprint')
    return fingerprint
  }

  async fingerprintBuildInput(roomId: string, workspaceVolume: string): Promise<string> {
    await this.assertPinnedEngineIdentity()
    assertExpectedRoomVolumeName(roomId, workspaceVolume)
    const volume = await this.inspectVolume(workspaceVolume)
    if (!volume) throw new Error(`build input volume does not exist: ${workspaceVolume}`)
    await this.assertRoomVolumeOwnership(volume, roomId, workspaceVolume)
    await this.ensureImage(DU_IMAGE)
    const result = must(
      await runDocker([
        'run',
        '--rm',
        '--network',
        'none',
        '--cap-drop',
        'NET_RAW',
        '-v',
        `${workspaceVolume}:/workspace:ro`,
        DU_IMAGE,
        'sh',
        '-lc',
        "set -eu; paths=$(mktemp); sorted=$(mktemp); records=$(mktemp); cd /workspace; find . -mindepth 1 -print0 > \"$paths\"; sort -z \"$paths\" > \"$sorted\"; while IFS= read -r -d '' path; do path_hash=$(printf '%s' \"$path\" | sha256sum); path_hash=${path_hash%% *}; metadata=$(stat -c '%f:%u:%g:%Y' \"$path\"); if [ -L \"$path\" ]; then kind=L; content_hash=$(readlink -n \"$path\" | sha256sum); content_hash=${content_hash%% *}; elif [ -f \"$path\" ]; then kind=F; content_hash=$(sha256sum \"$path\"); content_hash=${content_hash%% *}; elif [ -d \"$path\" ]; then kind=D; content_hash=-; else echo \"unsupported build input object: $path\" >&2; exit 2; fi; printf '%s %s %s %s\\n' \"$kind\" \"$metadata\" \"$path_hash\" \"$content_hash\" >> \"$records\"; done < \"$sorted\"; sha256sum \"$records\""
      ]),
      'fingerprint immutable build input'
    )
    const fingerprint = result.stdout.trim().split(/\s+/)[0] ?? ''
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('build input helper returned an invalid fingerprint')
    return fingerprint
  }

  async removeWorkspaceVolume(roomId: string, workspaceVolumeRevision: number): Promise<void> {
    await this.assertPinnedEngineIdentity()
    await this.removeRoomVolume(roomId, srcVolume(roomId, workspaceVolumeRevision))
  }

  async removeWorkspaceSnapshot(roomId: string, operationId: string): Promise<void> {
    await this.assertPinnedEngineIdentity()
    await this.removeRoomVolume(roomId, workspaceSnapshotVolume(roomId, operationId))
  }

  async removeDependencyVolume(roomId: string, nodeMajor: string, generation: number): Promise<void> {
    await this.assertPinnedEngineIdentity()
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new Error('Only generated dependency volumes can be removed through this operation')
    }
    await this.removeRoomVolume(roomId, `${depsVolume(roomId, nodeMajor)}-g${generation}`)
  }

  async copyVolume(
    sourceRoomId: string,
    source: string,
    targetRoomId: string,
    target: string,
    log?: (line: string) => void
  ): Promise<void> {
    await this.assertPinnedEngineIdentity()
    assertExpectedRoomVolumeName(sourceRoomId, source)
    assertExpectedRoomVolumeName(targetRoomId, target)
    if (source === target) throw new Error('source and target volumes must be different')

    const sourceVolume = await this.inspectVolume(source)
    if (!sourceVolume) throw new Error(`source volume does not exist: ${source}`)
    await this.assertRoomVolumeOwnership(sourceVolume, sourceRoomId, source)
    if (await this.inspectVolume(target)) throw new Error(`target volume already exists: ${target}`)

    await this.ensureImage(DU_IMAGE, log)
    await this.ensureRoomVolume(targetRoomId, target)
    try {
      must(
        await runDocker(
          [
            'run',
            '--rm',
            '-v',
            `${source}:/from:ro`,
            '-v',
            `${target}:/to`,
            DU_IMAGE,
            'sh',
            '-c',
            'cd /from && tar cf - . | tar xpf - -C /to'
          ],
          { timeoutMs: LONG_TIMEOUT_MS, onLine: log }
        ),
        `copy volume ${source} to ${target}`
      )
    } catch (err) {
      await this.removeRoomVolume(targetRoomId, target)
      throw err
    }
  }

  async volumeSizes(roomId: string): Promise<Record<string, number>> {
    await this.assertPinnedEngineIdentity()
    const sizes: Record<string, number> = {}
    for (const volume of await this.listRoomVolumes(roomId)) {
      const result = await runDocker(
        ['run', '--rm', '-v', `${volume}:/v`, DU_IMAGE, 'du', '-sb', '/v'],
        { timeoutMs: 300_000 },
      )
      if (result.code !== 0) continue
      const m = /^(\d+)/.exec(result.stdout.trim())
      if (m?.[1]) sizes[volume] = Number.parseInt(m[1], 10)
    }
    return sizes
  }

  /**
   * Empty a volume in place. `resetVolume` removes and recreates, which Docker
   * refuses for a volume any container still references — and the Room's cache
   * and SDK volumes are mounted by its web container for the Room's whole life,
   * stopped or not. Mounting the same volume into a throwaway helper and
   * clearing it there works regardless.
   */
  async clearVolumeContents(roomId: string, name: string): Promise<void> {
    await this.assertPinnedEngineIdentity()
    assertExpectedRoomVolumeName(roomId, name)
    const volume = await this.inspectVolume(name)
    if (!volume) return
    await this.assertRoomVolumeOwnership(volume, roomId, name)
    await this.ensureImage(DU_IMAGE)
    must(
      await runDocker([
        'run',
        '--rm',
        '--network',
        'none',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '-v',
        `${name}:/target`,
        DU_IMAGE,
        'sh',
        '-lc',
        'find /target -mindepth 1 -maxdepth 1 -exec rm -rf {} +'
      ]),
      `clear volume ${name}`
    )
  }

  async resetVolume(roomId: string, name: string): Promise<void> {
    await this.assertPinnedEngineIdentity()
    assertExpectedRoomVolumeName(roomId, name)
    await this.removeRoomVolume(roomId, name)
    await this.ensureRoomVolume(roomId, name)
  }

  async createService(roomId: string, svc: 'postgres' | 'redis', version: string): Promise<void> {
    await this.assertPinnedEngineIdentity()
    let networkNamespace = anchorName(roomId)
    let androidRuntimeId: string | null = null
    let androidRuntimeSandboxId: string | null = null
    const androidRuntime = await this.inspectContainer(androidRuntimeAnchorName(roomId))
    if (androidRuntime) {
      const androidControl = await this.inspectNetwork(androidControlNetworkName(roomId))
      if (!androidControl) {
        throw new Error('Android control network is missing; refusing to create a service in a partial topology')
      }
      assertRoomNetwork(androidControl, roomId, androidControlNetworkName(roomId))
      await this.assertRoomContainer(
        roomId,
        androidRuntimeAnchorName(roomId),
        'android-runtime-anchor',
        androidRuntime
      )
      this.assertContainerNetworkMode(androidRuntime, roomNetworkName(roomId), 'Android runtime anchor')
      if (androidRuntime.State?.Status !== 'running') {
        throw new Error('Android runtime anchor must be running before a managed service is created')
      }
      androidRuntimeId = exactContainerId(androidRuntime, roomId)
      androidRuntimeSandboxId = this.exactRunningSandboxId(androidRuntime, 'Android runtime anchor')
      networkNamespace = androidRuntimeId
    } else {
      const androidControl = await this.inspectNetwork(androidControlNetworkName(roomId))
      if (androidControl) {
        assertRoomNetwork(androidControl, roomId, androidControlNetworkName(roomId))
        throw new Error('Android runtime anchor is missing; refusing to attach a service to the control namespace')
      }
    }
    await this.ensureImage(svcImage(svc, version))
    await this.ensureRoomVolume(roomId, svcVolume(roomId, svc))
    const creationToken = randomUUID()
    let createdId: string | undefined
    try {
      const launched = await runDocker(
        buildServiceArgs(roomId, svc, version, networkNamespace, creationToken),
        {
          timeoutMs: null,
          maxStdoutBytes: 128,
          maxStderrBytes: 8 * 1024,
          killOnOutputLimit: false
        }
      )
      const candidateId = launched.stdout.trim()
      if (/^[a-f0-9]{64}$/.test(candidateId)) createdId = candidateId
      must(launched, `run ${svc} container`)
      if (!createdId) throw new Error(`${svc} create did not return one immutable container ID`)
      const inspected = await this.inspectContainer(createdId)
      if (!inspected) throw new Error(`${svc} immutable container disappeared during creation`)
      const created = await this.assertRoomContainer(roomId, svcName(roomId, svc), `svc-${svc}`, inspected)
      if (created.Config?.Labels?.['devhotel.creation-token'] !== creationToken) {
        throw new Error(`${svc} immutable creation token changed during creation`)
      }
      if (exactContainerId(created, roomId) !== createdId) {
        throw new Error(`${svc} immutable container changed during creation`)
      }
      if (androidRuntimeId && androidRuntimeSandboxId) {
        this.assertContainerNetworkNamespace(
          created,
          androidRuntimeAnchorName(roomId),
          androidRuntimeId,
          `Android ${svc} service`
        )
        if (this.exactRunningSandboxId(created, `Android ${svc} service`) !== androidRuntimeSandboxId) {
          throw new Error(`Android ${svc} service was created outside the exact runtime namespace`)
        }
        await this.assertCurrentAndroidRuntimeAnchor(
          roomId,
          androidRuntimeId,
          androidRuntimeSandboxId
        )
      }
    } catch (error) {
      try {
        await this.removeFailedCreatedService(roomId, svc, creationToken, createdId)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `${svc} creation validation and exact cleanup both failed`)
      }
      throw error
    }
  }

  async startService(roomId: string, svc: 'postgres' | 'redis'): Promise<void> {
    await this.assertPinnedEngineIdentity()
    const name = svcName(roomId, svc)
    const existing = await this.assertRoomContainer(roomId, name, `svc-${svc}`)
    const id = exactContainerId(existing, roomId)
    const androidRuntime = await this.inspectContainer(androidRuntimeAnchorName(roomId))
    let runtimeId: string | null = null
    let runtimeSandboxId: string | null = null
    const rejectAfterAndroidCleanup = async (error: unknown): Promise<never> => {
      try {
        await this.removeMisboundStartedService(roomId, svc, id)
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Android ${svc} start validation and exact cleanup both failed`
        )
      }
      throw error
    }
    if (androidRuntime) {
      const androidControl = await this.inspectNetwork(androidControlNetworkName(roomId))
      if (!androidControl) {
        throw new Error('Android control network is missing; refusing to start a service in a partial topology')
      }
      assertRoomNetwork(androidControl, roomId, androidControlNetworkName(roomId))
      await this.assertRoomContainer(
        roomId,
        androidRuntimeAnchorName(roomId),
        'android-runtime-anchor',
        androidRuntime
      )
      runtimeId = exactContainerId(androidRuntime, roomId)
      if (androidRuntime.State?.Status !== 'running') {
        throw new Error('Android runtime anchor must be running before a managed service is started')
      }
      this.assertContainerNetworkMode(androidRuntime, roomNetworkName(roomId), 'Android runtime anchor')
      runtimeSandboxId = this.exactRunningSandboxId(androidRuntime, 'Android runtime anchor')
      try {
        this.assertContainerNetworkNamespace(
          existing,
          androidRuntimeAnchorName(roomId),
          runtimeId,
          `Android ${svc} service`
        )
      } catch (error) {
        await rejectAfterAndroidCleanup(error)
      }
    } else {
      const androidControl = await this.inspectNetwork(androidControlNetworkName(roomId))
      if (androidControl) {
        assertRoomNetwork(androidControl, roomId, androidControlNetworkName(roomId))
        throw new Error('Android runtime anchor is missing; refusing to start a service in the control namespace')
      }
    }
    const startAndValidate = async (): Promise<void> => {
      must(await runDocker(['start', id]), `start ${svc}`)
      const started = await this.inspectContainer(id)
      if (!started || started.State?.Status !== 'running') throw new Error(`${svc} start incomplete: ${name}`)
      await this.assertRoomContainer(roomId, name, `svc-${svc}`, started)
      if (exactContainerId(started, roomId) !== id) throw new Error(`${svc} immutable container changed during start`)
      if (
        runtimeSandboxId &&
        this.exactRunningSandboxId(started, `Android ${svc} service`) !== runtimeSandboxId
      ) throw new Error(`Android ${svc} service started outside the exact runtime namespace`)
      if (runtimeId && runtimeSandboxId) {
        await this.assertCurrentAndroidRuntimeAnchor(roomId, runtimeId, runtimeSandboxId)
      }
    }
    if (androidRuntime) {
      try {
        await startAndValidate()
      } catch (error) {
        await rejectAfterAndroidCleanup(error)
      }
    } else {
      await startAndValidate()
    }
  }

  async stopService(roomId: string, svc: 'postgres' | 'redis'): Promise<void> {
    await this.assertPinnedEngineIdentity()
    const name = svcName(roomId, svc)
    const existing = await this.assertRoomContainer(roomId, name, `svc-${svc}`)
    if (existing.State?.Status === 'exited') return
    const id = exactContainerId(existing, roomId)
    must(await runDocker(['stop', '-t', '5', id]), `stop ${svc}`)
    const stopped = await this.inspectContainer(id)
    if (!stopped || stopped.State?.Status !== 'exited') throw new Error(`${svc} stop incomplete: ${name}`)
  }

  async removeService(roomId: string, svc: 'postgres' | 'redis', opts: { volume: boolean }): Promise<void> {
    await this.assertPinnedEngineIdentity()
    await this.removeRoomContainer(roomId, svcName(roomId, svc), `svc-${svc}`)
    if (opts.volume) await this.removeRoomVolume(roomId, svcVolume(roomId, svc))
  }

  async serviceState(roomId: string, svc: 'postgres' | 'redis'): Promise<'running' | 'exited' | 'missing'> {
    await this.assertPinnedEngineIdentity()
    const name = svcName(roomId, svc)
    const existing = await this.inspectContainer(name)
    if (!existing) return 'missing'
    const owned = await this.assertRoomContainer(roomId, name, `svc-${svc}`, existing)
    exactContainerId(owned, roomId)
    return owned.State?.Status === 'running' ? 'running' : 'exited'
  }

  async execInService(
    roomId: string,
    svc: 'postgres' | 'redis',
    cmd: string[],
    opts?: { timeoutMs?: number; input?: string }
  ): Promise<ExecResult> {
    await this.assertPinnedEngineIdentity()
    const container = await this.assertRoomContainer(roomId, svcName(roomId, svc), `svc-${svc}`)
    const interactive = opts?.input !== undefined ? ['-i'] : []
    return runDocker(['exec', ...interactive, exactContainerId(container, roomId), ...cmd], {
      timeoutMs: opts?.timeoutMs ?? 120_000,
      input: opts?.input
    })
  }

  async execInServiceToFile(
    roomId: string,
    svc: 'postgres' | 'redis',
    cmd: string[],
    hostPath: string,
    opts?: { timeoutMs?: number }
  ): Promise<ExecResult> {
    await this.assertPinnedEngineIdentity()
    const container = await this.assertRoomContainer(roomId, svcName(roomId, svc), `svc-${svc}`)
    return runDocker(['exec', exactContainerId(container, roomId), ...cmd], {
      timeoutMs: opts?.timeoutMs ?? 600_000,
      outputFile: hostPath
    })
  }

  async execInServiceFromFile(
    roomId: string,
    svc: 'postgres' | 'redis',
    cmd: string[],
    hostPath: string,
    opts?: { timeoutMs?: number }
  ): Promise<ExecResult> {
    await this.assertPinnedEngineIdentity()
    const container = await this.assertRoomContainer(roomId, svcName(roomId, svc), `svc-${svc}`)
    return runDocker(['exec', '-i', exactContainerId(container, roomId), ...cmd], {
      timeoutMs: opts?.timeoutMs ?? 600_000,
      inputFile: hostPath
    })
  }

  async copyFromService(roomId: string, svc: 'postgres' | 'redis', containerPath: string, hostPath: string): Promise<void> {
    await this.assertPinnedEngineIdentity()
    const container = await this.assertRoomContainer(roomId, svcName(roomId, svc), `svc-${svc}`)
    must(await runDocker(['cp', `${exactContainerId(container, roomId)}:${containerPath}`, hostPath]), `copy from ${svc}`)
  }

  async copyToService(roomId: string, svc: 'postgres' | 'redis', hostPath: string, containerPath: string): Promise<void> {
    await this.assertPinnedEngineIdentity()
    const container = await this.assertRoomContainer(roomId, svcName(roomId, svc), `svc-${svc}`)
    must(await runDocker(['cp', hostPath, `${exactContainerId(container, roomId)}:${containerPath}`]), `copy into ${svc}`)
  }

  async copyIntoRoom(roomId: string, hostPath: string, containerPath: string): Promise<void> {
    await this.assertPinnedEngineIdentity()
    const container = await this.assertRoomContainer(roomId, webName(roomId), 'web')
    must(await runDocker(['cp', hostPath, `${exactContainerId(container, roomId)}:${containerPath}`]), 'copy into room')
  }

  async copyFromRoom(roomId: string, containerPath: string, hostPath: string): Promise<void> {
    await this.assertPinnedEngineIdentity()
    const container = await this.assertRoomContainer(roomId, webName(roomId), 'web')
    must(await runDocker(['cp', `${exactContainerId(container, roomId)}:${containerPath}`, hostPath]), 'copy from room')
  }

  async execFencedEmulatorAdb(roomId: string, args: string[], opts: ExecOpts = {}): Promise<ExecResult> {
    throwIfAborted(opts.signal)
    return this.runFencedEmulatorAdb(roomId, args, opts)
  }

  async installFencedEmulatorApk(roomId: string, hostApkPath: string, opts: ExecOpts = {}): Promise<ExecResult> {
    let canonicalApk: string | undefined
    try {
      throwIfAborted(opts.signal)
      const sourceStat = lstatSync(hostApkPath)
      if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
        throw new Error('fenced emulator install refused an invalid private APK stage')
      }
      canonicalApk = realpathSync.native(hostApkPath)
      const apkStat = lstatSync(canonicalApk)
      if (
        apkStat.isSymbolicLink() ||
        !apkStat.isFile() ||
        apkStat.size < 1 ||
        apkStat.size > 512 * 1024 * 1024 ||
        sourceStat.dev !== apkStat.dev ||
        sourceStat.ino !== apkStat.ino ||
        sourceStat.size !== apkStat.size
      ) {
        throw new Error('fenced emulator install refused an invalid private APK stage')
      }
      return await this.runFencedEmulatorAdb(
        roomId,
        ['install', '-r', '/devhotel-install/app.apk'],
        opts,
        canonicalApk
      )
    } catch (error) {
      const privateTokens = Array.from(new Set([
        resolve(hostApkPath),
        basename(hostApkPath),
        ...(canonicalApk ? [canonicalApk, basename(canonicalApk)] : [])
      ]))
      if (
        opts.signal?.aborted &&
        opts.signal.reason !== undefined &&
        !containsPrivateStageToken(opts.signal.reason, privateTokens)
      ) {
        throw opts.signal.reason
      }
      // Docker mount/create/cleanup diagnostics can echo the canonical Host
      // path. It is a private capability and must never cross this boundary,
      // including through AggregateError.errors or Error.cause.
      const cleanupFailed = error instanceof AggregateError
      const sanitized = new Error(
        `Fenced emulator APK install failed for [private APK stage]${
          cleanupFailed ? '; exact helper cleanup also failed' : ''
        }`
      )
      if (opts.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) sanitized.name = 'AbortError'
      throw sanitized
    }
  }

  private async runFencedEmulatorAdb(
    roomId: string,
    args: string[],
    opts: ExecOpts,
    hostApkPath?: string
  ): Promise<ExecResult> {
    throwIfAborted(opts.signal)
    await this.assertPinnedEngineIdentity()
    if (!args[0] || args[0].startsWith('-')) throw new Error('fenced emulator ADB requires a command without selectors')
    if (!hostApkPath && ['install', 'install-multiple', 'install-multi-package'].includes(args[0])) {
      throw new Error('fenced emulator installs require a private staged APK capability')
    }
    const topology = await this.assertFencedEmulatorTopology(roomId)
    const { emulatorId } = topology
    await this.ensureImage(ANDROID_IMAGE)
    const id = randomUUID()
    const name = jobName(roomId, id)
    const abortToken = randomUUID()
    const state = `/tmp/devhotel-fenced-adb-${id}`
    const mount = hostApkPath
      ? ['--mount', `type=bind,source=${hostApkPath},target=/devhotel-install/app.apk,readonly`]
      : []
    const stdoutLimit = Math.min(opts.maxStdoutBytes ?? 1024 * 1024, SCREENSHOT_MAX_BASE64_BYTES)
    const stderrLimit = Math.min(opts.maxStderrBytes ?? 64 * 1024, 64 * 1024)
    if (
      !Number.isSafeInteger(stdoutLimit) || stdoutLimit < 1 ||
      !Number.isSafeInteger(stderrLimit) || stderrLimit < 1
    ) throw new Error('fenced emulator ADB output limits must be positive safe integers')
    const timeoutMs = Math.min(opts.timeoutMs ?? 120_000, 10 * 60_000)
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error('fenced emulator ADB timeout must be a positive safe integer')
    }
    const stdout = boundedCommandOutput(stdoutLimit)
    const stderr = boundedCommandOutput(stderrLimit)
    const tmpfsSizeMiB = Math.ceil((stdoutLimit + stderrLimit + 1024 * 1024) / (1024 * 1024))
    const createArgs = [
      'create',
      '--rm',
      '--name',
      name,
      '--network',
      `container:${emulatorId}`,
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--read-only',
      '--tmpfs',
      `/tmp:rw,nosuid,nodev,noexec,size=${tmpfsSizeMiB}m`,
      '-l',
      `devhotel.room=${roomId}`,
      '-l',
      'devhotel.role=job',
      '-l',
      'devhotel.managed=1',
      '-l',
      `devhotel.abort-token=${abortToken}`,
      ...mount,
      '-e',
      `ADB_SERVER_SOCKET=localfilesystem:${state}/server.sock`,
      '--entrypoint',
      '/bin/sh',
      ANDROID_IMAGE,
      '-c',
      FENCED_EMULATOR_ADB_SCRIPT,
      'devhotel-fenced-adb',
      state,
      String(stdoutLimit),
      String(stderrLimit),
      String(Math.max(1, Math.ceil(timeoutMs / 1000))),
      ...args
    ]
    let helperId: string | undefined
    try {
      throwIfAborted(opts.signal)
      const createResult = await runDocker(createArgs, {
        timeoutMs: null,
        maxStdoutBytes: 128,
        maxStderrBytes: 8 * 1024,
        killOnOutputLimit: false
      })
      const candidateId = createResult.stdout.trim()
      if (/^[a-f0-9]{64}$/.test(candidateId)) helperId = candidateId
      throwIfAborted(opts.signal)
      must(createResult, 'create fenced emulator ADB helper')
      if (!helperId) {
        throw new Error('fenced emulator ADB helper create did not return one immutable container ID')
      }
      const createdHelper = await this.inspectContainer(helperId)
      if (!createdHelper || !this.isOwnedFencedJob(createdHelper, roomId, name, abortToken)) {
        throw new Error('fenced emulator ADB helper ownership could not be verified before start')
      }
      if (exactContainerId(createdHelper, roomId) !== helperId) {
        throw new Error('fenced emulator ADB helper immutable ID changed before start')
      }
      if (createdHelper.HostConfig?.NetworkMode !== `container:${emulatorId}`) {
        throw new Error('fenced emulator ADB helper is not attached to the exact emulator network namespace')
      }
      if (createdHelper.State?.Status !== 'created') {
        throw new Error('fenced emulator ADB helper was not inert before its controlled action')
      }
      await this.assertFencedEmulatorTopology(roomId, topology)
      throwIfAborted(opts.signal)
    } catch (error) {
      try {
        await this.removeAbortedFencedJob(roomId, name, abortToken, helperId)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'fenced emulator helper create and cleanup both failed')
      }
      throw error
    }
    if (!helperId) throw new Error('fenced emulator ADB helper immutable ID was not retained')

    let result: ExecResult | undefined
    let executionError: unknown
    try {
      result = await runDocker(['start', '-a', helperId], {
        timeoutMs,
        signal: opts.signal,
        maxStdoutBytes: stdoutLimit,
        maxStderrBytes: stderrLimit,
        onAbort: () => this.removeAbortedFencedJob(roomId, name, abortToken, helperId),
        onStdout: (chunk) => {
          const accepted = stdout.push(chunk)
          if (accepted) opts.onStdout?.(accepted)
        },
        onStderr: (chunk) => {
          const accepted = stderr.push(chunk)
          if (accepted) opts.onStderr?.(accepted)
        }
      })
    } catch (error) {
      executionError = error
    }
    try {
      await this.removeAbortedFencedJob(roomId, name, abortToken, helperId)
    } catch (cleanupError) {
      if (executionError) {
        throw new AggregateError([executionError, cleanupError], 'fenced emulator helper execution and cleanup both failed')
      }
      throw cleanupError
    }
    if (executionError) throw executionError
    throwIfAborted(opts.signal)
    if (!result) throw new Error('fenced emulator helper did not return an execution result')
    const exceeded = result.outputLimitExceeded === true || result.code === 97 || stdout.exceeded || stderr.exceeded
    return {
      code: exceeded ? -1 : result.code,
      stdout: opts.onStdout ? '' : stdout.text(),
      stderr: opts.onStderr
        ? ''
        : `${stderr.text()}${exceeded ? '\nFenced emulator ADB output exceeded its safety limit.' : ''}`
    }
  }

  private async assertFencedEmulatorTopology(
    roomId: string,
    expected?: FencedEmulatorTopology
  ): Promise<FencedEmulatorTopology> {
    const participant = async (
      name: string,
      role: string,
      expectedId?: string
    ): Promise<DockerContainerInspect> => {
      const inspected = expectedId ? await this.inspectContainer(expectedId) : undefined
      if (expectedId && !inspected) {
        throw new Error(`Android execution topology participant disappeared: ${name}`)
      }
      const owned = await this.assertRoomContainer(roomId, name, role, inspected ?? undefined)
      const id = exactContainerId(owned, roomId)
      if (expectedId && id !== expectedId) {
        throw new Error(`Android execution topology participant changed immutable ID: ${name}`)
      }
      return owned
    }
    const anchor = await participant(anchorName(roomId), 'anchor', expected?.anchorId)
    const runtimeAnchor = await participant(
      androidRuntimeAnchorName(roomId),
      'android-runtime-anchor',
      expected?.runtimeAnchorId
    )
    const web = await participant(webName(roomId), 'web', expected?.webId)
    const emulator = await participant(emulatorName(roomId), 'svc-emulator', expected?.emulatorId)
    const anchorId = exactContainerId(anchor, roomId)
    const runtimeAnchorId = exactContainerId(runtimeAnchor, roomId)
    const webId = exactContainerId(web, roomId)
    const emulatorId = exactContainerId(emulator, roomId)
    const controlSandboxId = this.exactRunningSandboxId(anchor, 'Android control anchor')
    const runtimeSandboxId = this.exactRunningSandboxId(runtimeAnchor, 'Android runtime anchor')
    const webSandboxId = this.exactRunningSandboxId(web, 'Android web')
    const emulatorSandboxId = this.exactRunningSandboxId(emulator, 'Android emulator')
    if (
      expected &&
      (controlSandboxId !== expected.controlSandboxId || runtimeSandboxId !== expected.runtimeSandboxId)
    ) {
      throw new Error('Android execution topology network namespace changed while the helper was created')
    }
    if (controlSandboxId === runtimeSandboxId) {
      throw new Error('Android control and runtime workloads unexpectedly share one network namespace')
    }
    if (emulatorSandboxId !== controlSandboxId) {
      throw new Error('Android emulator is not live in the exact control anchor network namespace')
    }
    if (webSandboxId !== runtimeSandboxId) {
      throw new Error('Android web is not live in the exact runtime anchor network namespace')
    }
    const controlNetwork = await this.inspectNetwork(androidControlNetworkName(roomId))
    if (!controlNetwork) throw new Error('Android control network is missing; recreate this legacy Room')
    assertRoomNetwork(controlNetwork, roomId, androidControlNetworkName(roomId))
    const runtimeNetwork = await this.inspectNetwork(roomNetworkName(roomId))
    if (!runtimeNetwork) throw new Error('Android runtime network is missing')
    assertRoomNetwork(runtimeNetwork, roomId, roomNetworkName(roomId))
    assertAndroidNetworkMembership(controlNetwork, runtimeNetwork, roomId, anchorId, runtimeAnchorId)
    this.assertContainerNetworkMode(anchor, androidControlNetworkName(roomId), 'Android control anchor')
    this.assertContainerNetworkNamespace(web, androidRuntimeAnchorName(roomId), runtimeAnchorId, 'Android web')
    this.assertContainerNetworkMode(runtimeAnchor, roomNetworkName(roomId), 'Android runtime anchor')
    const networkMode = emulator.HostConfig?.NetworkMode ?? ''
    if (networkMode !== `container:${anchorName(roomId)}` && networkMode !== `container:${anchorId}`) {
      throw new Error('Room emulator is not attached to the exact owned anchor network namespace')
    }
    for (const svc of ['postgres', 'redis'] as const) {
      const service = await this.inspectContainer(svcName(roomId, svc))
      if (!service) continue
      await this.assertRoomContainer(roomId, svcName(roomId, svc), `svc-${svc}`, service)
      this.assertContainerNetworkNamespace(
        service,
        androidRuntimeAnchorName(roomId),
        runtimeAnchorId,
        `Android ${svc} service`
      )
      if (
        service.State?.Status === 'running' &&
        this.exactRunningSandboxId(service, `Android ${svc} service`) !== runtimeSandboxId
      ) {
        throw new Error(`Android ${svc} service is not live in the exact runtime anchor network namespace`)
      }
    }
    return { anchorId, runtimeAnchorId, webId, emulatorId, controlSandboxId, runtimeSandboxId }
  }

  private isOwnedFencedJob(
    container: DockerContainerInspect,
    roomId: string,
    name: string,
    abortToken: string
  ): boolean {
    const actualName = (container.Name ?? '').replace(/^\//, '')
    const labels = container.Config?.Labels ?? {}
    return actualName === name &&
      labels['devhotel.room'] === roomId &&
      labels['devhotel.role'] === 'job' &&
      labels['devhotel.managed'] === '1' &&
      labels['devhotel.abort-token'] === abortToken &&
      isJobName(roomId, name)
  }

  private async removeAbortedFencedJob(
    roomId: string,
    name: string,
    abortToken: string,
    expectedId?: string
  ): Promise<void> {
    await this.assertPinnedEngineIdentity()
    const container = await this.inspectContainer(expectedId ?? name)
    if (!container) return
    if (!this.isOwnedFencedJob(container, roomId, name, abortToken)) {
      if (expectedId) {
        throw new Error('Refusing to clean up a fenced Android helper whose immutable ownership changed')
      }
      return
    }
    const id = exactContainerId(container, roomId)
    if (expectedId && id !== expectedId) {
      throw new Error('Refusing to clean up a fenced Android helper with a different immutable ID')
    }
    const removed = await runDocker(['rm', '-f', id], { timeoutMs: 30_000 })
    if (removed.code !== 0 && !/no such (?:object|container)/i.test(`${removed.stderr}\n${removed.stdout}`)) {
      throw new Error('Could not clean up the exact aborted fenced Android helper')
    }
    if (await this.inspectContainer(id)) {
      throw new Error('The exact aborted fenced Android helper still exists after cleanup')
    }
  }

  private async assertAndroidControlAnchorForEmulator(roomId: string): Promise<DockerContainerInspect> {
    const anchor = await this.assertRoomContainer(roomId, anchorName(roomId), 'anchor')
    if (anchor.State?.Status !== 'running') throw new Error('Android control anchor is not running')
    const anchorId = exactContainerId(anchor, roomId)
    this.assertContainerNetworkMode(anchor, androidControlNetworkName(roomId), 'Android control anchor')
    const control = await this.inspectNetwork(androidControlNetworkName(roomId))
    if (!control) throw new Error('Android control network is missing')
    assertRoomNetwork(control, roomId, androidControlNetworkName(roomId))
    const members = Object.entries(control.Containers ?? {})
    if (
      members.length !== 1 ||
      members[0]?.[0] !== anchorId ||
      members[0]?.[1]?.Name !== anchorName(roomId)
    ) {
      throw new Error('Android control network does not contain only the exact owned anchor')
    }
    return anchor
  }

  private assertOwnedEmulatorCreate(
    container: DockerContainerInspect | null,
    roomId: string,
    name: string,
    abortToken: string,
    expectedId: string,
    anchorId: string
  ): void {
    const labels = container?.Config?.Labels ?? {}
    if (
      !container ||
      (container.Name ?? '').replace(/^\//, '') !== name ||
      labels['devhotel.room'] !== roomId ||
      labels['devhotel.role'] !== 'svc-emulator' ||
      labels['devhotel.managed'] !== '1' ||
      labels['devhotel.abort-token'] !== abortToken ||
      exactContainerId(container, roomId) !== expectedId ||
      container.HostConfig?.NetworkMode !== `container:${anchorId}`
    ) {
      throw new Error('emulator immutable ownership or control namespace changed during creation')
    }
  }

  private async removeAbortedEmulatorCreate(
    roomId: string,
    name: string,
    abortToken: string,
    expectedId?: string
  ): Promise<void> {
    await this.assertPinnedEngineIdentity()
    const container = await this.inspectContainer(expectedId ?? name)
    if (!container) return
    const labels = container.Config?.Labels ?? {}
    const owned = (container.Name ?? '').replace(/^\//, '') === name &&
      labels['devhotel.room'] === roomId &&
      labels['devhotel.role'] === 'svc-emulator' &&
      labels['devhotel.managed'] === '1' &&
      labels['devhotel.abort-token'] === abortToken
    if (!owned) {
      if (expectedId) throw new Error('Refusing to clean up an emulator whose immutable ownership changed')
      return
    }
    const id = exactContainerId(container, roomId)
    if (expectedId && id !== expectedId) {
      throw new Error('Refusing to clean up a replacement emulator container')
    }
    const removed = await runDocker(['rm', '-f', id], { timeoutMs: 30_000 })
    if (removed.code !== 0 && !/no such (?:object|container)/i.test(`${removed.stderr}\n${removed.stdout}`)) {
      throw new Error('Could not clean up the exact aborted emulator container')
    }
    if (await this.inspectContainer(id)) throw new Error('The exact aborted emulator still exists after cleanup')
  }

  async createEmulator(
    roomId: string,
    opts?: { device: string; version: string; resolution?: 'native' | 'balanced' | 'fast'; orientation?: 'portrait' | 'landscape' }
  ): Promise<void> {
    await this.assertPinnedEngineIdentity()
    await this.ensureImage(opts?.version ? emulatorImage(opts.version) : EMULATOR_IMAGE)
    const anchor = await this.assertAndroidControlAnchorForEmulator(roomId)
    const anchorId = exactContainerId(anchor, roomId)
    const anchorSandboxId = this.exactRunningSandboxId(anchor, 'Android control anchor')
    const abortToken = randomUUID()
    const name = emulatorName(roomId)
    let emulatorId: string | undefined
    // frameless fullscreen phone: rules, autostart, the fit daemon and the AVD
    // resolution override are copied into the *created* (not yet started)
    // container, so openbox can never win a race and map the emulator
    // decorated, and the AVD is born at the requested LCD size/orientation.
    try {
      const createResult = await runDocker(
        buildEmulatorArgs(roomId, opts, { networkNamespace: anchorId, abortToken }),
        {
          timeoutMs: null,
          maxStdoutBytes: 128,
          maxStderrBytes: 8 * 1024,
          killOnOutputLimit: false
        }
      )
      const candidateId = createResult.stdout.trim()
      if (/^[a-f0-9]{64}$/.test(candidateId)) emulatorId = candidateId
      must(createResult, 'create emulator container')
      if (!emulatorId) {
        throw new Error('emulator create did not return one immutable container ID')
      }
      const inert = await this.inspectContainer(emulatorId)
      this.assertOwnedEmulatorCreate(inert, roomId, name, abortToken, emulatorId, anchorId)
      if (inert?.State?.Status !== 'created') {
        throw new Error('emulator was not inert while its private configuration was installed')
      }

      const screen = emulatorScreen(opts?.orientation)
      const staging = mkdtempSync(join(tmpdir(), 'dh-openbox-'))
      try {
        mkdirSync(join(staging, 'openbox'))
        writeFileSync(join(staging, 'openbox', 'rc.xml'), openboxFramelessRc(screen.width, screen.height))
        writeFileSync(join(staging, 'openbox', 'autostart'), OPENBOX_AUTOSTART)
        writeFileSync(join(staging, 'openbox', 'fit-emulator.py'), fitEmulatorPy(screen.width, screen.height))
        writeFileSync(
          join(staging, 'avd-override.ini'),
          emulatorAvdOverride(opts?.device, opts?.resolution ?? 'balanced', opts?.orientation ?? 'portrait')
        )
        must(
          await runDocker(['cp', join(staging, 'openbox'), `${emulatorId}:/home/androidusr/.config/`]),
          'install emulator window rules'
        )
        must(
          await runDocker(['cp', join(staging, 'avd-override.ini'), `${emulatorId}:${EMULATOR_AVD_OVERRIDE_PATH}`]),
          'install emulator resolution override'
        )
      } finally {
        rmSync(staging, { recursive: true, force: true })
      }
      must(await runDocker(['start', emulatorId]), 'start emulator container')
      const started = await this.inspectContainer(emulatorId)
      this.assertOwnedEmulatorCreate(started, roomId, name, abortToken, emulatorId, anchorId)
      if (started?.State?.Status !== 'running') throw new Error('emulator did not enter the running state')
      if (this.exactRunningSandboxId(started, 'Android emulator') !== anchorSandboxId) {
        throw new Error('emulator started outside the exact control anchor network namespace')
      }
    } catch (error) {
      try {
        await this.removeAbortedEmulatorCreate(roomId, name, abortToken, emulatorId)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'emulator creation and exact cleanup both failed')
      }
      throw error
    }
  }

  async captureEmulatorScreen(
    roomId: string,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<string> {
    throwIfAborted(opts.signal)
    await this.assertPinnedEngineIdentity()
    const topology = await this.assertFencedEmulatorTopology(roomId)
    const timeoutMs = Math.min(opts.timeoutMs ?? 60_000, 120_000)
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error('emulator screen capture timeout must be a positive safe integer')
    }
    const stdout = boundedCommandOutput(SCREENSHOT_MAX_BASE64_BYTES)
    const stderr = boundedCommandOutput(64 * 1024)
    const result = await runDocker([
      'exec',
      topology.emulatorId,
      'sh',
      '-c',
      "ffmpeg -y -loglevel error -f x11grab -i :0 -frames:v 1 -f image2pipe -vcodec png - | base64 | tr -d '\\n'"
    ], {
      timeoutMs,
      signal: opts.signal,
      maxStdoutBytes: SCREENSHOT_MAX_BASE64_BYTES,
      maxStderrBytes: 64 * 1024,
      onStdout: (chunk) => stdout.push(chunk),
      onStderr: (chunk) => stderr.push(chunk)
    })
    await this.assertFencedEmulatorTopology(roomId, topology)
    throwIfAborted(opts.signal)
    if (result.outputLimitExceeded || stdout.exceeded || stderr.exceeded) {
      throw new Error('emulator screen capture exceeded its safety limit')
    }
    const completed = { ...result, stdout: stdout.text(), stderr: stderr.text() }
    must(completed, 'capture emulator screen')
    const png = completed.stdout.trim()
    if (png.length < 100) throw new Error('emulator screen capture returned no image')
    return png
  }

  async removeEmulator(roomId: string): Promise<void> {
    await this.assertPinnedEngineIdentity()
    await this.removeRoomContainer(roomId, emulatorName(roomId), 'svc-emulator')
  }

  async emulatorState(roomId: string): Promise<'running' | 'exited' | 'missing'> {
    await this.assertPinnedEngineIdentity()
    const existing = await this.inspectContainer(emulatorName(roomId))
    if (!existing) return 'missing'
    const owned = await this.assertRoomContainer(roomId, emulatorName(roomId), 'svc-emulator', existing)
    exactContainerId(owned, roomId)
    if (owned.State?.Status !== 'running') return 'exited'
    await this.assertFencedEmulatorTopology(roomId)
    return 'running'
  }

  async imageExists(image: string): Promise<boolean> {
    const result = await runDocker(['image', 'inspect', '--format', '{{.Id}}', image])
    return result.code === 0
  }

  async pullImage(image: string, log?: (line: string) => void): Promise<void> {
    await this.assertPinnedEngineIdentity()
    must(await runDocker(['pull', image], { timeoutMs: LONG_TIMEOUT_MS, onLine: log }), `pull ${image}`)
  }

  /**
   * One-time, non-destructive adoption for volumes created by DevHotel before
   * ownership labels existed. It records immutable inspect data; it never
   * recreates or deletes the legacy volume.
   */
  async adoptLegacyRoomVolumes(roomId: string): Promise<string[]> {
    if (!this.legacyVolumeAdoptionFile || !this.canAdoptLegacyVolume) return []
    await this.assertPinnedEngineIdentity()
    const prefix = `dh-${roomId}-`
    const listed = must(
      await runDocker(['volume', 'ls', '--filter', `name=${prefix}`, '--format', '{{.Name}}']),
      `discover legacy Room ${roomId} volumes`
    )
    const adopted: string[] = []
    for (const name of listed.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
      if (!name.startsWith(prefix)) continue
      try {
        assertExpectedRoomVolumeName(roomId, name)
      } catch {
        continue
      }
      const volume = await this.inspectVolume(name)
      if (!volume) throw new Error(`legacy Room volume disappeared during adoption: ${name}`)
      if (hasRoomVolumeLabels(volume, roomId, name) || (await this.isRecordedLegacyVolume(roomId, name, volume))) {
        continue
      }
      if (!this.canAdoptLegacyVolume(roomId, name)) {
        throw new Error(`legacy Room volume adoption was not authorized by DB and manifest ownership: ${name}`)
      }
      if (
        volume.Driver !== 'local' ||
        volume.Scope !== 'local' ||
        !volume.Mountpoint ||
        Object.keys(volume.Labels ?? {}).length > 0 ||
        Object.keys(volume.Options ?? {}).length > 0
      ) {
        throw new Error(`legacy Room volume has unsafe or ambiguous metadata and was not adopted: ${name}`)
      }
      const registry = await this.loadLegacyVolumeRegistry()
      registry.volumes[name] = {
        roomId,
        driver: volume.Driver,
        scope: volume.Scope,
        mountpoint: volume.Mountpoint,
        adoptedAt: new Date().toISOString()
      }
      this.writeLegacyVolumeRegistry(registry)
      adopted.push(name)
    }
    return adopted
  }

  private async ensureImage(image: string, log?: (line: string) => void): Promise<void> {
    if (!(await this.imageExists(image))) await this.pullImage(image, log)
  }

  private async assertPinnedEngineIdentity(): Promise<void> {
    if (!this.identityFile) return
    const current = await this.readEngineIdentity()
    if (this.expectedEngineIdentity === undefined) {
      if (existsSync(this.identityFile)) {
        let parsed: EngineIdentity
        try {
          parsed = JSON.parse(readFileSync(this.identityFile, 'utf8')) as EngineIdentity
        } catch {
          throw new Error(`DevHotel Docker engine identity file is unreadable: ${this.identityFile}`)
        }
        if (parsed.schema !== 1 || !parsed.context || !parsed.engineId) {
          throw new Error(`DevHotel Docker engine identity file is invalid: ${this.identityFile}`)
        }
        this.expectedEngineIdentity = parsed
      } else {
        this.expectedEngineIdentity = null
      }
    }
    const expected = this.expectedEngineIdentity
    if (!expected) {
      mkdirSync(dirname(this.identityFile), { recursive: true })
      const temp = `${this.identityFile}.${process.pid}.tmp`
      writeFileSync(temp, JSON.stringify(current, null, 2) + '\n', 'utf8')
      renameSync(temp, this.identityFile)
      this.expectedEngineIdentity = current
      return
    }
    if (expected.context !== current.context || expected.engineId !== current.engineId) {
      throw new Error(
        `Docker engine identity changed (expected ${expected.context}/${expected.engineId}, ` +
          `found ${current.context}/${current.engineId}); refusing Room operations`
      )
    }
  }

  private async readEngineIdentity(): Promise<EngineIdentity> {
    const result = must(
      await runDocker(['info', '--format', '{{json .}}'], { timeoutMs: 15_000 }),
      'read Docker engine identity'
    )
    let info: { ID?: string }
    try {
      info = JSON.parse(result.stdout) as { ID?: string }
    } catch {
      throw new Error('Docker engine returned invalid identity JSON')
    }
    const engineId = info.ID?.trim()
    if (!engineId) throw new Error('Docker engine did not report a stable engine ID')
    return { schema: 1, context: getPinnedDockerRuntime().context, engineId }
  }

  private async loadLegacyVolumeRegistry(): Promise<LegacyVolumeAdoptionRegistry> {
    if (this.legacyVolumeAdoptions) return this.legacyVolumeAdoptions
    const engine = await this.readEngineIdentity()
    if (!this.legacyVolumeAdoptionFile || !existsSync(this.legacyVolumeAdoptionFile)) {
      this.legacyVolumeAdoptions = { schema: 1, engine, volumes: {} }
      return this.legacyVolumeAdoptions
    }
    let parsed: LegacyVolumeAdoptionRegistry
    try {
      parsed = JSON.parse(readFileSync(this.legacyVolumeAdoptionFile, 'utf8')) as LegacyVolumeAdoptionRegistry
    } catch {
      throw new Error(`legacy volume adoption file is unreadable: ${this.legacyVolumeAdoptionFile}`)
    }
    if (
      parsed.schema !== 1 ||
      !parsed.engine ||
      parsed.engine.context !== engine.context ||
      parsed.engine.engineId !== engine.engineId ||
      !parsed.volumes ||
      typeof parsed.volumes !== 'object'
    ) {
      throw new Error('legacy volume adoption file does not match the pinned Docker engine')
    }
    this.legacyVolumeAdoptions = parsed
    return parsed
  }

  private writeLegacyVolumeRegistry(registry: LegacyVolumeAdoptionRegistry): void {
    if (!this.legacyVolumeAdoptionFile) throw new Error('legacy volume adoption file is not configured')
    mkdirSync(dirname(this.legacyVolumeAdoptionFile), { recursive: true })
    const temp = `${this.legacyVolumeAdoptionFile}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(registry, null, 2) + '\n', 'utf8')
    renameSync(temp, this.legacyVolumeAdoptionFile)
  }

  private async isRecordedLegacyVolume(
    roomId: string,
    name: string,
    volume: DockerVolumeInspect
  ): Promise<boolean> {
    if (!this.legacyVolumeAdoptionFile) return false
    const registry = await this.loadLegacyVolumeRegistry()
    const recorded = registry.volumes[name]
    return Boolean(
      recorded &&
        recorded.roomId === roomId &&
        recorded.driver === volume.Driver &&
        recorded.scope === volume.Scope &&
        recorded.mountpoint === volume.Mountpoint
    )
  }

  private async assertRoomVolumeOwnership(
    volume: DockerVolumeInspect,
    roomId: string,
    name: string
  ): Promise<void> {
    if (hasRoomVolumeLabels(volume, roomId, name)) return
    if (await this.isRecordedLegacyVolume(roomId, name, volume)) return
    throw new Error(`volume name collision or invalid ownership metadata: ${name}`)
  }

  private async ensureRoomVolume(roomId: string, name: string): Promise<void> {
    assertExpectedRoomVolumeName(roomId, name)
    const existing = await this.inspectVolume(name)
    if (existing) {
      await this.assertRoomVolumeOwnership(existing, roomId, name)
      return
    }
    must(
      await runDocker([
        'volume',
        'create',
        '--label',
        `devhotel.room=${roomId}`,
        '--label',
        'devhotel.role=volume',
        '--label',
        'devhotel.managed=1',
        name
      ]),
      `create Room ${roomId} volume ${name}`
    )
    const created = await this.inspectVolume(name)
    if (!created) throw new Error(`created Room volume is missing: ${name}`)
    await this.assertRoomVolumeOwnership(created, roomId, name)
  }

  private async removeRoomVolume(roomId: string, name: string): Promise<void> {
    assertExpectedRoomVolumeName(roomId, name)
    const existing = await this.inspectVolume(name)
    if (!existing) return
    await this.assertRoomVolumeOwnership(existing, roomId, name)
    must(await runDocker(['volume', 'rm', '-f', name]), `remove Room ${roomId} volume ${name}`)
    if (await this.inspectVolume(name)) {
      throw new Error(`Room ${roomId} volume cleanup incomplete: ${name}`)
    }
  }

  private async inspectVolume(name: string): Promise<DockerVolumeInspect | null> {
    const result = await runDocker(['volume', 'inspect', name])
    if (result.code !== 0) {
      const detail = `${result.stderr}\n${result.stdout}`
      if (/no such volume|not found/i.test(detail)) return null
      must(result, `inspect volume ${name}`)
    }
    let parsed: DockerVolumeInspect[]
    try {
      parsed = JSON.parse(result.stdout) as DockerVolumeInspect[]
    } catch {
      throw new Error(`inspect volume ${name} returned invalid JSON`)
    }
    if (!Array.isArray(parsed) || !parsed[0]) {
      throw new Error(`inspect volume ${name} returned no volume`)
    }
    return parsed[0]
  }

  private async ensureRoomNetwork(roomId: string): Promise<void> {
    const name = roomNetworkName(roomId)
    const existing = await this.inspectNetwork(name)
    if (existing) {
      assertRoomNetwork(existing, roomId, name)
      return
    }
    must(await runDocker(buildRoomNetworkCreateArgs(roomId)), `create room network ${name}`)
  }

  private async ensureAndroidControlNetwork(roomId: string): Promise<void> {
    const name = androidControlNetworkName(roomId)
    const existing = await this.inspectNetwork(name)
    if (existing) {
      assertRoomNetwork(existing, roomId, name)
      return
    }
    must(await runDocker(buildAndroidControlNetworkCreateArgs(roomId)), `create Android control network ${name}`)
  }

  private async ensureAndroidRuntimeAnchor(roomId: string): Promise<void> {
    await this.ensureImage(ANCHOR_IMAGE)
    await this.ensureRoomNetwork(roomId)
    const name = androidRuntimeAnchorName(roomId)
    const existing = await this.inspectContainer(name)
    if (existing) {
      const owned = await this.assertRoomContainer(roomId, name, 'android-runtime-anchor', existing)
      this.assertContainerNetworkMode(owned, roomNetworkName(roomId), 'Android runtime anchor')
      const id = exactContainerId(owned, roomId)
      if (owned.State?.Status !== 'running') {
        must(await runDocker(['start', id]), 'start Android runtime anchor')
        const started = await this.inspectContainer(id)
        if (!started || started.State?.Status !== 'running') {
          throw new Error('Android runtime anchor start did not produce a running namespace leader')
        }
        await this.assertRoomContainer(roomId, name, 'android-runtime-anchor', started)
        this.assertContainerNetworkMode(started, roomNetworkName(roomId), 'Android runtime anchor')
      }
      return
    }
    must(await runDocker(buildAndroidRuntimeAnchorArgs(roomId)), 'create Android runtime anchor')
    const created = await this.assertRoomContainer(roomId, name, 'android-runtime-anchor')
    exactContainerId(created, roomId)
    this.assertContainerNetworkMode(created, roomNetworkName(roomId), 'Android runtime anchor')
    if (created.State?.Status !== 'running') {
      throw new Error('Android runtime anchor was not running after creation')
    }
  }

  private async rollbackPartialAndroidTopology(roomId: string): Promise<void> {
    const failures: unknown[] = []
    for (const [name, role] of [
      [webName(roomId), 'web'],
      [androidRuntimeAnchorName(roomId), 'android-runtime-anchor'],
      [anchorName(roomId), 'anchor']
    ] as const) {
      try {
        await this.removeRoomContainer(roomId, name, role)
      } catch (error) {
        failures.push(error)
      }
    }
    try {
      await this.removeAndroidControlNetwork(roomId)
    } catch (error) {
      failures.push(error)
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'partial Android topology cleanup was incomplete')
    }
  }

  private async removeAndroidControlDependents(roomId: string): Promise<void> {
    const anchor = await this.inspectContainer(anchorName(roomId))
    let anchorId: string | null = null
    if (anchor) {
      await this.assertRoomContainer(roomId, anchorName(roomId), 'anchor', anchor)
      anchorId = exactContainerId(anchor, roomId)
    }
    for (const [name, role] of [
      [webName(roomId), 'web'],
      [svcName(roomId, 'postgres'), 'svc-postgres'],
      [svcName(roomId, 'redis'), 'svc-redis'],
      [emulatorName(roomId), 'svc-emulator']
    ] as const) {
      const container = await this.inspectContainer(name)
      if (!container) continue
      await this.assertRoomContainer(roomId, name, role, container)
      const mode = container.HostConfig?.NetworkMode ?? ''
      if (mode === `container:${anchorName(roomId)}` || (anchorId && mode === `container:${anchorId}`)) {
        await this.removeRoomContainer(roomId, name, role)
      }
    }
  }

  private assertContainerNetworkMode(
    container: DockerContainerInspect,
    expectedNetwork: string,
    what: string
  ): void {
    if (container.HostConfig?.NetworkMode !== expectedNetwork) {
      throw new Error(`${what} is not attached to its exact owned bridge network`)
    }
  }

  private assertContainerNetworkNamespace(
    container: DockerContainerInspect,
    expectedName: string,
    expectedId: string,
    what: string
  ): void {
    const mode = container.HostConfig?.NetworkMode ?? ''
    if (mode !== `container:${expectedName}` && mode !== `container:${expectedId}`) {
      throw new Error(`${what} is not attached to the exact Android runtime namespace`)
    }
  }

  private exactRunningSandboxId(container: DockerContainerInspect, what: string): string {
    if (container.State?.Status !== 'running') {
      throw new Error(`${what} is not running in a live network namespace`)
    }
    const sandboxId = container.NetworkSettings?.SandboxID?.trim() ?? ''
    if (!/^[a-f0-9]{64}$/.test(sandboxId)) {
      throw new Error(`${what} did not report a valid live network namespace identity`)
    }
    return sandboxId
  }

  private async assertCurrentAndroidRuntimeAnchor(
    roomId: string,
    expectedId: string,
    expectedSandboxId: string
  ): Promise<void> {
    const current = await this.inspectContainer(expectedId)
    if (!current) {
      throw new Error('Android runtime anchor disappeared before service validation completed')
    }
    await this.assertRoomContainer(
      roomId,
      androidRuntimeAnchorName(roomId),
      'android-runtime-anchor',
      current
    )
    if (exactContainerId(current, roomId) !== expectedId) {
      throw new Error('Android runtime anchor immutable ID changed before service validation completed')
    }
    this.assertContainerNetworkMode(current, roomNetworkName(roomId), 'Android runtime anchor')
    if (this.exactRunningSandboxId(current, 'Android runtime anchor') !== expectedSandboxId) {
      throw new Error('Android runtime anchor network namespace changed before service validation completed')
    }
  }

  private async removeRoomNetwork(roomId: string): Promise<void> {
    const name = roomNetworkName(roomId)
    const existing = await this.inspectNetwork(name)
    if (!existing) return
    assertRoomNetwork(existing, roomId, name)
    must(await runDocker(['network', 'rm', name]), `remove room network ${name}`)
    if (await this.inspectNetwork(name)) {
      throw new Error(`Room ${roomId} network cleanup incomplete: ${name}`)
    }
  }

  private async removeAndroidControlNetwork(roomId: string): Promise<void> {
    const name = androidControlNetworkName(roomId)
    const existing = await this.inspectNetwork(name)
    if (!existing) return
    assertRoomNetwork(existing, roomId, name)
    must(await runDocker(['network', 'rm', name]), `remove Android control network ${name}`)
    if (await this.inspectNetwork(name)) {
      throw new Error(`Room ${roomId} Android control network cleanup incomplete: ${name}`)
    }
  }

  private async inspectNetwork(name: string): Promise<DockerNetworkInspect | null> {
    const result = await runDocker(['network', 'inspect', name])
    if (result.code !== 0) {
      const detail = `${result.stderr}\n${result.stdout}`
      if (/no such network|not found/i.test(detail)) return null
      must(result, `inspect network ${name}`)
    }
    let parsed: DockerNetworkInspect[]
    try {
      parsed = JSON.parse(result.stdout) as DockerNetworkInspect[]
    } catch {
      throw new Error(`inspect network ${name} returned invalid JSON`)
    }
    if (!Array.isArray(parsed) || !parsed[0]) {
      throw new Error(`inspect network ${name} returned no network`)
    }
    return parsed[0]
  }

  private async inspectContainer(name: string): Promise<DockerContainerInspect | null> {
    const result = await runDocker(['inspect', name])
    if (result.code !== 0) {
      const detail = `${result.stderr}\n${result.stdout}`
      if (/no such object|no such container|not found/i.test(detail)) return null
      must(result, `inspect container ${name}`)
    }
    let parsed: DockerContainerInspect[]
    try {
      parsed = JSON.parse(result.stdout) as DockerContainerInspect[]
    } catch {
      throw new Error(`inspect container ${name} returned invalid JSON`)
    }
    if (!Array.isArray(parsed) || !parsed[0]) {
      throw new Error(`inspect container ${name} returned no container`)
    }
    return parsed[0]
  }

  private async assertRoomContainer(
    roomId: string,
    name: string,
    role: string,
    inspected?: DockerContainerInspect
  ): Promise<DockerContainerInspect> {
    const container = inspected ?? (await this.inspectContainer(name))
    if (!container) throw new Error(`Room ${roomId} container is missing: ${name}`)
    const actualName = (container.Name ?? '').replace(/^\//, '')
    const labels = container.Config?.Labels ?? {}
    if (
      actualName !== name ||
      labels['devhotel.room'] !== roomId ||
      labels['devhotel.role'] !== role ||
      labels['devhotel.managed'] !== '1' ||
      !isExpectedRoomContainer(roomId, actualName, role)
    ) {
      throw new Error(`Room ${roomId} container ownership metadata is invalid: ${name}`)
    }
    return container
  }

  private async removeRoomContainer(roomId: string, name: string, role: string): Promise<void> {
    const existing = await this.inspectContainer(name)
    if (!existing) return
    await this.assertRoomContainer(roomId, name, role)
    must(await runDocker(['rm', '-f', name]), `remove Room ${roomId} container ${name}`)
    if (await this.inspectContainer(name)) throw new Error(`Room ${roomId} container cleanup incomplete: ${name}`)
  }

  private async removeFailedCreatedService(
    roomId: string,
    svc: 'postgres' | 'redis',
    creationToken: string,
    expectedId?: string
  ): Promise<void> {
    const name = svcName(roomId, svc)
    const existing = await this.inspectContainer(expectedId ?? name)
    if (!existing) return
    const labels = existing.Config?.Labels ?? {}
    const owned = (existing.Name ?? '').replace(/^\//, '') === name &&
      labels['devhotel.room'] === roomId &&
      labels['devhotel.role'] === `svc-${svc}` &&
      labels['devhotel.managed'] === '1' &&
      labels['devhotel.creation-token'] === creationToken
    if (!owned) {
      if (expectedId) throw new Error(`Refusing to clean up a ${svc} container whose creation ownership changed`)
      return
    }
    const id = exactContainerId(existing, roomId)
    if (expectedId && id !== expectedId) {
      throw new Error(`Refusing to clean up a replacement ${svc} container`)
    }
    must(await runDocker(['rm', '-f', id]), `remove failed ${svc} container`)
    if (await this.inspectContainer(id)) {
      throw new Error(`The exact failed ${svc} container still exists after cleanup`)
    }
  }

  private async removeMisboundStartedService(
    roomId: string,
    svc: 'postgres' | 'redis',
    expectedId: string
  ): Promise<void> {
    const existing = await this.inspectContainer(expectedId)
    if (!existing) return
    if (exactContainerId(existing, roomId) !== expectedId) {
      throw new Error(`Refusing to clean up a replacement ${svc} container after namespace mismatch`)
    }
    must(await runDocker(['rm', '-f', expectedId]), `remove misbound ${svc} container`)
    if (await this.inspectContainer(expectedId)) {
      throw new Error(`The exact misbound ${svc} container still exists after cleanup`)
    }
  }

  private async listRoomContainers(roomId: string): Promise<ManagedRoomContainer[]> {
    const result = must(
      await runDocker([
        'ps',
        '-a',
        '--filter',
        `label=devhotel.room=${roomId}`,
        '--filter',
        'label=devhotel.managed=1',
        '--format',
        '{{json .}}'
      ]),
      `list Room ${roomId} containers`
    )
    const containers: ManagedRoomContainer[] = []
    for (const line of result.stdout.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let row: { ID?: string; Names?: string; Labels?: string; State?: string }
      try {
        row = JSON.parse(trimmed) as { ID?: string; Names?: string; Labels?: string; State?: string }
      } catch {
        throw new Error(`list Room ${roomId} containers returned invalid JSON`)
      }
      const id = row.ID ?? ''
      const name = row.Names ?? ''
      const state = row.State ?? ''
      const labels = parseDockerLabels(row.Labels ?? '')
      const role = labels.get('devhotel.role') ?? ''
      if (
        !/^[a-f0-9]+$/.test(id) ||
        !state ||
        labels.get('devhotel.room') !== roomId ||
        labels.get('devhotel.managed') !== '1' ||
        !isExpectedRoomContainer(roomId, name, role)
      ) {
        throw new Error(`Room ${roomId} container ownership metadata is invalid: ${name || id || 'unknown'}`)
      }
      containers.push({ id, name, role, state })
    }
    return [...new Map(containers.map((container) => [container.id, container])).values()]
  }

  private async readHostPort(roomId: string): Promise<number> {
    const anchor = await this.assertRelayAnchorAuthority(roomId)
    const result = must(
      await runDocker(['port', exactContainerId(anchor, roomId), `${RELAY_PORT}/tcp`]),
      'read anchor host port',
    )
    return parsePortOutput(result.stdout)
  }

  private async assertRelayAnchorAuthority(roomId: string): Promise<DockerContainerInspect> {
    const anchor = await this.assertRoomContainer(roomId, anchorName(roomId), 'anchor')
    if (anchor.State?.Status !== 'running') throw new Error(`Room ${roomId} relay control anchor is not running`)
    const anchorId = exactContainerId(anchor, roomId)
    const controlName = androidControlNetworkName(roomId)
    const control = await this.inspectNetwork(controlName)
    const networkName = control ? controlName : roomNetworkName(roomId)
    const network = control ?? (await this.inspectNetwork(networkName))
    if (!network) throw new Error(`Room ${roomId} relay network is missing`)
    assertRoomNetwork(network, roomId, networkName)
    this.assertContainerNetworkMode(anchor, networkName, 'Room relay control anchor')
    const member = network.Containers?.[anchorId]
    if (member?.Name !== anchorName(roomId)) {
      throw new Error(`Room ${roomId} relay network does not contain the exact control anchor endpoint`)
    }
    if (control && Object.keys(control.Containers ?? {}).length !== 1) {
      throw new Error('Android control network contains a workload outside the exact relay anchor endpoint')
    }
    return anchor
  }

  private newRelayToken(): string {
    const token = this.relayTokenFactory()
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('relay token factory returned an invalid token')
    return token
  }

  private async listRoomVolumes(roomId: string): Promise<string[]> {
    const prefix = `dh-${roomId}-`
    const result = must(
      await runDocker(['volume', 'ls', '--filter', `name=${prefix}`, '--format', '{{.Name}}']),
      `list Room ${roomId} volumes`
    )
    const names = result.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((name) => name.startsWith(prefix))
    for (const name of names) {
      assertExpectedRoomVolumeName(roomId, name)
      const volume = await this.inspectVolume(name)
      if (!volume) throw new Error(`Room ${roomId} volume disappeared during enumeration: ${name}`)
      try {
        await this.assertRoomVolumeOwnership(volume, roomId, name)
      } catch {
        throw new Error(
          `refusing to treat unowned or legacy volume as Room ${roomId} data: ${name}; explicit migration is required`
        )
      }
    }
    return [...new Set(names)]
  }
}

interface ManagedRoomContainer {
  id: string
  name: string
  role: string
  state: string
}

interface DockerVolumeInspect {
  Name?: string
  Driver?: string
  Scope?: string
  Mountpoint?: string
  Labels?: Record<string, string> | null
  Options?: Record<string, string> | null
}

interface DockerNetworkInspect {
  Name?: string
  Driver?: string
  Labels?: Record<string, string> | null
  Containers?: Record<string, { Name?: string } | null> | null
}

interface DockerContainerInspect {
  Id?: string
  Name?: string
  Config?: { Labels?: Record<string, string> | null } | null
  State?: { Status?: string; Paused?: boolean } | null
  HostConfig?: { NetworkMode?: string } | null
  NetworkSettings?: { SandboxID?: string; SandboxKey?: string } | null
}

interface FencedEmulatorTopology {
  anchorId: string
  runtimeAnchorId: string
  webId: string
  emulatorId: string
  controlSandboxId: string
  runtimeSandboxId: string
}

function exactContainerId(container: DockerContainerInspect, roomId: string): string {
  const id = container.Id?.trim() ?? ''
  if (!/^[a-f0-9]{12,64}$/.test(id)) {
    throw new Error(`Room ${roomId} container did not report a valid immutable ID`)
  }
  return id
}

interface EngineIdentity {
  schema: 1
  context: string
  engineId: string
}

interface LegacyVolumeAdoptionRegistry {
  schema: 1
  engine: EngineIdentity
  volumes: Record<
    string,
    { roomId: string; driver: string; scope: string; mountpoint: string; adoptedAt: string }
  >
}

function isExpectedRoomContainer(roomId: string, name: string, role: string): boolean {
  switch (role) {
    case 'anchor':
      return name === anchorName(roomId)
    case 'android-runtime-anchor':
      return name === androidRuntimeAnchorName(roomId)
    case 'web':
      return name === webName(roomId)
    case 'job':
      return isJobName(roomId, name)
    case 'svc-postgres':
      return name === svcName(roomId, 'postgres')
    case 'svc-redis':
      return name === svcName(roomId, 'redis')
    case 'svc-emulator':
      return name === emulatorName(roomId)
    default:
      return false
  }
}

function isStoppedContainerState(state: string): boolean {
  return state === 'exited' || state === 'created'
}

function assertExpectedRoomVolumeName(roomId: string, name: string): void {
  const prefix = `dh-${roomId}-`
  if (!name.startsWith(prefix)) throw new Error(`invalid Room ${roomId} volume name: ${name}`)
  const suffix = name.slice(prefix.length)
  const expected =
    suffix === 'src' ||
    /^src-r[1-9][0-9]*$/.test(suffix) ||
    /^src-build-[a-f0-9]{32}$/.test(suffix) ||
    suffix === 'cache' ||
    suffix === 'sdk' ||
    /^deps-node[a-z0-9_.-]+$/i.test(suffix) ||
    /^svc-(postgres|redis)-data$/.test(suffix)
  if (!expected) throw new Error(`unexpected Room ${roomId} volume name: ${name}`)
}

function hasRoomVolumeLabels(volume: DockerVolumeInspect, roomId: string, name: string): boolean {
  const labels = volume.Labels ?? {}
  return (
    volume.Name === name &&
    labels['devhotel.room'] === roomId &&
    labels['devhotel.role'] === 'volume' &&
    labels['devhotel.managed'] === '1'
  )
}

function parseDockerLabels(value: string): Map<string, string> {
  const labels = new Map<string, string>()
  for (const pair of value.split(',')) {
    const eq = pair.indexOf('=')
    if (eq > 0) labels.set(pair.slice(0, eq), pair.slice(eq + 1))
  }
  return labels
}

function assertManagedNetworkName(name: string): void {
  if (!/^dh-[a-z0-9][a-z0-9_.-]*-net$/.test(name)) {
    throw new Error(`invalid DevHotel network name: ${name}`)
  }
}

function assertRoomNetwork(network: DockerNetworkInspect, roomId: string, name: string): void {
  if (name !== roomNetworkName(roomId) && name !== androidControlNetworkName(roomId)) {
    throw new Error(`invalid Room network identity: ${name}`)
  }
  const labels = network.Labels ?? {}
  if (
    network.Name !== name ||
    network.Driver !== 'bridge' ||
    labels['devhotel.room'] !== roomId ||
    labels['devhotel.role'] !== 'network' ||
    labels['devhotel.managed'] !== '1'
  ) {
    throw new Error(`network name collision or invalid ownership metadata: ${name}`)
  }
}

function assertAndroidNetworkMembership(
  control: DockerNetworkInspect,
  runtime: DockerNetworkInspect,
  roomId: string,
  controlAnchorId: string,
  runtimeAnchorId: string
): void {
  const controlMembers = Object.entries(control.Containers ?? {})
  if (
    controlMembers.length !== 1 ||
    controlMembers[0]?.[0] !== controlAnchorId ||
    controlMembers[0]?.[1]?.Name !== anchorName(roomId)
  ) {
    throw new Error('Android control network must contain only the exact owned control anchor endpoint')
  }
  const runtimeMembers = runtime.Containers ?? {}
  if (
    runtimeMembers[controlAnchorId] !== undefined ||
    runtimeMembers[runtimeAnchorId]?.Name !== androidRuntimeAnchorName(roomId)
  ) {
    throw new Error('Android runtime and control network endpoint sets are not disjoint')
  }
}
