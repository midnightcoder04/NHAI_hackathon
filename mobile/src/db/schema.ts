export const PERSONNEL_DDL = `
CREATE TABLE IF NOT EXISTS personnel (
  id            TEXT PRIMARY KEY,
  employee_id   TEXT NOT NULL UNIQUE,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  sync_status   TEXT NOT NULL DEFAULT 'pending'
                CHECK(sync_status IN ('pending','synced','failed')),
  sync_error    TEXT,
  tombstoned    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_personnel_sync        ON personnel(sync_status);
CREATE INDEX IF NOT EXISTS idx_personnel_employee_id ON personnel(employee_id);
`;

export const FACE_IMAGE_DDL = `
CREATE TABLE IF NOT EXISTS face_image (
  id            TEXT PRIMARY KEY,
  personnel_id  TEXT NOT NULL REFERENCES personnel(id) ON DELETE CASCADE,
  image_path    TEXT NOT NULL,
  embedding     BLOB,
  s3_key        TEXT,
  created_at    TEXT NOT NULL,
  sync_status   TEXT NOT NULL DEFAULT 'pending'
                CHECK(sync_status IN ('pending','synced','failed'))
);
CREATE INDEX IF NOT EXISTS idx_face_image_personnel ON face_image(personnel_id);
CREATE INDEX IF NOT EXISTS idx_face_image_sync      ON face_image(sync_status);
`;

export const VERIFICATION_RECORD_DDL = `
CREATE TABLE IF NOT EXISTS verification_record (
  id                   TEXT PRIMARY KEY,
  personnel_id_matched TEXT REFERENCES personnel(id) ON DELETE SET NULL,
  initiated_at         TEXT NOT NULL,
  completed_at         TEXT NOT NULL,
  outcome              TEXT NOT NULL
                       CHECK(outcome IN ('authorized','unauthorized','liveness_failed','low_confidence','quality_insufficient')),
  confidence_score     REAL,
  operator_context     TEXT,
  device_id            TEXT NOT NULL,
  sync_status          TEXT NOT NULL DEFAULT 'pending'
                       CHECK(sync_status IN ('pending','synced','failed'))
);
CREATE INDEX IF NOT EXISTS idx_verification_sync       ON verification_record(sync_status);
CREATE INDEX IF NOT EXISTS idx_verification_personnel  ON verification_record(personnel_id_matched);
CREATE INDEX IF NOT EXISTS idx_verification_initiated  ON verification_record(initiated_at);
`;

export const BACKUP_JOB_DDL = `
CREATE TABLE IF NOT EXISTS backup_job (
  id                   TEXT PRIMARY KEY,
  started_at           TEXT NOT NULL,
  completed_at         TEXT,
  status               TEXT NOT NULL
                       CHECK(status IN ('in_progress','completed','failed','cancelled')),
  records_personnel    INTEGER NOT NULL DEFAULT 0,
  records_verification INTEGER NOT NULL DEFAULT 0,
  records_images       INTEGER NOT NULL DEFAULT 0,
  bytes_transferred    INTEGER NOT NULL DEFAULT 0,
  error_message        TEXT
);
CREATE INDEX IF NOT EXISTS idx_backup_job_status  ON backup_job(status);
CREATE INDEX IF NOT EXISTS idx_backup_job_started ON backup_job(started_at DESC);
`;

export const SYNC_OUTBOX_DDL = `
CREATE TABLE IF NOT EXISTS sync_outbox (
  id               TEXT PRIMARY KEY,
  record_type      TEXT NOT NULL
                   CHECK(record_type IN ('personnel','face_image','verification_record')),
  record_id        TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL UNIQUE,
  payload_json     TEXT NOT NULL,
  enqueued_at      TEXT NOT NULL,
  dispatched_at    TEXT,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK(status IN ('pending','dispatched','acknowledged','failed')),
  retry_count      INTEGER NOT NULL DEFAULT 0,
  error_message    TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON sync_outbox(status);
CREATE INDEX IF NOT EXISTS idx_outbox_record ON sync_outbox(record_type, record_id);
`;

export const ALL_DDL = [
  PERSONNEL_DDL,
  FACE_IMAGE_DDL,
  VERIFICATION_RECORD_DDL,
  BACKUP_JOB_DDL,
  SYNC_OUTBOX_DDL,
];
