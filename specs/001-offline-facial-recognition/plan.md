# Implementation Plan: Offline Facial Recognition & Liveness Detection

**Branch**: `001-offline-facial-recognition` | **Date**: 2026-05-27 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-offline-facial-recognition/spec.md`

## Summary

A React Native (Expo bare workflow) mobile app that performs on-device facial recognition and liveness detection using TFLite models, persisting all data in encrypted SQLite, and syncing to AWS (HTTP API Gateway → Lambda → RDS PostgreSQL) via an outbox pattern when connectivity is restored. The cloud backend is provisioned entirely via Terraform.

## Technical Context

**Language/Version**: TypeScript (React Native / Expo SDK 52+), Node.js 20 (Lambda), HCL (Terraform 1.7+)

**Primary Dependencies**:
- Mobile: `react-native-vision-camera` v4 + `react-native-fast-tflite` (TFLite inference for face embeddings and liveness), `expo-sqlite` SDK 52+ async API with WAL mode (local persistence), `expo-secure-store` (AES-256 encryption for sensitive fields), AWS SDK v3 (Cognito + API Gateway), `@react-native-community/netinfo` (connectivity monitoring)
- Backend: Node.js `pg` (node-postgres), AWS SDK v3 (SQS, S3)

**Storage**: SQLite on-device (`expo-sqlite`), Amazon S3 (face images), Amazon RDS PostgreSQL (cloud replica)

**Testing**: Jest + React Native Testing Library (mobile unit), Maestro (E2E flows), Jest (Lambda unit tests)

**Target Platform**: Android 8+ / iOS 14+ (mobile); AWS Lambda Node.js 20 (backend)

**Project Type**: Mobile app (React Native/Expo bare) + Cloud API (AWS HTTP API Gateway + Lambda)

**Performance Goals**:
- Verification result displayed to operator < 5 s end-to-end (SC-002)
- Liveness detection rejects photo spoofing ≥ 95 % of attempts (SC-003)
- Face matching accuracy ≥ 90 % under typical field lighting (SC-004)
- All pending records synced within 3 min of stable connectivity for ≤ 500 records (SC-005)
- Cloud API endpoints < 300 ms p95 under expected load (Constitution V)

**Constraints**: Fully offline capable (FR-012/FR-013); encrypted local storage (AES-256); no long-lived API secrets on device; SigV4-signed requests via Cognito Identity Pool temporary credentials

**Scale/Scope**: Single-device operator; 50+ enrolled personnel records; 500 verification records per typical field session per sync batch

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Code Quality | PASS | Single-responsibility services planned; all thresholds as named constants; no god objects |
| II. TDD (NON-NEGOTIABLE) | PASS | All tasks in tasks.md will follow Red → Green → Refactor; face matching logic is pure-function testable |
| III. Testing Standards | PASS | Unit (business logic isolated), integration (real SQLite via expo-sqlite test helpers), contract (sync-api.md schema validated); ≥ 80 % line / ≥ 70 % branch enforced in CI |
| IV. UX Consistency | PASS | Single component library (React Native Paper); domain glossary in spec.md drives all UI text; 200 ms feedback rule enforced via loading states |
| V. Performance | PASS | SC-002 < 5 s covers on-device verification; Constitution < 300 ms p95 for Lambda API; benchmark step in CI |

**Post-Phase-1 re-check**: All gates remain PASS. No constitution violations detected.

**Complexity Tracking** (justified deviations):

| Deviation | Why Needed | Simpler Alternative Rejected Because |
|-----------|-----------|-------------------------------------|
| Bare Expo workflow (eject from managed) | `react-native-vision-camera` and `react-native-fast-tflite` require native module compilation | Managed workflow cannot link native TFLite code; expo-face-detector (managed-compatible) provides bounding boxes only — not embeddings |
| Outbox pattern + SQS FIFO | Ensures no record loss if connectivity drops mid-sync; idempotent replay | Direct HTTP retry from mobile loses durability on app restart; spec requires partial-sync resilience (FR-015) |
| Dual ML approach (face detection landmark model + separate embedding TFLite) | MLKit face detector does not expose embeddings; a separate FaceNet/MobileFaceNet model is required for offline 1:N matching | Single-model alternatives do not provide both landmark detection and 128-d embeddings in one Expo-compatible package |

## Project Structure

### Documentation (this feature)

```text
specs/001-offline-facial-recognition/
├── plan.md              # This file
├── research.md          # Phase 0: resolved unknowns
├── data-model.md        # Phase 1: entity schemas (SQLite + RDS)
├── quickstart.md        # Phase 1: dev setup guide
├── contracts/
│   ├── sync-api.md      # Phase 1: cloud sync API contract (STABLE)
│   └── rds-schema.sql   # Phase 1: RDS PostgreSQL DDL
└── tasks.md             # Phase 2 (/speckit-tasks command — NOT created by /speckit-plan)
```

### Source Code

```text
mobile/                          # Expo bare React Native app
├── src/
│   ├── constants/               # Named constants (thresholds, batch limits)
│   ├── models/                  # TypeScript domain types (Personnel, FaceImage, etc.)
│   ├── db/
│   │   ├── schema.ts            # SQLite DDL strings
│   │   ├── migrations.ts        # Migration runner
│   │   └── repositories/        # DAOs: PersonnelRepository, FaceImageRepository, etc.
│   ├── services/
│   │   ├── VerificationService.ts   # Orchestrates liveness + matching
│   │   ├── SyncService.ts           # Outbox dispatch, SQS, S3 pre-sign
│   │   └── BackupStatusService.ts   # Backup job tracking
│   ├── ml/
│   │   ├── FaceDetector.ts      # Vision Camera frame processor integration
│   │   ├── EmbeddingModel.ts    # TFLite MobileFaceNet wrapper
│   │   ├── LivenessDetector.ts  # Blink detection + texture classifier
│   │   └── FaceMatcher.ts       # Cosine similarity 1:N matching
│   ├── screens/
│   │   ├── PersonnelListScreen.tsx
│   │   ├── PersonnelDetailScreen.tsx
│   │   ├── VerificationScreen.tsx
│   │   └── BackupStatusScreen.tsx
│   └── components/              # Shared UI (from React Native Paper)
├── __tests__/
│   ├── unit/
│   ├── integration/
│   └── contract/
└── app.json / eas.json

infra/
├── terraform/
│   ├── modules/
│   │   ├── core-infra/          # VPC, Cognito Identity Pool, IAM roles
│   │   ├── serverless/          # HTTP API Gateway (v2) + Lambda (Node.js 20)
│   │   └── database/            # RDS PostgreSQL (db.t3.micro for prototype)
│   ├── main.tf                  # Root: remote state (S3 + DynamoDB lock)
│   └── terraform.tfvars.example
└── lambda/
    └── sync-engine/
        ├── src/
        │   ├── handler.ts       # SQS event handler
        │   ├── db.ts            # pg connection pool
        │   └── processors/      # PersonnelProcessor, VerificationProcessor, etc.
        └── __tests__/
```

**Structure Decision**: Option 3 (Mobile + API). Two top-level workspaces — `mobile/` (React Native/Expo) and `infra/` (Terraform + Lambda). This cleanly separates mobile and cloud concerns while keeping everything in one monorepo for hackathon simplicity.
