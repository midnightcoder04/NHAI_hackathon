# Tasks: Offline Facial Recognition & Liveness Detection

**Input**: Design documents from `/specs/001-offline-facial-recognition/`

**Prerequisites**: plan.md ✓, spec.md ✓, data-model.md ✓, research.md ✓, contracts/sync-api.md ✓, quickstart.md ✓

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1–US4)
- Exact file paths included in every task description

## Path Conventions

```
mobile/                   # Expo bare React Native app (TypeScript)
infra/
  lambda/sync-engine/     # AWS Lambda Node.js 20 sync engine
  terraform/              # Terraform HCL IaC
specs/001-offline-facial-recognition/   # Design docs (read-only at implementation time)
```

---

## Test-Driven Development Protocol (Constitution II — NON-NEGOTIABLE)

Every implementation task here is governed by strict Red → Green → Refactor:

1. The matching test task in **Phase 8** MUST be authored first and MUST fail for the right reason (assertion, not import/compile error) before the implementation task it references is started.
2. Phases 1–3 were implemented before test tasks existed; tasks **T081–T087** backfill that coverage and MUST be green before any Phase 4+ implementation continues.
3. Contract tests (T093) MUST run before integration/E2E (Constitution III). Every commit MUST leave the suite green; coverage gates (≥ 80 % line / ≥ 70 % branch) are enforced in CI (T103).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Monorepo scaffolding, workspaces, tooling — must complete before any other work.

- [x] T001 Create monorepo directory structure: `mobile/`, `infra/lambda/sync-engine/`, `infra/terraform/` with placeholder README.md files per implementation plan
- [x] T002 Initialize Expo bare workflow in `mobile/` (`npx create-expo-app mobile --template bare-minimum`) and verify `app.json` with `expo` config for Android 8+ / iOS 14+
- [x] T003 [P] Configure TypeScript for `mobile/` workspace: create `mobile/tsconfig.json` extending `expo/tsconfig.base` with strict mode enabled
- [x] T004 [P] Configure ESLint + Prettier for `mobile/`: create `mobile/.eslintrc.js` (react-native + typescript rules) and `mobile/.prettierrc`
- [x] T005 Initialize Lambda TypeScript project in `infra/lambda/sync-engine/`: `package.json` with `typescript`, `@types/aws-lambda`, `pg`, `aws-sdk` v3; create `tsconfig.json` targeting Node.js 20
- [x] T006 [P] Initialize Terraform project in `infra/terraform/`: create `main.tf` with S3 remote state backend block and DynamoDB lock table reference; create `terraform.tfvars.example` placeholder
- [x] T007 [P] Create pnpm workspace config at repo root: `pnpm-workspace.yaml` listing `mobile` and `infra/lambda/sync-engine` packages
- [x] T008 [P] Configure Jest for `mobile/`: add `jest` config to `mobile/package.json` with `jest-expo` preset, coverage thresholds (≥80% lines, ≥70% branches), and `__tests__/unit/`, `__tests__/integration/`, `__tests__/contract/` directories
- [x] T009 [P] Create `mobile/.env.example` with placeholders: `AWS_API_GATEWAY_URL`, `AWS_REGION`, `AWS_COGNITO_IDENTITY_POOL_ID`, `DEVICE_ID_SEED`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core domain types, SQLite schema, migration runner, and shared utilities that ALL user stories depend on. No user story can begin until this phase is complete.

**⚠️ CRITICAL**: These tasks block every user story phase below.

- [x] T010 Create `mobile/src/constants/index.ts` with all named constants: `FACE_MATCH_THRESHOLD = 0.65` (cosine, MobileFaceNet INT8 per README), `FACE_LOW_CONFIDENCE_THRESHOLD = 0.5`, `FACE_MIN_QUALITY_SCORE = 0.4`, `LIVENESS_BLINK_FRAMES = 3`, `SYNC_BATCH_MAX_PERSONNEL = 100`, `SYNC_BATCH_MAX_VERIFICATIONS = 500`, `SYNC_RETRY_MAX_ATTEMPTS = 3`, `SYNC_RETRY_BACKOFF_MS = 5000`, `IMAGE_STORAGE_DIR = 'face_images/'`, and model-asset filename constants (`MODEL_FACE_DETECTOR`, `MODEL_FACE_EMBEDDING`, `MODEL_LIVENESS_LANDMARKS`, `MODEL_LIVENESS_ANTISPOOF`)
- [x] T011 [P] Create `mobile/src/models/Personnel.ts` with `SyncStatus` union type and `Personnel` interface per data-model.md TypeScript types
- [x] T012 [P] Create `mobile/src/models/FaceImage.ts` with `FaceImage` interface (including `embedding: Float32Array | null`) per data-model.md
- [x] T013 [P] Create `mobile/src/models/VerificationRecord.ts` with `VerificationOutcome` union and `VerificationRecord` interface per data-model.md
- [x] T014 [P] Create `mobile/src/models/BackupJob.ts` with `BackupStatus` union and `BackupJob` interface per data-model.md
- [x] T015 Implement all five SQLite DDL strings in `mobile/src/db/schema.ts` (personnel, face_image, verification_record, backup_job, sync_outbox tables with indexes) exactly matching data-model.md On-Device Schema
- [x] T016 Implement SQLite migration runner in `mobile/src/db/migrations.ts` using `expo-sqlite` `openDatabaseAsync` (WAL mode) that executes DDL from `schema.ts` and is idempotent (CREATE TABLE IF NOT EXISTS)
- [x] T017 Wire `SQLiteProvider` in `mobile/App.tsx` using `expo-sqlite` SDK 52+ `SQLiteProvider` component so all screens can access the DB via `useSQLiteContext()`
- [x] T018 [P] Create `mobile/src/utils/uuid.ts` exporting a `generateUUID()` function using `expo-crypto` or `uuid` v4 for RFC-4122 UUIDs
- [x] T019 [P] Create `mobile/src/utils/idempotency.ts` exporting `computeIdempotencyKey(parts: string[]): string` using SHA-256 (via `expo-crypto`) for outbox deduplication keys
- [x] T020 [P] Implement `infra/lambda/sync-engine/src/db.ts` with a singleton `pg.Pool` connection pool (reads `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` from environment) with graceful shutdown
- [x] T021 [P] Copy RDS PostgreSQL DDL from `specs/001-offline-facial-recognition/contracts/rds-schema.sql` into `infra/lambda/sync-engine/migrations/001_initial.sql` and create a `migrate.ts` script to apply it against the target RDS instance

**Checkpoint**: Foundation ready — all domain types, schema, and utilities in place. User story phases can now begin.

---

## Phase 3: User Story 1 — Register Personnel Profile (Priority: P1) 🎯 MVP

**Goal**: Operator can add, edit, and delete personnel records with facial photos entirely offline. Delivers a working on-device personnel registry.

**Independent Test**: Add a new personnel record (name, employee ID, role) with a captured photo → confirm record appears in personnel list → edit the name → confirm edit persists → delete the record → confirm it is removed. All steps work with Airplane Mode on.

### Implementation for User Story 1

- [x] T022 [P] [US1] Implement `PersonnelRepository` in `mobile/src/db/repositories/PersonnelRepository.ts` with methods: `create(p: Omit<Personnel, 'id'>): Promise<Personnel>`, `update(id, fields): Promise<void>`, `delete(id): Promise<void>`, `findAll(): Promise<Personnel[]>`, `findById(id): Promise<Personnel | null>` using `useSQLiteContext()`
- [x] T023 [P] [US1] Implement `FaceImageRepository` in `mobile/src/db/repositories/FaceImageRepository.ts` with methods: `create(fi: Omit<FaceImage, 'id'>): Promise<FaceImage>`, `findByPersonnelId(personnelId): Promise<FaceImage[]>`, `update(id, fields): Promise<void>`, `deleteByPersonnelId(personnelId): Promise<void>`
- [x] T024 [US1] Implement `ImageStorageService` in `mobile/src/services/ImageStorageService.ts` using `expo-file-system` to save captured camera frames to `FileSystem.documentDirectory + IMAGE_STORAGE_DIR`, return the absolute `image_path`, and delete images by path; check available storage and throw a typed error if insufficient
- [x] T025 [US1] Implement `EmbeddingModel` **stub** in `mobile/src/ml/EmbeddingModel.ts` exposing `extractEmbedding(imagePath: string): Promise<Float32Array>` — returns a zeroed 128-float array (dev placeholder). **Superseded by T099**, which loads the real MobileFaceNet INT8 model (`mobile/assets/models/MobileFaceNet_new_latest_int8.tflite`) via `react-native-fast-tflite`.
- [x] T026 [US1] Implement `PersonnelListScreen` in `mobile/src/screens/PersonnelListScreen.tsx` using React Native Paper `FlatList` showing each personnel record's `fullName`, `employeeId`, and `role`; include a FAB for adding new records; navigate to `PersonnelDetailScreen` on row press
- [x] T027 [US1] Implement `PersonnelDetailScreen` in `mobile/src/screens/PersonnelDetailScreen.tsx` with React Native Paper `TextInput` fields for `fullName`, `employeeId`, `role`; support both create mode (no `personnelId` param) and edit mode (pre-populated from `PersonnelRepository.findById`)
- [x] T028 [US1] Integrate `react-native-vision-camera` v5 photo capture into `PersonnelDetailScreen.tsx`: add a camera preview component, a "Capture Photo" button that takes a snapshot, passes the image path through `ImageStorageService.save` → `EmbeddingModel.extractEmbedding` → `FaceImageRepository.create`, and displays a thumbnail of the captured image
- [x] T029 [US1] Implement save action in `PersonnelDetailScreen.tsx`: validate that `fullName`, `employeeId`, and `role` are non-empty, call `PersonnelRepository.create` (or `update`), enqueue to `sync_outbox` via `SyncOutboxRepository.enqueue` (created in T047 — use a stub that no-ops until T047 is done), then navigate back to `PersonnelListScreen`
- [x] T030 [US1] Implement delete action in `PersonnelDetailScreen.tsx`: show a React Native Paper `Dialog` confirmation, then call `PersonnelRepository.delete` (cascades to `face_image` via SQLite FK), delete files via `ImageStorageService.deleteByPersonnelId`, and navigate back
- [x] T031 [US1] Create `mobile/src/navigation/AppNavigator.tsx` using React Navigation v6 stack navigator with initial route `PersonnelList`, route `PersonnelDetail`, and placeholder routes for `Verification` and `BackupStatus` (added in later phases)

**Checkpoint**: US1 complete — personnel CRUD with photo capture works fully offline. Verify: create → list → edit → delete with Airplane Mode on.

---

## Phase 4: User Story 2 — Verify Personnel On-Site (Priority: P1)

**Goal**: Camera-based on-device liveness detection and facial matching against enrolled profiles with a clear authorization result, all offline.

**Independent Test**: With at least one enrolled personnel record, open the verification screen → camera activates → present the enrolled person's face → system returns "Authorized" with the person's name. Then present an unknown face → "Unauthorized". Present a printed photo → "Liveness Check Failed". All with Airplane Mode on.

### Implementation for User Story 2

- [x] T032 [P] [US2] **Frame-processor setup + FaceDetector.** ⚠️ **CORRECTION:** the installed `react-native-vision-camera@5.0.11` is the **Nitro** rewrite — there is **no `react-native-worklets` / `react-native-vision-camera-worklets` and no babel worklets plugin** in this stack (verified: v5.0.11 + `react-native-fast-tflite@3` peer-depend on `react-native-nitro-modules@0.35.9` + `react-native-nitro-image@0.15.0`; there is no `useFrameProcessor`). The runtime is wired the Nitro way instead. ✅ **Native runtime setup done (JS-verifiable parts):** installed `react-native-nitro-modules@0.35.9` + `react-native-nitro-image@0.15.0` as direct deps (required for autolinking); `tflite` already an `assetExts` in metro.config.js (T098); boxed-model loader `mobile/src/ml/tfliteRuntime.ts` (`loadBoxedModel` → `loadTensorflowModel()` + `NitroModules.box()`), unit-tested (`__tests__/unit/ml/tfliteRuntime.test.ts`, 3 tests; native modules mocked in jest.setup.js); per-stage asset wiring `mobile/src/ml/modelAssets.ts` (BlazeFace/landmarks/antispoof/MobileFaceNet `require()`s → boxed loaders) + `tflite-assets.d.ts`. JS-side `FaceDetector` implemented + unit-tested (`mobile/src/ml/FaceDetector.ts`: `computeQualityScore`/`selectBestDetection`/`parseDetection`/`detectFace`; `__tests__/unit/ml/FaceDetector.test.ts`, 8 tests). ✅ **Native rebuild DONE & verified (2026-05-29):** `./gradlew :app:assembleDebug` BUILD SUCCESSFUL with the new Nitro modules autolinked (CMake compiled `libNitroModules.so`/`libNitroImage.so`/`libNitroTflite.so`/`libVisionCamera.so` for all ABIs); installed on `emulator-5554` — SoLoader loads `libNitroTflite.so`/`libworklets.so`/`libVisionCameraWorklets.so` and `Nitro.HybridObjectRegistry` registers `TfliteModule` + `WorkletQueueFactory` with no FATAL/UnsatisfiedLink/dlopen errors. ✅ **Frame-output worklet smoke test VERIFIED on device (2026-05-29):** the correction above was half-wrong — VisionCamera 5 core is Nitro, but `useFrameOutput`'s `onFrame` IS a worklet, so it needs `react-native-worklets` (pinned to Expo SDK 55's blessed **0.7.4**) + `react-native-vision-camera-worklets@5.0.11` + the `react-native-worklets/plugin` babel plugin (now added; jest stays green). `src/ml/frameProcessor.ts` `useFrameDimsSmokeTest` is wired into `VerificationScreen`; on device the `CameraFrameOutput` HybridObject is created and the onFrame worklet streams `[frameProcessor] frame 1280x720` at ~30fps. Plus real **BlazeFace decode** (`generateBlazeFaceAnchors`/`decodeBlazeFace`/`runFaceDetection`) + per-model **preprocessing** (`src/ml/preprocessing.ts`) + FaceMesh→EAR **eye extraction** (`LivenessDetector.extractEyeLandmarks`), all transcribed from `scripts/test_*.py` and unit-tested. ✅ **Real BlazeFace inference wired into the worklet:** `frameProcessor.ts useFaceDetectionFrameOutput` does `frame.getPixelBuffer()` → inline nearest-neighbour resize+normalise (mirrors unit-tested `resizeRgbNearestNeighbor`/`preprocessBlazeFace`) → boxed `model.unbox().runSync()` on the frame thread → `runOnJS` → `decodeBlazeFace`/`parseDetection` (tested) on JS. `VerificationScreen` loads the model via `loadFaceDetectorModel()` (CPU/XNNPACK delegate — `android-gpu` hangs on emulators) and feeds the worklet. ✅ **End-to-end pipeline VERIFIED on emulator-5554:** the worklet logs `[frameProcessor] inference ok: 896 anchors, 0 candidate(s)` per frame — i.e. camera frame → worklet (`getPixelBuffer` → resize → normalise → boxed `model.unbox().runSync()`) → `runOnJS` → `decodeBlazeFace`/`parseDetection` on JS, running correctly. (896 anchors = real BlazeFace output decoded; 0 candidates is correct — the emulator scene has no face. Needed a fix: native runSync output ArrayBuffers don't survive the worklet→JS handoff, so they're copied to plain arrays in the worklet first.) A **real face / real device** is all that's left to see a non-zero detection. Full multi-ABI build also needs more build-host disk (x86_64 CMake hit a disk-full ninja kill; arm64-only build is green).
- [x] T033 [P] [US2] Implement `LivenessDetector` in `mobile/src/ml/LivenessDetector.ts` with two layers: (1) **active** — blink/head-turn via eye-aspect-ratio tracked across `LIVENESS_BLINK_FRAMES` consecutive frames using the MiniFASNet/landmarks f16 model (`face_landmarks_detector_float16.tflite`, `MODEL_LIVENESS_LANDMARKS`); (2) **passive** — run the Antispoof INT8 texture classifier (`antispoof_128x128_int8.tflite`, `MODEL_LIVENESS_ANTISPOOF`) on the 128×128 face ROI to detect printed-photo/screen-replay spoofs; expose `check(frames: Frame[]): 'live' | 'spoof' | 'inconclusive'`. Runs in the same VisionCamera v5 frame-processor/worklet context wired in T032 (shares `react-native-worklets` + boxed-model setup); the active layer accumulates eye-aspect-ratio across the live frame stream — this is the multi-frame requirement that drove choosing frame processors over still-capture. ✅ Done (TDD: T089 red→green) — pure dual-layer fusion: `eyeAspectRatio` + `detectBlink` (active) + `fuseLiveness`/`check` over the antispoof gate (passive). Model runners injected as deps (`runLandmarks`/`runAntispoof`) so the boxed-TFLite calls are the only native piece; that native invocation rides on the T032 frame-processor wiring (pending device build). New named constants `LIVENESS_EAR_CLOSED_THRESHOLD`, `LIVENESS_ANTISPOOF_REAL_THRESHOLD`. ✅ **Native PASSIVE layer wired + device-verified (2026-05-30):** chose the passive Antispoof INT8 layer first — it's the least-compute model (~30 ms) of the three remaining stages AND the most TOCTOU-safe (single-shot → runs in the SAME worklet pass / same pixel buffer as detection, so liveness can't be sourced from a different frame than the match; a "check liveness then wait for a new frame to match" split would be the spoofing flaw). `frameProcessor.ts useVerificationFrameOutput(models, sampleLiveness, onSample)`: detection every frame (cheap, overlay) + Antispoof on the same frame's ROI **only during the capture window** (`phase==='capturing'`, gated to keep idle cost ~detection). Single-best-anchor decode + 1.5× square ROI crop + ImageNet-normalise + softmax inlined in the worklet (mirror unit-tested helpers). `VerificationScreen` collects the window's real-probs → `LivenessDetector.passiveLiveness` (new pure fn, +4 unit tests) → `VerificationEvidence`. Release APK runs on emulator-5554 with no crash (TFLite runtime inits, worklet streams `[frameProcessor] verify: face=none real=n/a` — faceless scene). **Gotcha fixed:** an early-return `frame.dispose()` *inside* the try plus `finally { frame.dispose() }` double-disposed the Nitro Frame HybridObject → SIGSEGV in `HybridObject::disposeRaw` on every faceless frame; let `finally` own the single dispose. ✅ **ACTIVE blink layer now wired too (2026-05-30) — dual-layer complete, same-frame, sub-second.** Per stakeholder: active liveness is a hard requirement and the budget is 1 s (SC-002 corrected 5 s → 1 s, aligning with README "sub-second"). Both layers run in the SAME worklet pass during a ~1 s capture window (`LIVENESS_CAPTURE_WINDOW_MS=1000`) on the same pixel buffer: FaceMesh f16 on a 1.3× eye↔mouth crop → inline EAR (mirrors `eyeAspectRatio`/`EAR_*_EYE_INDICES`); Antispoof on a 1.5× box crop → real-prob; FaceMesh's 478×3 landmark tensor disambiguated as the largest output (test_facemesh_f16.py). The window's per-frame `{facePresent, ear, realProb}` samples reduce via new pure `LivenessDetector.reduceCapture` (+6 unit tests): **continuous-presence gate** (face tracked ≥ `LIVENESS_MIN_PRESENCE_RATIO=0.6` of frames — a mid-window photo-swap/pull-away drops below it → inconclusive) → `detectBlink` (active) + mean antispoof (passive) → `fuseLiveness`. TOCTOU-closed: blink + texture + (future) match all from one continuous tracked presentation. Release APK device-verified on emulator-5554 (no crash, worklet streams `verify: face=none ear=n/a real=n/a`, phase-change worklet recreation clean); FaceMesh/antispoof inference + real blink/spoof verdict pending a physical face. Embedding still zeroed stub (T099) → live enrolled face still reads Unauthorized until T099 (which must join the same worklet pass).
- [x] T034 [US2] Implement `FaceMatcher` in `mobile/src/ml/FaceMatcher.ts` with method `matchBest(queryEmbedding: Float32Array, candidates: FaceImage[]): { personnelId: string; score: number } | null` using cosine similarity; return the best match if score ≥ `FACE_MATCH_THRESHOLD`, otherwise `null`. ✅ Done (TDD: T088 red→green). Also exposes `cosineSimilarity` + `scoreBest` (raw top score, for the low-confidence band).
- [x] T035 [US2] Implement `VerificationRepository` in `mobile/src/db/repositories/VerificationRepository.ts` with `create(vr: Omit<VerificationRecord, 'id'>): Promise<VerificationRecord>`, `findAll(): Promise<VerificationRecord[]>`, `findByPersonnelId(id): Promise<VerificationRecord[]>`. ✅ Done (TDD: T091 red→green; real node:sqlite).
- [x] T036 [US2] Implement `VerificationService` in `mobile/src/services/VerificationService.ts` orchestrating: (1) load all `FaceImage` embeddings from DB, (2) start `FaceDetector` frame stream, (3) run `LivenessDetector` — abort with `liveness_failed` on spoof, (4) extract embedding via `EmbeddingModel`, (5) run `FaceMatcher` — map result to outcome enum, (6) save `VerificationRecord` via `VerificationRepository`, (7) enqueue to `sync_outbox` stub. ✅ Done — pure `decideOutcome` (5-outcome mapping) + `evaluateVerification` (load gallery → decide → persist → enqueue) + `useVerificationService` hook (TDD: T090 red→green). **Live frame-stream capture (steps 2–4) is delegated to `VerificationScreen` (T037) + the frame-processor pipeline (T032/T033); the service consumes the captured `VerificationEvidence`.** Outbox enqueue is omitted until T045.
- [x] T037 [US2] Implement `VerificationScreen` in `mobile/src/screens/VerificationScreen.tsx` using `react-native-vision-camera` Camera component: show live preview, a "Start Verification" button, and overlay guidance text ("Position face in frame", "Please blink"). ✅ Done — `mobile/src/screens/VerificationScreen.tsx` (front `useCameraDevice`, live `Camera` preview, Start button, guidance overlay, capturing spinner). Frame-stream capture is injected as `captureEvidence` (default no-op until the T032 native frame processor lands) → feeds `useVerificationService().verify` → renders `VerificationResultOverlay`. Component tests in `__tests__/unit/screens/VerificationScreen.test.tsx` (5 tests).
- [x] T038 [US2] Add result overlay to `VerificationScreen.tsx`: display a full-screen card with outcome label and colour coding — Authorized (green, personnel name + role), Unauthorized (red), Liveness Check Failed (amber), Low Confidence — Secondary Check Required (orange), Image Quality Insufficient — Reposition Camera (grey). ✅ Done — extracted as `mobile/src/components/VerificationResultOverlay.tsx` (`outcomePresentation` maps all 5 FR-009 outcomes → label + colour + icon; result conveyed by text+icon, not colour alone, per Constitution IV); Authorized surfaces matched name + role + confidence. Tested in `__tests__/unit/components/VerificationResultOverlay.test.tsx` (7 tests).
- [x] T039 [US2] Handle camera permission denied in `VerificationScreen.tsx`: check `Camera.getCameraPermissionStatus()` on mount; if denied, show a React Native Paper `Banner` with a "Grant Permission" deep-link button instead of the camera view. ✅ Done — `useCameraPermission()` gate renders a Paper `Banner` ("Grant Permission" → `requestPermission`, "Open Settings" → `Linking.openSettings()`) instead of the camera when `!hasPermission`; plus a "no front camera" fallback. Covered by VerificationScreen tests.
- [x] T040 [US2] Add `VerificationScreen` route to `AppNavigator.tsx` and add a "Verify" button to `PersonnelListScreen.tsx` header to navigate to it. ✅ Done — `AppNavigator` now mounts `VerificationScreen` on the `Verification` route (replacing the placeholder); `PersonnelListScreen` installs a `face-recognition` `Appbar.Action` via `navigation.setOptions({ headerRight })` that navigates to `Verification`. New test in `PersonnelListScreen.test.tsx` asserts the header action navigates.
- [x] T041 [P] [US2] Add image quality gate in `VerificationService.ts`: if `FaceDetector.detectFace` returns `qualityScore < 0.4` or `boundingBox` area below minimum threshold, return outcome `quality_insufficient` without running liveness or matching. ✅ Done — implemented as the first branch of `decideOutcome` (gates on `FACE_MIN_QUALITY_SCORE`, short-circuits before liveness/matching; covered by T090).

**Checkpoint**: US2 complete — verification pipeline works end-to-end offline. Verify all five outcome paths with Airplane Mode on.

---

## Phase 5: User Story 3 — Cloud Synchronisation (Priority: P2)

**Goal**: When connectivity is restored, all pending personnel, face image metadata, and verification records automatically upload to the cloud (API Gateway → SQS → Lambda → RDS + S3) with no duplicates and partial-sync resilience.

**Independent Test**: Perform 3+ verifications and 1 personnel registration offline. Enable Wi-Fi → confirm all records appear in RDS PostgreSQL and images in S3 within 3 minutes. Disable Wi-Fi mid-sync → re-enable → confirm remaining records sync without duplicates.

### Mobile Sync Client (T042–T052)

- [x] T042 [US3] Implement `SyncOutboxRepository` in `mobile/src/db/repositories/SyncOutboxRepository.ts`: `enqueue(type, recordId, payload): Promise<void>` (computes idempotency key via `computeIdempotencyKey`), `dequeuePending(limit: number): Promise<SyncOutboxEntry[]>`, `markDispatched(id): Promise<void>`, `markAcknowledged(id): Promise<void>`, `markFailed(id, error): Promise<void>`, `countPending(): Promise<number>`
- [x] T043 [P] [US3] Update `PersonnelRepository.create` and `PersonnelRepository.update` in `mobile/src/db/repositories/PersonnelRepository.ts` to call `SyncOutboxRepository.enqueue('personnel', id, payload)` within the same SQLite transaction (atomicity: local write + outbox enqueue)
- [x] T044 [P] [US3] Update `FaceImageRepository.create` in `mobile/src/db/repositories/FaceImageRepository.ts` to call `SyncOutboxRepository.enqueue('face_image', id, payload)` within the same transaction
- [x] T045 [P] [US3] Update `VerificationRepository.create` in `mobile/src/db/repositories/VerificationRepository.ts` to call `SyncOutboxRepository.enqueue('verification_record', id, payload)` within the same transaction
- [x] T046 [P] [US3] Implement `AuthService` in `mobile/src/services/AuthService.ts` using `@aws-sdk/credential-providers` `fromCognitoIdentityPool({ identityPoolId: AWS_COGNITO_IDENTITY_POOL_ID, clientConfig: { region } })` (guest / unauthenticated identity — no app login) to obtain temporary IAM credentials; expose `getCredentials(): Promise<AwsCredentialIdentity>` with in-memory caching and expiry refresh. ⚠️ **CORRECTION:** `@aws-sdk/credential-providers` is not in `mobile/package.json`. Implemented via **direct Cognito Identity REST API calls** (`GetId` → `GetCredentialsForIdentity` HTTP endpoints) using plain `fetch` — no AWS SDK on device. Same `AwsCredentialIdentity` return shape, in-memory 5-min expiry cache, concurrent-request deduplication, and `refresh()` for post-403 forced refresh. ✅ Done.
- [x] T047 [US3] Implement S3 image upload step in `mobile/src/services/SyncService.ts`: call `PUT /sync/images/presign` with pending face image IDs → receive pre-signed URLs → `PUT` each image file to S3 → store returned `s3Key` in `face_image.s3_key` via `FaceImageRepository.update` before submitting the batch
- [x] T048 [US3] Implement `POST /sync/batch` API call in `mobile/src/services/SyncService.ts`: batch up to `SYNC_BATCH_MAX_PERSONNEL` personnel, `SYNC_BATCH_MAX_VERIFICATIONS` verification records, and face image metadata from the outbox; include `batchId` (UUID), `deviceId`, `sentAt`; sign the request with SigV4 using `aws-sigv4-fetch` (a thin signed-`fetch` wrapper over the AWS SDK v3 signers; alternatively `@aws-sdk/signature-v4` + `@aws-crypto/sha256-js`) with credentials from `AuthService`
- [x] T049 [US3] Implement outbox dispatch loop in `mobile/src/services/SyncService.ts`: scan `sync_outbox` for pending entries → group into a batch → call presign + batch API → on 200 OK mark outbox entries acknowledged and source records `synced` → on failure mark `failed` with error message; implement exponential backoff with `SYNC_RETRY_MAX_ATTEMPTS` and `SYNC_RETRY_BACKOFF_MS`
- [x] T050 [US3] Wire connectivity-triggered sync in `mobile/src/services/SyncService.ts` using `@react-native-community/netinfo` `addEventListener`: on `isConnected: true` event call the outbox dispatch loop; also trigger on app foreground via `AppState.addEventListener('change')`
- [x] T051 [P] [US3] Handle 409 DUPLICATE_BATCH response in `SyncService.ts`: treat as success, mark outbox entries acknowledged (idempotent replay safe)
- [x] T052 [P] [US3] Handle 400 VALIDATION_ERROR response in `SyncService.ts`: parse `details` array, mark the offending records as `failed` with `syncError` set to the first relevant detail message, and continue dispatching the remaining batch entries

### Lambda Sync Engine (T053–T058)

- [x] T053 [P] [US3] Implement the **two Lambda entry points** in `infra/lambda/sync-engine/src/handler.ts` (single Lambda, two triggers per `contracts/sync-api.md`): (a) **HTTP handler** for `POST /sync/batch` — validate the batch, `SendMessage` to the SQS FIFO queue (`@aws-sdk/client-sqs`, `MessageGroupId=deviceId`, `MessageDeduplicationId=batchId`), return `200` with `queueMessageId`; and for `PUT /sync/images/presign` — return S3 pre-signed PUT URLs (`@aws-sdk/s3-request-presigner`, add when implementing); (b) **SQS event handler** — receive SQS record batch (size 1), parse message body, route to the processor chain, handle errors → throw to return the message to the queue (up to 3 retries before DLQ)
- [x] T054 [P] [US3] Implement `PersonnelProcessor` in `infra/lambda/sync-engine/src/processors/PersonnelProcessor.ts`: upsert each personnel record with `ON CONFLICT (employee_id) DO UPDATE SET ... WHERE EXCLUDED.updated_at > personnel.updated_at` using the `pg.Pool` from `db.ts`
- [x] T055 [P] [US3] Implement `VerificationProcessor` in `infra/lambda/sync-engine/src/processors/VerificationProcessor.ts`: idempotent insert `ON CONFLICT (id, device_id) DO NOTHING`
- [x] T056 [P] [US3] Implement `FaceImageProcessor` in `infra/lambda/sync-engine/src/processors/FaceImageProcessor.ts`: idempotent insert `ON CONFLICT (id) DO NOTHING`; verify that the referenced `s3Key` is accessible (optional HEAD check)
- [x] T057 [US3] Compose processor chain in `handler.ts`: wrap `PersonnelProcessor`, `VerificationProcessor`, and `FaceImageProcessor` calls in a single `pg` transaction; on success call `WebhookNotifier` if `WEBHOOK_URL` env var is set
- [x] T058 [P] [US3] Implement `WebhookNotifier` in `infra/lambda/sync-engine/src/processors/WebhookNotifier.ts`: POST `sync.batch.completed` event payload to `process.env.WEBHOOK_URL` (FR-017 optional webhook); no-op if env var absent

### Terraform Infrastructure (T059–T064)

- [x] T059 [P] [US3] Create Terraform `core-infra` module in `infra/terraform/modules/core-infra/`: VPC with public + private subnets, Cognito Identity Pool with **unauthenticated (guest) identities enabled** (no in-app login, per spec) mapped to a least-privilege IAM role granting only `execute-api:Invoke` on the two `/sync` routes and `s3:PutObject` to the face-images bucket's `images/` prefix (document Play Integrity / App Attest or developer-authenticated identities as the production hardening path)
- [x] T060 [P] [US3] Create Terraform `serverless` module in `infra/terraform/modules/serverless/`: HTTP API Gateway v2 with routes `POST /sync/batch` and `PUT /sync/images/presign` integrated to the Lambda (Node.js 20, 512 MB, 300 s timeout) as the **HTTP entry point** (validate + enqueue to SQS / return presigned URLs), an SQS FIFO queue `nhai-sync-queue.fifo` with the **same Lambda** attached as an event-source-mapping consumer (batch size 1), and DLQ `nhai-sync-dlq.fifo` (max receive count 3). Grant the Lambda IAM `sqs:SendMessage` (HTTP path) and the queue's consume permissions
- [x] T061 [P] [US3] Create Terraform `database` module in `infra/terraform/modules/database/`: RDS PostgreSQL 15 `db.t3.micro` in private subnet, security group permitting Lambda SG inbound on port 5432, AWS Secrets Manager secret for DB password
- [x] T062 [P] [US3] Add S3 bucket resource `nhai-face-images-${var.account_id}` to `serverless` module in `infra/terraform/modules/serverless/main.tf` with versioning enabled and block-public-access policy; add Lambda IAM permission to `s3:GetObject` and `s3:PutObject`
- [x] T063 [US3] Complete root `infra/terraform/main.tf`: wire `core-infra`, `serverless`, and `database` modules; configure S3 remote state backend (`bucket`, `key`, `region`, `dynamodb_table`); output `api_gateway_url` for `mobile/.env.local`
- [x] T064 [P] [US3] Create `infra/terraform/terraform.tfvars.example` with all required variable placeholders: `aws_region`, `account_id`, `db_password`, `webhook_url` (optional)

**Checkpoint**: US3 complete — full sync cycle works. Verify: offline operations → enable network → records appear in RDS and S3 within 3 min.

---

## Phase 6: User Story 4 — Backup Management (Priority: P2)

**Goal**: Operator has full visibility into sync status and manual control (retry, cancel) over backup operations with push notifications on completion or failure.

**Independent Test**: Simulate a failed backup (kill network mid-sync) → open BackupStatusScreen → see failure reason and record count → tap "Retry" → confirm backup succeeds → notification appears. Cancel an in-progress backup → confirm pending records remain on device. (US3 `SyncService` may be stubbed/mocked so US4 can be developed and tested in isolation.)

### Implementation for User Story 4

- [x] T065 [P] [US4] Implement `BackupJobRepository` in `mobile/src/db/repositories/BackupJobRepository.ts`: `create(job: Omit<BackupJob, 'id'>): Promise<BackupJob>`, `updateStatus(id, fields: Partial<BackupJob>): Promise<void>`, `findLatest(): Promise<BackupJob | null>`, `findAll(limit: number): Promise<BackupJob[]>`
- [x] T066 [US4] Implement `BackupStatusService` in `mobile/src/services/BackupStatusService.ts`: `startJob(): Promise<string>` (creates backup_job with status `in_progress`), `completeJob(id, summary)`, `failJob(id, errorMessage)`, `cancelJob(id)`; expose `getStatus(): Promise<{ lastSyncTime, pendingCount, latestJob }>`
- [x] T067 [US4] Integrate `BackupStatusService` with `SyncService.ts`: call `startJob()` before outbox dispatch, `completeJob()` on full success, `failJob()` on unrecoverable error, `cancelJob()` when operator cancels
- [x] T068 [US4] Implement `BackupStatusScreen` in `mobile/src/screens/BackupStatusScreen.tsx` using React Native Paper: display last successful sync time, pending record count (from `SyncOutboxRepository.countPending()`), current backup status, error message (if any), a "Retry" button (visible when status is `failed`), and a "Cancel" button (visible when status is `in_progress`)
- [x] T069 [US4] Wire "Retry" button in `BackupStatusScreen.tsx` to call `SyncService.triggerSync()` which resets `failed` outbox entries back to `pending` status and re-runs the outbox dispatch loop
- [x] T070 [US4] Wire "Cancel" button in `BackupStatusScreen.tsx`: set a cancellation flag on `SyncService` that the dispatch loop checks between batches; call `BackupStatusService.cancelJob()` when acknowledged
- [x] T071 [US4] Add `BackupStatusScreen` route to `AppNavigator.tsx` and add a "Backup Status" icon button to the `PersonnelListScreen.tsx` header right area
- [x] T072 [P] [US4] Implement push notification for backup events in `mobile/src/services/BackupStatusService.ts` using `expo-notifications`: request permission on first sync; send a local notification on `completeJob` ("Sync complete: N records uploaded") and `failJob` ("Sync failed: {errorMessage}")

**Checkpoint**: US4 complete — backup management panel with retry, cancel, and notifications works. All four user stories independently functional.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Security hardening, edge-case handling, and production readiness improvements that span multiple stories.

- [ ] T073 [P] Implement AES-256 field-level encryption at rest over **all PII** (FR-022) via a device-bound key held in `expo-secure-store`: create `mobile/src/services/CryptoService.ts` (encrypt/decrypt using `expo-crypto`), then encrypt-before-write / decrypt-after-read for `full_name`, `employee_id`, and the `embedding` BLOB in `PersonnelRepository.ts` and `FaceImageRepository.ts`, and encrypt the saved face image files in `ImageStorageService.ts`. (SQLCipher full-DB encryption noted as future upgrade — `expo-sqlite` does not bundle it.)
- [ ] T074 Handle device storage full edge case in `ImageStorageService.ts`: call `FileSystem.getFreeDiskStorageAsync()` before saving; if available bytes < 2× image size, throw a typed `StorageFullError` and surface a React Native Paper Snackbar in `PersonnelDetailScreen.tsx`
- [ ] T075 Add camera permission handling in `PersonnelDetailScreen.tsx`: check `Camera.getCameraPermissionStatus()` on mount; if not granted, request permission; if permanently denied, show a "Go to Settings" button
- [ ] T076 Handle RDS schema-rejected records in `SyncService.ts`: on `400 VALIDATION_ERROR` response, log the full `details` array to console, mark each affected `sync_outbox` entry as `failed` with the field-level message, and do not block healthy records in the same batch from being retried
- [ ] T077 Guard personnel delete during active sync in `PersonnelRepository.delete`: if the personnel record's `sync_status` is not `synced` or a `sync_outbox` entry for that record is `in_progress`, enqueue the delete as a tombstone entry rather than immediately removing the row; add a `tombstoned` column to the `personnel` SQLite table and filter it from `PersonnelListScreen`
- [ ] T078 [P] Add React Native Paper theme configuration in `mobile/src/components/theme.ts`: define primary, secondary, and error colours; wrap `App.tsx` root with `PaperProvider theme={theme}`; apply `200 ms` activity indicator delay rule across all async operations (show loading state only after 200 ms to avoid flicker)
- [ ] T079 [P] Add `infra/docker-compose.yml` with a LocalStack service (image `localstack/localstack`) exposing SQS, S3 on `localhost:4566`, and document local Lambda integration test setup in `quickstart.md`
- [ ] T080 Run full golden-path validation against `quickstart.md`: `pnpm install` → `pnpm android` → register a personnel record with photo → verify (authorized result) → verify with unknown face (unauthorized) → enable network → confirm sync in RDS → open BackupStatusScreen → confirm last sync time updated

---

## Phase 8: Test Coverage & TDD Compliance (Constitution II/III)

**Purpose**: Restore and enforce test-first discipline. Backfill tests for already-shipped Phases 1–3; author write-first failing tests for all remaining implementation tasks.

### Backfill — Phases 1–3 (already implemented; MUST become green before Phase 4+ continues)

- [x] T081 [P] Create shared test helpers in `mobile/__tests__/helpers/`: real `expo-sqlite` test-DB factory (fresh in-memory DB per test, runs migrations) and fixture builders for `Personnel`, `FaceImage`, `VerificationRecord`
- [x] T082 [P] Backfill unit tests for `mobile/src/utils/uuid.ts` + `idempotency.ts` (RFC-4122 shape; deterministic SHA-256 keys) in `__tests__/unit/utils/`
- [x] T083 [P] Backfill integration tests for `PersonnelRepository` (create/update/delete/findAll/findById + FK cascade to face_image) against real SQLite in `__tests__/integration/`
- [x] T084 [P] Backfill integration tests for `FaceImageRepository` (embedding `Float32Array`↔BLOB round-trip, `deleteByPersonnelId`)
- [x] T085 [P] Backfill integration tests for `migrations.ts` + `schema.ts` (idempotent re-run; all 5 tables, indexes, FK + CHECK constraints present)
- [x] T086 [P] Backfill component tests (React Native Testing Library) for `PersonnelListScreen` (rows, empty state, FAB navigation) and `PersonnelDetailScreen` (create vs edit mode, required-field validation)
- [x] T087 [P] Backfill unit tests for `ImageStorageService` (save returns path, `deleteByPersonnelId`, throws `StorageFullError` when free space < 2× image size)

### Write-FIRST — Phases 4–6 (each MUST be authored and failing before its referenced implementation task)

- [x] T088 [US2] Failing unit tests for `FaceMatcher` (cosine similarity correctness; accept ≥ `FACE_MATCH_THRESHOLD`; low-confidence band ≥ `FACE_LOW_CONFIDENCE_THRESHOLD`; `null` on no-match) — precedes T034. ✅ `__tests__/unit/ml/FaceMatcher.test.ts` (14 tests).
- [x] T089 [US2] Failing unit tests for `LivenessDetector` (blink across `LIVENESS_BLINK_FRAMES`; spoof/live/inconclusive from mocked model outputs) — precedes T033. ✅ `__tests__/unit/ml/LivenessDetector.test.ts` (15 tests: EAR, blink detection, fusion, full-stream check) — authored red (module missing) → green.
- [x] T090 [US2] Failing unit tests for `VerificationService` outcome mapping — all five FR-009 outcomes incl. `quality_insufficient` gate — precedes T036. ✅ `__tests__/unit/services/VerificationService.test.ts` (11 tests: 5 outcomes, gate precedence, persistence + enqueue).
- [x] T091 [US2] Failing integration tests for `VerificationRepository` — precedes T035. ✅ `__tests__/integration/VerificationRepository.test.ts` (7 tests: create/findAll/findByPersonnelId, ordering, CHECK constraint, ON DELETE SET NULL).
- [x] T092 [US3] Failing unit tests for `SyncOutboxRepository` (enqueue/dequeue ordering, idempotency key, status transitions) — precedes T042
- [x] T093 [US3] Failing **contract tests** for `contracts/sync-api.md` (`POST /sync/batch`, `PUT /sync/images/presign` request/response + 409/400 error bodies) in `mobile/__tests__/contract/`; MUST run before integration/E2E (Constitution III) — precedes T048
- [x] T094 [P] [US3] Failing unit tests for Lambda processors (Personnel newest-wins upsert; Verification/FaceImage idempotent insert) in `infra/lambda/sync-engine/__tests__/` — precedes T054–T056
- [x] T095 [US3] Failing integration test for the outbox dispatch loop (mocked NetInfo + real SQLite outbox; retry/backoff; 409 duplicate handling) — precedes T049
- [x] T096 [US4] Failing unit tests for `BackupStatusService` (start/complete/fail/cancel; `getStatus` aggregation) — precedes T066
- [x] T097 [US4] Failing component tests for `BackupStatusScreen` (Retry visible only when `failed`; Cancel only when `in_progress`) — precedes T068

**Checkpoint**: Coverage gates green (≥ 80 % line / ≥ 70 % branch); contract tests pass.

---

## Phase 9: Real Model Integration (replaces ML stubs) — closes SC-003 / SC-004

**Goal**: Swap the dev stubs for the real four-stage TFLite pipeline so liveness (SC-003 ≥ 95 %) and matching (SC-004 ≥ 90 %) become measurable.

- [x] T098 [P] [US1] Bundle the four production TFLite models into `mobile/assets/models/` (`blaze_face_short_range_float16.tflite`, `MobileFaceNet_new_latest_int8.tflite`, `face_landmarks_detector_float16.tflite`, `antispoof_128x128_int8.tflite`) and register `tflite` in `metro.config.js` `resolver.assetExts`. ✅ Done — models copied (~4.8 MB total) and Metro updated.
- [x] T099 [US2] Replace the `EmbeddingModel` stub (T025) with real **MobileFaceNet INT8** inference via `react-native-fast-tflite`: load `MODEL_FACE_EMBEDDING`, preprocess the aligned face ROI to model input size, run CPU/XNNPACK-first per README, output an L2-normalized 128-d `Float32Array`. Write-first unit test asserting a deterministic embedding for a fixed fixture image precedes this task. ✅ Done (2026-05-30, TDD: `EmbeddingModel.test.ts` 3 tests). The model is **true int8 I/O** (unlike antispoof's float I/O) — quant params extracted from the .tflite via ai_edge_litert and baked as constants: input `si=1/255, zi=-128` ⇒ `q = px-128`; output `zo=0`, `so=1/128` (so cancels under L2-norm). Pure `EmbeddingModel.extractEmbeddingFromRoi(rgb112, runner)` + `finalizeEmbedding(int8)` reuse `quantizeEmbeddingInput`/`dequantizeAndNormalize`. **Same-frame TOCTOU binding:** the verification worklet (`useVerificationFrameOutput`, now with an `embedder` model) runs MobileFaceNet on the tight face ROI in the SAME pass as detection+liveness and emits raw int8 [128]; `VerificationScreen` finalises the best-quality frame's embedding as the query (bound to a frame within the proven-live window). **Enrollment consistency:** `PersonnelDetailScreen` reuses the same worklet (detector+embedder only) to embed the live preview ROI at capture — identical crop+preprocess to the query, so cosine matching is valid (whole-JPEG stub embedding removed). FaceMatcher threshold `FACE_MATCH_THRESHOLD=0.65` already wired. Release APK device-verified on emulator-5554 (4 models load, worklet streams `verify: face=none … emb=n/a`, no crash); real embedding/match pending a physical face. **Unlocks the Authorized path** (was impossible with the zeroed stub).

**Checkpoint**: Verification returns real embeddings; SC-003 / SC-004 validated by T100.

---

## Phase 10: Performance, CI, Accessibility & E2E Gates (Constitution IV/V + Quality Gates)

- [ ] T100 [P] Performance benchmark harness `mobile/__tests__/perf/inference.bench.ts`: assert per-stage budget (BlazeFace ~20 ms, MobileFaceNet ~60 ms, MiniFASNet ~100 ms, Antispoof ~30 ms; ≈ 210 ms total) and end-to-end verification < 1 s (SC-002); also assert SC-003 ≥ 95 % spoof rejection and SC-004 ≥ 90 % match accuracy against a labelled fixture set; record results in `plan.md` Profiling Results
- [ ] T101 [P] Sync throughput benchmark: 500 verification records sync within 3 min over stable connectivity (SC-005); fail on > 20 % regression
- [ ] T102 Memory/CPU profiling pass on a mid-range device profile (Snapdragon 665 / 3 GB RAM): record peak memory, CPU, and per-stage timings into `plan.md` Profiling Results before demo (Constitution V)
- [ ] T103 [P] CI pipeline `.github/workflows/ci.yml`: pnpm install → lint (zero violations) → typecheck → jest with coverage gate (≥ 80 % line / ≥ 70 % branch) → contract tests → perf benchmark step (fail on > 20 % regression). Enforces all Constitution Quality Gates.
- [ ] T104 [P] Accessibility pass (WCAG 2.1 AA) across all four screens: `accessibilityLabel`/`accessibilityRole` on every interactive element, ≥ 4.5:1 text contrast in the Paper theme, ≥ 48 dp touch targets, logical screen-reader focus order, and outcome results conveyed by text+icon (not colour alone) — Constitution IV
- [ ] T105 [P] Maestro E2E flows in `mobile/.maestro/`: (a) US1 register → list → edit → delete; (b) US2 verify authorized / unauthorized / liveness-failed; run headless in CI (supersedes the manual-only golden path in T080)

**Checkpoint**: All Constitution quality gates green in CI; profiling recorded; E2E flows pass.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Requires Phase 1 complete — **BLOCKS all user stories**
- **US1 (Phase 3)**: Requires Phase 2 complete; no dependency on US2–US4
- **US2 (Phase 4)**: Requires Phase 2 complete; uses `FaceImage` embeddings written by US1 but independently testable with seed data
- **US3 (Phase 5)**: Requires Phase 2 complete; uses repositories written by US1 and US2 (stubs the sync_outbox enqueue until T042 lands)
- **US4 (Phase 6)**: Requires Phase 5 (`SyncService`) to be in place; independently testable via `BackupStatusService` alone
- **Polish (Phase 7)**: Requires all desired stories complete
- **Tests (Phase 8)**: Backfill T081–T087 MUST be green before Phase 4+ implementation continues; write-first tests T088–T097 each precede their referenced implementation task (TDD, Constitution II)
- **Model Integration (Phase 9)**: T099 follows the US2 ML scaffolding (T032–T036); T098 already done
- **Gates (Phase 10)**: Accuracy/performance benchmarks (T100–T101) require Phase 9 real models; CI (T103) runs continuously once Phase 8 lands

### User Story Dependencies

- **US1** (T022–T031): Depends only on Phase 2. No cross-story dependencies.
- **US2** (T032–T041): Depends on Phase 2 and US1 repositories (or seed data). No hard dependency on US1 being fully shipped.
- **US3** (T042–T064): Depends on Phase 2; stubs for `SyncOutboxRepository.enqueue` allow US1/US2 to land first and be back-filled by T043–T045.
- **US4** (T065–T072): Depends on US3 `SyncService` interface existing (can be stubbed for early UI work).

### Within Each User Story

- Models/repositories before services
- Services before screens
- Screens before navigation wiring
- Core implementation before edge-case handling

### Parallel Opportunities

All tasks marked `[P]` within a phase have no file conflicts and can be executed simultaneously. Key parallel groups:

- Phase 2: T011–T014 (model files), T018–T019, T020–T021
- Phase 3: T022 + T023 (repositories), T026 + T027 (screens)
- Phase 4: T032 + T033 (ML models), T054 + T055 + T056 (Lambda processors)
- Phase 5: T043 + T044 + T045 (outbox wiring), T059 + T060 + T061 + T062 (Terraform modules)

---

## Parallel Example: User Story 3 Mobile + Lambda

```
# These groups can run simultaneously (no shared files):

Group A (Mobile repositories):
  T043 — PersonnelRepository outbox wiring
  T044 — FaceImageRepository outbox wiring
  T045 — VerificationRepository outbox wiring

Group B (Lambda processors):
  T054 — PersonnelProcessor
  T055 — VerificationProcessor
  T056 — FaceImageProcessor

Group C (Terraform modules):
  T059 — core-infra
  T060 — serverless
  T061 — database
  T062 — S3 bucket
```

---

## Implementation Strategy

### MVP First (User Stories 1 + 2 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (**CRITICAL — blocks all stories**)
3. Complete Phase 3: US1 (Personnel Registration)
4. **STOP and VALIDATE**: Offline personnel CRUD with photo capture works
5. Complete Phase 4: US2 (Verification)
6. **STOP and VALIDATE**: Offline verification pipeline returns all 5 outcome types
7. Demo MVP — full offline capability proven

### Incremental Delivery

1. Setup + Foundational → shared infrastructure ready
2. US1 → Working offline personnel registry (demo-able)
3. US2 → End-to-end offline verification (demo-able)
4. US3 → Cloud sync pipeline (requires AWS account provisioned via Terraform)
5. US4 → Backup management dashboard
6. Each phase adds value without breaking previous stories

### Parallel Team Strategy (3 developers post-Foundational)

- **Dev A**: US1 (PersonnelRepository + screens)
- **Dev B**: US2 (ML pipeline + VerificationService)
- **Dev C**: US3 Terraform + Lambda skeleton (no mobile dependency needed)

---

## Task Summary

| Phase | Tasks | Count |
|-------|-------|-------|
| Phase 1: Setup | T001–T009 | 9 |
| Phase 2: Foundational | T010–T021 | 12 |
| Phase 3: US1 Register Personnel (P1) | T022–T031 | 10 |
| Phase 4: US2 Verify Personnel (P1) | T032–T041 | 10 |
| Phase 5: US3 Cloud Sync (P2) | T042–T064 | 23 |
| Phase 6: US4 Backup Management (P2) | T065–T072 | 8 |
| Phase 7: Polish | T073–T080 | 8 |
| Phase 8: Test Coverage & TDD | T081–T097 | 17 |
| Phase 9: Real Model Integration | T098–T099 | 2 |
| Phase 10: Perf / CI / A11y / E2E Gates | T100–T105 | 6 |
| **Total** | | **105** |

---

## Notes

- `[P]` tasks = operate on different files, no shared state with sibling tasks in the same phase
- `[Story]` label maps each task to a specific user story for traceability and independent delivery
- Each user story is independently completable and testable — stop at any checkpoint for a demo
- TDD workflow per `quickstart.md`: write failing test → implement → refactor → coverage check
- Commit after each task or logical group
- Constitution gates (≥80% line / ≥70% branch coverage) must stay green throughout
