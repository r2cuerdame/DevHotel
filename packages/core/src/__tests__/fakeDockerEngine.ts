import { createHash } from 'node:crypto'
import type { Mock } from 'vitest'
import type { runDocker } from '../backend/cli'
import {
  NETWORK_AUTHORITY_SANDBOX_LABEL,
  NETWORK_AUTHORITY_STARTED_AT_LABEL,
  RELAY_PORT,
  anchorName,
  androidControlNetworkName,
  androidRuntimeAnchorName,
  roomNetworkName
} from '../backend/naming'
import type { WebSpec } from '../backend/types'

/**
 * In-memory Docker engine for backend tests: networks, containers and volumes
 * with the inspect shapes the ownership and network-authority proofs read.
 * Shared by the network lifecycle tests and the control-plane budget tests.
 */

export type MockedRunDocker = Mock<typeof runDocker>

export const ok = { code: 0, stdout: '', stderr: '' }

export function webSpec(roomId: string, overrides: Partial<WebSpec> = {}): WebSpec {
  return {
    roomId,
    internalPort: 5173,
    nodeMajor: '22',
    sourceType: 'empty',
    sourceRef: '',
    workspaceMode: 'hotel',
    workspaceVolumeRevision: 0,
    startCommand: 'npm run dev',
    ...overrides
  }
}

function handleVolume(cmd: string | undefined, subcmd: string | undefined, args: string[]) {
  if (cmd === 'volume' && subcmd === 'inspect') {
    // Every requested volume exists and is owned by the Room its name carries.
    const volumes = args.slice(2).map((name) => {
      const roomId = name.replace(/^dh-/, '').replace(/-.*$/, '')
      return {
        Name: name,
        Labels: {
          'devhotel.room': roomId,
          'devhotel.role': 'volume',
          'devhotel.managed': '1'
        }
      }
    })
    return { code: 0, stdout: JSON.stringify(volumes), stderr: '' }
  }
  if (cmd === 'volume' && (subcmd === 'create' || subcmd === 'rm')) {
    return ok
  }
  return null
}

export function networkIdFromName(name: string): string {
  return createHash('sha256').update(name).digest('hex')
}

export function makeContainerInspect(
  name: string,
  status = 'running',
  opts: {
    androidIsolation?: boolean
    labels?: Record<string, string>
    networkMode?: string
  } = {}
) {
  const cleanName = name.replace(/^\//, '')
  const parts = cleanName.split('-')
  const roomId = parts[1]!
  const role = parts.slice(2).join('-')
  const id = createHash('sha256').update(cleanName).digest('hex')
  const ownSandboxId = createHash('sha256').update(`${cleanName}-sandbox`).digest('hex')
  const isAndroidControlAnchor = role === 'anchor' && opts.androidIsolation
  const netName = isAndroidControlAnchor
    ? androidControlNetworkName(roomId)
    : roomNetworkName(roomId)
  const netMode =
    opts.networkMode ??
    (role === 'web'
      ? opts.androidIsolation
        ? `container:${androidRuntimeAnchorName(roomId)}`
        : `container:${anchorName(roomId)}`
      : netName)
  const netId = networkIdFromName(netName)

  const sandboxId =
    role === 'web' ? (opts.labels?.[NETWORK_AUTHORITY_SANDBOX_LABEL] ?? '') : ownSandboxId

  return {
    Id: id,
    Name: `/${cleanName}`,
    Config: {
      Labels: {
        'devhotel.room': roomId,
        'devhotel.role': role,
        'devhotel.managed': '1',
        [NETWORK_AUTHORITY_SANDBOX_LABEL]:
          opts.labels?.[NETWORK_AUTHORITY_SANDBOX_LABEL] ?? ownSandboxId,
        [NETWORK_AUTHORITY_STARTED_AT_LABEL]:
          opts.labels?.[NETWORK_AUTHORITY_STARTED_AT_LABEL] ?? '2026-01-01T00:00:00.000000001Z',
        ...opts.labels
      }
    },
    State: {
      Status: status,
      Running: status === 'running',
      Paused: false,
      StartedAt: '2026-01-01T00:00:00.000000001Z'
    },
    HostConfig: { NetworkMode: netMode },
    NetworkSettings: {
      SandboxID: sandboxId,
      Networks:
        role === 'web'
          ? {}
          : {
              [netName]: { NetworkID: netId }
            },
      Ports:
        role === 'anchor'
          ? { [`${RELAY_PORT}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: '40001' }] }
          : {}
    }
  }
}

export interface MockDockerOptions {
  networkCreateFailsWithIpam?: boolean
  webCreateFails?: boolean
}

export function setupDockerMock(mockedRunDocker: MockedRunDocker, options: MockDockerOptions = {}) {
  const dockerNetworks = new Map<
    string,
    {
      name: string
      subnet?: string
      labels: Record<string, string>
      containers?: Record<string, any>
    }
  >()
  const dockerContainers = new Map<string, any>()

  mockedRunDocker.mockImplementation(async (args) => {
    const [cmd, subcmd] = args
    const vol = handleVolume(cmd, subcmd, args)
    if (vol) return vol

    if (cmd === 'image') return ok

    if (cmd === 'network' && subcmd === 'inspect') {
      const names = args.slice(2)
      if (names.length === 1) {
        const target = names[0]!
        const exists =
          dockerNetworks.has(target) ||
          Array.from(dockerNetworks.values()).some((n) => networkIdFromName(n.name) === target)
        if (!exists) {
          return { code: 1, stdout: '', stderr: 'No such network' }
        }
      }
      const inspected = names
        .map((name) => {
          const net =
            dockerNetworks.get(name) ??
            Array.from(dockerNetworks.values()).find((n) => networkIdFromName(n.name) === name)
          if (!net) return null
          const netId = networkIdFromName(net.name)
          const netContainers: Record<string, { Name: string }> = { ...(net.containers ?? {}) }
          for (const c of dockerContainers.values()) {
            if (c.State?.Status === 'running' && c.NetworkSettings?.Networks?.[net.name]) {
              netContainers[c.Id] = { Name: c.Name.replace(/^\//, '') }
            }
          }
          return {
            Id: netId,
            Name: net.name,
            Driver: 'bridge',
            Labels: net.labels,
            Containers: netContainers,
            IPAM: {
              Config: net.subnet
                ? [{ Subnet: net.subnet, Gateway: net.subnet.replace(/\.0\/\d+$/, '.1') }]
                : []
            }
          }
        })
        .filter(Boolean)
      if (inspected.length === 0) return { code: 1, stdout: '', stderr: 'No such network' }
      return { code: 0, stdout: JSON.stringify(inspected), stderr: '' }
    }

    if (cmd === 'network' && subcmd === 'ls') {
      if (args.includes('{{.Name}}')) {
        const names = Array.from(dockerNetworks.values()).map((net) => net.name)
        return { code: 0, stdout: names.join('\n'), stderr: '' }
      }
      const rows = Array.from(dockerNetworks.values()).map((net) =>
        JSON.stringify({
          Name: net.name,
          Labels: Object.entries(net.labels)
            .map(([k, v]) => `${k}=${v}`)
            .join(',')
        })
      )
      return { code: 0, stdout: rows.join('\n'), stderr: '' }
    }

    if (cmd === 'network' && subcmd === 'create') {
      if (options.networkCreateFailsWithIpam) {
        return {
          code: 1,
          stdout: '',
          stderr: 'failed to create network: all predefined address pools have been fully subnetted'
        }
      }
      const subnetIdx = args.indexOf('--subnet')
      const subnet = subnetIdx !== -1 ? args[subnetIdx + 1] : undefined
      const name = args.at(-1)!
      const labels: Record<string, string> = {}
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--label' && args[i + 1]) {
          const [k, v] = args[i + 1]!.split('=')
          if (k && v) labels[k] = v
        }
      }
      dockerNetworks.set(name, { name, subnet, labels, containers: {} })
      return ok
    }

    if (cmd === 'network' && subcmd === 'rm') {
      const nameOrId = args[2]!
      dockerNetworks.delete(nameOrId)
      for (const [k, v] of Array.from(dockerNetworks.entries())) {
        if (networkIdFromName(v.name) === nameOrId) {
          dockerNetworks.delete(k)
        }
      }
      return ok
    }

    if (cmd === 'run') {
      const nameIdx = args.indexOf('--name')
      const name = nameIdx !== -1 ? args[nameIdx + 1]! : 'generic'
      const labels: Record<string, string> = {}
      for (let i = 0; i < args.length; i++) {
        if ((args[i] === '--label' || args[i] === '-l') && args[i + 1]) {
          const [k, ...v] = args[i + 1]!.split('=')
          if (k) labels[k] = v.join('=')
        }
      }
      const netIdx = args.indexOf('--network')
      const netMode = netIdx !== -1 ? args[netIdx + 1]! : ''
      const isAndroid = netMode.endsWith('-android-control-net')
      const c = makeContainerInspect(name, 'running', {
        androidIsolation: isAndroid,
        labels,
        networkMode: netMode
      })
      dockerContainers.set(name, c)
      dockerContainers.set(c.Id, c)
      // Like the real CLI, run/create print the new container's immutable ID.
      return { code: 0, stdout: `${c.Id}\n`, stderr: '' }
    }

    if (cmd === 'create') {
      const nameIdx = args.indexOf('--name')
      const name = nameIdx !== -1 ? args[nameIdx + 1]! : 'generic'
      if (options.webCreateFails && name.endsWith('-web')) {
        return { code: 1, stdout: '', stderr: 'Error response from daemon: container start failed' }
      }
      const labels: Record<string, string> = {}
      for (let i = 0; i < args.length; i++) {
        if ((args[i] === '--label' || args[i] === '-l') && args[i + 1]) {
          const [k, ...v] = args[i + 1]!.split('=')
          if (k) labels[k] = v.join('=')
        }
      }
      const netIdx = args.indexOf('--network')
      const netMode = netIdx !== -1 ? args[netIdx + 1]! : ''
      const isAndroid = netMode.includes('android-runtime-anchor')
      const c = makeContainerInspect(name, 'created', {
        androidIsolation: isAndroid,
        labels,
        networkMode: netMode
      })
      dockerContainers.set(name, c)
      dockerContainers.set(c.Id, c)
      // Like the real CLI, run/create print the new container's immutable ID.
      return { code: 0, stdout: `${c.Id}\n`, stderr: '' }
    }

    if (cmd === 'inspect') {
      // Like the CLI: any number of targets, missing ones reported on stderr
      // while the rest are still printed, and `--format` for one field.
      const formatIdx = args.indexOf('--format')
      const format = formatIdx !== -1 ? args[formatIdx + 1] : null
      const targets = args.slice(1).filter((arg, i, list) => arg !== '--format' && list[i - 1] !== '--format')
      const found = targets.map((target) => dockerContainers.get(target)).filter(Boolean)
      if (found.length === 0) return { code: 1, stdout: '', stderr: 'No such container' }
      if (format === '{{.State.Status}}') {
        return { code: 0, stdout: found.map((c) => `${c.State.Status}\n`).join(''), stderr: '' }
      }
      const complete = found.length === targets.length
      return { code: complete ? 0 : 1, stdout: JSON.stringify(found), stderr: complete ? '' : 'No such container' }
    }

    if (cmd === 'start') {
      const idOrName = args[1]!
      for (const [n, c] of dockerContainers.entries()) {
        if (n === idOrName || c.Id === idOrName) {
          c.State.Status = 'running'
          c.State.Running = true
        }
      }
      return ok
    }

    if (cmd === 'stop') {
      const tIdx = args.indexOf('-t')
      const targets = tIdx !== -1 ? args.slice(tIdx + 2) : args.slice(1)
      for (const id of targets) {
        for (const c of dockerContainers.values()) {
          if (c.Id === id || c.Name === `/${id}`) {
            c.State.Status = 'exited'
            c.State.Running = false
          }
        }
      }
      return ok
    }

    if (cmd === 'rm') {
      for (const id of args.slice(1)) {
        if (id.startsWith('-')) continue
        for (const [k, c] of Array.from(dockerContainers.entries())) {
          if (c.Id === id || k === id || c.Name === `/${id}`) {
            dockerContainers.delete(k)
          }
        }
      }
      return ok
    }

    if (cmd === 'port') {
      return { code: 0, stdout: '127.0.0.1:40001\n', stderr: '' }
    }

    return ok
  })

  return { dockerNetworks, dockerContainers }
}
