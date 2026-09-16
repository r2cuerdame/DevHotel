import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OciCliBackend, type OciCliBackendOptions } from './ociCli'
import { MANAGED_RUNTIME_GUEST_STAGE_ROOT } from './managedRuntimeGuestAgent'
import type { ManagedRuntimeEngine } from './managedRuntimeEngine'
import type { ManagedRuntimeIngress } from './managedRuntimeIngress'
import type { ExecResult, GitCredential } from './types'

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
