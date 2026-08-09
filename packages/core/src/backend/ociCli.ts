import { runDocker } from './cli'
import {
  ANCHOR_IMAGE,
  EMULATOR_IMAGE,
  RELAY_PORT,
  anchorName,
  buildAnchorArgs,
  buildEmulatorArgs,
  buildOneShotArgs,
  buildServiceArgs,
  buildWebCreateArgs,
  cacheVolume,
  emulatorImage,
  emulatorName,
  effectiveDepsVolume,
  imageFor,
  parsePortOutput,
  srcVolume,
  svcImage,
  svcName,
  svcVolume,
  webName,
} from './naming'
import type { AnchorSpec, ExecResult, IsolationBackend, WebSpec } from './types'

const CLONE_IMAGE = 'alpine/git'
const DU_IMAGE = 'alpine'
const LONG_TIMEOUT_MS = 600_000

const OPENBOX_FRAMELESS_RC = `<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
  <applications>
    <application class="*">
      <decor>no</decor>
      <maximized>yes</maximized>
      <position force="yes"><x>0</x><y>0</y></position>
    </application>
  </applications>
</openbox_config>
`

function must(result: ExecResult, what: string): ExecResult {
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim()
    throw new Error(`${what} failed (exit ${result.code}): ${detail}`)
  }
  return result
}

interface DockerVersionJson {
  Client?: { Version?: string } | null
  Server?: { Version?: string } | null
}

export class OciCliBackend implements IsolationBackend {
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
      return { ok: true, detail: `client ${parsed.Client.Version}, server ${parsed.Server.Version}` }
    }
    const detail = result.stderr.trim() || 'docker daemon not reachable'
    return { ok: false, detail }
  }

  async createRoomPod(spec: WebSpec): Promise<{ hostPort: number | null }> {
    if (!spec.standalone) await this.ensureImage(ANCHOR_IMAGE)
    await this.ensureImage(imageFor(spec))
    if (spec.sourceType === 'managed-git') {
      await this.ensureImage(CLONE_IMAGE)
      must(await runDocker(['volume', 'create', srcVolume(spec.roomId)]), 'create src volume')
    }
    if (spec.sourceType !== 'empty' && !spec.noDepsVolume) {
      must(await runDocker(['volume', 'create', effectiveDepsVolume(spec)]), 'create deps volume')
    }
    must(await runDocker(['volume', 'create', cacheVolume(spec.roomId)]), 'create cache volume')
    if (spec.sourceType === 'managed-git') {
      await this.cloneIntoVolume(spec.roomId, spec.sourceRef)
    }
    if (!spec.standalone) {
      must(
        await runDocker(buildAnchorArgs({ roomId: spec.roomId, internalPort: spec.internalPort })),
        'run anchor container',
      )
    }
    must(await runDocker(buildWebCreateArgs(spec)), 'create web container')
    must(await runDocker(['start', webName(spec.roomId)]), 'start web container')
    return { hostPort: spec.standalone ? null : await this.readHostPort(spec.roomId) }
  }

  async startRoomPod(roomId: string): Promise<{ hostPort: number }> {
    must(await runDocker(['start', anchorName(roomId)]), 'start anchor container')
    must(await runDocker(['start', webName(roomId)]), 'start web container')
    return { hostPort: await this.readHostPort(roomId) }
  }

  async stopRoomPod(roomId: string): Promise<void> {
    await runDocker(['stop', '-t', '8', webName(roomId)])
    // services and the anchor — everything else carrying the room label
    const rest = await runDocker(['ps', '-q', '--filter', `label=devhotel.room=${roomId}`])
    const ids = rest.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    if (ids.length > 0) await runDocker(['stop', '-t', '5', ...ids])
  }

  async restartWeb(roomId: string): Promise<void> {
    must(await runDocker(['restart', '-t', '8', webName(roomId)]), 'restart web container')
  }

  async recreateWeb(spec: WebSpec): Promise<void> {
    await runDocker(['rm', '-f', webName(spec.roomId)])
    await this.ensureImage(imageFor(spec))
    if (spec.sourceType !== 'empty' && !spec.noDepsVolume) {
      must(await runDocker(['volume', 'create', effectiveDepsVolume(spec)]), 'create deps volume')
    }
    must(await runDocker(buildWebCreateArgs(spec)), 'create web container')
    must(await runDocker(['start', webName(spec.roomId)]), 'start web container')
  }

  async recreateAnchor(spec: AnchorSpec): Promise<{ hostPort: number }> {
    await runDocker(['rm', '-f', anchorName(spec.roomId)])
    await this.ensureImage(ANCHOR_IMAGE)
    must(await runDocker(buildAnchorArgs(spec)), 'run anchor container')
    return { hostPort: await this.readHostPort(spec.roomId) }
  }

  async deleteRoomPod(roomId: string, opts: { volumes: boolean }): Promise<{ reclaimedBytes: number }> {
    let reclaimedBytes = 0
    if (opts.volumes) {
      try {
        const sizes = await this.volumeSizes(roomId)
        reclaimedBytes = Object.values(sizes).reduce((a, b) => a + b, 0)
      } catch {
        reclaimedBytes = 0
      }
    }
    const all = await runDocker(['ps', '-aq', '--filter', `label=devhotel.room=${roomId}`])
    const ids = all.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    await runDocker(['rm', '-f', webName(roomId), anchorName(roomId), ...ids])
    if (opts.volumes) {
      const volumes = await this.listRoomVolumes(roomId)
      if (volumes.length > 0) await runDocker(['volume', 'rm', '-f', ...volumes])
    }
    return { reclaimedBytes }
  }

  async execInRoom(roomId: string, cmd: string[], opts?: { timeoutMs?: number }): Promise<ExecResult> {
    return runDocker(['exec', webName(roomId), ...cmd], { timeoutMs: opts?.timeoutMs })
  }

  async runOneShot(spec: WebSpec, cmd: string, log?: (line: string) => void): Promise<ExecResult> {
    await this.ensureImage(imageFor(spec), log)
    return runDocker(buildOneShotArgs(spec, cmd), { timeoutMs: LONG_TIMEOUT_MS, onLine: log })
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

  async cloneIntoVolume(roomId: string, gitUrl: string, log?: (line: string) => void): Promise<void> {
    await this.ensureImage(CLONE_IMAGE, log)
    must(await runDocker(['volume', 'create', srcVolume(roomId)]), 'create src volume')
    must(
      await runDocker(
        ['run', '--rm', '-v', `${srcVolume(roomId)}:/workspace`, '-w', '/workspace', CLONE_IMAGE, 'clone', gitUrl, '.'],
        { timeoutMs: LONG_TIMEOUT_MS, onLine: log },
      ),
      `clone ${gitUrl}`,
    )
  }

  async volumeSizes(roomId: string): Promise<Record<string, number>> {
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

  async resetVolume(name: string): Promise<void> {
    await runDocker(['volume', 'rm', '-f', name])
    must(await runDocker(['volume', 'create', name]), `create volume ${name}`)
  }

  async createService(roomId: string, svc: 'postgres' | 'redis', version: string): Promise<void> {
    await this.ensureImage(svcImage(svc, version))
    must(await runDocker(['volume', 'create', svcVolume(roomId, svc)]), 'create service volume')
    must(await runDocker(buildServiceArgs(roomId, svc, version)), `run ${svc} container`)
  }

  async startService(roomId: string, svc: 'postgres' | 'redis'): Promise<void> {
    must(await runDocker(['start', svcName(roomId, svc)]), `start ${svc}`)
  }

  async stopService(roomId: string, svc: 'postgres' | 'redis'): Promise<void> {
    await runDocker(['stop', '-t', '5', svcName(roomId, svc)])
  }

  async removeService(roomId: string, svc: 'postgres' | 'redis', opts: { volume: boolean }): Promise<void> {
    await runDocker(['rm', '-f', svcName(roomId, svc)])
    if (opts.volume) await runDocker(['volume', 'rm', '-f', svcVolume(roomId, svc)])
  }

  async serviceState(roomId: string, svc: 'postgres' | 'redis'): Promise<'running' | 'exited' | 'missing'> {
    const result = await runDocker(['inspect', '--format', '{{.State.Status}}', svcName(roomId, svc)])
    if (result.code !== 0) return 'missing'
    return result.stdout.trim() === 'running' ? 'running' : 'exited'
  }

  async execInService(
    roomId: string,
    svc: 'postgres' | 'redis',
    cmd: string[],
    opts?: { timeoutMs?: number; input?: string }
  ): Promise<ExecResult> {
    const interactive = opts?.input !== undefined ? ['-i'] : []
    return runDocker(['exec', ...interactive, svcName(roomId, svc), ...cmd], {
      timeoutMs: opts?.timeoutMs ?? 120_000,
      input: opts?.input
    })
  }

  async copyFromService(roomId: string, svc: 'postgres' | 'redis', containerPath: string, hostPath: string): Promise<void> {
    must(await runDocker(['cp', `${svcName(roomId, svc)}:${containerPath}`, hostPath]), `copy from ${svc}`)
  }

  async copyToService(roomId: string, svc: 'postgres' | 'redis', hostPath: string, containerPath: string): Promise<void> {
    must(await runDocker(['cp', hostPath, `${svcName(roomId, svc)}:${containerPath}`]), `copy into ${svc}`)
  }

  async createEmulator(roomId: string, opts?: { device: string; version: string }): Promise<void> {
    await this.ensureImage(opts?.version ? emulatorImage(opts.version) : EMULATOR_IMAGE)
    must(await runDocker(buildEmulatorArgs(roomId, opts)), 'run emulator container')
    // frameless fullscreen phone: openbox applies these rules when the
    // emulator window maps, stripping decorations and margins
    await runDocker(
      [
        'exec',
        '-i',
        emulatorName(roomId),
        'sh',
        '-c',
        'mkdir -p ~/.config/openbox && cat > ~/.config/openbox/rc.xml && DISPLAY=:0 openbox --reconfigure || true'
      ],
      { input: OPENBOX_FRAMELESS_RC }
    )
  }

  async removeEmulator(roomId: string): Promise<void> {
    await runDocker(['rm', '-f', emulatorName(roomId)])
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
    must(await runDocker(['pull', image], { timeoutMs: LONG_TIMEOUT_MS, onLine: log }), `pull ${image}`)
  }

  private async ensureImage(image: string, log?: (line: string) => void): Promise<void> {
    if (!(await this.imageExists(image))) await this.pullImage(image, log)
  }

  private async readHostPort(roomId: string): Promise<number> {
    const result = must(
      await runDocker(['port', anchorName(roomId), `${RELAY_PORT}/tcp`]),
      'read anchor host port',
    )
    return parsePortOutput(result.stdout)
  }

  private async listRoomVolumes(roomId: string): Promise<string[]> {
    const prefix = `dh-${roomId}-`
    const result = await runDocker(['volume', 'ls', '--filter', `name=${prefix}`, '--format', '{{.Name}}'])
    if (result.code !== 0) return []
    return result.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((name) => name.startsWith(prefix))
  }
}
