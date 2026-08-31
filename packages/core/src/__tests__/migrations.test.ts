import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { applyMigrations, migrations } from '../store/migrations'

describe('database migrations', () => {
  it('upgrades an async-startup v5 database through physical acceptance fencing v11 without losing operations', () => {
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
      ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
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
        'android_app_installs',
        'room_artifacts',
        'android_acceptance_secrets',
        'android_acceptance_reports',
        'android_acceptance_run_snapshots',
        'android_acceptance_report_runs',
        'android_physical_operation_intents',
        'android_physical_acceptance_proof_gates'
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
      expect(installColumns.map(({ name }) => name)).toEqual(expect.arrayContaining([
        'acceptance_artifact_size_bytes',
        'acceptance_source_state_revision',
        'acceptance_source_workspace_revision',
        'acceptance_source_identity_hmac',
        'acceptance_environment_identity_hmac',
        'acceptance_image_reference',
        'acceptance_image_sha256'
      ]))
      expect(installTable.sql.replace(/\s+/g, ' ')).toContain('install_user_id BETWEEN 0 AND 21474')
      expect(installTable.sql.replace(/\s+/g, ' ')).toContain('install_user_serial BETWEEN 0 AND 2147483647')
      const artifactTable = sqlite
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'room_artifacts'")
        .get() as { sql: string }
      expect(artifactTable.sql.replace(/\s+/g, ' ')).toContain('REFERENCES rooms(id) ON DELETE CASCADE')
      expect(artifactTable.sql.replace(/\s+/g, ' ')).toContain("media_type TEXT NOT NULL CHECK (media_type = 'image/png')")
      expect(sqlite.prepare(
        "SELECT length(value) AS bytes FROM android_acceptance_secrets WHERE name = 'acceptance-hmac-v1'"
      ).get()).toEqual({ bytes: 32 })
      const reportRunsTable = sqlite
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'android_acceptance_report_runs'")
        .get() as { sql: string }
      expect(reportRunsTable.sql.replace(/\s+/g, ' ')).toContain(
        'REFERENCES android_acceptance_reports(id, room_id) ON DELETE CASCADE'
      )
      expect(reportRunsTable.sql.replace(/\s+/g, ' ')).toContain(
        'REFERENCES android_acceptance_run_snapshots(room_id, run_id) ON DELETE NO ACTION'
      )
      const writerIntents = sqlite
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'android_physical_operation_intents'")
        .get() as { sql: string }
      expect(writerIntents.sql.replace(/\s+/g, ' ')).toContain(
        'REFERENCES android_device_leases(id) ON DELETE RESTRICT'
      )
      expect(writerIntents.sql.replace(/\s+/g, ' ')).toContain('device_id TEXT NOT NULL UNIQUE')
      const proofGates = sqlite
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'android_physical_acceptance_proof_gates'")
        .get() as { sql: string }
      expect(proofGates.sql.replace(/\s+/g, ' ')).toContain('device_id TEXT NOT NULL UNIQUE')
    } finally {
      sqlite.close()
    }
  })

  it('upgrades a real v8 install receipt through acceptance fencing without changing its private authority', () => {
    const sqlite = new DatabaseSync(':memory:')
    try {
      for (const migration of migrations.filter(({ version }) => version <= 8)) {
        sqlite.exec(migration.sql)
        sqlite.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(migration.version)
      }
      sqlite.prepare(
        `INSERT INTO rooms (
           id, project, nickname, room_number, provider, source_type, source_ref,
           runtime_kind, runtime_version, pm_kind, start_command, internal_port,
           domain, https, status, created_at, last_used_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'aaaa1111',
        'app',
        'App',
        1,
        'android',
        'managed-git',
        'https://example.invalid/app.git',
        'android',
        '35',
        'gradle',
        './gradlew assembleDebug',
        3000,
        'app.localhost',
        0,
        'ready',
        '2026-08-30T00:00:00.000Z',
        '2026-08-30T00:00:00.000Z'
      )
      sqlite.prepare(
        `INSERT INTO android_app_installs (
           target_kind, target_id, lease_id, application_id, room_id, change_id, apk_sha256,
           installed_at, package_incarnation, log_fence, install_user_id, install_user_serial
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'emulator',
        'aaaa1111',
        null,
        'com.example.app',
        'aaaa1111',
        '11111111-2222-4333-8444-555555555555',
        'a'.repeat(64),
        '2026-08-31T00:00:00.000Z',
        'b'.repeat(64),
        'devhotel-install-u0-uid10123-11111111-2222-4333-8444-555555555555',
        0,
        42
      )

      applyMigrations(sqlite)

      expect(sqlite.prepare(
        `SELECT application_id, package_incarnation, install_user_id, install_user_serial,
                acceptance_artifact_size_bytes, acceptance_source_state_revision,
                acceptance_source_workspace_revision, acceptance_source_identity_hmac,
                acceptance_environment_identity_hmac, acceptance_image_reference,
                acceptance_image_sha256
         FROM android_app_installs`
      ).get()).toEqual({
        application_id: 'com.example.app',
        package_incarnation: 'b'.repeat(64),
        install_user_id: 0,
        install_user_serial: 42,
        acceptance_artifact_size_bytes: null,
        acceptance_source_state_revision: null,
        acceptance_source_workspace_revision: null,
        acceptance_source_identity_hmac: null,
        acceptance_environment_identity_hmac: null,
        acceptance_image_reference: null,
        acceptance_image_sha256: null
      })
      expect(sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'room_artifacts'"
      ).get()).toEqual({ name: 'room_artifacts' })
      expect(sqlite.prepare(
        "SELECT length(value) AS bytes FROM android_acceptance_secrets WHERE name = 'acceptance-hmac-v1'"
      ).get()).toEqual({ bytes: 32 })
      expect(sqlite.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 11 })
    } finally {
      sqlite.close()
    }
  })
})
