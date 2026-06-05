/**
 * TypeScript types for the Cloud Sync API contract.
 * See: specs/001-offline-facial-recognition/contracts/sync-api.md
 */

// ---------------------------------------------------------------------------
// Shared enums / value types
// ---------------------------------------------------------------------------

export type SyncOutcome =
  | 'authorized'
  | 'unauthorized'
  | 'liveness_failed'
  | 'low_confidence'
  | 'quality_insufficient';

export type SyncRecordType = 'personnel' | 'face_image' | 'verification_record';

// ---------------------------------------------------------------------------
// POST /sync/batch — Request
// ---------------------------------------------------------------------------

export interface SyncPersonnelRecord {
  id: string;
  employeeId: string;
  fullName: string;
  role: string;
  registeredAt: string;
  updatedAt: string;
  idempotencyKey: string;
}

export interface SyncVerificationRecord {
  id: string;
  personnelIdMatched: string | null;
  initiatedAt: string;
  completedAt: string;
  outcome: SyncOutcome;
  confidenceScore: number | null;
  operatorContext: string | null;
  deviceId: string;
  idempotencyKey: string;
}

export interface SyncFaceImageRecord {
  id: string;
  personnelId: string;
  s3Key: string;
  createdAt: string;
  idempotencyKey: string;
}

export interface SyncBatchRequest {
  deviceId: string;
  batchId: string;
  sentAt: string;
  personnel: SyncPersonnelRecord[];
  verificationRecords: SyncVerificationRecord[];
  faceImages: SyncFaceImageRecord[];
}

// ---------------------------------------------------------------------------
// POST /sync/batch — Responses
// ---------------------------------------------------------------------------

export interface SyncBatchResponse200 {
  batchId: string;
  receivedAt: string;
  queueMessageId: string;
  accepted: {
    personnel: number;
    verificationRecords: number;
    faceImages: number;
  };
}

export interface SyncBatchValidationDetail {
  field: string;
  issue: string;
}

export interface SyncBatchResponse400 {
  error: 'VALIDATION_ERROR';
  message: string;
  details: SyncBatchValidationDetail[];
}

export interface SyncBatchResponse409 {
  error: 'DUPLICATE_BATCH';
  batchId: string;
  message: string;
}

export type SyncBatchResponse =
  | SyncBatchResponse200
  | SyncBatchResponse400
  | SyncBatchResponse409;

// ---------------------------------------------------------------------------
// PUT /sync/images/presign — Request
// ---------------------------------------------------------------------------

export interface PresignImageRequest {
  deviceId: string;
  images: Array<{
    faceImageId: string;
    contentType: 'image/jpeg';
    contentLength: number;
  }>;
}

// ---------------------------------------------------------------------------
// PUT /sync/images/presign — Response
// ---------------------------------------------------------------------------

export interface PresignedUrlEntry {
  faceImageId: string;
  s3Key: string;
  uploadUrl: string;
  expiresAt: string;
}

export interface PresignResponse200 {
  presignedUrls: PresignedUrlEntry[];
}

// ---------------------------------------------------------------------------
// Batch size constraints (mirrors constants/index.ts)
// ---------------------------------------------------------------------------

export const BATCH_MAX_PERSONNEL = 100;
export const BATCH_MAX_VERIFICATIONS = 500;
export const BATCH_MAX_FACE_IMAGES = 200;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;
const ISO8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export function isUUID(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function isSHA256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_RE.test(value);
}

export function isISO8601UTC(value: unknown): value is string {
  return typeof value === 'string' && ISO8601_RE.test(value);
}

export const SYNC_OUTCOMES: readonly SyncOutcome[] = [
  'authorized',
  'unauthorized',
  'liveness_failed',
  'low_confidence',
  'quality_insufficient',
] as const;

export const SYNC_RECORD_TYPES: readonly SyncRecordType[] = [
  'personnel',
  'face_image',
  'verification_record',
] as const;

export function isSyncOutcome(value: unknown): value is SyncOutcome {
  return SYNC_OUTCOMES.includes(value as SyncOutcome);
}

export function isSyncRecordType(value: unknown): value is SyncRecordType {
  return SYNC_RECORD_TYPES.includes(value as SyncRecordType);
}

/** Validate a SyncBatchRequest and return an array of error strings (empty = valid). */
export function validateSyncBatchRequest(req: unknown): string[] {
  const errors: string[] = [];
  if (typeof req !== 'object' || req === null) {
    return ['request must be a non-null object'];
  }
  const r = req as Record<string, unknown>;

  if (!isUUID(r.deviceId)) errors.push('deviceId must be a UUID');
  if (!isUUID(r.batchId)) errors.push('batchId must be a UUID');
  if (!isISO8601UTC(r.sentAt)) errors.push('sentAt must be ISO-8601 UTC');

  if (!Array.isArray(r.personnel)) {
    errors.push('personnel must be an array');
  } else if (r.personnel.length > BATCH_MAX_PERSONNEL) {
    errors.push(`personnel exceeds max ${BATCH_MAX_PERSONNEL}`);
  }

  if (!Array.isArray(r.verificationRecords)) {
    errors.push('verificationRecords must be an array');
  } else if (r.verificationRecords.length > BATCH_MAX_VERIFICATIONS) {
    errors.push(`verificationRecords exceeds max ${BATCH_MAX_VERIFICATIONS}`);
  }

  if (!Array.isArray(r.faceImages)) {
    errors.push('faceImages must be an array');
  } else if ((r.faceImages as unknown[]).length > BATCH_MAX_FACE_IMAGES) {
    errors.push(`faceImages exceeds max ${BATCH_MAX_FACE_IMAGES}`);
  }

  return errors;
}

/** Validate a PresignImageRequest and return an array of error strings. */
export function validatePresignRequest(req: unknown): string[] {
  const errors: string[] = [];
  if (typeof req !== 'object' || req === null) {
    return ['request must be a non-null object'];
  }
  const r = req as Record<string, unknown>;
  if (!isUUID(r.deviceId)) errors.push('deviceId must be a UUID');
  if (!Array.isArray(r.images)) {
    errors.push('images must be an array');
  } else {
    for (const img of r.images as unknown[]) {
      if (typeof img !== 'object' || img === null) {
        errors.push('each image entry must be an object');
        continue;
      }
      const i = img as Record<string, unknown>;
      if (!isUUID(i.faceImageId)) errors.push('faceImageId must be a UUID');
      if (i.contentType !== 'image/jpeg') errors.push('contentType must be image/jpeg');
      if (typeof i.contentLength !== 'number' || i.contentLength <= 0)
        errors.push('contentLength must be a positive number');
    }
  }
  return errors;
}
