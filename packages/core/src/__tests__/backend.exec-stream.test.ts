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

  it('refuses to combine chunk sinks with the file/line sinks', async () => {
    await expect(
      runDocker(['-e', ''], { onStdout: () => {}, outputFile: 'ignored.log' })
    ).rejects.toThrow(/chunk sinks/)
    await expect(runDocker(['-e', ''], { onStderr: () => {}, onLine: () => {} })).rejects.toThrow(/chunk sinks/)
  })
})
