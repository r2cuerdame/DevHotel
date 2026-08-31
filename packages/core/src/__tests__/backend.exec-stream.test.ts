import { beforeAll, describe, expect, it } from 'vitest'

// The pinned runtime is resolved once per module registry: point it at this
// Node binary before the first call so runDocker drives a real child process
// instead of needing Docker.
process.env.DEVHOTEL_DOCKER_PATH = process.execPath

const { runDocker } = await import('../backend/cli')

/** Emit `lines` lines to stdout and, optionally, to stderr. */
function emitScript(lines: number, stream: 'out' | 'both' = 'out'): string[] {
  return [
    '-e',
    `for (let i = 0; i < ${lines}; i++) { process.stdout.write('out ' + i + '\\n');` +
      (stream === 'both' ? ` process.stderr.write('err ' + i + '\\n');` : '') +
      ' }'
  ]
}

describe('runDocker output sinks', () => {
  beforeAll(() => {
    expect(process.env.DEVHOTEL_DOCKER_PATH).toBe(process.execPath)
  })

  it('streams both streams to the sinks and buffers neither', async () => {
    let stdout = ''
    let stderr = ''
    const result = await runDocker(emitScript(2000, 'both'), {
      timeoutMs: 30_000,
      onStdout: (chunk) => {
        stdout += Buffer.from(chunk).toString('utf8')
      },
      onStderr: (chunk) => {
        stderr += Buffer.from(chunk).toString('utf8')
      }
    })

    expect(result.code).toBe(0)
    // The whole point: nothing accumulates in the result.
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
    expect(stdout.split('\n').filter(Boolean)).toHaveLength(2000)
    expect(stderr.split('\n').filter(Boolean)).toHaveLength(2000)
    expect(stdout.endsWith('out 1999\n')).toBe(true)
  })

  it('still buffers into the result when no sink is given', async () => {
    const result = await runDocker(emitScript(50), { timeoutMs: 30_000 })
    expect(result.code).toBe(0)
    expect(result.stdout.split('\n').filter(Boolean)).toHaveLength(50)
  })

  it('delivers raw bytes to a chunk sink without UTF-8 replacement', async () => {
    const chunks: Buffer[] = []
    const result = await runDocker(['-e', 'process.stdout.write(Buffer.from([0, 255, 13, 10, 254]))'], {
      timeoutMs: 30_000,
      onStdout: (chunk) => chunks.push(Buffer.from(chunk))
    })

    expect(result.code).toBe(0)
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([0, 255, 13, 10, 254]))
    expect(result.stdout).toBe('')
  })

  it('delivers the timeout notice through the stderr sink instead of dropping it', async () => {
    let stderr = ''
    const result = await runDocker(['-e', 'setTimeout(() => {}, 30000)'], {
      timeoutMs: 250,
      onStderr: (chunk) => {
        stderr += Buffer.from(chunk).toString('utf8')
      }
    })

    expect(result.code).not.toBe(0)
    expect(stderr).toMatch(/timed out after 250ms/)
    expect(result.stderr).toBe('')
  })

  it('kills immediately at the byte cap and never emits a post-limit chunk', async () => {
    const chunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    const startedAt = Date.now()
    const result = await runDocker([
      '-e',
      `process.stdout.write('abcdefgh'); setTimeout(() => process.stdout.write('post-limit'), 30000)`
    ], {
      timeoutMs: 30_000,
      maxStdoutBytes: 4,
      maxStderrBytes: 64,
      onStdout: (chunk) => chunks.push(Buffer.from(chunk)),
      onStderr: (chunk) => stderrChunks.push(Buffer.from(chunk))
    })

    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(result).toMatchObject({ code: -1, outputLimitExceeded: true })
    expect(Buffer.concat(chunks).toString('utf8')).toBe('abcd')
    expect(Buffer.concat(stderrChunks)).toHaveLength(0)
  })

  it('bounded-drains a definitive-create critical section without killing it on overflow', async () => {
    let cleanupCalls = 0
    const startedAt = Date.now()
    const result = await runDocker([
      '-e',
      `process.stdout.write('abcdefgh'); setTimeout(() => process.exit(0), 250)`
    ], {
      timeoutMs: null,
      maxStdoutBytes: 4,
      maxStderrBytes: 64,
      killOnOutputLimit: false,
      onAbort: async () => { cleanupCalls += 1 }
    })

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150)
    expect(result).toMatchObject({ code: -1, stdout: 'abcd', outputLimitExceeded: true })
    expect(cleanupCalls).toBe(0)
  })

  it('rejects the operation when mandatory abort cleanup cannot prove completion', async () => {
    await expect(runDocker([
      '-e',
      `process.stdout.write('overflow'); setTimeout(() => {}, 30000)`
    ], {
      timeoutMs: 30_000,
      maxStdoutBytes: 4,
      maxStderrBytes: 64,
      onStdout: () => undefined,
      onAbort: async () => { throw new Error('exact helper cleanup failed') }
    })).rejects.toThrow(/exact helper cleanup failed/)
  })

  it('rejects a pre-aborted command before spawning or invoking cleanup', async () => {
    const controller = new AbortController()
    const chunks: Buffer[] = []
    let cleanupCalls = 0
    controller.abort()

    await expect(runDocker([
      '-e',
      `process.stdout.write('must-not-run'); setTimeout(() => {}, 30000)`
    ], {
      signal: controller.signal,
      onStdout: (chunk) => chunks.push(Buffer.from(chunk)),
      onAbort: async () => { cleanupCalls += 1 }
    })).rejects.toThrow(/aborted/i)
    await new Promise<void>((resolve) => setTimeout(resolve, 100))

    expect(chunks).toHaveLength(0)
    expect(cleanupCalls).toBe(0)
  })

  it('kills a silent command on signal abort and completes cleanup before rejecting', async () => {
    const controller = new AbortController()
    let cleanupCalls = 0
    const startedAt = Date.now()
    const operation = runDocker(['-e', `setInterval(() => {}, 30000)`], {
      timeoutMs: 30_000,
      signal: controller.signal,
      onAbort: async () => { cleanupCalls += 1 }
    })
    setTimeout(() => controller.abort(), 100)

    await expect(operation).rejects.toThrow(/aborted/i)
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(cleanupCalls).toBe(1)

    controller.abort()
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
    expect(cleanupCalls).toBe(1)
  })

  it('delivers a live chunk before a long-lived command settles, then aborts with exact cleanup', async () => {
    const controller = new AbortController()
    const abortReason = new Error('stop long-lived stream')
    const chunks: Buffer[] = []
    let cleanupCalls = 0
    let settled = false
    let firstChunkResolve: (() => void) | undefined
    const firstChunk = new Promise<void>((resolveChunk) => { firstChunkResolve = resolveChunk })
    const operation = runDocker([
      '-e',
      `process.stdout.write('begin\\n'); setInterval(() => {}, 30000)`
    ], {
      timeoutMs: 30_000,
      signal: controller.signal,
      onStdout: (chunk) => {
        chunks.push(Buffer.from(chunk))
        firstChunkResolve?.()
      },
      onAbort: async () => { cleanupCalls += 1 }
    })
    void operation.then(
      () => { settled = true },
      () => { settled = true }
    )

    await firstChunk
    expect(Buffer.concat(chunks).toString('utf8')).toBe('begin\n')
    expect(settled).toBe(false)
    controller.abort(abortReason)
    let observedAbort: unknown
    try {
      await operation
    } catch (error) {
      observedAbort = error
    }
    expect(observedAbort).toBe(abortReason)
    expect(cleanupCalls).toBe(1)
  })

  it('refuses to combine chunk sinks with the file/line sinks', async () => {
    await expect(
      runDocker(['-e', ''], { onStdout: () => {}, outputFile: 'ignored.log' })
    ).rejects.toThrow(/chunk sinks/)
    await expect(runDocker(['-e', ''], { onStderr: () => {}, onLine: () => {} })).rejects.toThrow(/chunk sinks/)
  })
})
