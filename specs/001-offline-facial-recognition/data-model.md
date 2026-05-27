# Data Model: Offline Facial Recognition & Liveness Detection

**Phase 1 output for**: `001-offline-facial-recognition`
**Date**: 2026-05-27

---

## Overview

Two storage tiers:

| Tier | Technology | Scope |
|------|-----------|-------|
| **On-device** | SQLite (`expo-sqlite`) + device filesystem | All runtime data; source of truth while offline |
| **Cloud** | Amazon RDS PostgreSQL + AWS S3 | Backup destination; read by other NHAI systems |

---

## On-Device Schema (SQLite)

### Entity: `personnel`

Represents a registered individual.

```sql
CREATE TABLE IF NOT EXISTS personnel (
  id            TEXT PRIMARY KEY,          -- UUID v4, generated on device
  employee_id   TEXT NOT NULL UNIQUE,      -- NHAI employee identifier
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL,
  registered_at TEXT NOT NULL,             -- ISO-8601 UTC
  updated_at    TEXT NOT NULL,             -- ISO-8601 UTC; used for conflict resolution
  sync_status   TEXT NOT NULL DEFAULT 'pending'  -- 'pending' | 'synced' | 'failed'
                CHECK(sync_status IN ('pending','synced','failed')),
  sync_error    TEXT                        -- last sync error message if status='failed'
);

CREATE INDEX idx_personnel_sync ON personnel(sync_status);
CREATE INDEX idx_personnel_employee_id ON personnel(employee_id);
```

**Validation rules**:
- `full_name` must be non-empty string
- `employee_id` must be non-empty string; unique across device
- `role` must be non-empty string
- `sync_status` transitions: `pending → synced | failed`; `failed → pending` (on retry)

---

### Entity: `face_image`

A facial capture associated with a personnel record. Stores both the on-disk image path and the extracted face embedding.

```sql
CREATE TABLE IF NOT EXISTS face_image (
  id            TEXT PRIMARY KEY,          -- UUID v4
  personnel_id  TEXT NOT NULL REFERENCES personnel(id) ON DELETE CASCADE,
  image_path    TEXT NOT NULL,             -- absolute device filesystem path (FileSystem.documentDirectory)
  embedding     BLOB,                      -- Float32Array serialized as 512-byte BLOB (128 floats × 4 bytes)
  s3_key        TEXT,                      -- populated after successful image sync to S3
  created_at    TEXT NOT NULL,
  sync_status   TEXT NOT NULL DEFAULT 'pending'
                CHECK(sync_status IN ('pending','synced','failed'))
);

CREATE INDEX idx_face_image_personnel ON face_image(personnel_id);
CREATE INDEX idx_face_image_sync ON face_image(sync_status);
```

**Notes**:
- `embedding` stored as raw Float32Array bytes (128 floats × 4 bytes = 512 bytes per face). Null until ML inference completes.
- `image_path` is the local file path for display; image is also uploaded to S3 on sync.
- Multiple face images per personnel supported (FR-002).

---

### Entity: `verification_record`

An audit log entry for each authorization attempt.

```sql
CREATE TABLE IF NOT EXISTS verification_record (
  id                   TEXT PRIMARY KEY,   -- UUID v4
  personnel_id_matched TEXT REFERENCES personnel(id) ON DELETE SET NULL,
  initiated_at         TEXT NOT NULL,       -- ISO-8601 UTC timestamp of attempt start
  completed_at         TEXT NOT NULL,       -- ISO-8601 UTC timestamp of result display
  outcome              TEXT NOT NULL
                       CHECK(outcome IN ('authorized','unauthorized','liveness_failed','quality_insufficient')),
  confidence_score     REAL,               -- 0.0–1.0; NULL for non-match outcomes
  operator_context     TEXT,               -- free-text: site name, operator notes
  device_id            TEXT NOT NULL,       -- device UUID for multi-device deduplication
  sync_status          TEXT NOT NULL DEFAULT 'pending'
                       CHECK(sync_status IN ('pending','synced','failed'))
);

CREATE INDEX idx_verification_sync ON verification_record(sync_status);
CREATE INDEX idx_verification_personnel ON verification_record(personnel_id_matched);
CREATE INDEX idx_verification_initiated ON verification_record(initiated_at);
```

**State transitions**:
- `outcome: authorized` — face matched with `confidence_score ≥ threshold` AND liveness passed
- `outcome: unauthorized` — face did not match any enrolled personnel
- `outcome: liveness_failed` — liveness detection rejected the capture (spoof attempt or printed photo)
- `outcome: quality_insufficient` — image quality too low to process (prompt operator to reposition)

---

### Entity: `backup_job`

Tracks each sync attempt lifecycle.

```sql
CREATE TABLE IF NOT EXISTS backup_job (
  id                   TEXT PRIMARY KEY,   -- UUID v4
  started_at           TEXT NOT NULL,
  completed_at         TEXT,               -- NULL while in-progress
  status               TEXT NOT NULL
                       CHECK(status IN ('in_progress','completed','failed','cancelled')),
  records_personnel    INTEGER NOT NULL DEFAULT 0,
  records_verification INTEGER NOT NULL DEFAULT 0,
  records_images       INTEGER NOT NULL DEFAULT 0,
  bytes_transferred    INTEGER NOT NULL DEFAULT 0,
  error_message        TEXT
);

CREATE INDEX idx_backup_job_status ON backup_job(status);
CREATE INDEX idx_backup_job_started ON backup_job(started_at DESC);
```

---

### Entity: `sync_outbox`

The outbox pattern table — acts as a durable queue before records are dispatched to SQS.

```sql
CREATE TABLE IF NOT EXISTS sync_outbox (
  id               TEXT PRIMARY KEY,       -- UUID v4
  record_type      TEXT NOT NULL
                   CHECK(record_type IN ('personnel','face_image','verification_record')),
  record_id        TEXT NOT NULL,          -- FK to the source record
  idempotency_key  TEXT NOT NULL UNIQUE,   -- SHA256(record_type + record_id + updated_at)
  payload_json     TEXT NOT NULL,          -- serialized record snapshot at enqueue time
  enqueued_at      TEXT NOT NULL,
  dispatched_at    TEXT,                   -- NULL until SQS ACK received
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK(status IN ('pending','dispatched','acknowledged','failed')),
  retry_count      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_outbox_status ON sync_outbox(status);
CREATE INDEX idx_outbox_record ON sync_outbox(record_type, record_id);
```

---

## State Transition Diagram: Sync Status

```
[local write]
      │
      ▼
   pending ──(sync trigger)──► in_progress
      ▲                              │
      │ (retry)               ┌──────┴──────┐
      │                       ▼             ▼
   failed ◄──────────── failed         synced
```

---

## Cloud Schema (Amazon RDS PostgreSQL)

```sql
-- personnel (cloud replica)
CREATE TABLE IF NOT EXISTS personnel (
  id            UUID PRIMARY KEY,
  employee_id   VARCHAR(64) NOT NULL,
  full_name     VARCHAR(255) NOT NULL,
  role          VARCHAR(128) NOT NULL,
  registered_at TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL,
  device_id     VARCHAR(64) NOT NULL,
  created_from_device BOOLEAN DEFAULT TRUE,
  UNIQUE (employee_id)
);

-- face_image (cloud replica)
CREATE TABLE IF NOT EXISTS face_image (
  id            UUID PRIMARY KEY,
  personnel_id  UUID NOT NULL REFERENCES personnel(id),
  s3_key        VARCHAR(512) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL,
  device_id     VARCHAR(64) NOT NULL
);

-- verification_record (cloud replica)
CREATE TABLE IF NOT EXISTS verification_record (
  id                   UUID PRIMARY KEY,
  personnel_id_matched UUID REFERENCES personnel(id),
  initiated_at         TIMESTAMPTZ NOT NULL,
  completed_at         TIMESTAMPTZ NOT NULL,
  outcome              VARCHAR(32) NOT NULL
                       CHECK(outcome IN ('authorized','unauthorized','liveness_failed','quality_insufficient')),
  confidence_score     NUMERIC(5,4),
  operator_context     TEXT,
  device_id            VARCHAR(64) NOT NULL,
  synced_at            TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (id, device_id)   -- multi-device deduplication guard
);

-- backup_job (audit log in cloud)
CREATE TABLE IF NOT EXISTS sync_job_log (
  id                   UUID PRIMARY KEY,
  device_id            VARCHAR(64) NOT NULL,
  started_at           TIMESTAMPTZ NOT NULL,
  completed_at         TIMESTAMPTZ,
  status               VARCHAR(32) NOT NULL,
  records_synced       INTEGER DEFAULT 0,
  error_message        TEXT
);

CREATE INDEX idx_vr_device_initiated ON verification_record(device_id, initiated_at);
CREATE INDEX idx_personnel_employee ON personnel(employee_id);
```

---

## TypeScript Domain Types

```typescript
// models/Personnel.ts
export type SyncStatus = 'pending' | 'synced' | 'failed';

export interface Personnel {
  id: string;            // UUID
  employeeId: string;
  fullName: string;
  role: string;
  registeredAt: string;  // ISO-8601
  updatedAt: string;
  syncStatus: SyncStatus;
  syncError?: string;
}

// models/FaceImage.ts
export interface FaceImage {
  id: string;
  personnelId: string;
  imagePath: string;
  embedding: Float32Array | null;  // 128 floats
  s3Key?: string;
  createdAt: string;
  syncStatus: SyncStatus;
}

// models/VerificationRecord.ts
export type VerificationOutcome =
  | 'authorized'
  | 'unauthorized'
  | 'liveness_failed'
  | 'quality_insufficient';

export interface VerificationRecord {
  id: string;
  personnelIdMatched?: string;
  initiatedAt: string;
  completedAt: string;
  outcome: VerificationOutcome;
  confidenceScore?: number;
  operatorContext?: string;
  deviceId: string;
  syncStatus: SyncStatus;
}

// models/BackupJob.ts
export type BackupStatus = 'in_progress' | 'completed' | 'failed' | 'cancelled';

export interface BackupJob {
  id: string;
  startedAt: string;
  completedAt?: string;
  status: BackupStatus;
  recordsPersonnel: number;
  recordsVerification: number;
  recordsImages: number;
  bytesTransferred: number;
  errorMessage?: string;
}
```

---

## Entity Relationships

```
personnel 1──────────* face_image
    │
    └──────────────── verification_record (0..* via personnelIdMatched)

sync_outbox ──(references)──► personnel | face_image | verification_record

backup_job (standalone — tracks sync attempt, references outbox batch)
```
