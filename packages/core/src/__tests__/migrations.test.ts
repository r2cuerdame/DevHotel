import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { applyMigrations, migrations } from '../store/migrations'

describe('database migrations', () => {
  it('upgrades an async-startup v5 database through user-bound install receipts v8 without losing operations', () => {
    const sqlite = new DatabaseSync(':memory:')
    try {
      for (const migration of migrations.filter(({ version }) => version <= 5)) {
        sqlite.exec(migration.sql)
        sqlite.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(migration.version)
      }

      sqlite.prepare(
        `INSERT INTO operations (
           id, kind, room_id, actor, status, stage, stages_json,
           error_json, started_at, updated_at, finished_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'operation-before-device-broker',
        'room-start',
        'room-before-device-broker',
        'agent',
        'succeeded',
        'complete',
        '[]',
        null,
        '2026-08-30T00:00:00.000Z',
        '2026-08-30T00:00:01.000Z',
        '2026-08-30T00:00:01.000Z'
      )

      applyMigrations(sqlite)

      expect(
        (sqlite.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[])
          .map(({ version }) => version)
      ).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      expect(sqlite.prepare('SELECT id, status FROM operations').get()).toEqual({
        id: 'operation-before-device-broker',
        status: 'succeeded'
      })
      expect(
        (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
          .map(({ name }) => name)
      ).toEqual(expect.arrayContaining([
        'operations',
        'android_device_broker_secrets',
        'android_devices',
        'android_device_leases',
        'android_device_queue',
        'android_device_events',
        'android_app_installs'
      ]))
      const queueDedupe = sqlite
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_android_queue_dedupe'")
        .get() as { sql: string }
      expect(queueDedupe.sql.replace(/\s+/g, ' ')).toContain(
        "ON android_device_queue(room_id) WHERE state = 'waiting'"
      )
      expect(queueDedupe.sql).not.toContain('IFNULL')
      expect(
        sqlite.prepare("SELECT length(value) AS bytes FROM android_device_broker_secrets WHERE name = 'physical-identity-hmac-v1'").get()
      ).toEqual({ bytes: 32 })
      const deviceColumns = sqlite.prepare('PRAGMA table_info(android_devices)').all() as { name: string; notnull: number }[]
      expect(deviceColumns.find(({ name }) => name === 'physical_identity')).toMatchObject({ notnull: 1 })
      const installTable = sqlite
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'android_app_installs'")
        .get() as { sql: string }
      expect(installTable.sql.replace(/\s+/g, ' ')).toContain(
        'PRIMARY KEY (target_kind, target_id, application_id)'
      )
      expect(installTable.sql.replace(/\s+/g, ' ')).toContain(
        "target_kind = 'physical' AND lease_id IS NOT NULL"
      )
      const installColumns = sqlite.prepare('PRAGMA table_info(android_app_installs)').all() as {
        name: string
        notnull: number
      }[]
      expect(installColumns.find(({ name }) => name === 'package_incarnation')).toMatchObject({ notnull: 1 })
      expect(installColumns.find(({ name }) => name === 'log_fence')).toMatchObject({ notnull: 0 })
      expect(installColumns.find(({ name }) => name === 'install_user_id')).toMatchObject({ notnull: 0 })
      expect(installColumns.find(({ name }) => name === 'install_user_serial')).toMatchObject({ notnull: 0 })
      expect(installTable.sql.replace(/\s+/g, ' ')).toContain('install_user_id BETWEEN 0 AND 21474')
      expect(installTable.sql.replace(/\s+/g, ' ')).toContain('install_user_serial BETWEEN 0 AND 2147483647')
    } finally {
      sqlite.close()
    }
  })
})
