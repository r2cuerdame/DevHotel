import { describe, expect, it } from 'vitest'
import { wrapStartCommand } from '../backend/naming'
import { parseDockerTop, webWorkloadState } from '../backend/workloadLiveness'

// Docker Desktop's `docker top`: `ps -ef` columns, no STAT.
const HEADER = 'UID                 PID                 PPID                C                   STIME               TTY                 TIME                CMD'

function row(pid: number, ppid: number, cmd: string): string {
  return ['root', pid, ppid, '0', '00:37', '?', '00:00:00', cmd].map(String).join('                ')
}

/**
 * The exact rows a real `--init` Room web container lists (captured from
 * Docker 29.2.1 on Docker Desktop): docker-init, the outer wrapper shell, and
 * then whatever the start command left running.
 */
function startTree(startCommand: string, tail: string[]): string {
  const wrapped = wrapStartCommand(startCommand)
  return [
    HEADER,
    row(513453, 513430, `/sbin/docker-init -- docker-entrypoint.sh sh -lc ${wrapped}`),
    row(513468, 513453, `sh -lc ${wrapped}`),
    ...tail
  ].join('\n') + '\n'
}

const ok = (stdout: string) => webWorkloadState({ code: 0, stdout })

describe('webWorkloadState (#160)', () => {
  it('reports a live app under the wrapper shells as running', () => {
    const start = 'node -e "require(\\"http\\").createServer(()=>{}).listen(3000)"'
    expect(ok(startTree(start, [
      row(513592, 513468, `sh -lc trap : TERM; ${start}`),
      row(513596, 513592, 'node -e require("http").createServer(()=>{}).listen(3000)')
    ]))).toBe('running')
  })

  it('reports a dead app under a surviving `exec sleep infinity` keeper as degraded', () => {
    // The dead node child is not listed at all: no STAT, no <defunct> row.
    expect(ok(startTree('node server.js & exec sleep infinity', [
      row(513484, 513468, 'sleep infinity')
    ]))).toBe('degraded')
  })

  it('reports a dead app beside a `tail -f /dev/null` keeper as degraded', () => {
    const start = 'node server.js & tail -f /dev/null'
    expect(ok(startTree(start, [
      row(513700, 513468, `sh -lc trap : TERM; ${start}`),
      row(513705, 513700, 'tail -f /dev/null')
    ]))).toBe('degraded')
  })

  it('reports a <defunct> app child under a live keeper as degraded', () => {
    expect(ok(startTree('node server.js & exec sleep infinity', [
      row(513484, 513468, 'sleep infinity'),
      row(513490, 513484, '[node] <defunct>')
    ]))).toBe('degraded')
  })

  it('reports only the wrapper shells left behind as degraded', () => {
    expect(ok(startTree('node server.js', [
      row(513592, 513468, 'sh -lc trap : TERM; node server.js')
    ]))).toBe('degraded')
  })

  it('does not let a docker exec (run_in_room) process stand in for a dead app', () => {
    // An exec hangs off the engine shim, the same parent as docker-init.
    expect(ok(startTree('node server.js & exec sleep infinity', [
      row(513484, 513468, 'sleep infinity'),
      row(514000, 513430, 'sleep 600')
    ]))).toBe('degraded')
  })

  it('still counts an app daemon re-parented to docker-init', () => {
    expect(ok(startTree('(node server.js &); exec sleep infinity', [
      row(513484, 513468, 'sleep infinity'),
      row(513500, 513453, 'node server.js')
    ]))).toBe('running')
  })

  it('treats an image entrypoint still waiting on the wrapper as a launcher, not the app', () => {
    const wrapped = wrapStartCommand('node server.js & exec sleep infinity')
    expect(ok([
      HEADER,
      row(10, 1, `/sbin/docker-init -- /bin/bash /entrypoint.sh sh -lc ${wrapped}`),
      row(11, 10, `/bin/bash /entrypoint.sh sh -lc ${wrapped}`),
      row(12, 11, `sh -lc ${wrapped}`),
      row(13, 12, 'sleep infinity')
    ].join('\n'))).toBe('degraded')
  })

  it('keeps an app that merely sleeps for a bounded time running', () => {
    expect(ok(startTree('while true; do sleep 30; done', [
      row(513592, 513468, 'sh -lc trap : TERM; while true; do sleep 30; done'),
      row(513600, 513592, 'sleep 30')
    ]))).toBe('running')
  })

  it('falls back to the whole listing without a recognisable start tree', () => {
    expect(ok(`${HEADER}\n${row(1, 0, 'node index.js')}\n`)).toBe('running')
    expect(ok(`${HEADER}\n${row(1, 0, 'sleep infinity')}\n`)).toBe('degraded')
    expect(ok(`${HEADER}\n${row(1234, 1, '[node] <defunct>')}\n`)).toBe('degraded')
    // STAT-bearing listings (Linux engines with `ps aux` columns) still read Z.
    expect(ok('USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND\nroot 1234 0.0 0.0 0 0 ? Z 00:00 00:00 [node]\n')).toBe('degraded')
    expect(ok('USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND\nroot 1234 0.0 0.0 0 0 ? S 00:00 00:00 node index.js\n')).toBe('running')
  })

  it('reports an empty, header-only or failed listing as degraded', () => {
    expect(ok('')).toBe('degraded')
    expect(ok(`${HEADER}\n`)).toBe('degraded')
    expect(webWorkloadState({ code: 1, stdout: '' })).toBe('degraded')
  })

  it('keeps the free-form command tail intact', () => {
    expect(parseDockerTop(`${HEADER}\n${row(7, 1, 'node  -e  "a b"')}\n`)).toEqual([
      { pid: '7', ppid: '1', cmd: 'node -e "a b"', dead: false }
    ])
  })
})
