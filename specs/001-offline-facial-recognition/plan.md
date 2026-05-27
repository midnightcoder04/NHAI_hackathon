# Implementation Plan: Offline Facial Recognition & Liveness Detection System

**Branch**: `main` | **Date**: 2026-05-27 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-offline-facial-recognition/spec.md`

## Summary

A React Native / Expo mobile app that performs offline personnel registration, facial recognition, and liveness detection using on-device ML models. All data is persisted in SQLite with facial images stored in device filesystem (path references in DB). When connectivity is restored, unsynced records are queued to AWS SQS, processed by an AWS Lambda sync engine, written to Amazon RDS PostgreSQL, and images uploaded to AWS S3. Multi-device sync safety is achieved via idempotent SQS message processing.

## Technical Context

**Language/Version**: TypeScript 5.x, React Native 0.76+, Expo SDK 52+

**Primary Dependencies**:
- `expo` (SDK 52+), `expo-router` (navigation)
- `expo-sqlite` (v14+ with async API) — local relational storage
- `expo-file-system` — device filesystem for image storage
- `expo-camera` — camera capture for registration and verification
- `expo-network` — connectivity detection for sync trigger
- `@tensorflow/tfjs-react-native` + `@tensorflow-models/face-landmarks-detection` — on-device face embedding extraction
- `react-native-vision-camera` (optional) — higher-performance camera pipeline
- `@aws-sdk/client-sqs`, `@aws-sdk/client-s3` — AWS service clients
- `jest` + `@testing-library/react-native` — testing

**Storage**:
- Local: SQLite via `expo-sqlite` (structured data), `expo-file-system` (images under `FileSystem.documentDirectory`)
- Cloud: Amazon RDS PostgreSQL (sync destination), AWS S3 (image backup)

**Testing**: Jest + React Native Testing Library (unit/integration); Detox or Maestro (E2E)

**Target Platform**: iOS 16+ and Android 12+ (Expo managed workflow)

**Project Type**: Mobile app (Expo managed → bare if native modules required)

**Performance Goals**:
- Verification result within 5 s of face capture (SC-002)
- Personnel registration in < 2 min (SC-001)
- Full sync of 500 records within 3 min on stable connection (SC-005)
- Face matching: p95 < 500 ms (embedding comparison against ≤ 200 stored embeddings)

**Constraints**:
- Fully offline-capable for all core functions (FR-012, FR-013)
- No duplicate records on multi-device sync (FR-015, FR-016)
- Clean integration interface for external systems (SC-008)
- Local data encryption at rest (spec assumption)

**Scale/Scope**: ~50–200 personnel per device; up to 500 verification records per sync batch; multiple devices per deployment

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Code Quality | PASS | Expo + TypeScript enforces typed, modular structure. Single-responsibility services planned (FaceService, SyncService, PersonnelRepository). |
| II. TDD (NON-NEGOTIABLE) | PASS | All business logic (face matching, sync queue, record management) will have failing tests written first. ML model integration wrapped in testable adapters. |
| III. Testing Standards | PASS | Unit: business logic with mocked SQLite/S3. Integration: real SQLite (in-memory), real SQS/Lambda via LocalStack in CI. Contract tests for sync API schema. Coverage ≥ 80% line / 70% branch enforced. |
| IV. UX Consistency | PASS | Single design system (React Native Paper or NativeBase). 200ms feedback rule enforced via loading states. Accessible labels on all interactive elements. |
| V. Performance | PASS | Face matching benchmarks in CI; SQLite queries use indices on `sync_status`, `personnel_id`; SQS batch size tuned for 3-min sync target. |

**Post-design re-check** (Phase 1 complete):

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Code Quality | PASS | Repository pattern (`PersonnelRepository`, `FaceImageRepository`, etc.) enforces single-responsibility. Service layer (`FaceService`, `SyncService`) isolates business logic from UI. All magic values extracted to `constants/index.ts`. |
| II. TDD | PASS | Task generation will enforce Red-Green-Refactor order: contract tests first, then repository unit tests, then service tests, then UI integration tests. |
| III. Testing Standards | PASS | Contract tests cover sync-api.md schema. Integration tests use real SQLite in-memory. LocalStack used for SQS/S3 integration tests. |
| IV. UX Consistency | PASS | Single component library (React Native Paper). All outcomes use spec-defined terminology (Authorized/Unauthorized/Liveness Failed). 200ms feedback enforced via loading states in camera service. |
| V. Performance | PASS | Face embedding comparison: ~0.5ms for 500 records (research.md §3). SQLite indices on `sync_status` and `personnel_id`. Profiling recorded in Complexity Tracking below. |

**Memory & CPU profiling baseline** (to be recorded after prototype build):
- Face matching: target < 500ms p95 for 200 enrolled personnel
- App cold start: target < 3s Time-to-Interactive
- SQLite sync outbox drain: target < 30ms for 500-record batch serialization

## Project Structure

### Documentation (this feature)

```text
specs/001-offline-facial-recognition/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   ├── sync-api.md      # SQS message schema + Lambda contract
│   └── rds-schema.sql   # PostgreSQL DDL for cloud side
└── tasks.md             # Phase 2 output (/speckit-tasks command)
```

### Source Code (repository root)

```text
mobile/                         # Expo React Native application
├── app/                        # expo-router file-based navigation
│   ├── (tabs)/
│   │   ├── index.tsx           # Personnel list screen
│   │   ├── verification.tsx    # Live verification screen
│   │   └── backup.tsx          # Backup status screen
│   ├── personnel/
│   │   ├── [id].tsx            # Personnel detail / edit
│   │   └── new.tsx             # Register new personnel
│   └── _layout.tsx
├── src/
│   ├── db/
│   │   ├── schema.ts           # SQLite table definitions + migrations
│   │   ├── repositories/
│   │   │   ├── PersonnelRepository.ts
│   │   │   ├── FaceImageRepository.ts
│   │   │   ├── VerificationRepository.ts
│   │   │   └── BackupJobRepository.ts
│   │   └── migrations/
│   ├── services/
│   │   ├── FaceService.ts      # Embedding extraction + liveness + matching
│   │   ├── SyncService.ts      # Connectivity detection + queue dispatch
│   │   ├── S3UploadService.ts  # Image upload to S3
│   │   └── CameraService.ts    # Camera lifecycle + image capture
│   ├── models/                 # TypeScript domain types
│   │   ├── Personnel.ts
│   │   ├── FaceImage.ts
│   │   ├── VerificationRecord.ts
│   │   └── BackupJob.ts
│   ├── hooks/                  # React hooks (useSync, useCamera, usePersonnel)
│   ├── components/             # Shared UI components
│   └── constants/
├── __tests__/
│   ├── unit/
│   │   ├── services/
│   │   └── repositories/
│   ├── integration/
│   │   └── sync/               # SQS + Lambda integration (LocalStack)
│   └── contract/
│       └── sync-schema.test.ts
└── assets/

infra/                          # AWS infrastructure
├── lambda/
│   └── sync-engine/
│       ├── handler.ts          # SQS event handler → RDS writer
│       ├── imageProcessor.ts   # S3 image registration
│       └── __tests__/
├── terraform/ (or CDK)         # IaC for SQS, Lambda, RDS, S3
└── scripts/
    └── db-migrate.sql          # RDS schema bootstrap
```

**Structure Decision**: Mobile + AWS infra monorepo. `mobile/` is the Expo app; `infra/` contains the Lambda sync engine and IaC. This cleanly separates the two independently deployable units while keeping them in one repo for the hackathon.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Multi-layer sync (SQS → Lambda → RDS) | Multi-device conflict safety; at-least-once delivery guarantee; decouples mobile from RDS | Direct mobile → RDS connection exposes DB credentials on device and creates connection pool exhaustion at scale |
| Face embedding storage in SQLite BLOB | Avoids re-running ML inference on every match; reduces verification latency from ~2s to ~50ms per comparison | Storing only raw image paths requires reprocessing all images on every verification |
| Expo managed → bare ejection possible | On-device ML via TFLite may require native modules unavailable in managed workflow | Managed workflow preferred initially; bare ejection documented as escape hatch if TFLite native module is needed |
