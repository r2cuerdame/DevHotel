import { START_COMMAND_PROGRAM_PRELUDE, START_COMMAND_WRAPPER_PRELUDE } from './naming'

/**
 * Whether a running Room web container still hosts its app, judged from one
 * `docker top` listing.
 *
 * A running container proves little on its own: `--init` keeps docker-init at
 * PID 1, `wrapStartCommand` adds two supervisor shells below it, and a start
 * command such as `node server.js & exec sleep infinity` leaves an idle keeper
 * that outlives the server. None of those is the app. Docker Desktop's
 * `docker top` is `ps -ef` shaped (no STAT column) and a cgroup v2 engine
 * drops an exited process from the listing before its parent reaps it, so a
 * dead app is usually simply absent, not a `<defunct>` row. Liveness therefore
 * asks for a live process that is not one of those keepers.
 *
 * Only the container's own start tree counts. A `docker exec` process (a
 * `run_in_room` command) hangs off the engine shim rather than PID 1, so it
 * cannot make a dead app look alive. Orphans the app leaves behind are
 * re-parented to PID 1 and still count.
 */
export function webWorkloadState(listing: { code: number; stdout: string }): 'running' | 'degraded' {
  if (listing.code !== 0) return 'degraded'
  const processes = parseDockerTop(listing.stdout)
  if (processes.length === 0) return 'degraded'
  return appProcesses(processes).some((p) => !p.dead && !isKeeper(p.cmd)) ? 'running' : 'degraded'
}

export interface TopProcess {
  pid: string | undefined
  ppid: string | undefined
  cmd: string
  dead: boolean
}

export function parseDockerTop(stdout: string): TopProcess[] {
  const lines = stdout.trim().split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length <= 1) return []
  const headers = lines[0]!.trim().split(/\s+/).map((h) => h.toUpperCase())
  const cmdIndex = headers.findIndex((h) => h === 'CMD' || h === 'COMMAND' || h === 'ARGS')
  const pidIndex = headers.indexOf('PID')
  const ppidIndex = headers.indexOf('PPID')
  const statIndex = headers.findIndex((h) => h === 'STAT' || h === 'S')
  return lines.slice(1).map((line) => {
    const cols = line.trim().split(/\s+/)
    // The command is the free-form tail; every column before it is one token.
    const cmd = cmdIndex === -1 ? cols.join(' ') : cols.slice(cmdIndex).join(' ')
    const stat = statIndex === -1 ? '' : cols[statIndex] ?? ''
    return {
      pid: pidIndex === -1 ? undefined : cols[pidIndex],
      ppid: ppidIndex === -1 ? undefined : cols[ppidIndex],
      cmd,
      dead: cmd.includes('<defunct>') || stat.startsWith('Z')
    }
  })
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const INIT = /^(\S*\/)?(docker-init|tini)(\s|$)/
const WRAPPER_SHELL = new RegExp(`^(\\S*/)?sh -lc ${escapeRegExp(START_COMMAND_WRAPPER_PRELUDE)};`)
const PROGRAM_SHELL = new RegExp(`^(\\S*/)?sh -lc ${escapeRegExp(START_COMMAND_PROGRAM_PRELUDE)};`)
const IDLE_KEEPER = /^(\S*\/)?(sleep (infinity|inf)|tail -[fF] \/dev\/null)$/

function isKeeper(cmd: string): boolean {
  return INIT.test(cmd) || WRAPPER_SHELL.test(cmd) || PROGRAM_SHELL.test(cmd) || IDLE_KEEPER.test(cmd)
}

/**
 * The container's start tree minus the chain that launches the wrapper shell
 * (docker-init and any image entrypoint still waiting on it). Without PID and
 * PPID columns, or without a recognisable root, every listed process is kept.
 */
function appProcesses(processes: TopProcess[]): TopProcess[] {
  const byPid = new Map<string, TopProcess>()
  for (const p of processes) if (p.pid !== undefined && p.ppid !== undefined) byPid.set(p.pid, p)
  if (byPid.size !== processes.length) return processes
  const root =
    processes.find((p) => INIT.test(p.cmd)) ??
    processes.find((p) => WRAPPER_SHELL.test(p.cmd) && !byPid.has(p.ppid!))
  if (!root) return processes

  const children = new Map<string, TopProcess[]>()
  for (const p of processes) {
    if (p === root) continue
    const siblings = children.get(p.ppid!) ?? []
    siblings.push(p)
    children.set(p.ppid!, siblings)
  }
  const tree = new Set<TopProcess>()
  const pending = [root]
  while (pending.length > 0) {
    const next = pending.pop()!
    if (tree.has(next)) continue
    tree.add(next)
    pending.push(...(children.get(next.pid!) ?? []))
  }

  const launchers = new Set<TopProcess>([root])
  for (const p of tree) {
    if (!WRAPPER_SHELL.test(p.cmd)) continue
    for (let at: TopProcess | undefined = p; at && at !== root && !launchers.has(at); at = byPid.get(at.ppid!)) {
      launchers.add(at)
    }
  }
  return [...tree].filter((p) => !launchers.has(p))
}
