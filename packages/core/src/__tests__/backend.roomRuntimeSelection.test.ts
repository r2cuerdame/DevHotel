import net from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runDocker } from '../backend/cli'
import { ManagedRoomBackend } from '../backend/managedRoomBackend'
import { connectGuestChannel, selectRoomRuntime } from '../backend/roomRuntimeSelection'
import {
  GuestFrameDecoder,
  GuestFrameType,
  encodeGuestFrame,
  encodeGuestJsonFrame
} from '../backend/managedRuntimeGuestProtocol'
import type { ManagedRuntimeChannel } from '../backend/managedRuntimeEngine'
import type { ManagedHyperVGuestChannel } from '../backend/managedHyperVRuntime'
import { until } from './timing'

vi.mock('../backend/cli', async (importOriginal) => {
  const original = await importOriginal<typeof import('../backend/cli')>()
  return { ...original, runDocker: vi.fn(), spawnDockerProcess: vi.fn() }
})

const mockedRunDocker = vi.mocked(runDocker)

const channelFacts: ManagedHyperVGuestChannel = {
  owner: 'devhotel',
  state: 'ready',
  address: '172.30.1.5',
  port: 27_017,
  token: 'a'.repeat(64)
}

describe('selectRoomRuntime', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dh-runtime-selection-'))
    mockedRunDocker.mockReset()
    mockedRunDocker.mockResolvedValue({ code: 0, stdout: '', stderr: '' })
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const compatibility = () => ({ identityFile: join(dir, 'engine.json') })

  it('falls back to the compatibility engine when there is no usable runtime', async () => {
    const selection = await selectRoomRuntime({
      channel: null,
      runtimeId: null,
      compatibility: compatibility()
    })

    expect(selection.mode).toBe('compatibility')
    expect(selection.backend).not.toBeInstanceOf(ManagedRoomBackend)
    // The reason is reported, not swallowed: it is what the runtime card shows.
    expect(selection.detail).toMatch(/not ready/)
    await selection.dispose()
  })

  it('refuses to select managed mode when the guest engine does not answer', async () => {
    const selection = await selectRoomRuntime({
      channel: channelFacts,
      runtimeId: 'runtime-1',
      compatibility: compatibility(),
      connect: async () => {
        throw new Error('connection refused')
      }
    })

    // A managed mode that reported itself selected and then failed every Room
    // create would be worse than the engine it replaced.
    expect(selection.mode).toBe('compatibility')
    expect(selection.detail).toMatch(/connection refused/)
    await selection.dispose()
  })

  it('selects the managed runtime once its engine proves healthy', async () => {
    const selection = await selectRoomRuntime({
      channel: channelFacts,
      runtimeId: 'runtime-1',
      compatibility: compatibility(),
      connect: async () => guestAnswering()
    })

    expect(selection.mode).toBe('managed')
    expect(selection.backend).toBeInstanceOf(ManagedRoomBackend)
    expect(mockedRunDocker).not.toHaveBeenCalled()
    await selection.dispose()
  })

  it('pins the managed engine under the runtime identity, not a Docker context', async () => {
    const identityFile = join(dir, 'engine.json')
    const selection = await selectRoomRuntime({
      channel: channelFacts,
      runtimeId: 'runtime-1',
      compatibility: { identityFile },
      connect: async () => guestAnswering()
    })
    expect(selection.mode).toBe('managed')

    const { readFileSync } = await import('node:fs')
    expect(JSON.parse(readFileSync(identityFile, 'utf8'))).toMatchObject({
      context: 'managed-linux:runtime-1',
      engineId: 'guest-engine'
    })
    await selection.dispose()
  })
})

describe('connectGuestChannel', () => {
  it('completes the token handshake and then carries frames', async () => {
    const received: Buffer[] = []
    const server = net.createServer((socket) => {
      const decoder = new GuestFrameDecoder()
      socket.on('data', (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          if (frame.type === GuestFrameType.Request) {
            const request = JSON.parse(frame.payload.toString('utf8')) as { op: string; token?: string }
            if (request.op === 'hello' && request.token === channelFacts.token) {
              socket.write(encodeGuestJsonFrame(GuestFrameType.Result, frame.id, { code: 0 }))
              // Anything after the handshake belongs to the caller's conversation.
              socket.write(encodeGuestJsonFrame(GuestFrameType.Result, 99, { code: 7 }))
              return
            }
            socket.write(encodeGuestJsonFrame(GuestFrameType.Error, frame.id, { message: 'unauthorized' }))
          }
        }
      })
    })
    const port = await new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port))
    )

    const channel = await connectGuestChannel({ ...channelFacts, address: '127.0.0.1', port })
    channel.onData((chunk) => received.push(chunk))
    await until(
      () => new GuestFrameDecoder().push(Buffer.concat(received)).some((frame) => frame.id === 99),
      { what: 'the guest reply frame over loopback' }
    )

    const frames = new GuestFrameDecoder().push(Buffer.concat(received))
    expect(frames.map((frame) => frame.id)).toContain(99)

    channel.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('refuses a channel the guest did not authorize', async () => {
    const server = net.createServer((socket) => {
      const decoder = new GuestFrameDecoder()
      socket.on('data', (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          socket.write(encodeGuestJsonFrame(GuestFrameType.Error, frame.id, { message: 'unauthorized' }))
        }
      })
    })
    const port = await new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port))
    )

    await expect(connectGuestChannel({ ...channelFacts, address: '127.0.0.1', port, token: 'b'.repeat(64) })).rejects.toThrow(
      /rejected the Room command channel/
    )

    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
})

/** A guest that answers `version` and `info` over the real frame protocol. */
function guestAnswering(engineId = 'guest-engine'): ManagedRuntimeChannel {
  const decoder = new GuestFrameDecoder()
  let listener: ((chunk: Buffer) => void) | null = null
  const send = (buffer: Buffer): void => listener?.(buffer)
  return {
    write: (chunk) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.type !== GuestFrameType.Request) continue
        const request = JSON.parse(frame.payload.toString('utf8')) as { op: string; argv?: string[] }
        if (request.op !== 'exec') {
          send(encodeGuestJsonFrame(GuestFrameType.Result, frame.id, { code: 0 }))
          continue
        }
        const stdout =
          request.argv?.[0] === 'version'
            ? JSON.stringify({ Client: { Version: '28.0.0' }, Server: { Version: '28.0.0' } })
            : request.argv?.[0] === 'info'
              ? JSON.stringify({ ID: engineId })
              : ''
        if (stdout) send(encodeGuestFrame(GuestFrameType.Stdout, frame.id, Buffer.from(stdout, 'utf8')))
        send(encodeGuestJsonFrame(GuestFrameType.Result, frame.id, { code: 0 }))
      }
    },
    onData: (next) => {
      listener = next
    },
    onClose: () => {},
    close: () => {}
  }
}
