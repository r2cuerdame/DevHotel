import type { Db } from './db'

export interface SettingsRepo {
  get(k: string): string | null
  set(k: string, v: string): void
  delete(k: string): void
}

export function settingsRepo(db: Db): SettingsRepo {
  const { sqlite } = db
  return {
    get(k) {
      const row = sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(k) as
        | { value: string }
        | undefined
      return row ? row.value : null
    },
    set(k, v) {
      sqlite
        .prepare(
          `INSERT INTO settings (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(k, v)
    },
    delete(k) {
      sqlite.prepare('DELETE FROM settings WHERE key = ?').run(k)
    },
  }
}
