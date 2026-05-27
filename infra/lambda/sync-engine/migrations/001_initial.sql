-- NHAI Hackathon: Cloud RDS PostgreSQL Schema
-- Feature: 001-offline-facial-recognition
-- Stability: STABLE

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Personnel registered across all devices
CREATE TABLE IF NOT EXISTS personnel (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  employee_id   VARCHAR(64)  NOT NULL,
  full_name     VARCHAR(255) NOT NULL,
  role          VARCHAR(128) NOT NULL,
  registered_at TIMESTAMPTZ  NOT NULL,
  updated_at    TIMESTAMPTZ  NOT NULL,
  device_id     VARCHAR(64)  NOT NULL,
  synced_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_personnel_employee_id UNIQUE (employee_id)
);

CREATE INDEX idx_personnel_employee_id ON personnel (employee_id);
CREATE INDEX idx_personnel_device      ON personnel (device_id);

-- Facial image metadata (actual image stored in S3)
CREATE TABLE IF NOT EXISTS face_image (
  id            UUID PRIMARY KEY,
  personnel_id  UUID         NOT NULL REFERENCES personnel (id) ON DELETE CASCADE,
  s3_key        VARCHAR(512) NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL,
  device_id     VARCHAR(64)  NOT NULL,
  synced_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_face_image_id UNIQUE (id)
);

CREATE INDEX idx_face_image_personnel ON face_image (personnel_id);
CREATE INDEX idx_face_image_device    ON face_image (device_id);

-- Verification attempt audit log
CREATE TABLE IF NOT EXISTS verification_record (
  id                   UUID PRIMARY KEY,
  personnel_id_matched UUID         REFERENCES personnel (id) ON DELETE SET NULL,
  initiated_at         TIMESTAMPTZ  NOT NULL,
  completed_at         TIMESTAMPTZ  NOT NULL,
  outcome              VARCHAR(32)  NOT NULL
                         CHECK (outcome IN ('authorized','unauthorized','liveness_failed','quality_insufficient')),
  confidence_score     NUMERIC(5,4),
  operator_context     TEXT,
  device_id            VARCHAR(64)  NOT NULL,
  synced_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- Multi-device deduplication: same record from two devices is idempotent
  CONSTRAINT uq_verification_id_device UNIQUE (id, device_id)
);

CREATE INDEX idx_vr_device_initiated  ON verification_record (device_id, initiated_at DESC);
CREATE INDEX idx_vr_outcome           ON verification_record (outcome);
CREATE INDEX idx_vr_personnel_matched ON verification_record (personnel_id_matched);

-- Sync job audit log (one row per device sync batch processed by Lambda)
CREATE TABLE IF NOT EXISTS sync_job_log (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  batch_id             VARCHAR(64)  NOT NULL UNIQUE,   -- device-generated batch UUID
  device_id            VARCHAR(64)  NOT NULL,
  received_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  processed_at         TIMESTAMPTZ,
  status               VARCHAR(32)  NOT NULL
                         CHECK (status IN ('received','processing','completed','failed')),
  personnel_upserted   INTEGER      NOT NULL DEFAULT 0,
  verifications_inserted INTEGER    NOT NULL DEFAULT 0,
  images_registered    INTEGER      NOT NULL DEFAULT 0,
  error_message        TEXT
);

CREATE INDEX idx_sync_job_device    ON sync_job_log (device_id, received_at DESC);
CREATE INDEX idx_sync_job_batch     ON sync_job_log (batch_id);
CREATE INDEX idx_sync_job_status    ON sync_job_log (status);
