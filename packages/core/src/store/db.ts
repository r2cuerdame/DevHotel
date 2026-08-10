import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { applyMigrations } from './migrations'

export interface Db {
  sqlite: DatabaseSync
  close(): void
}

export function openDb(dir: string): Db {
  mkdirSync(dir, { recursive: true })
  const sqlite = new DatabaseSync(join(dir, 'devhotel.db'))
  // Hotel Service assignments are permission ownership records. Their Room
  // and injection cleanup must never depend on callers remembering deletes.
  sqlite.exec('PRAGMA foreign_keys=ON')
  sqlite.exec('PRAGMA journal_mode=WAL')
  applyMigrations(sqlite)
  return {
    sqlite,
    close() {
      sqlite.close()
    },
  }
}
