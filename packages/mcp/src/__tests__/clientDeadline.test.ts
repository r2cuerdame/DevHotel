import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_ADB_TIMEOUT_MS, MAX_EXEC_TIMEOUT_MS } from '@devhotel/shared'
import { ControlClient, DevHotelNotRunningError, DevHotelRequestTimeoutError } from '../client'
import { makeTools } from '../tools'

const TOKEN = 'test-token'
const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

/** A control API that never answers, standing in for one still doing the work. */
async function silentServer(): Promise<number> {
  const server = createServer(() => {
    // Deliberately no response: the request stays open until the client's own
    // deadline decides, which is exactly the case under test.
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('no port')
  return address.port
}

function clientFor(port: number): ControlClient {
  return new ControlClient({ port, token: TOKEN, pid: process.pid, version: 'test' })
}

describe('the client’s own deadline', () => {
  it('says the client stopped waiting, not that DevHotel is gone', async () => {
    const port = await silentServer()
    const client = clientFor(port)
    // Reach the private request path with a deliberately tiny deadline.
    const req = Reflect.get(client, 'req') as (
      method: string,
      path: string,
      body?: unknown,
      timeoutMs?: number
    ) => Promise<unknown>

    const failure = await req.call(client, 'GET', '/v1/ping', undefined, 60).then(
      () => null,
      (error: unknown) => error
    )

    expect(failure).toBeInstanceOf(DevHotelRequestTimeoutError)
    expect(failure).not.toBeInstanceOf(DevHotelNotRunningError)
    // A caller has to be able to tell "still working" from "nothing happened".
    expect((failure as Error).message).toContain('stopped waiting')
    expect((failure as Error).message).toContain('check_operation')
  })

  it('still reports an unreachable DevHotel as not running', async () => {
    const port = await silentServer()
    const closed = servers.pop()!
    await new Promise<void>((resolve) => closed.close(() => resolve()))

    await expect(clientFor(port).ping()).rejects.toBeInstanceOf(DevHotelNotRunningError)
  })
})

describe('MCP timeout schemas match the server maximum', () => {
  const tools = makeTools(async () => ({}) as never)

  function schemaFor(name: string): Record<string, { safeParse(input: unknown): { success: boolean } }> {
    const tool = tools.find((entry) => entry.name === name)
    if (!tool) throw new Error(`no tool named ${name}`)
    return tool.schema as never
  }

  it('caps run_in_room at the exec bound the control API enforces', () => {
    const timeoutMs = schemaFor('run_in_room').timeoutMs!
    expect(timeoutMs.safeParse(MAX_EXEC_TIMEOUT_MS).success).toBe(true)
    // Over the bound the control API would answer 400; refuse it here instead,
    // where the real limit is visible to the caller.
    expect(timeoutMs.safeParse(MAX_EXEC_TIMEOUT_MS + 1).success).toBe(false)
  })

  it('caps android_device_adb at the ADB bound the control API enforces', () => {
    const timeoutMs = schemaFor('android_device_adb').timeoutMs!
    expect(timeoutMs.safeParse(MAX_ADB_TIMEOUT_MS).success).toBe(true)
    expect(timeoutMs.safeParse(MAX_ADB_TIMEOUT_MS + 1).success).toBe(false)
  })
})
