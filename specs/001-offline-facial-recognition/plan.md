# Implementation Plan: Offline Facial Recognition & Liveness Detection

**Branch**: `001-offline-facial-recognition` | **Date**: 2026-05-27 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-offline-facial-recognition/spec.md`

## Summary

A React Native (Expo bare workflow) mobile app that performs on-device facial recognition and liveness detection using TFLite models, persisting all data in encrypted SQLite, and syncing to AWS (HTTP API Gateway → Lambda → SQS FIFO → Lambda → RDS PostgreSQL) via a device-side outbox plus a server-side queue when connectivity is restored. The HTTP-facing Lambda validates and enqueues each batch to SQS FIFO; the same Lambda's SQS-triggered consumer performs the idempotent RDS writes (see `contracts/sync-api.md`). The cloud backend is provisioned entirely via Terraform.

## Technical Context

**Language/Version**: TypeScript (React Native 0.83 / Expo SDK 55, bare workflow), Node.js 20 (Lambda), HCL (Terraform 1.7+)

**Primary Dependencies**:
- Mobile: `react-native-vision-camera` v5 (Nitro) with `react-native-worklets` + `react-native-vision-camera-worklets` (frame-processor runtime — v5 dropped `react-native-worklets-core`) + `react-native-fast-tflite` (the loaded model is boxed via `NitroModules.box()` for worklet access; fast-tflite's v5 frame-processor integration is community/undocumented — see Complexity Tracking) for the four-stage on-device pipeline — BlazeFace f16 (`blaze_face_short_range_float16.tflite`, detection), MobileFaceNet INT8 (`MobileFaceNet_new_latest_int8.tflite`, 128-d embedding), MiniFASNet/landmarks f16 (`face_landmarks_detector_float16.tflite`, active liveness) and Antispoof INT8 (`antispoof_128x128_int8.tflite`, passive liveness); `expo-sqlite` (SDK 55 async API, WAL mode) for local persistence; `expo-secure-store` + `expo-crypto` (AES-256 field-level encryption of PII, FR-022); `@aws-sdk/credential-providers` (Cognito Identity Pool guest temporary credentials) + `aws-sigv4-fetch` (SigV4-signed API Gateway calls under `AWS_IAM` auth — no JWT/API key/long-lived secret on device; the S3 image upload is a plain `PUT` to a pre-signed URL, so no S3 SDK is needed on the device); `@react-native-community/netinfo` (connectivity monitoring)
- Backend: Node.js `pg` (node-postgres), AWS SDK v3 (SQS, S3)

**Storage**: SQLite on-device (`expo-sqlite`), Amazon S3 (face images), Amazon RDS PostgreSQL (cloud replica)

**Testing**: Jest + React Native Testing Library (mobile unit), Maestro (E2E flows), Jest (Lambda unit tests)

**Target Platform**: Android 8+ / iOS 14+ (mobile); AWS Lambda Node.js 20 (backend)

**Project Type**: Mobile app (React Native/Expo bare) + Cloud API (AWS HTTP API Gateway + Lambda)

**Performance Goals**:
- Verification result displayed to operator < 1 s end-to-end (SC-002)
- Liveness detection rejects photo spoofing ≥ 95 % of attempts (SC-003)
- Face matching accuracy ≥ 90 % under typical field lighting (SC-004)
- All pending records synced within 3 min of stable connectivity for ≤ 500 records (SC-005)
- Cloud API endpoints < 300 ms p95 under expected load (Constitution V)
- On-device inference budget ≈ 210 ms/verification (BlazeFace ~20 + MobileFaceNet ~60 + MiniFASNet ~100 + Antispoof ~30); end-to-end auth < 1 s (SC-002, README sub-second target)

**Constraints**: Fully offline capable (FR-012/FR-013); AES-256 field-level encryption at rest over all PII — names, employee IDs, embeddings, and face image files (FR-022) via a device-bound key (`expo-secure-store`); no long-lived API secrets on device; SigV4-signed requests via Cognito Identity Pool temporary credentials

**Scale/Scope**: Single-device operator; 50+ enrolled personnel records; 500 verification records per typical field session per sync batch

**Profiling Results**: To be recorded here post-implementation per Constitution V (memory/CPU profile on a mid-range device — e.g., Snapdragon 665 / 3 GB RAM — and per-stage inference timings; see task T102). _[pending]_

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Code Quality | PASS | Single-responsibility services planned; all thresholds as named constants; no god objects |
| II. TDD (NON-NEGOTIABLE) | PASS | All tasks in tasks.md will follow Red → Green → Refactor; face matching logic is pure-function testable |
| III. Testing Standards | PASS | Unit (business logic isolated), integration (real SQLite via expo-sqlite test helpers), contract (sync-api.md schema validated); ≥ 80 % line / ≥ 70 % branch enforced in CI |
| IV. UX Consistency | PASS | Single component library (React Native Paper); domain glossary in spec.md drives all UI text; 200 ms feedback rule enforced via loading states; accessibility (WCAG 2.1 AA — labels, ≥4.5:1 contrast, ≥48dp targets) designed in per task T104 |
| V. Performance | PASS | SC-002 < 1 s and ~210 ms inference budget covered by benchmark harness (T100–T101) gated in CI (T103); Constitution < 300 ms p95 for Lambda API; memory/CPU profiling (T102) recorded in this plan |

**Post-Phase-1 re-check**: All gates remain PASS. No constitution violations detected.

**Complexity Tracking** (justified deviations):

| Deviation | Why Needed | Simpler Alternative Rejected Because |
|-----------|-----------|-------------------------------------|
| Bare Expo workflow (eject from managed) | `react-native-vision-camera` and `react-native-fast-tflite` require native module compilation | Managed workflow cannot link native TFLite code; expo-face-detector (managed-compatible) provides bounding boxes only — not embeddings |
| Outbox pattern + SQS FIFO | Ensures no record loss if connectivity drops mid-sync; idempotent replay | Direct HTTP retry from mobile loses durability on app restart; spec requires partial-sync resilience (FR-015) |
| Four-model TFLite pipeline (BlazeFace detection + MobileFaceNet INT8 embedding + MiniFASNet/landmarks + Antispoof liveness) | No single model provides detection, 128-d embeddings, AND dual-layer (active blink + passive texture) liveness; each stage is independently swappable and quantization-tuned (f16 where texture/stability matters, INT8 where NNAPI applies) | A single multi-task TFLite model is not available open-source; MLKit exposes only bounding boxes/landmarks — not embeddings or anti-spoof |
| Phases 1–3 (T001–T031) were implemented test-after, before the TDD protocol was formalized — a documented deviation from Constitution II (NON-NEGOTIABLE) | The initial scaffolding/spike landed before tasks.md existed; preserving the working, manually-verified code is cheaper than discarding it | Re-doing Phases 1–3 strictly test-first was rejected as wasteful; instead, backfill tests T081–T087 restore the missing coverage and are **gated to be green before any Phase 4+ implementation continues** (tasks.md Phase 8). No further test-after work is permitted. |
| Frame-processor ML on VisionCamera **v5** with `react-native-fast-tflite` (whose public frame-processor path targets **v4**; v5 integration is community/undocumented) | Multi-frame active liveness (blink/head-turn tracked across a frame stream, FR-007/SC-003) needs a real-time frame processor, not single still captures; v5 is already integrated and working in the app | Downgrading the camera to v4 reverts the working v5 setup and reintroduces SDK-version churn; burst still-capture was rejected because it cannot sustain the frame rate needed for reliable blink detection. Risk mitigated by boxing the model via `NitroModules.box()`, pinning `react-native-worklets` / `react-native-vision-camera-worklets` versions, and a frame-processor smoke test before building the full pipeline. |

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
