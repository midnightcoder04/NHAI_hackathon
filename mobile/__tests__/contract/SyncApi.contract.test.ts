/**
 * T093 — Contract tests for the Cloud Sync API.
 * These are pure schema-validation tests — no HTTP calls are made.
 * They validate that request/response shapes conform to the contract defined in
 * specs/001-offline-facial-recognition/contracts/sync-api.md.
 */
import {
  type SyncBatchRequest,
  type SyncBatchResponse200,
  type SyncBatchResponse400,
  type SyncBatchResponse409,
  type PresignImageRequest,
  type PresignResponse200,
  BATCH_MAX_PERSONNEL,
  BATCH_MAX_VERIFICATIONS,
  BATCH_MAX_FACE_IMAGES,
  SYNC_OUTCOMES,
  SYNC_RECORD_TYPES,
  isUUID,
  isSHA256Hex,
  isISO8601UTC,
  isSyncOutcome,
  isSyncRecordType,
  validateSyncBatchRequest,
  validatePresignRequest,
} from '../../src/services/SyncApiTypes';

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------
const DEVICE_ID = '550e8400-e29b-41d4-a716-446655440000';
const BATCH_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const RECORD_ID = 'a3bb189e-8bf9-3888-9912-ace4e6543002';
const PERSONNEL_ID = 'b3bb189e-8bf9-3888-9912-ace4e6543003';
const FACE_IMAGE_ID = 'c3bb189e-8bf9-3888-9912-ace4e6543004';
const VALID_ISO = '2026-05-30T10:00:00.000Z';
const VALID_SHA256 = 'a'.repeat(64);

function validPersonnelRecord() {
  return {
    id: RECORD_ID,
    employeeId: 'EMP-001',
    fullName: 'Asha Rao',
    role: 'Inspector',
    registeredAt: VALID_ISO,
    updatedAt: VALID_ISO,
    idempotencyKey: VALID_SHA256,
  };
}

function validVerificationRecord() {
  return {
    id: RECORD_ID,
    personnelIdMatched: PERSONNEL_ID,
    initiatedAt: VALID_ISO,
    completedAt: VALID_ISO,
    outcome: 'authorized' as const,
    confidenceScore: 0.92,
    operatorContext: null,
    deviceId: DEVICE_ID,
    idempotencyKey: VALID_SHA256,
  };
}

function validFaceImageRecord() {
  return {
    id: FACE_IMAGE_ID,
    personnelId: PERSONNEL_ID,
    s3Key: `images/${DEVICE_ID}/${FACE_IMAGE_ID}.jpg`,
    createdAt: VALID_ISO,
    idempotencyKey: VALID_SHA256,
  };
}

function validBatchRequest(): SyncBatchRequest {
  return {
    deviceId: DEVICE_ID,
    batchId: BATCH_ID,
    sentAt: VALID_ISO,
    personnel: [validPersonnelRecord()],
    verificationRecords: [validVerificationRecord()],
    faceImages: [validFaceImageRecord()],
  };
}

// ---------------------------------------------------------------------------
// 1. POST /sync/batch — valid request body conforms to contract
// ---------------------------------------------------------------------------
describe('POST /sync/batch request schema', () => {
  it('valid request body passes validation', () => {
    const errors = validateSyncBatchRequest(validBatchRequest());
    expect(errors).toHaveLength(0);
  });

  it('deviceId must be a UUID', () => {
    const req = { ...validBatchRequest(), deviceId: 'not-a-uuid' };
    const errors = validateSyncBatchRequest(req);
    expect(errors.some((e) => e.includes('deviceId'))).toBe(true);
  });

  it('batchId must be a UUID', () => {
    const req = { ...validBatchRequest(), batchId: '12345' };
    const errors = validateSyncBatchRequest(req);
    expect(errors.some((e) => e.includes('batchId'))).toBe(true);
  });

  it('sentAt must be ISO-8601 UTC', () => {
    const req = { ...validBatchRequest(), sentAt: '2026/05/30' };
    const errors = validateSyncBatchRequest(req);
    expect(errors.some((e) => e.includes('sentAt'))).toBe(true);
  });

  it('null/non-object request is invalid', () => {
    expect(validateSyncBatchRequest(null)).toEqual(['request must be a non-null object']);
    expect(validateSyncBatchRequest('string')).toEqual(['request must be a non-null object']);
  });

  it('personnel array over 100 is rejected', () => {
    const req = {
      ...validBatchRequest(),
      personnel: Array.from({ length: BATCH_MAX_PERSONNEL + 1 }, (_, i) => ({
        ...validPersonnelRecord(),
        id: `id-${i}`,
        employeeId: `EMP-${i}`,
      })),
    };
    const errors = validateSyncBatchRequest(req);
    expect(errors.some((e) => e.includes('personnel'))).toBe(true);
  });

  it('verificationRecords array over 500 is rejected', () => {
    const req = {
      ...validBatchRequest(),
      verificationRecords: Array.from({ length: BATCH_MAX_VERIFICATIONS + 1 }, (_, i) => ({
        ...validVerificationRecord(),
        id: `id-${i}`,
      })),
    };
    const errors = validateSyncBatchRequest(req);
    expect(errors.some((e) => e.includes('verificationRecords'))).toBe(true);
  });

  it('faceImages array over 200 is rejected', () => {
    const req = {
      ...validBatchRequest(),
      faceImages: Array.from({ length: BATCH_MAX_FACE_IMAGES + 1 }, (_, i) => ({
        ...validFaceImageRecord(),
        id: `id-${i}`,
      })),
    };
    const errors = validateSyncBatchRequest(req);
    expect(errors.some((e) => e.includes('faceImages'))).toBe(true);
  });

  it('empty arrays are valid (batch can be personnel-only etc.)', () => {
    const req = { ...validBatchRequest(), verificationRecords: [], faceImages: [] };
    expect(validateSyncBatchRequest(req)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. PUT /sync/images/presign — valid request conforms
// ---------------------------------------------------------------------------
describe('PUT /sync/images/presign request schema', () => {
  function validPresignRequest(): PresignImageRequest {
    return {
      deviceId: DEVICE_ID,
      images: [
        {
          faceImageId: FACE_IMAGE_ID,
          contentType: 'image/jpeg',
          contentLength: 204800,
        },
      ],
    };
  }

  it('valid presign request passes validation', () => {
    expect(validatePresignRequest(validPresignRequest())).toHaveLength(0);
  });

  it('invalid deviceId is rejected', () => {
    const req = { ...validPresignRequest(), deviceId: 'bad' };
    expect(validatePresignRequest(req).some((e) => e.includes('deviceId'))).toBe(true);
  });

  it('contentType other than image/jpeg is rejected', () => {
    const req = {
      ...validPresignRequest(),
      images: [{ faceImageId: FACE_IMAGE_ID, contentType: 'image/png', contentLength: 1000 }],
    };
    expect(validatePresignRequest(req).some((e) => e.includes('contentType'))).toBe(true);
  });

  it('non-positive contentLength is rejected', () => {
    const req = {
      ...validPresignRequest(),
      images: [{ faceImageId: FACE_IMAGE_ID, contentType: 'image/jpeg' as const, contentLength: 0 }],
    };
    expect(validatePresignRequest(req).some((e) => e.includes('contentLength'))).toBe(true);
  });

  it('invalid faceImageId UUID is rejected', () => {
    const req = {
      ...validPresignRequest(),
      images: [{ faceImageId: 'not-uuid', contentType: 'image/jpeg' as const, contentLength: 1000 }],
    };
    expect(validatePresignRequest(req).some((e) => e.includes('faceImageId'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Response shapes for 200, 400, 409
// ---------------------------------------------------------------------------
describe('POST /sync/batch response shapes', () => {
  it('200 OK response has required fields', () => {
    const response: SyncBatchResponse200 = {
      batchId: BATCH_ID,
      receivedAt: VALID_ISO,
      queueMessageId: 'msg-12345',
      accepted: {
        personnel: 1,
        verificationRecords: 1,
        faceImages: 1,
      },
    };
    expect(typeof response.batchId).toBe('string');
    expect(typeof response.receivedAt).toBe('string');
    expect(typeof response.queueMessageId).toBe('string');
    expect(typeof response.accepted.personnel).toBe('number');
    expect(typeof response.accepted.verificationRecords).toBe('number');
    expect(typeof response.accepted.faceImages).toBe('number');
  });

  it('400 Bad Request response has VALIDATION_ERROR error code and details array', () => {
    const response: SyncBatchResponse400 = {
      error: 'VALIDATION_ERROR',
      message: 'personnel[0].employeeId is required',
      details: [{ field: 'personnel[0].employeeId', issue: 'required' }],
    };
    expect(response.error).toBe('VALIDATION_ERROR');
    expect(Array.isArray(response.details)).toBe(true);
    expect(response.details[0]).toHaveProperty('field');
    expect(response.details[0]).toHaveProperty('issue');
  });

  it('409 Conflict response has DUPLICATE_BATCH error code', () => {
    const response: SyncBatchResponse409 = {
      error: 'DUPLICATE_BATCH',
      batchId: BATCH_ID,
      message: 'Batch already processed',
    };
    expect(response.error).toBe('DUPLICATE_BATCH');
    expect(response.batchId).toBe(BATCH_ID);
    expect(typeof response.message).toBe('string');
  });
});

describe('PUT /sync/images/presign response shape', () => {
  it('200 response has presignedUrls array with s3Key and uploadUrl', () => {
    const response: PresignResponse200 = {
      presignedUrls: [
        {
          faceImageId: FACE_IMAGE_ID,
          s3Key: `images/${DEVICE_ID}/${FACE_IMAGE_ID}.jpg`,
          uploadUrl: 'https://bucket.s3.amazonaws.com/presigned?...',
          expiresAt: VALID_ISO,
        },
      ],
    };
    expect(response.presignedUrls).toHaveLength(1);
    expect(typeof response.presignedUrls[0].s3Key).toBe('string');
    expect(typeof response.presignedUrls[0].uploadUrl).toBe('string');
    expect(typeof response.presignedUrls[0].expiresAt).toBe('string');
  });

  it('s3Key follows images/{deviceId}/{faceImageId}.jpg format', () => {
    const s3Key = `images/${DEVICE_ID}/${FACE_IMAGE_ID}.jpg`;
    expect(s3Key).toMatch(/^images\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/i);
  });
});

// ---------------------------------------------------------------------------
// 4. Idempotency key format — SHA-256 hex string
// ---------------------------------------------------------------------------
describe('Idempotency key format', () => {
  it('valid SHA-256 hex string (64 chars) is accepted', () => {
    expect(isSHA256Hex('a'.repeat(64))).toBe(true);
    expect(isSHA256Hex('0'.repeat(64))).toBe(true);
    // Mixed hex digits
    expect(isSHA256Hex('deadbeef' + 'a1b2c3d4'.repeat(7))).toBe(true);
  });

  it('non-64-char strings are rejected', () => {
    expect(isSHA256Hex('abc')).toBe(false);
    expect(isSHA256Hex('a'.repeat(63))).toBe(false);
    expect(isSHA256Hex('a'.repeat(65))).toBe(false);
  });

  it('non-hex chars are rejected', () => {
    expect(isSHA256Hex('g'.repeat(64))).toBe(false);
    expect(isSHA256Hex('z'.repeat(64))).toBe(false);
  });

  it('actual SHA-256 of a sample string is valid', () => {
    // SHA-256 of 'personnel:rec-001' = known hex output
    const hash = 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3'; // SHA-1, just for test structure
    // Use a known SHA-256 format (64 hex chars)
    const sha256 = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
    expect(isSHA256Hex(sha256)).toBe(true);
    expect(sha256).toHaveLength(64);
  });
});

// ---------------------------------------------------------------------------
// 5. outcome enum values
// ---------------------------------------------------------------------------
describe('Verification outcome enum', () => {
  it('all five outcome values are valid', () => {
    const expected = [
      'authorized',
      'unauthorized',
      'liveness_failed',
      'low_confidence',
      'quality_insufficient',
    ];
    expect(SYNC_OUTCOMES).toEqual(expected);
    for (const o of expected) {
      expect(isSyncOutcome(o)).toBe(true);
    }
  });

  it('unknown outcome values are rejected', () => {
    expect(isSyncOutcome('approved')).toBe(false);
    expect(isSyncOutcome('denied')).toBe(false);
    expect(isSyncOutcome(null)).toBe(false);
    expect(isSyncOutcome(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. record_type constraint validation
// ---------------------------------------------------------------------------
describe('record_type constraint', () => {
  it('all three record types are valid', () => {
    const expected = ['personnel', 'face_image', 'verification_record'];
    expect(SYNC_RECORD_TYPES).toEqual(expected);
    for (const t of expected) {
      expect(isSyncRecordType(t)).toBe(true);
    }
  });

  it('unknown record types are rejected', () => {
    expect(isSyncRecordType('user')).toBe(false);
    expect(isSyncRecordType('image')).toBe(false);
    expect(isSyncRecordType(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. UUID and ISO-8601 format validators
// ---------------------------------------------------------------------------
describe('UUID validator', () => {
  it('valid UUIDs pass', () => {
    expect(isUUID(DEVICE_ID)).toBe(true);
    expect(isUUID(BATCH_ID)).toBe(true);
  });

  it('non-UUIDs fail', () => {
    expect(isUUID('not-a-uuid')).toBe(false);
    expect(isUUID('')).toBe(false);
    expect(isUUID(null)).toBe(false);
    expect(isUUID(42)).toBe(false);
  });
});

describe('ISO-8601 UTC validator', () => {
  it('valid ISO-8601 UTC strings pass', () => {
    expect(isISO8601UTC('2026-05-30T10:00:00.000Z')).toBe(true);
    expect(isISO8601UTC('2026-05-30T10:00:00Z')).toBe(true);
  });

  it('non-UTC or malformed strings fail', () => {
    expect(isISO8601UTC('2026/05/30')).toBe(false);
    expect(isISO8601UTC('2026-05-30')).toBe(false);
    expect(isISO8601UTC('not-a-date')).toBe(false);
    expect(isISO8601UTC(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. Batch size constants match the contract
// ---------------------------------------------------------------------------
describe('Batch size limits from contract', () => {
  it('personnel max is 100', () => {
    expect(BATCH_MAX_PERSONNEL).toBe(100);
  });

  it('verificationRecords max is 500', () => {
    expect(BATCH_MAX_VERIFICATIONS).toBe(500);
  });

  it('faceImages max is 200', () => {
    expect(BATCH_MAX_FACE_IMAGES).toBe(200);
  });
});
