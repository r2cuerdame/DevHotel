import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OciCliBackend, openboxFramelessRc, fitEmulatorPy, type OciCliBackendOptions } from './ociCli'
import { MANAGED_RUNTIME_GUEST_STAGE_ROOT } from './managedRuntimeGuestAgent'
import type { ManagedRuntimeEngine } from './managedRuntimeEngine'
import type { ManagedRuntimeIngress } from './managedRuntimeIngress'
import type { ExecResult, GitCredential } from './types'
import {
  androidAvdPlan,
  androidEmulatorLaunch,
  buildManagedEmulatorContainerArgs
} from './androidEmulatorLaunch'
import { pinnedAndroidVersions } from './androidSdkPin'
import { anchorName, emulatorName, emulatorScreen, EMULATOR_IMAGE, emulatorImage } from './naming'


/**
 * Where a Host path has to be staged before the guest engine can see it.
 * Relative to the agent's staging root, which the agent refuses to escape.
 */
function stagedName(hostPath: string): string {
  // The Host's own path never crosses: only its basename, which keeps a
  // meaningful name in guest diagnostics without disclosing the Host layout —
  // the same rule the rest of the backend follows for Host detail.
  return `${randomUUID()}-${basename(hostPath).replace(/[^A-Za-z0-9._-]/g, '_') || 'file'}`
}

export interface ManagedRoomBackendOptions extends Omit<OciCliBackendOptions, 'engine'> {
  engine: ManagedRuntimeEngine
  ingress: ManagedRuntimeIngress
  /** Where the guest agent is reachable; the forwarders point at this address. */
  guestAddress: string
}

/**
 * Web Rooms running inside the DevHotel-managed Linux runtime.
 *
 * It is a subclass rather than a second `IsolationBackend` on purpose, and that
 * is the central design decision of #107. The Room model — the anchor container
 * that owns a network namespace, role containers that join it, per-Room bridge
 * networks and subnet allocation, owned volume generations for workspace, deps
 * and cache, the ownership labels every destructive operation re-proves, the
 * relay token that gates ingress — is not Docker-specific. It is DevHotel's, and
 * it is what makes two Rooms able to serve internal port 3000 at once and a
 * Room's state survive sleep and wake. Reimplementing it against a second engine
 * would mean maintaining two copies of the rules that keep Rooms isolated, and
 * the copies would drift; the first divergence would be a Room deleting
 * something it did not own.
 *
 * So the engine moves and the rules do not. Everything inherited here reaches
 * the guest engine through the injected executor. What this class adds is only
 * the three places where a hypervisor boundary genuinely changes the meaning of
 * an operation:
 *
 * 1. **Ingress.** The engine publishes on the guest, so the Host runs a loopback
 *    forwarder per Room and hands the Gateway the same kind of port it always
 *    had.
 * 2. **Host paths.** `docker cp <host path>` and a `-v <host path>` bind are
 *    silently wrong against a remote engine — they resolve inside the guest — so
 *    every Host-path crossing is staged explicitly instead.
 * 3. **Teardown.** A Room that stops or is deleted must not leave a Host port
 *    listening for a guest container that no longer exists.
 */
export class ManagedRoomBackend extends OciCliBackend {
  private readonly managedEngine: ManagedRuntimeEngine
  private readonly ingress: ManagedRuntimeIngress
  private readonly guestAddress: string

  constructor(opts: ManagedRoomBackendOptions) {
    super({ ...opts, engine: opts.engine })
    this.managedEngine = opts.engine
    this.ingress = opts.ingress
    this.guestAddress = opts.guestAddress
  }

  /**
   * The guest engine must publish on an interface the Host can reach. This is
   * wider than the compatibility backend's loopback binding, and it is bounded
   * by two things that are not weakened: the Default Switch is a NAT'd private
   * network rather than a bridge onto the user's LAN, and the relay gate still
   * refuses any connection that does not present the Room's relay token.
   */
  protected override get relayPublishAddress(): string {
    return '0.0.0.0'
  }

  protected override async reachHostPort(roomId: string, publishedPort: number): Promise<number> {
    return await this.ingress.publish(roomId, { host: this.guestAddress, port: publishedPort })
  }

  override async stopRoomPod(roomId: string): Promise<void> {
    await super.stopRoomPod(roomId)
    // A sleeping Room's Host port would otherwise accept a connection and hang
    // against a container that is no longer listening, which reads to the user
    // as a Room that is up and broken rather than asleep.
    await this.ingress.revoke(roomId)
  }

  override async deleteRoomPod(roomId: string, opts: { volumes: boolean }): Promise<{ reclaimedBytes: number }> {
    const result = await super.deleteRoomPod(roomId, opts)
    await this.ingress.revoke(roomId)
    return result
  }

  override async copyIntoRoom(roomId: string, hostPath: string, containerPath: string): Promise<void> {
    const staged = stagedName(hostPath)
    await this.managedEngine.putFile(hostPath, staged)
    try {
      await super.copyIntoRoom(roomId, `${MANAGED_RUNTIME_GUEST_STAGE_ROOT}/${staged}`, containerPath)
    } finally {
      await this.discardStaged(staged)
    }
  }

  override async copyFromRoom(roomId: string, containerPath: string, hostPath: string): Promise<void> {
    const staged = stagedName(hostPath)
    await super.copyFromRoom(roomId, containerPath, `${MANAGED_RUNTIME_GUEST_STAGE_ROOT}/${staged}`)
    try {
      await this.managedEngine.getFile(staged, hostPath)
    } finally {
      await this.discardStaged(staged)
    }
  }

  /**
   * Detection needs the repository on the *Host*, because the detection engine
   * reads it with Host file APIs. The clone therefore runs guest-side into the
   * staging root and the tree is brought back as one archive — a Host bind mount
   * would have resolved inside the guest and produced an empty directory the
   * caller would have read as an empty repository.
   */
  override async cloneToHostDirectory(
    gitUrl: string,
    hostPath: string,
    opts: { credential?: GitCredential | null; timeoutMs?: number } = {}
  ): Promise<ExecResult> {
    const staged = stagedName('source.tar')
    const guestArchive = `${MANAGED_RUNTIME_GUEST_STAGE_ROOT}/${staged}`
    const clone = await super.cloneToHostDirectory(gitUrl, `${MANAGED_RUNTIME_GUEST_STAGE_ROOT}/${staged}.d`, opts)
    if (clone.code !== 0) {
      await this.discardStaged(`${staged}.d`)
      return clone
    }
    const local = mkdtempSync(join(tmpdir(), 'dh-managed-clone-'))
    try {
      const pack = await this.managedEngine.run([
        'run',
        '--rm',
        '--network',
        'none',
        '-v',
        `${guestArchive}.d:/src:ro`,
        '-v',
        `${MANAGED_RUNTIME_GUEST_STAGE_ROOT}:/out`,
        'alpine/git',
        '--',
        'tar',
        '-cf',
        `/out/${staged}`,
        '-C',
        '/src',
        '.'
      ])
      if (pack.code !== 0) return pack
      const archive = join(local, 'source.tar')
      await this.managedEngine.getFile(staged, archive)
      await extractTarTo(archive, hostPath)
      return { code: 0, stdout: '', stderr: '' }
    } finally {
      rmSync(local, { recursive: true, force: true })
      await this.discardStaged(staged)
      await this.discardStaged(`${staged}.d`)
    }
  }

  /**
   * Staged bytes are Room input or Room output, so they do not outlive the
   * operation that needed them. A failure to clean up must not fail the
   * operation: the staging root is inside the runtime and is reclaimed with it.
   */
  private async discardStaged(name: string): Promise<void> {
    await this.managedEngine
      .run(['run', '--rm', '-v', `${MANAGED_RUNTIME_GUEST_STAGE_ROOT}:/stage`, 'alpine/git', '--', 'rm', '-rf', `/stage/${name}`])
      .catch(() => undefined)
  }

  /**
   * Create the Android emulator sidecar for a managed Room (#108).
   *
   * **Managed path (pinned Android version):** uses `androidAvdPlan` +
   * `androidEmulatorLaunch` + `buildManagedEmulatorContainerArgs` to launch the
   * emulator directly — no docker-android supervisord, no env-var interface. The
   * per-Room AVD volume survives container recreation; quickboot saves/loads are
   * left alone so warm-Room state persists across sleep/wake cycles (#78).
   *
   * **Compatibility fallback (unpinned Android version):** delegates to
   * `super.createEmulator`, which uses `budtmo/docker-android` via the guest
   * engine — behaviour unchanged from before #108.
   *
   * The openbox window rules and `fit-emulator.py` are staged into the created
   * (not yet started) container before `docker start`, exactly as
   * `OciCliBackend.createEmulator` does today — so the preview geometry is
   * fixed before the WM maps the emulator window.
   */
  override async createEmulator(
    roomId: string,
    opts?: { device: string; version: string; resolution?: 'native' | 'balanced' | 'fast'; orientation?: 'portrait' | 'landscape' },
    limits?: { cpus?: number; memoryMB?: number }
  ): Promise<void> {
    const version = opts?.version ?? '14.0'
    const pinned = pinnedAndroidVersions()

    if (!pinned.includes(version)) {
      // Version not yet pinned for the managed path — use docker-android via the
      // guest engine. This is the compatibility fallback the spec mandates until
      // every offered version has a pinned system image.
      return super.createEmulator(roomId, opts, limits)
    }

    // ── Managed path ─────────────────────────────────────────────────────────

    const plan = androidAvdPlan(roomId, opts)
    const launch = androidEmulatorLaunch(roomId, opts, limits)

    // Resolve the image to use. We reuse the docker-android image as the base
    // because it ships the complete X11/VNC/openbox stack. The entrypoint is
    // replaced by buildManagedEmulatorContainerArgs so docker-android's
    // supervisord never runs.
    const imageRef = opts?.version ? emulatorImage(opts.version) : EMULATOR_IMAGE

    // Pull the image so the create below does not time out on first use.
    await this.managedEngine.run(['pull', imageRef], { timeoutMs: null })

    // Find the control anchor — the emulator joins its network namespace.
    const anchorInspect = await this.managedEngine.run([
      'inspect',
      '--format',
      '{{.Id}}|{{.State.Status}}|{{.State.StartedAt}}',
      anchorName(roomId)
    ])
    if (anchorInspect.code !== 0) {
      throw new Error(`managed emulator: control anchor for Room ${roomId} not found`)
    }
    const anchorFields = anchorInspect.stdout.trim().split('|')
    if (anchorFields.length < 3) {
      throw new Error(`managed emulator: control anchor inspect returned unexpected format for Room ${roomId}`)
    }
    const [anchorId, anchorStatus, anchorStartedAt] = anchorFields
    if (anchorStatus !== 'running') {
      throw new Error(`managed emulator: control anchor for Room ${roomId} is not running (${anchorStatus})`)
    }

    // Resolve the sandbox ID for the network fencing label.
    const sandboxInspect = await this.managedEngine.run([
      'inspect',
      '--format',
      '{{.NetworkSettings.SandboxID}}',
      anchorName(roomId)
    ])
    const networkAuthoritySandboxId = sandboxInspect.stdout.trim()
    if (!/^[a-f0-9]{64}$/.test(networkAuthoritySandboxId)) {
      throw new Error(`managed emulator: could not resolve control anchor sandbox ID for Room ${roomId}`)
    }

    // Generate the openbox WM config that makes the emulator window frameless
    // and full-screen — identical rules to those OciCliBackend stages for
    // docker-android, embedded as base64 in the entrypoint script.
    const screen = emulatorScreen(opts?.orientation)
    const openbox = {
      rcXml: openboxFramelessRc(screen.width, screen.height),
      fitPy: fitEmulatorPy(screen.width, screen.height)
    }

    const networkAuthorityStartedAt = anchorStartedAt!.trim()
    const networkNamespace = anchorId!.trim()
    const abortToken = randomUUID()

    const containerArgs = buildManagedEmulatorContainerArgs(roomId, plan, launch, {
      networkNamespace,
      networkAuthoritySandboxId,
      networkAuthorityStartedAt,
      abortToken,
      limits,
      openbox
    }, imageRef)

    let emulatorId: string | undefined
    try {
      const createResult = await this.managedEngine.run(
        // buildManagedEmulatorContainerArgs starts with 'create' and sets
        // --name to emulatorName(roomId). The openbox config is embedded in the
        // entrypoint script — no docker cp staging step needed.
        containerArgs,
        { timeoutMs: null, maxStdoutBytes: 128, maxStderrBytes: 8 * 1024 }
      )
      const candidateId = createResult.stdout.trim()
      if (/^[a-f0-9]{64}$/.test(candidateId)) emulatorId = candidateId
      if (createResult.code !== 0) {
        throw new Error(`managed emulator create failed: ${createResult.stderr.slice(-500)}`)
      }
      if (!emulatorId) {
        throw new Error('managed emulator create did not return one immutable container ID')
      }

      const startResult = await this.managedEngine.run(['start', emulatorId])
      if (startResult.code !== 0) {
        throw new Error(`managed emulator start failed: ${startResult.stderr.slice(-500)}`)
      }
    } catch (error) {
      // Best-effort abort cleanup: remove the named container so the next
      // createEmulator call does not collide with a stuck created-not-started one.
      await this.managedEngine
        .run(['rm', '-f', emulatorId ?? emulatorName(roomId)])
        .catch(() => undefined)
      throw error
    }
  }

  /**
   * Recovery restart of the managed Android emulator (#108).
   *
   * On the compatibility (docker-android) path, `OciCliBackend` calls
   * `prepareDockerAndroidEmulatorRestart` before `docker start` because
   * docker-android's bootstrap deletes the root passwd entry and Docker restores
   * `/dev/kvm` on the next start — so `sudo` would otherwise fail before qemu.
   * The managed emulator does not run docker-android's bootstrap, so the passwd
   * is never mutated and the workaround is not needed; the managed restart is
   * just a validated `docker start` of the exact retained container.
   *
   * Everything else in `startExistingEmulatorForRecovery` — capturing all
   * participant IDs, verifying the full isolated topology before and after,
   * proving namespace membership, writing the network recovery attestation —
   * is the same on both paths and is inherited from `OciCliBackend`.
   */
  override async startExistingEmulatorForRecovery(roomId: string): Promise<void> {
    // The managed emulator does not use docker-android's entrypoint and therefore
    // never runs the bootstrap that removes the root passwd line; the KVM restart
    // workaround that super calls prepareDockerAndroidEmulatorRestart for is not
    // needed. All topology fencing is identical: super handles it.
    //
    // The distinction is tracked in the docker-android entrypoint comment in
    // OciCliBackend.prepareDockerAndroidEmulatorRestart. If a future managed
    // emulator image requires its own restart preparation, override here.
    return super.startExistingEmulatorForRecovery(roomId)
  }
}


/** Unpacks the archive the guest produced, using the Host's own tar. */
async function extractTarTo(archive: string, destination: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises')
  const { spawn } = await import('node:child_process')
  await mkdir(destination, { recursive: true })
  await new Promise<void>((resolve, reject) => {
    // Windows 10+ ships bsdtar as `tar`, which reads this archive natively.
    const child = spawn('tar', ['-xf', archive, '-C', destination], { windowsHide: true })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`could not unpack the managed runtime source archive: ${stderr.slice(-300)}`))
    )
  })
}
