import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { IngressRouteObservation } from './observations'

/**
 * A durable record of the Host ports DevHotel opened, and for whom.
 *
 * Every other thing a Room owns is enumerable by asking the engine that holds
 * it. A Host ingress port is not: no engine knows about it, the Host's own
 * socket table cannot say which Room it belonged to, and until now the only
 * record was a `Map` inside a running process. That is fine right up to the
 * moment the process does not exit cleanly — and then a port is listening, a
 * connection to it hangs against a container that is gone, and nothing on the
 * machine can attribute or reclaim it.
 *
 * So DevHotel writes it down. The ledger is what makes an ingress route an
 * artifact with an ownership proof like any other, which is what lets the Host
 * footprint claim to enumerate *all* owned artifacts rather than all the owned
 * artifacts that happen to live in an engine.
 */

const LEDGER_FILE = 'ingress.json'
const SCHEMA = 1

interface LedgerEntry {
  roomId: string
  hostPort: number
  target: string
  runtimeId: string | null
  createdAt: string
}

interface LedgerFile {
  schema: typeof SCHEMA
  owner: 'devhotel'
  routes: LedgerEntry[]
}

function isValidEntry(value: unknown): value is LedgerEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry['roomId'] === 'string' &&
    /^[a-z0-9]{8}$/.test(entry['roomId']) &&
    typeof entry['hostPort'] === 'number' &&
    Number.isSafeInteger(entry['hostPort']) &&
    entry['hostPort'] > 0 &&
    entry['hostPort'] <= 65_535 &&
    typeof entry['target'] === 'string' &&
    entry['target'].length <= 256 &&
    (entry['runtimeId'] === null || typeof entry['runtimeId'] === 'string') &&
    typeof entry['createdAt'] === 'string'
  )
}

export interface IngressLedgerOptions {
  userData: string
  now?: () => Date
}

export class IngressLedger {
  private readonly root: string
  private readonly file: string
  private readonly now: () => Date

  constructor(opts: IngressLedgerOptions) {
    this.root = path.resolve(opts.userData, 'runtime')
    this.file = path.join(this.root, LEDGER_FILE)
    this.now = opts.now ?? (() => new Date())
  }

  /**
   * Every route DevHotel believes it published.
   *
   * A ledger that cannot be read comes back empty rather than throwing. An
   * unreadable ledger is a lost inventory, not a reason to refuse to start —
   * and the footprint reports the gap separately, so the loss is visible where
   * it matters instead of taking the app down.
   */
  list(): IngressRouteObservation[] {
    if (!existsSync(this.file)) return []
    try {
      const info = lstatSync(this.file)
      if (!info.isFile() || info.isSymbolicLink()) return []
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<LedgerFile>
      if (parsed.schema !== SCHEMA || parsed.owner !== 'devhotel' || !Array.isArray(parsed.routes)) return []
      return parsed.routes.filter(isValidEntry).map((entry) => ({ ...entry }))
    } catch {
      return []
    }
  }

  /** True when the ledger file exists but could not be read as one. */
  isDamaged(): boolean {
    if (!existsSync(this.file)) return false
    try {
      const info = lstatSync(this.file)
      if (!info.isFile() || info.isSymbolicLink()) return true
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<LedgerFile>
      return parsed.schema !== SCHEMA || parsed.owner !== 'devhotel' || !Array.isArray(parsed.routes)
    } catch {
      return true
    }
  }

  /**
   * Records one route, replacing any the Room already had.
   *
   * Written before the port is handed to the Gateway, never after. A record of
   * a port that was never opened costs one revoke of nothing; a port opened
   * with no record is the orphan this ledger exists to prevent.
   */
  record(route: Omit<IngressRouteObservation, 'createdAt'> & { createdAt?: string }): void {
    const routes = this.list().filter((entry) => entry.roomId !== route.roomId)
    routes.push({
      roomId: route.roomId,
      hostPort: route.hostPort,
      target: route.target,
      runtimeId: route.runtimeId,
      createdAt: route.createdAt ?? this.now().toISOString()
    })
    this.persist(routes)
  }

  forget(roomId: string): void {
    const routes = this.list()
    const remaining = routes.filter((entry) => entry.roomId !== roomId)
    if (remaining.length === routes.length) return
    this.persist(remaining)
  }

  forgetAll(): void {
    this.persist([])
  }

  private persist(routes: IngressRouteObservation[]): void {
    mkdirSync(this.root, { recursive: true })
    const payload: LedgerFile = {
      schema: SCHEMA,
      owner: 'devhotel',
      routes: routes.map((route) => ({
        roomId: route.roomId,
        hostPort: route.hostPort,
        target: route.target,
        runtimeId: route.runtimeId,
        createdAt: route.createdAt
      }))
    }
    const temporary = path.join(this.root, `.ingress-${randomUUID()}.tmp`)
    try {
      writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      renameSync(temporary, this.file)
    } finally {
      rmSync(temporary, { force: true })
    }
  }
}
