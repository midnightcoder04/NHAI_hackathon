# Research: Offline Facial Recognition & Liveness Detection

**Phase 0 output for**: `001-offline-facial-recognition`
**Date**: 2026-05-27

---

## 1. On-Device Face Recognition Library

**Decision**: `react-native-vision-camera` v4 + `react-native-fast-tflite`

**Rationale**: Vision Camera's Frame Processor API runs synchronous native code on each camera frame with sub-frame latency. `react-native-fast-tflite` loads a `.tflite` model (e.g., MobileFaceNet, FaceNet-128) directly on GPU/NPU — no server required. This aligns with the spec assumption of "pre-built on-device binaries." Inference time ~50ms vs ~300ms on the JS thread.

**Alternatives considered**:
- `@tensorflow/tfjs-react-native`: Works but runs on the JS thread — 3-5× slower inference, blocking UI.
- `expo-face-detector` (MLKit): Detects bounding boxes only — no embeddings, cannot be used for matching.
- `face-api.js`: Browser-oriented, no native acceleration in React Native.

**Note**: Requires bare Expo workflow (ejecting from managed) due to native module requirements. Managed workflow escape hatch is documented in plan.md Complexity Tracking.

---

## 2. Liveness Detection Approach

**Decision**: Blink detection (eye-aspect-ratio across frames) + texture analysis (reflectance-based binary classifier)

**Rationale**: 
- Blink detection instructs the user to blink; the face landmark model tracks eye-aspect-ratio across frames. This is implementable entirely with the Vision Camera Frame Processor and a landmark `.tflite` model. 
- Texture analysis distinguishes printed photos (uniform reflectance) from live faces (specular highlights) via a lightweight binary classifier `.tflite` model.
- Together, these target 95%+ spoof rejection rate (SC-003) without hardware dependency.

**Alternatives considered**:
- Depth / TrueDepth / ToF sensors: Only available on premium devices; not portable across fleet.
- 3D face mesh (MediaPipe): More accurate but adds 15+ MB to app bundle; overkill for hackathon prototype.

---

## 3. Face Embedding Storage Strategy

**Decision**: Store 128-float embeddings (512 bytes each) as BLOB in SQLite; raw images stored on device filesystem with path reference in SQLite.

**Rationale**: Cosine similarity between two 128-d vectors executes in < 1 ms in JS/native. With 500 records, total matching time is ~0.5 ms. Re-running inference at match time against raw images would take ~50-200 ms per candidate — ~25 s for 500 records. Embeddings also avoid re-downloading images during matching. Raw images retained on-disk linked by `personnel_id` for display only.

**Alternatives considered**:
- Raw image matching only: Prohibitively slow at scale; fails SC-002 (5s verification target).
- Cloud-side matching: Requires connectivity; violates FR-012 (offline-first).

---

## 4. Local Database: expo-sqlite v14+ API

**Decision**: `expo-sqlite` SDK 52+ with `openDatabaseAsync` (async API, WAL mode by default)

**Key API surface**:
```ts
import * as SQLite from 'expo-sqlite';

const db = await SQLite.openDatabaseAsync('nhai.db');
await db.execAsync(ddlSql);                          // DDL
await db.runAsync(sql, [param1, param2]);             // INSERT/UPDATE/DELETE
const rows = await db.getAllAsync<RowType>(sql, params); // SELECT
await db.withTransactionAsync(async () => { ... });   // Atomic batch
```

`SQLiteProvider` + `useSQLiteContext()` hook available for React component tree access.

**Alternatives considered**:
- Legacy `openDatabase` callback API: Deprecated, synchronous, blocks UI thread.
- WatermelonDB: Heavy abstraction; adds complexity not justified for this scope.
- Realm: React Native SDK available but adds proprietary sync layer we are replacing with custom AWS sync.

---

## 5. AWS Sync Architecture (SQS → Lambda → RDS + S3)

**Decision**: Outbox pattern on device → API Gateway → SQS FIFO → Lambda → RDS PostgreSQL; images via separate S3 pre-signed URL upload

**Rationale**:
- **Outbox pattern**: Device writes to local `sync_queue` SQLite table with `record_id` + `sha256_hash` as idempotency key before dispatching. Only records with `sync_status = 'pending'` are sent.
- **SQS FIFO**: `MessageDeduplicationId = idempotency_key` prevents duplicate processing. `MessageGroupId = device_id` ensures per-device ordering.
- **Lambda**: Upserts using idempotency key — safe to replay. Marks each message as processed.
- **Acknowledgment**: Lambda publishes status back (DynamoDB or direct response via API GW). Mobile marks records `synced` only after confirmed ACK.
- **Images**: Mobile obtains a pre-signed S3 URL from API Gateway, uploads directly to S3 (bypasses Lambda for large payloads), stores S3 key in the metadata payload sent via SQS.
- **Multi-device deduplication**: `(employee_id, created_at)` composite unique constraint on RDS prevents duplicate verification records from two devices syncing the same event.

**Alternatives considered**:
- Direct Lambda HTTP (no SQS): Loses replay resilience on Lambda throttle or timeout; mobile must implement retry logic itself.
- SNS fanout: Single consumer pattern — SNS adds unnecessary complexity.
- AppSync + DynamoDB: Managed sync but locks into non-relational model; NHAI likely has existing PostgreSQL systems.

---

## NEEDS CLARIFICATION — Resolved

| Item | Resolution |
|------|-----------|
| ML model format (TFLite vs CoreML vs ONNX) | Spec says "pre-built binaries" — plan assumes `.tflite` (cross-platform). CoreML variant can be swapped in for iOS if provided. |
| Conflict resolution for personnel record edits from two devices | Last-write-wins using `updated_at` timestamp. RDS `ON CONFLICT DO UPDATE SET ... WHERE excluded.updated_at > personnel.updated_at`. |
| Encryption at rest standard | AES-256 via `expo-secure-store` for sensitive fields; SQLite DB file encryption via SQLCipher if time permits in hackathon scope. |
| SQS vs SNS | SQS FIFO chosen (single consumer, ordered, deduplication built-in). |
