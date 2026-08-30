import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ControlClient } from '../client'
import { makeTools } from '../tools'

const TOKEN = 'device-token'
let server: Server
let port: number
const seen: { method: string; url: string; body: any }[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end('unauthorized')
      return
    }
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, body: raw ? JSON.parse(raw) : null })
      if (req.url === '/v1/devices' && req.method === 'GET') {
        return void res.end(
          JSON.stringify({
            available: true,
            detail: 'adb 35.0.0',
            devices: [
              {
                id: 'd0123456789abcdef0123456789abcdef',
                nickname: 'Pixel-USB-01',
                connection: 'usb',
                health: 'ready',
                brokered: true,
                queueDepth: 2,
                leaseOwner: { project: 'Movit', roomId: 'aaaa1111', purpose: 'acceptance' },
                waiters: [{ project: 'MiracleKeyboard' }, { project: 'WakePhone' }]
              }
            ],
            recentEvents: []
          })
        )
      }
      if (req.url === '/v1/rooms/abc12345/device/attach') {
        return void res.end(JSON.stringify({ state: 'queued', requestId: 'req-1', position: 2, reason: 'Pixel-USB-01 is held by Movit' }))
      }
      if (req.url === '/v1/rooms/abc12345/device/release') {
        return void res.end(JSON.stringify({ id: 'lease-1', state: 'released' }))
      }
      if (req.url === '/v1/rooms/abc12345/device/adb') {
        return void res.end(JSON.stringify({ code: 0, stdout: 'Success', stderr: '' }))
      }
      res.writeHead(404).end('not found')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
})

afterAll(() => server.close())

function tools() {
  const client = new ControlClient({ port, token: TOKEN, pid: 0, version: 'test' })
  return makeTools(async () => client)
}

function tool(name: string) {
  const found = tools().find((candidate) => candidate.name === name)
  if (!found) throw new Error(`no such tool: ${name}`)
  return found
}

describe('Android device broker MCP tools', () => {
  it('exposes the device tools an agent needs to share one phone', () => {
    const names = tools().map((candidate) => candidate.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'android_devices',
        'attach_android_device',
        'release_android_device',
        'android_device_adb',
        'heartbeat_android_device'
      ])
    )
  })

  it('answers "why can I not use the test phone" with the owner and the queue', async () => {
    const result = await tool('android_devices').handler({})
    const text = (result.content[0] as { text: string }).text

    expect(result.isError).toBeFalsy()
    expect(text).toContain('Pixel-USB-01')
    expect(text).toContain('Movit')
    expect(text).toContain('MiracleKeyboard')
  })

  it('queues an attach and reports the position rather than failing', async () => {
    const result = await tool('attach_android_device').handler({ roomId: 'abc12345', purpose: 'acceptance', workerId: 'agent-1' })
    const text = (result.content[0] as { text: string }).text

    expect(result.isError).toBeFalsy()
    expect(text).toContain('queued')
    expect(seen.at(-1)).toMatchObject({
      url: '/v1/rooms/abc12345/device/attach',
      body: { purpose: 'acceptance', workerId: 'agent-1' }
    })
  })

  it('sends an ADB argv through the Room so the broker can refuse it', async () => {
    const result = await tool('android_device_adb').handler({ roomId: 'abc12345', args: ['install', '-r', '/workspace/app.apk'] })

    expect(result.isError).toBeFalsy()
    expect(seen.at(-1)).toMatchObject({
      url: '/v1/rooms/abc12345/device/adb',
      body: { args: ['install', '-r', '/workspace/app.apk'] }
    })
  })

  it('warns that a physical lease never permits shared runtime configuration', () => {
    const description = tool('android_device_adb').description
    expect(description).toMatch(/Host-owned raw configuration surfaces/i)
    expect(description).toMatch(/settings, content, device_config, cmd, setprop, and svc/i)
    expect(description).toMatch(/always refused even with a lease/i)
    expect(description).toMatch(/am hang\/restart/i)
  })

  it('releases without pretending the phone was wiped', async () => {
    const release = tool('release_android_device')
    const result = await release.handler({ roomId: 'abc12345', reason: 'acceptance finished' })

    expect(result.isError).toBeFalsy()
    expect(release.description).toMatch(/install/i)
    expect(seen.at(-1)).toMatchObject({ url: '/v1/rooms/abc12345/device/release', body: { reason: 'acceptance finished' } })
  })

  it('tells agents to use the emulator for ordinary development', () => {
    expect(tool('attach_android_device').description).toMatch(/emulator/i)
    expect(tool('attach_android_device').description).toMatch(/acceptance|release/i)
  })

  it('describes android-run target selection for both Room attachment states', () => {
    const description = tool('android_run').description
    expect(description).toMatch(/without a physical lease.*Room emulator/i)
    expect(description).toMatch(/attached physical-device lease.*shared phone/i)
    expect(description).toMatch(/release the device before an emulator-only run/i)
  })
})
