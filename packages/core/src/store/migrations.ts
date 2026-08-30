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
        kind TEXT NOT NULL DEFAULT '',
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
  {
    version: 2,
    sql: `
      ALTER TABLE rooms ADD COLUMN workspace_mode TEXT;
      ALTER TABLE rooms ADD COLUMN state_revision INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE rooms ADD COLUMN workspace_volume_revision INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE rooms ADD COLUMN sync_status TEXT;
      ALTER TABLE rooms ADD COLUMN last_synced_at TEXT;
      ALTER TABLE rooms ADD COLUMN host_sync_enabled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE rooms ADD COLUMN workspace_fingerprint TEXT;

      UPDATE rooms
      SET workspace_mode = CASE
            WHEN source_type = 'linked-folder' THEN 'legacy-host-bind'
            WHEN source_type = 'empty' THEN 'empty'
            ELSE 'hotel'
          END,
          sync_status = CASE
            WHEN source_type = 'linked-folder' THEN 'legacy'
            WHEN source_type = 'empty' THEN 'empty'
            ELSE 'synced'
          END,
          host_sync_enabled = CASE WHEN source_type = 'linked-folder' THEN 1 ELSE 0 END;
    `
  },
  {
    version: 3,
    sql: `
      CREATE TABLE hotel_services (
        id TEXT PRIMARY KEY,
        manifest_json TEXT NOT NULL,
        availability TEXT NOT NULL CHECK (availability IN ('available', 'unavailable')),
        registration_state TEXT NOT NULL CHECK (registration_state IN ('registered', 'unregistered')),
        provision_state TEXT NOT NULL CHECK (provision_state IN ('not-provisioned', 'provisioning', 'provisioned', 'repair-needed', 'failed')),
        connection_state TEXT NOT NULL CHECK (connection_state IN ('not-applicable', 'disconnected', 'connected', 'unavailable', 'invalid', 'temporarily-unavailable')),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        status_detail TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE hotel_service_assignments (
        id TEXT PRIMARY KEY,
        service_id TEXT NOT NULL REFERENCES hotel_services(id) ON DELETE CASCADE,
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('hotel', 'host-project', 'room')),
        scope_ref TEXT,
        room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE,
        agent_adapter_id TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (scope_kind = 'hotel' AND scope_ref IS NULL AND room_id IS NULL) OR
          (scope_kind = 'host-project' AND scope_ref IS NOT NULL AND room_id IS NULL) OR
          (scope_kind = 'room' AND scope_ref IS NOT NULL AND room_id = scope_ref)
        )
      );
      CREATE TABLE hotel_service_injections (
        id TEXT PRIMARY KEY,
        assignment_id TEXT NOT NULL UNIQUE REFERENCES hotel_service_assignments(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        managed_key TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_hotel_assignments_scope
        ON hotel_service_assignments(service_id, scope_kind, IFNULL(scope_ref, ''), agent_adapter_id);
      CREATE INDEX idx_hotel_assignments_room ON hotel_service_assignments(room_id, agent_adapter_id);
    `
  },
  {
    // Tombstone for a pre-release table-rebuild draft. Keep the version so
    // developer databases that already recorded v4 never drift ahead of the
    // source migration sequence. The final v3 schema above is authoritative.
    version: 4,
    sql: 'SELECT 1;'
  },
  {
    // Long operations (waking a Room) outlive the call that started them, so
    // their progress has to survive both a caller timeout and an app restart.
    version: 5,
    sql: `
      CREATE TABLE operations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        room_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        status TEXT NOT NULL,
        stage TEXT NOT NULL,
        stages_json TEXT NOT NULL DEFAULT '[]',
        error_json TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX idx_operations_room_started ON operations(room_id, started_at DESC);
    `
  },
  {
    // Android Device Broker. A physical phone is Hotel-owned and shared, so its
    // ownership record cannot live in a Room row: the lease has to outlive the
    // Room process that took it, and a Room deletion must free the phone rather
    // than cascade the device away with it. The install secret correlates USB
    // and wireless routes without persisting the raw hardware identity.
    version: 6,
    sql: `
      CREATE TABLE android_device_broker_secrets (
        name TEXT PRIMARY KEY,
        value BLOB NOT NULL CHECK (length(value) = 32)
      );
      INSERT INTO android_device_broker_secrets (name, value)
        VALUES ('physical-identity-hmac-v1', randomblob(32));
      CREATE TABLE android_devices (
        id TEXT PRIMARY KEY,
        serial TEXT NOT NULL UNIQUE,
        physical_identity TEXT NOT NULL UNIQUE CHECK (length(physical_identity) = 64),
        nickname TEXT NOT NULL,
        model TEXT,
        android_version TEXT,
        api_level INTEGER,
        connection TEXT NOT NULL CHECK (connection IN ('usb', 'wireless', 'emulator')),
        health TEXT NOT NULL CHECK (health IN ('ready', 'unauthorized', 'offline', 'disconnected')),
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE TABLE android_device_leases (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL REFERENCES android_devices(id) ON DELETE CASCADE,
        room_id TEXT NOT NULL,
        project TEXT NOT NULL,
        issue_ref TEXT,
        run_id TEXT,
        worker_id TEXT NOT NULL,
        purpose TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'released', 'expired', 'revoked')),
        acquired_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        activity_at TEXT NOT NULL,
        ttl_ms INTEGER NOT NULL,
        max_duration_ms INTEGER NOT NULL,
        released_at TEXT,
        release_reason TEXT
      );
      -- The exclusivity invariant itself: at most one active lease per device,
      -- enforced by the database rather than by careful callers.
      CREATE UNIQUE INDEX idx_android_lease_exclusive
        ON android_device_leases(device_id) WHERE state = 'active';
      CREATE INDEX idx_android_lease_room ON android_device_leases(room_id, state);
      CREATE TABLE android_device_queue (
        id TEXT PRIMARY KEY,
        device_id TEXT REFERENCES android_devices(id) ON DELETE CASCADE,
        room_id TEXT NOT NULL,
        project TEXT NOT NULL,
        purpose TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        issue_ref TEXT,
        run_id TEXT,
        constraints_json TEXT NOT NULL DEFAULT '{}',
        priority INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL CHECK (state IN ('waiting', 'granted', 'cancelled')),
        requested_at TEXT NOT NULL,
        resolved_at TEXT,
        ttl_ms INTEGER NOT NULL,
        max_duration_ms INTEGER NOT NULL
      );
      -- One waiting request per Room: a retrying agent rejoins an identical
      -- request, while a changed request replaces the previous durable row.
      CREATE UNIQUE INDEX idx_android_queue_dedupe
        ON android_device_queue(room_id) WHERE state = 'waiting';
      CREATE INDEX idx_android_queue_order ON android_device_queue(state, priority DESC, requested_at);
      CREATE TABLE android_device_events (
        id TEXT PRIMARY KEY,
        device_id TEXT,
        room_id TEXT,
        kind TEXT NOT NULL,
        detail TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE INDEX idx_android_events_at ON android_device_events(at DESC);
    `
  }
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
