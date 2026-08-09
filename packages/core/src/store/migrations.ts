import type { DatabaseSync } from 'node:sqlite'

export interface Migration {
  version: number
  sql: string
}

export const migrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY
      );
      CREATE TABLE rooms (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        nickname TEXT NOT NULL,
        room_number INTEGER NOT NULL,
        provider TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        runtime_kind TEXT NOT NULL,
        runtime_version TEXT NOT NULL,
        pm_kind TEXT NOT NULL,
        pm_version TEXT,
        start_command TEXT NOT NULL,
        internal_port INTEGER NOT NULL,
        domain TEXT NOT NULL UNIQUE,
        https INTEGER NOT NULL,
        status TEXT NOT NULL,
        host_port INTEGER,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        thumb_path TEXT,
        extra TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE changes (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        title TEXT NOT NULL,
        actor TEXT NOT NULL,
        component TEXT NOT NULL,
        before_json TEXT,
        after_json TEXT,
        captured_json TEXT,
        steps_json TEXT NOT NULL DEFAULT '[]',
        verify_json TEXT,
        undoable INTEGER NOT NULL,
        undo_strategy TEXT NOT NULL,
        status TEXT NOT NULL,
        raw_log_path TEXT,
        created_at TEXT NOT NULL,
        undone_at TEXT,
        UNIQUE(room_id, seq)
      );
      CREATE TABLE checks (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        ran_at TEXT NOT NULL,
        report_json TEXT NOT NULL
      );
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE INDEX idx_changes_room_seq ON changes(room_id, seq DESC);
      CREATE INDEX idx_checks_room_ran ON checks(room_id, ran_at DESC);
    `,
  },
]

export function applyMigrations(sqlite: DatabaseSync): void {
  sqlite.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)')
  const row = sqlite.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as
    | { v: number | null }
    | undefined
  const current = row?.v ?? 0
  for (const m of migrations) {
    if (m.version <= current) continue
    sqlite.exec('BEGIN')
    try {
      sqlite.exec(m.sql)
      sqlite.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(m.version)
      sqlite.exec('COMMIT')
    } catch (err) {
      sqlite.exec('ROLLBACK')
      throw err
    }
  }
}
