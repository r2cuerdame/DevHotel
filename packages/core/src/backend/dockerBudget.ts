import type { ExecResult } from './types'

/**
 * Control-plane accounting for the Docker CLI, kept apart from the process
 * spawner so backends and tests that replace `runDocker` keep this behaviour.
 */

let dockerSpawns = 0

/** Called by the spawner for every Docker CLI process it starts. */
export function recordDockerSpawn(): void {
  dockerSpawns += 1
}

/**
 * Process-wide count of Docker CLI processes started so far. Control-plane
 * budgets (status, wake) are measured as a delta of this counter, so the
 * number is only attributable to one caller when nothing else is running.
 */
export function dockerSpawnCount(): number {
  return dockerSpawns
}

const TRANSPORT_FAILURE_PATTERNS: readonly RegExp[] = [
  /error during connect/i,
  /cannot connect to the docker daemon/i,
  /is the docker daemon running/i,
  /docker daemon is not running/i,
  /open \/\/\.\/pipe\//i,
  /the system cannot find the file specified/i,
  /permission denied while trying to connect/i,
  /context "[^"]*" does not exist/i,
  /no such context/i,
  /failed to load (?:the )?context/i,
  /connection refused/i,
  /connection reset/i,
  /broken pipe/i,
  /unexpected eof/i,
  /context deadline exceeded/i,
  /request canceled/i,
  /i\/o timeout/i,
  /docker \S* timed out after \d+ms/i
]

/**
 * Whether a Docker CLI outcome means the engine endpoint itself failed, as
 * opposed to the engine answering with an application error. The backend drops
 * its per-process engine-identity proof on these, so the next operation must
 * re-prove it is still talking to the pinned engine.
 */
export function isDockerTransportFailure(outcome: ExecResult | unknown): boolean {
  if (outcome instanceof Error) {
    const code = (outcome as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'EACCES' || code === 'EPIPE') return true
    return outcome.name === 'AbortError' ? false : TRANSPORT_FAILURE_PATTERNS.some((p) => p.test(outcome.message))
  }
  if (!outcome || typeof outcome !== 'object') return false
  const result = outcome as ExecResult
  if (result.code === 0) return false
  const detail = `${result.stderr ?? ''}\n${result.stdout ?? ''}`
  return TRANSPORT_FAILURE_PATTERNS.some((pattern) => pattern.test(detail))
}
