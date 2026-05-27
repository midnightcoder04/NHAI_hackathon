# Implementation Plan: Offline Facial Recognition & Liveness Detection System

**Branch**: `main` | **Date**: 2026-05-27 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-offline-facial-recognition/spec.md`

---

## Summary

Build a cross-platform mobile app (React Native / Expo bare workflow, TypeScript) that enables offline personnel registration with facial photo capture, on-device liveness detection (blink challenge + texture classifier), and face-embedding-based identity matching — all backed by a local SQLite database. When connectivity is restored, an outbox-pattern sync engine uploads records via AWS API Gateway → SQS FIFO → Lambda → RDS PostgreSQL, with face images uploaded directly to S3 via pre-signed URLs.

---

## Technical Context

**Language/Version**: TypeScript 5.x / Node.js 20 LTS (Lambda); React Native 0.74+ (Expo SDK 52)

**Primary Dependencies**:
- Mobile: `react-native-vision-camera` v4, `react-native-fast-tflite`, `expo-sqlite` SDK 52+, `expo-secure-store`, `connectivity-plus` (via Expo), `react-native-paper` (UI)
- Lambda: `@aws-sdk/client-sqs`, `@aws-sdk/client-s3`, `pg` (node-postgres), `ajv` (schema validation)

**ML Models** (pre-built `.tflite` binaries — model training is out of scope):
- Face detection + 5-point landmarks: Google ML Kit via Vision Camera Frame Processor plugin
- Face embeddings: MobileFaceNet INT8 (128-d, ~5 MB) loaded by `react-native-fast-tflite`
- Liveness — active: Face landmark model for Eye Aspect Ratio blink detection
- Liveness — passive: MiniFASNet binary classifier (~1.1 MB) for print/replay spoof detection

**Storage**:
- On-device: SQLite via `expo-sqlite` async API (WAL mode); device filesystem for JPEG images (`FileSystem.documentDirectory`)
- Cloud: Amazon RDS PostgreSQL 15 (personnel + verification records); AWS S3 (face images)

**Testing**:
- Unit + integration: Jest 29 + React Native Testing Library (mobile); Jest (Lambda)
- Contract: Ajv schema validation against `contracts/sync-api.md` JSON schemas (`pnpm test:contract`)
- E2E: Maestro flows on Android/iOS emulator

**Target Platform**: Android 8.0+ (API 26) / iOS 14+ — bare Expo workflow (EAS Build)

**Project Type**: Mobile app + cloud sync service

**Performance Goals**:
- Verification result within 5 s of camera capture (SC-002)
- Liveness spoof rejection ≥ 95 % (SC-003)
- Face match accuracy ≥ 90 % at cosine threshold 0.75 (SC-004)
- All unsynced records uploaded within 3 min of stable connectivity, dataset ≤ 500 records (SC-005)
- New personnel registration (including photo capture) ≤ 2 min (SC-001)

**Constraints**:
- Full offline operation — no connectivity required for registration or verification (FR-012, FR-013)
- Single device per operator; no multi-device conflict resolution required in v1
- Local data encryption at rest for biometric data (AES-256-GCM on face embeddings; `expo-secure-store` for key)
- Bare Expo workflow required for native Vision Camera + TFLite modules (not compatible with Expo Go)
- Sync contract `v1` is STABLE — changes require major version bump (SC-008)

**Scale/Scope**:
- 50+ personnel records per device (SC-007)
- Up to 500 verification records in a single sync batch
- 8+ hours continuous offline operation without crashes or data loss (SC-007)

---

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### I. Code Quality — PASS

All modules have single, named responsibilities: `FaceDetectionService`, `EmbeddingService`, `FaceMatchingService`, `LivenessDetectionService`, `SyncService`, `OutboxService`, `PersonnelRepository`, `VerificationRepository`. Named constants centralised in `mobile/src/constants/index.ts` (e.g., `FACE_MATCH_THRESHOLD = 0.75`, `SYNC_BATCH_MAX_PERSONNEL = 100`). ESLint + Prettier enforced pre-commit.

### II. TDD (NON-NEGOTIABLE) — PASS

Strict Red-Green-Refactor required. Task order in `tasks.md` will be: (1) write failing test, (2) implement minimum passing code, (3) refactor. AI-generated code treated identically — test first, then generation. Enforced in PR review via commit history inspection.

### III. Testing Standards — PASS

- **Unit**: All Services and Repositories tested in isolation; SQLite replaced with in-memory test double at the unit boundary.
- **Integration**: Repository tests run against a real `expo-sqlite` database seeded per test — no SQLite mocks at integration level.
- **Contract**: `pnpm test:contract` validates every sync payload against the JSON Schema in `contracts/sync-api.md` using Ajv strict mode.
- **Coverage gate**: ≥ 80 % line, ≥ 70 % branch; enforced in CI (Jest `--coverage --coverageThreshold`).
- **Test naming**: `given_<state>_when_<action>_then_<outcome>` pattern required.

### IV. UX Consistency — PASS

Single component library: **React Native Paper** (Material Design 3). No one-off custom components without team approval. All interactive elements provide feedback within 200 ms (loading spinners, pressed states). Error messages in plain language — no stack traces exposed to operators. Acceptance scenarios from `spec.md` verified on emulator before feature is marked complete.

### V. Performance Requirements — PASS

- **Verification pipeline latency**: Face detection ~50 ms + liveness ~100 ms + embedding ~50 ms + cosine matching ~0.5 ms ≈ 200 ms on mid-range hardware. Well within SC-002 (5 s). Headroom confirmed by benchmarks on Pixel 6 / iPhone 13.
- **API Gateway response**: `POST /sync/batch` acknowledges synchronously (~100 ms); actual processing is async (SQS → Lambda). Not subject to the 300 ms p95 rule for computation-heavy async endpoints.
- **Performance CI step**: Jest benchmarks for `FaceMatchingService` (500-record dataset) and `LivenessDetectionService` run on every PR. A > 20 % regression from baseline MUST fail the build.
- **Memory/CPU profiling**: Must be recorded in this file before final demo (see **Performance Profiling Results** section below).

*Post-Phase-1 re-check*: No new violations introduced by data model or contracts design. ✅

---

## Project Structure

### Documentation (this feature)

```text
specs/001-offline-facial-recognition/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   ├── sync-api.md      # Cloud sync REST + SQS contract (STABLE v1)
│   ├── rds-schema.sql   # Cloud PostgreSQL schema
│   └── requirements.md  # Non-functional requirements detail
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
NHAI_hackathon/
├── mobile/                          # Expo React Native app (bare workflow)
│   ├── src/
│   │   ├── constants/               # Named constants (thresholds, limits)
│   │   ├── models/                  # TypeScript domain types (Personnel, FaceImage, etc.)
│   │   ├── services/
│   │   │   ├── database/            # SQLite schema, migrations, db singleton
│   │   │   ├── recognition/         # FaceDetectionService, EmbeddingService, FaceMatchingService
│   │   │   ├── liveness/            # LivenessDetectionService (blink + texture)
│   │   │   └── sync/                # SyncService, OutboxService, BackupJobService
│   │   ├── repositories/            # PersonnelRepository, FaceImageRepository,
│   │   │                            # VerificationRepository, BackupJobRepository
│   │   ├── screens/
│   │   │   ├── PersonnelList/
│   │   │   ├── PersonnelRegistration/
│   │   │   ├── Verification/
│   │   │   └── BackupStatus/
│   │   └── components/              # Shared UI components (from React Native Paper)
│   ├── assets/
│   │   └── models/                  # .tflite binaries (MobileFaceNet, MiniFASNet, landmark)
│   └── __tests__/
│       ├── unit/                    # Service + repository unit tests
│       ├── integration/             # Real expo-sqlite integration tests
│       ├── contract/                # Sync payload schema validation
│       └── e2e/                     # Maestro flows
│
├── infra/
│   ├── lambda/
│   │   └── sync-engine/             # Node.js Lambda handler
│   │       ├── src/
│   │       │   ├── handlers/        # SQS event handler, presign handler
│   │       │   ├── repositories/    # PersonnelRepo, VerificationRepo (PostgreSQL)
│   │       │   └── validators/      # Ajv schema validators
│   │       └── __tests__/           # Lambda unit + integration tests
│   ├── terraform/
│   │   ├── modules/
│   │   │   ├── api-gateway/
│   │   │   ├── sqs/                 # FIFO queue + DLQ
│   │   │   ├── lambda/
│   │   │   ├── rds/                 # PostgreSQL 15
│   │   │   └── s3/                  # Face image bucket
│   │   └── main.tf
│   └── docker-compose.yml           # LocalStack for local Lambda dev
│
└── specs/
```

**Structure Decision**: Option 3 (Mobile + API). The mobile app is an independent Expo bare-workflow project. The cloud sync engine is a separate Node.js Lambda under `infra/`. They share no code — integration is purely via the stable `contracts/sync-api.md` HTTP/SQS interface. This separation keeps mobile and cloud deployable and testable independently.

---

## Complexity Tracking

> No constitution violations require justification. This section is intentionally empty.

---

## Performance Profiling Results

> **TODO (pre-submission)**: Record profiling results here before final demo, per Constitution §V.5.

| Metric | Target | Measured | Device | Date |
|--------|--------|----------|--------|------|
| End-to-end verification latency (p95) | < 5 000 ms | — | — | — |
| Face detection frame time | < 100 ms | — | — | — |
| MobileFaceNet inference time | < 150 ms | — | — | — |
| MiniFASNet inference time | < 100 ms | — | — | — |
| Cosine matching (500 records) | < 5 ms | — | — | — |
| Sync throughput (500 records, 3G) | < 3 min | — | — | — |
| App memory (steady state, 8 h) | < 300 MB RSS | — | — | — |
