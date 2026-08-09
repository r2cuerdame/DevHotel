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
  sqlite.exec('PRAGMA journal_mode=WAL')
  applyMigrations(sqlite)
  return {
    sqlite,
    close() {
      sqlite.close()
    },
  }
}
