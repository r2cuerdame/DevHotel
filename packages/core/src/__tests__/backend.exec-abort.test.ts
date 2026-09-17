import { beforeAll, describe, expect, it } from 'vitest'

// Same trick as backend.exec-stream: point the pinned runtime at this Node
// binary so runDocker drives a real child process without Docker.
process.env.DEVHOTEL_DOCKER_PATH = process.execPath

const { runDocker } = await import('../backend/cli')

const HANG = ['-e', 'setTimeout(() => {}, 60000)']

describe('runDocker abort cleanup ordering', () => {
  beforeAll(() => {
    expect(process.env.DEVHOTEL_DOCKER_PATH).toBe(process.execPath)
  })

  it('runs onAbort after the child closed and before a timed-out call settles', async () => {
    const order: string[] = []
    const result = await runDocker(HANG, {
      timeoutMs: 250,
      onAbort: async () => {
        order.push('onAbort')
        await new Promise((resolve) => setTimeout(resolve, 50))
        order.push('onAbort-done')
      }
    })
    order.push('settled')

    expect(result.code).toBe(-1)
    expect(result.stderr).toMatch(/timed out after 250ms/)
    expect(order).toEqual(['onAbort', 'onAbort-done', 'settled'])
  })

  it('runs onAbort for a caller-signalled abort and rejects with the caller reason', async () => {
    const controller = new AbortController()
    let reaped = false
    const pending = runDocker(HANG, {
      timeoutMs: 30_000,
      signal: controller.signal,
      onAbort: async () => {
        reaped = true
      }
    })
    setTimeout(() => controller.abort(new Error('response closed')), 100)

    await expect(pending).rejects.toThrow('response closed')
    expect(reaped).toBe(true)
  })

  it('surfaces a failed abort cleanup instead of pretending the abort completed', async () => {
    await expect(
      runDocker(HANG, {
        timeoutMs: 250,
        onAbort: async () => {
          throw new Error('guest processes survived')
        }
      })
    ).rejects.toThrow('guest processes survived')
  })
})
