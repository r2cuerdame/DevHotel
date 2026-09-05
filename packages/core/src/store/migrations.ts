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
  },
  {
    // A package name alone is not an automation capability. Only the last
    // successful DevHotel-managed install on one exact target owns a receipt;
    // another Room installing the same package atomically replaces that owner.
    version: 7,
    sql: `
      CREATE TABLE android_app_installs (
        target_kind TEXT NOT NULL CHECK (target_kind IN ('emulator', 'physical')),
        target_id TEXT NOT NULL,
        lease_id TEXT CHECK (
          (target_kind = 'emulator' AND lease_id IS NULL) OR
          (target_kind = 'physical' AND lease_id IS NOT NULL)
        ),
        application_id TEXT NOT NULL,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        change_id TEXT NOT NULL,
        apk_sha256 TEXT NOT NULL CHECK (length(apk_sha256) = 64),
        installed_at TEXT NOT NULL,
        package_incarnation TEXT NOT NULL CHECK (length(package_incarnation) = 64),
        log_fence TEXT CHECK (log_fence IS NULL OR length(log_fence) BETWEEN 32 AND 200),
        PRIMARY KEY (target_kind, target_id, application_id)
      );
      CREATE INDEX idx_android_app_installs_room_target
        ON android_app_installs(room_id, target_kind, target_id, application_id);
    `
  },
  {
    // Android APK paths and bytes are shared across users, and numeric user
    // IDs may be recycled after deletion. Keep the active user's non-reused
    // serial together with its ID as private durable authority; legacy rows
    // remain null and therefore fail closed until android_run.
    version: 8,
    sql: `
      ALTER TABLE android_app_installs
        ADD COLUMN install_user_id INTEGER CHECK (
          install_user_id IS NULL OR install_user_id BETWEEN 0 AND 21474
        );
      ALTER TABLE android_app_installs
        ADD COLUMN install_user_serial INTEGER CHECK (
          install_user_serial IS NULL OR install_user_serial BETWEEN 0 AND 2147483647
        );
    `
  },
  {
    // Immutable Room screenshot artifacts. Content paths are derived from the
    // validated Room/artifact IDs and never stored as caller-controlled text.
    version: 9,
    sql: `
      CREATE TABLE room_artifacts (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind = 'android-screenshot'),
        filename TEXT NOT NULL,
        media_type TEXT NOT NULL CHECK (media_type = 'image/png'),
        size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 16777216),
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
        actor TEXT NOT NULL CHECK (actor IN ('user', 'devhotel', 'agent')),
        created_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );
      CREATE INDEX idx_room_artifacts_room_created
        ON room_artifacts(room_id, created_at DESC, id DESC);
    `
  },
  {
    // Installation-local authentication for immutable Android acceptance
    // reports. Public install receipts stay unchanged; only Core can read the
    // additive source/build identities on tracked install rows.
    version: 10,
    sql: `
      ALTER TABLE android_app_installs
        ADD COLUMN acceptance_artifact_size_bytes INTEGER CHECK (
          acceptance_artifact_size_bytes IS NULL OR
          acceptance_artifact_size_bytes BETWEEN 1 AND 536870912
        );
      ALTER TABLE android_app_installs
        ADD COLUMN acceptance_source_state_revision INTEGER CHECK (
          acceptance_source_state_revision IS NULL OR acceptance_source_state_revision >= 0
        );
      ALTER TABLE android_app_installs
        ADD COLUMN acceptance_source_workspace_revision INTEGER CHECK (
          acceptance_source_workspace_revision IS NULL OR acceptance_source_workspace_revision >= 0
        );
      ALTER TABLE android_app_installs
        ADD COLUMN acceptance_source_identity_hmac TEXT CHECK (
          acceptance_source_identity_hmac IS NULL OR
          (length(acceptance_source_identity_hmac) = 64 AND acceptance_source_identity_hmac NOT GLOB '*[^0-9a-f]*')
        );
      ALTER TABLE android_app_installs
        ADD COLUMN acceptance_environment_identity_hmac TEXT CHECK (
          acceptance_environment_identity_hmac IS NULL OR
          (length(acceptance_environment_identity_hmac) = 64 AND acceptance_environment_identity_hmac NOT GLOB '*[^0-9a-f]*')
        );
      ALTER TABLE android_app_installs
        ADD COLUMN acceptance_image_reference TEXT CHECK (
          acceptance_image_reference IS NULL OR length(acceptance_image_reference) BETWEEN 1 AND 512
        );
      ALTER TABLE android_app_installs
        ADD COLUMN acceptance_image_sha256 TEXT CHECK (
          acceptance_image_sha256 IS NULL OR
          (length(acceptance_image_sha256) = 64 AND acceptance_image_sha256 NOT GLOB '*[^0-9a-f]*')
        );

      CREATE TABLE android_acceptance_secrets (
        name TEXT PRIMARY KEY,
        value BLOB NOT NULL CHECK (length(value) = 32)
      );
      INSERT INTO android_acceptance_secrets (name, value)
        VALUES ('acceptance-hmac-v1', randomblob(32));

      CREATE TABLE android_acceptance_reports (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        stage TEXT NOT NULL CHECK (stage IN ('development', 'final-physical')),
        status TEXT NOT NULL CHECK (status IN ('pass', 'fail')),
        application_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 65536),
        seal_hmac TEXT NOT NULL CHECK (length(seal_hmac) = 64 AND seal_hmac NOT GLOB '*[^0-9a-f]*'),
        report_json TEXT NOT NULL CHECK (
          length(CAST(report_json AS BLOB)) = size_bytes
        ),
        UNIQUE(id, room_id)
      );
      CREATE INDEX idx_android_acceptance_reports_room_created
        ON android_acceptance_reports(room_id, created_at DESC, id DESC);

      CREATE TABLE android_acceptance_run_snapshots (
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        identity_hmac TEXT NOT NULL CHECK (length(identity_hmac) = 64 AND identity_hmac NOT GLOB '*[^0-9a-f]*'),
        size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 4194304),
        snapshot_json TEXT NOT NULL CHECK (
          length(CAST(snapshot_json AS BLOB)) BETWEEN 1 AND 16384
        ),
        PRIMARY KEY (room_id, run_id)
      );
      CREATE TABLE android_acceptance_report_runs (
        report_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        PRIMARY KEY (report_id, run_id),
        FOREIGN KEY (report_id, room_id)
          REFERENCES android_acceptance_reports(id, room_id) ON DELETE CASCADE,
        FOREIGN KEY (room_id, run_id)
          REFERENCES android_acceptance_run_snapshots(room_id, run_id) ON DELETE NO ACTION
      );
      CREATE INDEX idx_android_acceptance_report_runs_room
        ON android_acceptance_report_runs(room_id, run_id);
    `
  },
  {
    // A Room lock is process-local, while a physical Android target and its
    // Host ADB children are shared by every DevHotel process. Durable per-command
    // intents prevent a final read-only proof from racing an already-spawned
    // writer; the proof gate prevents any later writer until report publication.
    // Writer intents intentionally survive process death and lease replacement:
    // an orphan Host ADB child cannot be proven gone merely because its parent
    // exited, so the device remains hard-gated for manual remediation.
    version: 11,
    sql: `
      CREATE TABLE android_physical_operation_intents (
        id TEXT PRIMARY KEY,
        lease_id TEXT NOT NULL REFERENCES android_device_leases(id) ON DELETE RESTRICT,
        device_id TEXT NOT NULL UNIQUE REFERENCES android_devices(id) ON DELETE RESTRICT,
        room_id TEXT NOT NULL,
        owner_worker_id TEXT NOT NULL,
        started_at TEXT NOT NULL
      );
      CREATE INDEX idx_android_physical_operation_intents_device
        ON android_physical_operation_intents(device_id, started_at, id);

      CREATE TABLE android_physical_acceptance_proof_gates (
        token TEXT PRIMARY KEY,
        lease_id TEXT NOT NULL UNIQUE REFERENCES android_device_leases(id) ON DELETE RESTRICT,
        device_id TEXT NOT NULL UNIQUE REFERENCES android_devices(id) ON DELETE RESTRICT,
        room_id TEXT NOT NULL,
        owner_worker_id TEXT NOT NULL,
        started_at TEXT NOT NULL
      );
    `
  },
  {
    // Client-assigned operation IDs are idempotency keys only when they remain
    // bound to the same request. Persist the bounded request identity so a
    // retry after completion cannot overwrite history or run different work.
    version: 12,
    sql: `
      ALTER TABLE operations ADD COLUMN request_key TEXT;
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
