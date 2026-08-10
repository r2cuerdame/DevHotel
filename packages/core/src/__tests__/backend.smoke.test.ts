import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'node:net'
import { runDocker } from '../backend/cli'
import { roomNetworkName, srcVolume } from '../backend/naming'
import { OciCliBackend } from '../backend/ociCli'
import type { WebSpec } from '../backend/types'
import { relayPreamble } from '../relayProtocol'

const ROOM_ID = 'smoketest1'
const SECOND_ROOM_ID = 'smoketest2'
const COPY_SOURCE_ROOM = 'smokecopysource'
const COPY_TARGET_ROOM = 'smokecopytarget'
const COPY_SOURCE = srcVolume(COPY_SOURCE_ROOM)
const COPY_TARGET = srcVolume(COPY_TARGET_ROOM)
const SPEC: WebSpec = {
  roomId: ROOM_ID,
  internalPort: 3000,
  nodeMajor: '22',
  sourceType: 'empty',
  sourceRef: '',
  workspaceMode: 'empty',
  workspaceVolumeRevision: 0,
  startCommand: `node -e "require('http').createServer((q,s)=>s.end('devhotel-ok')).listen(3000)"`,
}
const SECOND_SPEC: WebSpec = {
  ...SPEC,
  roomId: SECOND_ROOM_ID,
  startCommand: `node -e "require('http').createServer((q,s)=>s.end('devhotel-room-two')).listen(3000)"`
}

async function cleanup(): Promise<void> {
  await runDocker([
    'rm',
    '-f',
    `dh-${ROOM_ID}-web`,
    `dh-${ROOM_ID}-anchor`,
    `dh-${SECOND_ROOM_ID}-web`,
    `dh-${SECOND_ROOM_ID}-svc-redis`,
    `dh-${SECOND_ROOM_ID}-anchor`
  ])
  await runDocker(['network', 'rm', roomNetworkName(ROOM_ID), roomNetworkName(SECOND_ROOM_ID)])
  await runDocker([
    'volume',
    'rm',
    '-f',
    `dh-${ROOM_ID}-src`,
    `dh-${ROOM_ID}-deps-node22`,
    `dh-${ROOM_ID}-cache`,
    `dh-${SECOND_ROOM_ID}-src`,
    `dh-${SECOND_ROOM_ID}-deps-node22`,
    `dh-${SECOND_ROOM_ID}-cache`,
    `dh-${SECOND_ROOM_ID}-svc-redis-data`,
    COPY_SOURCE,
    COPY_TARGET
  ])
}

async function pollForRedis(backend: OciCliBackend, roomId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = 'no attempt made'
  while (Date.now() < deadline) {
    const result = await backend.execInService(roomId, 'redis', ['redis-cli', 'ping'])
    if (result.code === 0 && result.stdout.trim() === 'PONG') return
    last = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`timed out waiting for Redis in ${roomId}: ${last}`)
}

async function expectTcpBlocked(
  backend: OciCliBackend,
  sourceRoomId: string,
  host: string,
  port: number
): Promise<void> {
  const script = [
    "const net=require('node:net');let done=false;",
    "const finish=(reachable)=>{if(done)return;done=true;console.log(reachable?'reachable':'blocked');socket.destroy();process.exit(reachable?2:0)};",
    `const socket=net.createConnection({host:${JSON.stringify(host)},port:${port}});`,
    "socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));socket.setTimeout(2500,()=>finish(false));"
  ].join('')
  const result = await backend.execInRoom(sourceRoomId, ['node', '-e', script], { timeoutMs: 10_000 })
  expect(result.code, result.stderr || result.stdout).toBe(0)
  expect(result.stdout.trim()).toBe('blocked')
}

async function expectTcpReachable(
  backend: OciCliBackend,
  roomId: string,
  host: string,
  port: number
): Promise<void> {
  const script = [
    "const net=require('node:net');let done=false;",
    "const finish=(ok,msg)=>{if(done)return;done=true;console.log(msg);socket.destroy();process.exit(ok?0:2)};",
    `const socket=net.createConnection({host:${JSON.stringify(host)},port:${port}});`,
    "socket.once('connect',()=>finish(true,'reachable'));socket.once('error',err=>finish(false,err.message));",
    "socket.setTimeout(5000,()=>finish(false,'timed-out'));"
  ].join('')
  const result = await backend.execInRoom(roomId, ['node', '-e', script], { timeoutMs: 10_000 })
  expect(result.code, result.stderr || result.stdout).toBe(0)
  expect(result.stdout.trim()).toBe('reachable')
}

async function expectRelayAccessBlocked(
  backend: OciCliBackend,
  sourceRoomId: string,
  host: string,
  port: number,
  payload: string,
  forbiddenBody: string
): Promise<void> {
  const script = [
    "const net=require('node:net');let done=false,data='';",
    "const finish=(code,msg)=>{if(done)return;done=true;console.log(msg);socket.destroy();process.exit(code)};",
    `const socket=net.createConnection({host:${JSON.stringify(host)},port:${port}});`,
    `socket.once('connect',()=>socket.write(${JSON.stringify(payload)}));`,
    "socket.on('data',chunk=>{data+=chunk.toString('utf8');",
    `if(data.includes(${JSON.stringify(forbiddenBody)}))finish(2,'content-leaked')});`,
    "socket.once('error',()=>finish(0,'blocked'));socket.once('close',()=>finish(0,'blocked'));",
    "setTimeout(()=>finish(3,'gate-did-not-close'),5000);"
  ].join('')
  const result = await backend.execInRoom(sourceRoomId, ['node', '-e', script], { timeoutMs: 10_000 })
  expect(result.code, result.stderr || result.stdout).toBe(0)
  expect(result.stdout.trim()).toBe('blocked')
}

async function requestRelay(port: number, relayToken: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    let response = ''
    socket.setEncoding('utf8')
    socket.setTimeout(3000)
    socket.write(`${relayPreamble(relayToken)}GET / HTTP/1.1\r\nHost: devhotel-smoke\r\nConnection: close\r\n\r\n`)
    socket.on('data', (chunk: string) => (response += chunk))
    socket.once('end', () => resolve(response))
    socket.once('error', reject)
    socket.once('timeout', () => {
      socket.destroy()
      reject(new Error('relay socket timed out'))
    })
  })
}

async function pollForBody(port: number, relayToken: string, expected: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no attempt made'
  while (Date.now() < deadline) {
    try {
      const body = await Promise.race([
        requestRelay(port, relayToken),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('relay request timed out')), 3000))
      ])
      if (body.includes(expected)) return body
      lastError = `unexpected body: ${body.slice(0, 200)}`
    } catch (err) {
      lastError = (err as Error).message
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`timed out waiting for ${expected} at relay ${port}: ${lastError}`)
}

describe.skipIf(!process.env.DEVHOTEL_SMOKE)('oci backend smoke (real docker)', () => {
  const backend = new OciCliBackend()

  beforeAll(async () => {
    await cleanup()
  }, 120_000)

  afterAll(async () => {
    await cleanup()
  }, 120_000)

  it('reports a healthy docker daemon', async () => {
    const health = await backend.health()
    expect(health.ok, health.detail).toBe(true)
  }, 30_000)

  it(
    'creates, serves, stops, and deletes a room pod',
    async () => {
      const { hostPort } = await backend.createRoomPod(SPEC)
      expect(hostPort).toBeGreaterThan(0)
      if (hostPort === null) throw new Error('Room did not publish its relay')

      let body: string
      try {
        body = await pollForBody(hostPort, await backend.relayToken(ROOM_ID), 'devhotel-ok', 30_000)
      } catch (err) {
        const logs = await runDocker(['logs', `dh-${ROOM_ID}-anchor`])
        throw new Error(`${(err as Error).message}; anchor logs: ${logs.stderr || logs.stdout}`)
      }
      expect(body).toContain('devhotel-ok')

      expect(await backend.webState(ROOM_ID)).toBe('running')
      const listed = await backend.listManagedContainers()
      const roles = listed.filter((c) => c.roomId === ROOM_ID).map((c) => c.role)
      expect(roles).toContain('anchor')
      expect(roles).toContain('web')

      await backend.stopRoomPod(ROOM_ID)
      expect(await backend.webState(ROOM_ID)).toBe('exited')

      const { reclaimedBytes } = await backend.deleteRoomPod(ROOM_ID, { volumes: true })
      expect(reclaimedBytes).toBeGreaterThanOrEqual(0)
      expect(await backend.webState(ROOM_ID)).toBe('missing')
      const remaining = await backend.listManagedContainers()
      expect(remaining.filter((c) => c.roomId === ROOM_ID)).toEqual([])
    },
    600_000,
  )

  it(
    'blocks cross-Room internal endpoints and unauthenticated relay access while host relays work',
    async () => {
      const first = await backend.createRoomPod(SPEC)
      const second = await backend.createRoomPod(SECOND_SPEC)
      expect(first.hostPort).toBeGreaterThan(0)
      expect(second.hostPort).toBeGreaterThan(0)
      if (second.hostPort === null) throw new Error('second Room did not publish its relay')

      if (first.hostPort === null) throw new Error('first Room did not publish its relay')
      const firstToken = await backend.relayToken(ROOM_ID)
      const secondToken = await backend.relayToken(SECOND_ROOM_ID)
      expect(firstToken).not.toBe(secondToken)
      await pollForBody(first.hostPort, firstToken, 'devhotel-ok', 30_000)
      await pollForBody(second.hostPort, secondToken, 'devhotel-room-two', 30_000)
      await expectTcpReachable(backend, ROOM_ID, 'registry.npmjs.org', 443)
      await expectTcpReachable(backend, SECOND_ROOM_ID, 'registry.npmjs.org', 443)

      await backend.createService(SECOND_ROOM_ID, 'redis', '8')
      await pollForRedis(backend, SECOND_ROOM_ID, 30_000)

      const inspect = await runDocker([
        'inspect',
        '--format',
        '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
        `dh-${SECOND_ROOM_ID}-anchor`
      ])
      expect(inspect.code, inspect.stderr).toBe(0)
      const secondRoomIp = inspect.stdout.trim()
      expect(secondRoomIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/)

      await expectTcpBlocked(backend, ROOM_ID, secondRoomIp, 3000)
      await expectTcpBlocked(backend, ROOM_ID, secondRoomIp, 6379)
      await expectRelayAccessBlocked(
        backend,
        ROOM_ID,
        'host.docker.internal',
        second.hostPort,
        'GET / HTTP/1.1\r\nHost: room-two\r\nConnection: close\r\n\r\n',
        'devhotel-room-two'
      )
      await expectRelayAccessBlocked(
        backend,
        ROOM_ID,
        'host.docker.internal',
        second.hostPort,
        `DEVHOTEL/1 ${'0'.repeat(64)}\nGET / HTTP/1.0\r\n\r\n`,
        'devhotel-room-two'
      )
      await expectRelayAccessBlocked(
        backend,
        ROOM_ID,
        'host.docker.internal',
        second.hostPort,
        'DEVHOTEL/1 partial-without-newline',
        'devhotel-room-two'
      )
    },
    600_000
  )

  it(
    'copies a managed volume into an independent destination',
    async () => {
      await runDocker([
        'volume',
        'create',
        '--label',
        `devhotel.room=${COPY_SOURCE_ROOM}`,
        '--label',
        'devhotel.role=volume',
        '--label',
        'devhotel.managed=1',
        COPY_SOURCE
      ])
      const seed = await runDocker([
        'run',
        '--rm',
        '-v',
        `${COPY_SOURCE}:/v`,
        'alpine',
        'sh',
        '-c',
        "printf 'clone-source' > /v/sentinel"
      ])
      expect(seed.code, seed.stderr).toBe(0)

      await backend.copyVolume(COPY_SOURCE_ROOM, COPY_SOURCE, COPY_TARGET_ROOM, COPY_TARGET)

      const copied = await runDocker(['run', '--rm', '-v', `${COPY_TARGET}:/v:ro`, 'alpine', 'cat', '/v/sentinel'])
      expect(copied.code, copied.stderr).toBe(0)
      expect(copied.stdout).toBe('clone-source')

      const mutate = await runDocker([
        'run',
        '--rm',
        '-v',
        `${COPY_TARGET}:/v`,
        'alpine',
        'sh',
        '-c',
        "printf 'clone-target' > /v/sentinel"
      ])
      expect(mutate.code, mutate.stderr).toBe(0)
      const sourceAfter = await runDocker(['run', '--rm', '-v', `${COPY_SOURCE}:/v:ro`, 'alpine', 'cat', '/v/sentinel'])
      expect(sourceAfter.stdout).toBe('clone-source')
    },
    300_000
  )
})
