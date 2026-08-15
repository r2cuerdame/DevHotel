import { createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { getPinnedDockerRuntime, runDocker, spawnDockerProcess } from './cli'
import {
  ANCHOR_IMAGE,
  EMULATOR_AVD_OVERRIDE_PATH,
  EMULATOR_IMAGE,
  RELAY_PORT,
  anchorName,
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
  parsePortOutput,
  roomNetworkName,
  srcVolume,
  svcImage,
  svcName,
  svcVolume,
  webName,
  workspaceSnapshotVolume,
} from './naming'
import type { AnchorSpec, ExecResult, ExportedArtifact, IsolationBackend, ManagedNetwork, WebSpec } from './types'

const CLONE_IMAGE = 'alpine/git'
const DU_IMAGE = 'alpine'
const LONG_TIMEOUT_MS = 600_000

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
    await this.ensureRoomNetwork(spec.roomId)
    if (!spec.standalone) {
      const relayToken = this.newRelayToken()
      must(
        await runDocker(
          buildAnchorArgs(
            { roomId: spec.roomId, internalPort: spec.internalPort },
            createHash('sha256').update(relayToken).digest('hex')
          )
        ),
        'run anchor container',
      )
      this.relayTokens.set(spec.roomId, relayToken)
    }
    must(await runDocker(buildWebCreateArgs(spec)), 'create web container')
    if (startWeb) await this.startWeb(spec.roomId)
    return { hostPort: spec.standalone ? null : await this.readHostPort(spec.roomId) }
  }

  async relayToken(roomId: string): Promise<string> {
    await this.assertPinnedEngineIdentity()
    const cached = this.relayTokens.get(roomId)
    if (cached) return cached
    // The raw capability deliberately never enters a Room container, mount,
    // manifest, or docker-inspectable value. App startup reconciliation
    // recreates anchors before routing them, issuing a fresh in-memory token.
    throw new Error(`Room ${roomId} relay credential is not available; recreate its anchor`)
  }

  async startRoomPod(roomId: string, opts: { standalone?: boolean } = {}): Promise<{ hostPort: number | null }> {
    await this.assertPinnedEngineIdentity()
    if (!opts.standalone) {
      await this.assertRoomContainer(roomId, anchorName(roomId), 'anchor')
      must(await runDocker(['start', anchorName(roomId)]), 'start anchor container')
    }
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
    const rest = active.filter((container) => container.role !== 'web').map((container) => container.id)
    if (web.length > 0) must(await runDocker(['stop', '-t', '8', ...web]), `stop Room ${roomId} web container`)
    if (rest.length > 0) must(await runDocker(['stop', '-t', '5', ...rest]), `stop Room ${roomId} containers`)
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
    await this.removeRoomContainer(spec.roomId, webName(spec.roomId), 'web')
    must(await runDocker(buildWebCreateArgs(spec)), 'create web container')
    await this.startWeb(spec.roomId)
  }

  async recreateAnchor(spec: AnchorSpec): Promise<{ hostPort: number }> {
    await this.assertPinnedEngineIdentity()
    await this.adoptLegacyRoomVolumes(spec.roomId)
    await this.ensureImage(ANCHOR_IMAGE)
    await this.ensureRoomNetwork(spec.roomId)
    await this.removeRoomContainer(spec.roomId, anchorName(spec.roomId), 'anchor')
    const relayToken = this.newRelayToken()
    this.relayTokens.delete(spec.roomId)
    must(
      await runDocker(buildAnchorArgs(spec, createHash('sha256').update(relayToken).digest('hex'))),
      'run anchor container'
    )
    this.relayTokens.set(spec.roomId, relayToken)
    return { hostPort: await this.readHostPort(spec.roomId) }
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
    if (existingNetwork) assertRoomNetwork(existingNetwork, roomId)
    const anchorIds = containers.filter((container) => container.role === 'anchor').map((container) => container.id)
    const dependentIds = containers.filter((container) => container.role !== 'anchor').map((container) => container.id)
    if (dependentIds.length > 0) {
      must(await runDocker(['rm', '-f', ...dependentIds]), `remove Room ${roomId} containers`)
    }
    if (anchorIds.length > 0) {
      must(await runDocker(['rm', '-f', ...anchorIds]), `remove Room ${roomId} anchor`)
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

  async execInRoom(roomId: string, cmd: string[], opts?: { timeoutMs?: number }): Promise<ExecResult> {
    await this.assertPinnedEngineIdentity()
    const container = await this.assertRoomContainer(roomId, webName(roomId), 'web')
    return runDocker(['exec', exactContainerId(container, roomId), ...cmd], { timeoutMs: opts?.timeoutMs })
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
            "cd /workspace && find . -type f -path '*/build/outputs/apk/*' -name '*.apk' -exec sh -c 'for file do rel=${file#./}; mkdir -p \"/out/${rel%/*}\"; cp \"$file\" \"/out/$rel\"; done' sh {} +"
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
    if (
      network.Name !== name ||
      labels['devhotel.managed'] !== '1' ||
      labels['devhotel.role'] !== 'network'
    ) {
      throw new Error(`refusing to remove network not owned by DevHotel: ${name}`)
    }
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
            "tar -C /source --exclude='./node_modules' --exclude='*/node_modules' --exclude='./.next' --exclude='*/.next' --exclude='./dist' --exclude='*/dist' --exclude='./build' --exclude='*/build' --exclude='./coverage' --exclude='*/coverage' --exclude='./.gradle' --exclude='*/.gradle' -cf - . | tar -C /workspace -xf -"
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
        // Content identity of the Room's *source*, deliberately not a
        // filesystem snapshot: generated trees are pruned entirely (their own
        // directory entry included, or a first build would permanently look
        // like drift) and mtime is excluded (touching a file without changing
        // it is not a Room-side edit). Mode/uid/gid and content still count.
        "set -eu; sync_paths=$(mktemp); sync_sorted=$(mktemp); sync_records=$(mktemp); cd /workspace; find . -mindepth 1 \\( -type d \\( -name node_modules -o -name .next -o -name dist -o -name build -o -name coverage -o -name .gradle -o -path '*/.git/objects' \\) \\) -prune -o -print0 > \"$sync_paths\"; sort -z \"$sync_paths\" > \"$sync_sorted\"; while IFS= read -r -d '' path; do path_hash=$(printf '%s' \"$path\" | sha256sum); path_hash=${path_hash%% *}; metadata=$(stat -c '%f:%u:%g' \"$path\"); if [ -L \"$path\" ]; then kind=L; content_hash=$(readlink -n \"$path\" | sha256sum); content_hash=${content_hash%% *}; elif [ -f \"$path\" ]; then kind=F; content_hash=$(sha256sum \"$path\"); content_hash=${content_hash%% *}; elif [ -d \"$path\" ]; then kind=D; content_hash=-; else echo \"unsupported workspace object: $path\" >&2; exit 2; fi; printf '%s %s %s %s\\n' \"$kind\" \"$metadata\" \"$path_hash\" \"$content_hash\" >> \"$sync_records\"; done < \"$sync_sorted\"; sha256sum \"$sync_records\""
      ]),
      'fingerprint Room workspace'
    )
    const fingerprint = result.stdout.trim().split(/\s+/)[0] ?? ''
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('workspace helper returned an invalid fingerprint')
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
    await this.ensureImage(svcImage(svc, version))
    await this.ensureRoomVolume(roomId, svcVolume(roomId, svc))
    must(await runDocker(buildServiceArgs(roomId, svc, version)), `run ${svc} container`)
    const created = await this.assertRoomContainer(roomId, svcName(roomId, svc), `svc-${svc}`)
    exactContainerId(created, roomId)
  }

  async startService(roomId: string, svc: 'postgres' | 'redis'): Promise<void> {
    await this.assertPinnedEngineIdentity()
    const name = svcName(roomId, svc)
    const existing = await this.assertRoomContainer(roomId, name, `svc-${svc}`)
    const id = exactContainerId(existing, roomId)
    must(await runDocker(['start', id]), `start ${svc}`)
    const started = await this.inspectContainer(id)
    if (!started || started.State?.Status !== 'running') throw new Error(`${svc} start incomplete: ${name}`)
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

  async createEmulator(
    roomId: string,
    opts?: { device: string; version: string; resolution?: 'native' | 'balanced' | 'fast'; orientation?: 'portrait' | 'landscape' }
  ): Promise<void> {
    await this.assertPinnedEngineIdentity()
    await this.ensureImage(opts?.version ? emulatorImage(opts.version) : EMULATOR_IMAGE)
    // frameless fullscreen phone: rules, autostart, the fit daemon and the AVD
    // resolution override are copied into the *created* (not yet started)
    // container, so openbox can never win a race and map the emulator
    // decorated, and the AVD is born at the requested LCD size/orientation.
    must(await runDocker(buildEmulatorArgs(roomId, opts)), 'create emulator container')
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
        await runDocker(['cp', join(staging, 'openbox'), `${emulatorName(roomId)}:/home/androidusr/.config/`]),
        'install emulator window rules'
      )
      must(
        await runDocker(['cp', join(staging, 'avd-override.ini'), `${emulatorName(roomId)}:${EMULATOR_AVD_OVERRIDE_PATH}`]),
        'install emulator resolution override'
      )
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
    must(await runDocker(['start', emulatorName(roomId)]), 'start emulator container')
  }

  async captureEmulatorScreen(roomId: string): Promise<string> {
    await this.assertPinnedEngineIdentity()
    const result = await runDocker([
      'exec',
      emulatorName(roomId),
      'sh',
      '-c',
      "ffmpeg -y -loglevel error -f x11grab -i :0 -frames:v 1 -f image2pipe -vcodec png - | base64 | tr -d '\\n'"
    ])
    must(result, 'capture emulator screen')
    const png = result.stdout.trim()
    if (png.length < 100) throw new Error('emulator screen capture returned no image')
    return png
  }

  async removeEmulator(roomId: string): Promise<void> {
    await this.assertPinnedEngineIdentity()
    await this.removeRoomContainer(roomId, emulatorName(roomId), 'svc-emulator')
  }

  async emulatorState(roomId: string): Promise<'running' | 'exited' | 'missing'> {
    const result = await runDocker(['inspect', '--format', '{{.State.Status}}', emulatorName(roomId)])
    if (result.code !== 0) return 'missing'
    return result.stdout.trim() === 'running' ? 'running' : 'exited'
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
      assertRoomNetwork(existing, roomId)
      return
    }
    must(await runDocker(buildRoomNetworkCreateArgs(roomId)), `create room network ${name}`)
  }

  private async removeRoomNetwork(roomId: string): Promise<void> {
    const name = roomNetworkName(roomId)
    const existing = await this.inspectNetwork(name)
    if (!existing) return
    assertRoomNetwork(existing, roomId)
    must(await runDocker(['network', 'rm', name]), `remove room network ${name}`)
    if (await this.inspectNetwork(name)) {
      throw new Error(`Room ${roomId} network cleanup incomplete: ${name}`)
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
    const result = must(
      await runDocker(['port', anchorName(roomId), `${RELAY_PORT}/tcp`]),
      'read anchor host port',
    )
    return parsePortOutput(result.stdout)
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
}

interface DockerContainerInspect {
  Id?: string
  Name?: string
  Config?: { Labels?: Record<string, string> | null } | null
  State?: { Status?: string } | null
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

function assertRoomNetwork(network: DockerNetworkInspect, roomId: string): void {
  const name = roomNetworkName(roomId)
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
