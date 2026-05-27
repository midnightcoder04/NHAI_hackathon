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

- [ ] T010 Create `mobile/src/constants/index.ts` with all named constants: `FACE_MATCH_THRESHOLD = 0.75`, `LIVENESS_BLINK_FRAMES = 3`, `SYNC_BATCH_MAX_PERSONNEL = 100`, `SYNC_BATCH_MAX_VERIFICATIONS = 500`, `SYNC_RETRY_MAX_ATTEMPTS = 3`, `SYNC_RETRY_BACKOFF_MS = 5000`, `IMAGE_STORAGE_DIR = 'face_images/'`
- [ ] T011 [P] Create `mobile/src/models/Personnel.ts` with `SyncStatus` union type and `Personnel` interface per data-model.md TypeScript types
- [ ] T012 [P] Create `mobile/src/models/FaceImage.ts` with `FaceImage` interface (including `embedding: Float32Array | null`) per data-model.md
- [ ] T013 [P] Create `mobile/src/models/VerificationRecord.ts` with `VerificationOutcome` union and `VerificationRecord` interface per data-model.md
- [ ] T014 [P] Create `mobile/src/models/BackupJob.ts` with `BackupStatus` union and `BackupJob` interface per data-model.md
- [ ] T015 Implement all five SQLite DDL strings in `mobile/src/db/schema.ts` (personnel, face_image, verification_record, backup_job, sync_outbox tables with indexes) exactly matching data-model.md On-Device Schema
- [ ] T016 Implement SQLite migration runner in `mobile/src/db/migrations.ts` using `expo-sqlite` `openDatabaseAsync` (WAL mode) that executes DDL from `schema.ts` and is idempotent (CREATE TABLE IF NOT EXISTS)
- [ ] T017 Wire `SQLiteProvider` in `mobile/App.tsx` using `expo-sqlite` SDK 52+ `SQLiteProvider` component so all screens can access the DB via `useSQLiteContext()`
- [ ] T018 [P] Create `mobile/src/utils/uuid.ts` exporting a `generateUUID()` function using `expo-crypto` or `uuid` v4 for RFC-4122 UUIDs
- [ ] T019 [P] Create `mobile/src/utils/idempotency.ts` exporting `computeIdempotencyKey(parts: string[]): string` using SHA-256 (via `expo-crypto`) for outbox deduplication keys
- [ ] T020 [P] Implement `infra/lambda/sync-engine/src/db.ts` with a singleton `pg.Pool` connection pool (reads `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` from environment) with graceful shutdown
- [ ] T021 [P] Copy RDS PostgreSQL DDL from `specs/001-offline-facial-recognition/contracts/rds-schema.sql` into `infra/lambda/sync-engine/migrations/001_initial.sql` and create a `migrate.ts` script to apply it against the target RDS instance

**Checkpoint**: Foundation ready — all domain types, schema, and utilities in place. User story phases can now begin.

---

## Phase 3: User Story 1 — Register Personnel Profile (Priority: P1) 🎯 MVP

**Goal**: Operator can add, edit, and delete personnel records with facial photos entirely offline. Delivers a working on-device personnel registry.

**Independent Test**: Add a new personnel record (name, employee ID, role) with a captured photo → confirm record appears in personnel list → edit the name → confirm edit persists → delete the record → confirm it is removed. All steps work with Airplane Mode on.

### Implementation for User Story 1

- [ ] T022 [P] [US1] Implement `PersonnelRepository` in `mobile/src/db/repositories/PersonnelRepository.ts` with methods: `create(p: Omit<Personnel, 'id'>): Promise<Personnel>`, `update(id, fields): Promise<void>`, `delete(id): Promise<void>`, `findAll(): Promise<Personnel[]>`, `findById(id): Promise<Personnel | null>` using `useSQLiteContext()`
- [ ] T023 [P] [US1] Implement `FaceImageRepository` in `mobile/src/db/repositories/FaceImageRepository.ts` with methods: `create(fi: Omit<FaceImage, 'id'>): Promise<FaceImage>`, `findByPersonnelId(personnelId): Promise<FaceImage[]>`, `update(id, fields): Promise<void>`, `deleteByPersonnelId(personnelId): Promise<void>`
- [ ] T024 [US1] Implement `ImageStorageService` in `mobile/src/services/ImageStorageService.ts` using `expo-file-system` to save captured camera frames to `FileSystem.documentDirectory + IMAGE_STORAGE_DIR`, return the absolute `image_path`, and delete images by path; check available storage and throw a typed error if insufficient
- [ ] T025 [US1] Implement `EmbeddingModel` stub in `mobile/src/ml/EmbeddingModel.ts` using `react-native-fast-tflite` to load a MobileFaceNet `.tflite` asset from `mobile/assets/models/mobilefacenet.tflite` and expose `extractEmbedding(imagePath: string): Promise<Float32Array>` — return a zeroed 128-float array if model asset is absent (dev placeholder)
- [ ] T026 [US1] Implement `PersonnelListScreen` in `mobile/src/screens/PersonnelListScreen.tsx` using React Native Paper `FlatList` showing each personnel record's `fullName`, `employeeId`, and `role`; include a FAB for adding new records; navigate to `PersonnelDetailScreen` on row press
- [ ] T027 [US1] Implement `PersonnelDetailScreen` in `mobile/src/screens/PersonnelDetailScreen.tsx` with React Native Paper `TextInput` fields for `fullName`, `employeeId`, `role`; support both create mode (no `personnelId` param) and edit mode (pre-populated from `PersonnelRepository.findById`)
- [ ] T028 [US1] Integrate `react-native-vision-camera` v4 photo capture into `PersonnelDetailScreen.tsx`: add a camera preview component, a "Capture Photo" button that takes a snapshot, passes the image path through `ImageStorageService.save` → `EmbeddingModel.extractEmbedding` → `FaceImageRepository.create`, and displays a thumbnail of the captured image
- [ ] T029 [US1] Implement save action in `PersonnelDetailScreen.tsx`: validate that `fullName`, `employeeId`, and `role` are non-empty, call `PersonnelRepository.create` (or `update`), enqueue to `sync_outbox` via `SyncOutboxRepository.enqueue` (created in T047 — use a stub that no-ops until T047 is done), then navigate back to `PersonnelListScreen`
- [ ] T030 [US1] Implement delete action in `PersonnelDetailScreen.tsx`: show a React Native Paper `Dialog` confirmation, then call `PersonnelRepository.delete` (cascades to `face_image` via SQLite FK), delete files via `ImageStorageService.deleteByPersonnelId`, and navigate back
- [ ] T031 [US1] Create `mobile/src/navigation/AppNavigator.tsx` using React Navigation v6 stack navigator with initial route `PersonnelList`, route `PersonnelDetail`, and placeholder routes for `Verification` and `BackupStatus` (added in later phases)

**Checkpoint**: US1 complete — personnel CRUD with photo capture works fully offline. Verify: create → list → edit → delete with Airplane Mode on.

---

## Phase 4: User Story 2 — Verify Personnel On-Site (Priority: P1)

**Goal**: Camera-based on-device liveness detection and facial matching against enrolled profiles with a clear authorization result, all offline.

**Independent Test**: With at least one enrolled personnel record, open the verification screen → camera activates → present the enrolled person's face → system returns "Authorized" with the person's name. Then present an unknown face → "Unauthorized". Present a printed photo → "Liveness Check Failed". All with Airplane Mode on.

### Implementation for User Story 2

- [ ] T032 [P] [US2] Implement `FaceDetector` Vision Camera Frame Processor in `mobile/src/ml/FaceDetector.ts` using `react-native-fast-tflite` to run a face landmark `.tflite` model on each camera frame; expose `detectFace(frame): { boundingBox, landmarks, qualityScore } | null`
- [ ] T033 [P] [US2] Implement `LivenessDetector` in `mobile/src/ml/LivenessDetector.ts` with two checks: (1) blink detection — track eye-aspect-ratio across `LIVENESS_BLINK_FRAMES` consecutive frames from `FaceDetector` landmarks; (2) texture classifier — run a binary `.tflite` model on the face ROI to distinguish live face from printed photo; expose `check(frames: Frame[]): 'live' | 'spoof' | 'inconclusive'`
- [ ] T034 [US2] Implement `FaceMatcher` in `mobile/src/ml/FaceMatcher.ts` with method `matchBest(queryEmbedding: Float32Array, candidates: FaceImage[]): { personnelId: string; score: number } | null` using cosine similarity; return the best match if score ≥ `FACE_MATCH_THRESHOLD`, otherwise `null`
- [ ] T035 [US2] Implement `VerificationRepository` in `mobile/src/db/repositories/VerificationRepository.ts` with `create(vr: Omit<VerificationRecord, 'id'>): Promise<VerificationRecord>`, `findAll(): Promise<VerificationRecord[]>`, `findByPersonnelId(id): Promise<VerificationRecord[]>`
- [ ] T036 [US2] Implement `VerificationService` in `mobile/src/services/VerificationService.ts` orchestrating: (1) load all `FaceImage` embeddings from DB, (2) start `FaceDetector` frame stream, (3) run `LivenessDetector` — abort with `liveness_failed` on spoof, (4) extract embedding via `EmbeddingModel`, (5) run `FaceMatcher` — map result to outcome enum, (6) save `VerificationRecord` via `VerificationRepository`, (7) enqueue to `sync_outbox` stub
- [ ] T037 [US2] Implement `VerificationScreen` in `mobile/src/screens/VerificationScreen.tsx` using `react-native-vision-camera` Camera component: show live preview, a "Start Verification" button, and overlay guidance text ("Position face in frame", "Please blink")
- [ ] T038 [US2] Add result overlay to `VerificationScreen.tsx`: display a full-screen card with outcome label and colour coding — Authorized (green, personnel name + role), Unauthorized (red), Liveness Check Failed (amber), Low Confidence — Secondary Check Required (orange), Image Quality Insufficient — Reposition Camera (grey)
- [ ] T039 [US2] Handle camera permission denied in `VerificationScreen.tsx`: check `Camera.getCameraPermissionStatus()` on mount; if denied, show a React Native Paper `Banner` with a "Grant Permission" deep-link button instead of the camera view
- [ ] T040 [US2] Add `VerificationScreen` route to `AppNavigator.tsx` and add a "Verify" button to `PersonnelListScreen.tsx` header to navigate to it
- [ ] T041 [P] [US2] Add image quality gate in `VerificationService.ts`: if `FaceDetector.detectFace` returns `qualityScore < 0.4` or `boundingBox` area below minimum threshold, return outcome `quality_insufficient` without running liveness or matching

**Checkpoint**: US2 complete — verification pipeline works end-to-end offline. Verify all five outcome paths with Airplane Mode on.

---

## Phase 5: User Story 3 — Cloud Synchronisation (Priority: P2)

**Goal**: When connectivity is restored, all pending personnel, face image metadata, and verification records automatically upload to the cloud (API Gateway → SQS → Lambda → RDS + S3) with no duplicates and partial-sync resilience.

**Independent Test**: Perform 3+ verifications and 1 personnel registration offline. Enable Wi-Fi → confirm all records appear in RDS PostgreSQL and images in S3 within 3 minutes. Disable Wi-Fi mid-sync → re-enable → confirm remaining records sync without duplicates.

### Mobile Sync Client (T042–T052)

- [ ] T042 [US3] Implement `SyncOutboxRepository` in `mobile/src/db/repositories/SyncOutboxRepository.ts`: `enqueue(type, recordId, payload): Promise<void>` (computes idempotency key via `computeIdempotencyKey`), `dequeuePending(limit: number): Promise<SyncOutboxEntry[]>`, `markDispatched(id): Promise<void>`, `markAcknowledged(id): Promise<void>`, `markFailed(id, error): Promise<void>`, `countPending(): Promise<number>`
- [ ] T043 [P] [US3] Update `PersonnelRepository.create` and `PersonnelRepository.update` in `mobile/src/db/repositories/PersonnelRepository.ts` to call `SyncOutboxRepository.enqueue('personnel', id, payload)` within the same SQLite transaction (atomicity: local write + outbox enqueue)
- [ ] T044 [P] [US3] Update `FaceImageRepository.create` in `mobile/src/db/repositories/FaceImageRepository.ts` to call `SyncOutboxRepository.enqueue('face_image', id, payload)` within the same transaction
- [ ] T045 [P] [US3] Update `VerificationRepository.create` in `mobile/src/db/repositories/VerificationRepository.ts` to call `SyncOutboxRepository.enqueue('verification_record', id, payload)` within the same transaction
- [ ] T046 [P] [US3] Implement `AuthService` in `mobile/src/services/AuthService.ts` using AWS SDK v3 `CognitoIdentityClient` to obtain temporary IAM credentials from `AWS_COGNITO_IDENTITY_POOL_ID`; expose `getCredentials(): Promise<AwsCredentialIdentity>` with in-memory caching and expiry refresh
- [ ] T047 [US3] Implement S3 image upload step in `mobile/src/services/SyncService.ts`: call `PUT /sync/images/presign` with pending face image IDs → receive pre-signed URLs → `PUT` each image file to S3 → store returned `s3Key` in `face_image.s3_key` via `FaceImageRepository.update` before submitting the batch
- [ ] T048 [US3] Implement `POST /sync/batch` API call in `mobile/src/services/SyncService.ts`: batch up to `SYNC_BATCH_MAX_PERSONNEL` personnel, `SYNC_BATCH_MAX_VERIFICATIONS` verification records, and face image metadata from the outbox; include `batchId` (UUID), `deviceId`, `sentAt`; sign request with SigV4 via `AuthService`
- [ ] T049 [US3] Implement outbox dispatch loop in `mobile/src/services/SyncService.ts`: scan `sync_outbox` for pending entries → group into a batch → call presign + batch API → on 200 OK mark outbox entries acknowledged and source records `synced` → on failure mark `failed` with error message; implement exponential backoff with `SYNC_RETRY_MAX_ATTEMPTS` and `SYNC_RETRY_BACKOFF_MS`
- [ ] T050 [US3] Wire connectivity-triggered sync in `mobile/src/services/SyncService.ts` using `@react-native-community/netinfo` `addEventListener`: on `isConnected: true` event call the outbox dispatch loop; also trigger on app foreground via `AppState.addEventListener('change')`
- [ ] T051 [P] [US3] Handle 409 DUPLICATE_BATCH response in `SyncService.ts`: treat as success, mark outbox entries acknowledged (idempotent replay safe)
- [ ] T052 [P] [US3] Handle 400 VALIDATION_ERROR response in `SyncService.ts`: parse `details` array, mark the offending records as `failed` with `syncError` set to the first relevant detail message, and continue dispatching the remaining batch entries

### Lambda Sync Engine (T053–T058)

- [ ] T053 [P] [US3] Implement SQS event handler in `infra/lambda/sync-engine/src/handler.ts`: receive SQS record batch (size 1), parse message body, route to processor chain, handle errors → throw to return message to queue (up to 3 retries before DLQ)
- [ ] T054 [P] [US3] Implement `PersonnelProcessor` in `infra/lambda/sync-engine/src/processors/PersonnelProcessor.ts`: upsert each personnel record with `ON CONFLICT (employee_id) DO UPDATE SET ... WHERE EXCLUDED.updated_at > personnel.updated_at` using the `pg.Pool` from `db.ts`
- [ ] T055 [P] [US3] Implement `VerificationProcessor` in `infra/lambda/sync-engine/src/processors/VerificationProcessor.ts`: idempotent insert `ON CONFLICT (id, device_id) DO NOTHING`
- [ ] T056 [P] [US3] Implement `FaceImageProcessor` in `infra/lambda/sync-engine/src/processors/FaceImageProcessor.ts`: idempotent insert `ON CONFLICT (id) DO NOTHING`; verify that the referenced `s3Key` is accessible (optional HEAD check)
- [ ] T057 [US3] Compose processor chain in `handler.ts`: wrap `PersonnelProcessor`, `VerificationProcessor`, and `FaceImageProcessor` calls in a single `pg` transaction; on success call `WebhookNotifier` if `WEBHOOK_URL` env var is set
- [ ] T058 [P] [US3] Implement `WebhookNotifier` in `infra/lambda/sync-engine/src/processors/WebhookNotifier.ts`: POST `sync.batch.completed` event payload to `process.env.WEBHOOK_URL` (FR-017 optional webhook); no-op if env var absent

### Terraform Infrastructure (T059–T064)

- [ ] T059 [P] [US3] Create Terraform `core-infra` module in `infra/terraform/modules/core-infra/`: VPC with public + private subnets, Cognito Identity Pool with unauthenticated access disabled and IAM role granting `execute-api:Invoke` and `s3:PutObject` to the face-images bucket only
- [ ] T060 [P] [US3] Create Terraform `serverless` module in `infra/terraform/modules/serverless/`: HTTP API Gateway v2 with routes `POST /sync/batch` and `PUT /sync/images/presign`, Lambda function (Node.js 20, 512 MB, 300 s timeout) wired to both routes, SQS FIFO queue `nhai-sync-queue.fifo` and DLQ `nhai-sync-dlq.fifo` (max receive count 3)
- [ ] T061 [P] [US3] Create Terraform `database` module in `infra/terraform/modules/database/`: RDS PostgreSQL 15 `db.t3.micro` in private subnet, security group permitting Lambda SG inbound on port 5432, AWS Secrets Manager secret for DB password
- [ ] T062 [P] [US3] Add S3 bucket resource `nhai-face-images-${var.account_id}` to `serverless` module in `infra/terraform/modules/serverless/main.tf` with versioning enabled and block-public-access policy; add Lambda IAM permission to `s3:GetObject` and `s3:PutObject`
- [ ] T063 [US3] Complete root `infra/terraform/main.tf`: wire `core-infra`, `serverless`, and `database` modules; configure S3 remote state backend (`bucket`, `key`, `region`, `dynamodb_table`); output `api_gateway_url` for `mobile/.env.local`
- [ ] T064 [P] [US3] Create `infra/terraform/terraform.tfvars.example` with all required variable placeholders: `aws_region`, `account_id`, `db_password`, `webhook_url` (optional)

**Checkpoint**: US3 complete — full sync cycle works. Verify: offline operations → enable network → records appear in RDS and S3 within 3 min.

---

## Phase 6: User Story 4 — Backup Management (Priority: P2)

**Goal**: Operator has full visibility into sync status and manual control (retry, cancel) over backup operations with push notifications on completion or failure.

**Independent Test**: Simulate a failed backup (kill network mid-sync) → open BackupStatusScreen → see failure reason and record count → tap "Retry" → confirm backup succeeds → notification appears. Cancel an in-progress backup → confirm pending records remain on device.

### Implementation for User Story 4

- [ ] T065 [P] [US4] Implement `BackupJobRepository` in `mobile/src/db/repositories/BackupJobRepository.ts`: `create(job: Omit<BackupJob, 'id'>): Promise<BackupJob>`, `updateStatus(id, fields: Partial<BackupJob>): Promise<void>`, `findLatest(): Promise<BackupJob | null>`, `findAll(limit: number): Promise<BackupJob[]>`
- [ ] T066 [US4] Implement `BackupStatusService` in `mobile/src/services/BackupStatusService.ts`: `startJob(): Promise<string>` (creates backup_job with status `in_progress`), `completeJob(id, summary)`, `failJob(id, errorMessage)`, `cancelJob(id)`; expose `getStatus(): Promise<{ lastSyncTime, pendingCount, latestJob }>`
- [ ] T067 [US4] Integrate `BackupStatusService` with `SyncService.ts`: call `startJob()` before outbox dispatch, `completeJob()` on full success, `failJob()` on unrecoverable error, `cancelJob()` when operator cancels
- [ ] T068 [US4] Implement `BackupStatusScreen` in `mobile/src/screens/BackupStatusScreen.tsx` using React Native Paper: display last successful sync time, pending record count (from `SyncOutboxRepository.countPending()`), current backup status, error message (if any), a "Retry" button (visible when status is `failed`), and a "Cancel" button (visible when status is `in_progress`)
- [ ] T069 [US4] Wire "Retry" button in `BackupStatusScreen.tsx` to call `SyncService.triggerSync()` which resets `failed` outbox entries back to `pending` status and re-runs the outbox dispatch loop
- [ ] T070 [US4] Wire "Cancel" button in `BackupStatusScreen.tsx`: set a cancellation flag on `SyncService` that the dispatch loop checks between batches; call `BackupStatusService.cancelJob()` when acknowledged
- [ ] T071 [US4] Add `BackupStatusScreen` route to `AppNavigator.tsx` and add a "Backup Status" icon button to the `PersonnelListScreen.tsx` header right area
- [ ] T072 [P] [US4] Implement push notification for backup events in `mobile/src/services/BackupStatusService.ts` using `expo-notifications`: request permission on first sync; send a local notification on `completeJob` ("Sync complete: N records uploaded") and `failJob` ("Sync failed: {errorMessage}")

**Checkpoint**: US4 complete — backup management panel with retry, cancel, and notifications works. All four user stories independently functional.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Security hardening, edge-case handling, and production readiness improvements that span multiple stories.

- [ ] T073 [P] Add `expo-secure-store` AES-256 encryption for the `employee_id` field in `PersonnelRepository.ts`: encrypt before SQLite write, decrypt after read using `SecureStore.setItemAsync` / `getItemAsync` with a device-bound key
- [ ] T074 Handle device storage full edge case in `ImageStorageService.ts`: call `FileSystem.getFreeDiskStorageAsync()` before saving; if available bytes < 2× image size, throw a typed `StorageFullError` and surface a React Native Paper Snackbar in `PersonnelDetailScreen.tsx`
- [ ] T075 Add camera permission handling in `PersonnelDetailScreen.tsx`: check `Camera.getCameraPermissionStatus()` on mount; if not granted, request permission; if permanently denied, show a "Go to Settings" button
- [ ] T076 Handle RDS schema-rejected records in `SyncService.ts`: on `400 VALIDATION_ERROR` response, log the full `details` array to console, mark each affected `sync_outbox` entry as `failed` with the field-level message, and do not block healthy records in the same batch from being retried
- [ ] T077 Guard personnel delete during active sync in `PersonnelRepository.delete`: if the personnel record's `sync_status` is not `synced` or a `sync_outbox` entry for that record is `in_progress`, enqueue the delete as a tombstone entry rather than immediately removing the row; add a `tombstoned` column to the `personnel` SQLite table and filter it from `PersonnelListScreen`
- [ ] T078 [P] Add React Native Paper theme configuration in `mobile/src/components/theme.ts`: define primary, secondary, and error colours; wrap `App.tsx` root with `PaperProvider theme={theme}`; apply `200 ms` activity indicator delay rule across all async operations (show loading state only after 200 ms to avoid flicker)
- [ ] T079 [P] Add `infra/docker-compose.yml` with a LocalStack service (image `localstack/localstack`) exposing SQS, S3 on `localhost:4566`, and document local Lambda integration test setup in `quickstart.md`
- [ ] T080 Run full golden-path validation against `quickstart.md`: `pnpm install` → `pnpm android` → register a personnel record with photo → verify (authorized result) → verify with unknown face (unauthorized) → enable network → confirm sync in RDS → open BackupStatusScreen → confirm last sync time updated

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
| **Total** | | **80** |

---

## Notes

- `[P]` tasks = operate on different files, no shared state with sibling tasks in the same phase
- `[Story]` label maps each task to a specific user story for traceability and independent delivery
- Each user story is independently completable and testable — stop at any checkpoint for a demo
- TDD workflow per `quickstart.md`: write failing test → implement → refactor → coverage check
- Commit after each task or logical group
- Constitution gates (≥80% line / ≥70% branch coverage) must stay green throughout
