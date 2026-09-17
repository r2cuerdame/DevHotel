import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { applyMigrations } from './migrations'

export interface Db {
  sqlite: DatabaseSync
  close(): void
}

export interface OpenDbOptions {
  /**
   * How long one connection waits for another writer before SQLITE_BUSY is
   * raised. Must be positive: the desktop, its control API, and the device
   * sweeper share this file, and a zero budget turns every overlapping write
   * into an immediate failure instead of a bounded wait.
   */
  busyTimeoutMs?: number
}

/**
 * Contention budget for one repository statement. Room lifecycle work holds
 * short transactions, so a wait this long means something is wedged and
 * failing with SQLITE_BUSY is preferable to blocking the caller forever.
 */
export const DB_BUSY_TIMEOUT_MS = 5_000

export function openDb(dir: string, options: OpenDbOptions = {}): Db {
  const busyTimeoutMs = options.busyTimeoutMs ?? DB_BUSY_TIMEOUT_MS
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs <= 0) {
    throw new Error(`SQLite busy_timeout must be a positive integer, got ${String(busyTimeoutMs)}`)
  }
  mkdirSync(dir, { recursive: true })
  const sqlite = new DatabaseSync(join(dir, 'devhotel.db'))
  try {
    // Hotel Service assignments are permission ownership records. Their Room
    // and injection cleanup must never depend on callers remembering deletes.
    sqlite.exec('PRAGMA foreign_keys=ON')
    sqlite.exec('PRAGMA journal_mode=WAL')
    sqlite.exec(`PRAGMA busy_timeout=${busyTimeoutMs}`)
    // Prove the budget landed rather than trusting the pragma silently: a
    // connection without one races every other DevHotel writer unbounded.
    const applied = sqlite.prepare('PRAGMA busy_timeout').get() as { timeout: number } | undefined
    if (applied?.timeout !== busyTimeoutMs) {
      throw new Error(`SQLite busy_timeout was not applied (expected ${busyTimeoutMs}, got ${String(applied?.timeout)})`)
    }
    applyMigrations(sqlite)
  } catch (error) {
    sqlite.close()
    throw error
  }
  return {
    sqlite,
    close() {
      sqlite.close()
    },
  }
}
