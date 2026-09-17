import type {
  ClientBrowserKind,
  ClientBrowserProfileMode,
  ClientBrowserSessionRecord,
  ClientBrowserStatus
} from '@devhotel/shared'
import type { Db } from './db'

interface SessionRow {
  id: string
  room_id: string
  token_hash: string
  status: string
  pid: number | null
  devtools_port: number | null
  browser_kind: string | null
  headless: number
  profile_mode: string
  profile_path: string
  runtime_generation: string
  created_at: string
  last_active_at: string
}

function rowToRecord(row: SessionRow): ClientBrowserSessionRecord {
  return {
    id: row.id,
    roomId: row.room_id,
    tokenHash: row.token_hash,
    status: row.status as ClientBrowserStatus,
    pid: row.pid,
    devtoolsPort: row.devtools_port,
    browserKind: (row.browser_kind as ClientBrowserKind | null) ?? null,
    headless: row.headless === 1,
    profileMode: row.profile_mode as ClientBrowserProfileMode,
    profilePath: row.profile_path,
    runtimeGeneration: row.runtime_generation,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at
  }
}

/** Durable Client Browser sessions. Rows exist only while a browser may exist; release deletes them. */
export class ClientBrowserRepo {
  constructor(private readonly db: Db) {}

  create(record: ClientBrowserSessionRecord): void {
    this.db.sqlite
      .prepare(
        `INSERT INTO client_browser_sessions (
           id, room_id, token_hash, status, pid, devtools_port, browser_kind, headless,
           profile_mode, profile_path, runtime_generation, created_at, last_active_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.roomId,
        record.tokenHash,
        record.status,
        record.pid,
        record.devtoolsPort,
        record.browserKind,
        record.headless ? 1 : 0,
        record.profileMode,
        record.profilePath,
        record.runtimeGeneration,
        record.createdAt,
        record.lastActiveAt
      )
  }

  get(id: string): ClientBrowserSessionRecord | null {
    const row = this.db.sqlite.prepare('SELECT * FROM client_browser_sessions WHERE id = ?').get(id) as
      | SessionRow
      | undefined
    return row ? rowToRecord(row) : null
  }

  listByRoom(roomId: string): ClientBrowserSessionRecord[] {
    const rows = this.db.sqlite
      .prepare('SELECT * FROM client_browser_sessions WHERE room_id = ? ORDER BY created_at ASC, id ASC')
      .all(roomId) as unknown as SessionRow[]
    return rows.map(rowToRecord)
  }

  listAll(): ClientBrowserSessionRecord[] {
    const rows = this.db.sqlite
      .prepare('SELECT * FROM client_browser_sessions ORDER BY created_at ASC, id ASC')
      .all() as unknown as SessionRow[]
    return rows.map(rowToRecord)
  }

  /** Sessions that may still own a browser process. */
  listLive(): ClientBrowserSessionRecord[] {
    const rows = this.db.sqlite
      .prepare("SELECT * FROM client_browser_sessions WHERE status IN ('starting', 'ready') ORDER BY created_at ASC, id ASC")
      .all() as unknown as SessionRow[]
    return rows.map(rowToRecord)
  }

  markLaunched(
    id: string,
    launched: { pid: number | null; devtoolsPort: number | null; browserKind: ClientBrowserKind | null },
    at: string
  ): void {
    this.db.sqlite
      .prepare(
        `UPDATE client_browser_sessions
         SET status = 'ready', pid = ?, devtools_port = ?, browser_kind = ?, last_active_at = ?
         WHERE id = ?`
      )
      .run(launched.pid, launched.devtoolsPort, launched.browserKind, at, id)
  }

  updateStatus(id: string, status: ClientBrowserStatus, at: string): void {
    this.db.sqlite
      .prepare('UPDATE client_browser_sessions SET status = ?, last_active_at = ? WHERE id = ?')
      .run(status, at, id)
  }

  touch(id: string, at: string): void {
    this.db.sqlite.prepare('UPDATE client_browser_sessions SET last_active_at = ? WHERE id = ?').run(at, id)
  }

  delete(id: string): void {
    this.db.sqlite.prepare('DELETE FROM client_browser_sessions WHERE id = ?').run(id)
  }
}

export function clientBrowserRepo(db: Db): ClientBrowserRepo {
  return new ClientBrowserRepo(db)
}
