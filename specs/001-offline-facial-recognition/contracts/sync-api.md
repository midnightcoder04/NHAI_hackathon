# Contract: Cloud Sync API

**Phase 1 output for**: `001-offline-facial-recognition`
**Date**: 2026-05-27
**Stability**: STABLE (SC-008 — integration interface must be clean and stable)

---

## Overview

The mobile app communicates with AWS via three channels:

| Channel | Purpose |
|---------|---------|
| `POST /sync/batch` (API Gateway → Lambda) | Submit sync payload; Lambda enqueues to SQS FIFO |
| `PUT /sync/images/presign` (API Gateway → Lambda) | Obtain S3 pre-signed URL for direct image upload |
| SQS FIFO → Lambda (async) | Lambda processes queued payloads, writes to RDS |

---

## 1. POST /sync/batch

**Auth**: AWS Cognito JWT Bearer token (or API Key for hackathon prototype)

### Request

```json
{
  "deviceId": "string (UUID)",
  "batchId": "string (UUID, idempotency key for this batch)",
  "sentAt": "string (ISO-8601 UTC)",
  "personnel": [
    {
      "id": "string (UUID)",
      "employeeId": "string",
      "fullName": "string",
      "role": "string",
      "registeredAt": "string (ISO-8601 UTC)",
      "updatedAt": "string (ISO-8601 UTC)",
      "idempotencyKey": "string (SHA256 of id+updatedAt)"
    }
  ],
  "verificationRecords": [
    {
      "id": "string (UUID)",
      "personnelIdMatched": "string (UUID) | null",
      "initiatedAt": "string (ISO-8601 UTC)",
      "completedAt": "string (ISO-8601 UTC)",
      "outcome": "authorized | unauthorized | liveness_failed | quality_insufficient",
      "confidenceScore": "number (0.0–1.0) | null",
      "operatorContext": "string | null",
      "deviceId": "string (UUID)",
      "idempotencyKey": "string (SHA256 of id+deviceId+initiatedAt)"
    }
  ],
  "faceImages": [
    {
      "id": "string (UUID)",
      "personnelId": "string (UUID)",
      "s3Key": "string (S3 object key, populated after image upload)",
      "createdAt": "string (ISO-8601 UTC)",
      "idempotencyKey": "string (SHA256 of id+personnelId+createdAt)"
    }
  ]
}
```

**Constraints**:
- `personnel` array: max 100 records per batch
- `verificationRecords` array: max 500 records per batch
- `faceImages` array: max 200 records per batch
- All `faceImages` MUST have `s3Key` populated (image must be uploaded before metadata is submitted)

### Response 200 OK

```json
{
  "batchId": "string",
  "receivedAt": "string (ISO-8601 UTC)",
  "queueMessageId": "string",
  "accepted": {
    "personnel": number,
    "verificationRecords": number,
    "faceImages": number
  }
}
```

### Response 400 Bad Request

```json
{
  "error": "VALIDATION_ERROR",
  "message": "string",
  "details": [
    { "field": "string", "issue": "string" }
  ]
}
```

### Response 409 Conflict (duplicate batch)

```json
{
  "error": "DUPLICATE_BATCH",
  "batchId": "string",
  "message": "Batch already processed"
}
```

---

## 2. PUT /sync/images/presign

Obtain a pre-signed S3 URL for direct image upload from the mobile device.

### Request

```json
{
  "deviceId": "string (UUID)",
  "images": [
    {
      "faceImageId": "string (UUID)",
      "contentType": "image/jpeg",
      "contentLength": number
    }
  ]
}
```

### Response 200 OK

```json
{
  "presignedUrls": [
    {
      "faceImageId": "string (UUID)",
      "s3Key": "string",
      "uploadUrl": "string (pre-signed PUT URL, valid 15 min)",
      "expiresAt": "string (ISO-8601 UTC)"
    }
  ]
}
```

**S3 key format**: `images/{deviceId}/{faceImageId}.jpg`

Mobile uploads image via `PUT {uploadUrl}` with `Content-Type: image/jpeg`. After successful upload (HTTP 200), stores `s3Key` in local `face_image.s3_key`, then includes the `faceImages` entry in the next `/sync/batch` call.

---

## 3. SQS FIFO Queue: Message Schema

Queue name: `nhai-sync-queue.fifo`

**MessageGroupId**: `{deviceId}` (ensures per-device ordering)
**MessageDeduplicationId**: `{batchId}` (prevents duplicate processing)

Message body (same as POST /sync/batch request body):

```json
{
  "deviceId": "string",
  "batchId": "string",
  "sentAt": "string",
  "personnel": [...],
  "verificationRecords": [...],
  "faceImages": [...]
}
```

Lambda visibility timeout: 300 s
Maximum receive count before DLQ: 3
DLQ: `nhai-sync-dlq.fifo`

---

## 4. Lambda Sync Engine: Processing Contract

**Trigger**: SQS FIFO event (batch size: 1 message per invocation to preserve ordering guarantees)

**Processing rules**:

1. **Personnel upsert**:
   ```sql
   INSERT INTO personnel (...) VALUES (...)
   ON CONFLICT (employee_id) DO UPDATE SET
     full_name = EXCLUDED.full_name,
     role = EXCLUDED.role,
     updated_at = EXCLUDED.updated_at
   WHERE EXCLUDED.updated_at > personnel.updated_at;
   ```

2. **Verification record insert** (idempotent):
   ```sql
   INSERT INTO verification_record (...)
   ON CONFLICT (id, device_id) DO NOTHING;
   ```

3. **Face image metadata insert** (idempotent):
   ```sql
   INSERT INTO face_image (id, personnel_id, s3_key, created_at, device_id)
   ON CONFLICT (id) DO NOTHING;
   ```

4. **On success**: Message deleted from SQS (auto-deletion on Lambda success).
5. **On failure**: Message returned to queue; after 3 failures → DLQ. Lambda logs error with `batchId` for forensics.

---

## 5. Webhook / Callback (Optional — FR-017)

For integration with existing NHAI personnel management systems, the Lambda optionally POSTs a notification to a configured webhook URL after each successful batch:

```json
{
  "event": "sync.batch.completed",
  "batchId": "string",
  "deviceId": "string",
  "processedAt": "string (ISO-8601 UTC)",
  "summary": {
    "personnelUpserted": number,
    "verificationsInserted": number,
    "imagesRegistered": number
  }
}
```

**Webhook URL**: configured via Lambda environment variable `WEBHOOK_URL`.

---

## Versioning Policy

This contract is versioned via the API Gateway stage. Breaking changes increment the major version (`/v1/sync/batch` → `/v2/sync/batch`). The mobile app pins to a specific version. Non-breaking additions (new optional fields) are backwards-compatible and do not require a version bump.

**Current version**: v1
