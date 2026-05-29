# Feature Specification: Offline Facial Recognition & Liveness Detection System

**Feature Branch**: `001-offline-facial-recognition`

**Created**: 2026-05-27

**Status**: Draft

**Input**: User description: "A mobile-based personnel verification system designed for remote locations with limited or no internet connectivity. The system enables on-site facial recognition and liveness detection for personnel authorization, with automatic cloud synchronization when connectivity is restored."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Register Personnel Profile (Priority: P1)

An operator sets up the system at a remote site by adding personnel who need access. For each person, the operator enters basic information and captures one or more facial photos, which are stored locally on the device.

**Why this priority**: Without personnel profiles stored on-device, no verification can occur. This is the foundational data setup that all other features depend on.

**Independent Test**: Can be fully tested by adding a new personnel record with name, ID, role, and captured photo, then retrieving that record from local storage — delivers a working personnel registry with no connectivity required.

**Acceptance Scenarios**:

1. **Given** the operator is on the personnel management screen, **When** they enter a person's name, employee ID, and role and capture a facial photo, **Then** the record is saved locally and appears in the personnel list.
2. **Given** an existing personnel record, **When** the operator edits the name or role, **Then** the changes are saved and reflected immediately.
3. **Given** an existing personnel record, **When** the operator deletes it, **Then** the record and associated facial data are removed from local storage.
4. **Given** no network connection, **When** the operator adds a new personnel record, **Then** the record is saved successfully without any error or connectivity requirement.

---

### User Story 2 - Verify Personnel On-Site (Priority: P1)

An operator uses the mobile device to check whether a person presenting themselves at the site is an authorized personnel. The device camera captures a live image, performs liveness detection to confirm a real person (not a photo), and matches the face against stored profiles.

**Why this priority**: This is the primary purpose of the system — real-time, offline personnel authorization at the point of entry.

**Independent Test**: Can be fully tested by presenting an enrolled person's face to the camera and confirming the system returns an authorized result, and presenting an unknown face to confirm unauthorized result — delivers end-to-end verification without internet.

**Acceptance Scenarios**:

1. **Given** a personnel profile exists on the device, **When** the operator initiates verification and the person presents their face to the camera, **Then** the system performs liveness detection and matches the face, displaying "Authorized" with the person's name and role.
2. **Given** someone presents a printed photo instead of their live face, **When** the system performs liveness detection, **Then** it detects the spoof attempt and displays "Liveness Check Failed."
3. **Given** a face not matching any stored profile, **When** verification is performed, **Then** the system displays "Unauthorized — No Match Found."
4. **Given** poor lighting or partial occlusion, **When** verification is attempted, **Then** the system prompts the operator to reposition the camera rather than returning a false result.
5. **Given** a completed verification (success or failure), **When** the result is displayed, **Then** a verification record with timestamp, operator context, and outcome is saved locally.

---

### User Story 3 - Cloud Synchronization (Priority: P2)

When the device regains internet connectivity, all locally stored personnel data and verification records are automatically uploaded to the cloud, providing a centralized audit trail and enabling data backup.

**Why this priority**: Ensures continuity of records and provides the organization with a consolidated view of all site access events after field operations conclude.

**Independent Test**: Can be fully tested by performing several verifications offline, then enabling connectivity and observing that all pending records are uploaded to the cloud — delivers a complete sync cycle without manual intervention.

**Acceptance Scenarios**:

1. **Given** the device has pending unsynced records, **When** internet connectivity is detected, **Then** the system automatically begins uploading pending personnel data and verification logs.
2. **Given** a sync is in progress, **When** connectivity is lost mid-transfer, **Then** the sync pauses and resumes from where it left off when connectivity is restored (partial sync resilience).
3. **Given** all records have been synced, **When** new records are created offline, **Then** only the new records are uploaded on the next sync (no duplicate uploads).
4. **Given** a sync completes successfully, **When** the operator views the backup status, **Then** they see the last successful sync time and number of records uploaded.

---

### User Story 4 - Backup Management (Priority: P2)

The operator can monitor the status of cloud backups, manually trigger a retry of failed uploads, cancel an in-progress backup, and receive clear notifications about the outcome of backup operations.

**Why this priority**: Operators in the field need confidence that their data is preserved and visible control over the sync process when issues arise.

**Independent Test**: Can be fully tested by simulating a failed backup, using the manual retry option, and confirming the backup succeeds — delivers operator-controlled backup management independently of the auto-sync flow.

**Acceptance Scenarios**:

1. **Given** a backup has failed, **When** the operator views the backup status screen, **Then** they see the failure reason and a "Retry" button.
2. **Given** the operator taps "Retry," **When** connectivity is available, **Then** the system reattempts the backup and notifies the operator of success or continued failure.
3. **Given** a backup is in progress, **When** the operator taps "Cancel," **Then** the upload stops and the pending records remain on device for the next attempt.
4. **Given** a backup completes, **When** the operator has notifications enabled, **Then** they receive a confirmation notification with the sync summary.

---

### Edge Cases

- What happens when device storage is full and a new personnel photo cannot be saved?
- How does the system handle two personnel with very similar facial features? → The matcher returns only the single highest cosine-similarity candidate; if the best score falls below the acceptance threshold (or the top two candidates are within a narrow margin), the outcome is "Low Confidence — Secondary Check Required" rather than an arbitrary match.
- What happens when the ML model cannot make a confident match? → Display "Low Confidence — Secondary Check Required"; log outcome as inconclusive.
- How are verification records handled if the cloud rejects them (e.g., schema mismatch)?
- What happens if the operator attempts to delete a personnel record while a sync is in progress?
- How does the system behave when the camera permission is denied by the OS?

## Requirements *(mandatory)*

### Functional Requirements

**Personnel Management**

- **FR-001**: System MUST allow operators to create a personnel record with at minimum: full name, employee ID, and role designation.
- **FR-002**: System MUST allow operators to capture one or more facial images per personnel record using the device camera.
- **FR-003**: System MUST allow operators to update any field of an existing personnel record.
- **FR-004**: System MUST allow operators to delete a personnel record, removing all associated facial data from local storage.
- **FR-005**: System MUST display a list of all stored personnel records with name, ID, and role visible.

**Verification & Authorization**

- **FR-006**: System MUST access the device camera to capture a live image for verification.
- **FR-007**: System MUST perform on-device liveness detection before attempting facial matching to prevent photo-based spoofing.
- **FR-008**: System MUST match the captured live face against all stored personnel profiles and return the closest match or no-match result.
- **FR-009**: System MUST display a clear authorization result after each verification attempt — exactly one of these five outcomes: **Authorized**, **Unauthorized — No Match Found**, **Liveness Check Failed**, **Low Confidence — Secondary Check Required**, or **Image Quality Insufficient — Reposition Camera**. When the ML model cannot make a confident match, the system MUST display "Low Confidence — Secondary Check Required" and log the outcome as inconclusive.
- **FR-010**: System MUST store a verification record locally after each attempt, including: timestamp, outcome, matched personnel ID (if any), and confidence indicator.
- **FR-011**: System MUST provide operator guidance (e.g., reposition prompt) when image quality is insufficient for reliable matching.

**Offline Operation**

- **FR-012**: System MUST operate all personnel management and verification functions with no internet connection.
- **FR-013**: System MUST persist all personnel data and verification records across app restarts without requiring connectivity.

**Cloud Synchronization**

- **FR-014**: System MUST automatically detect when internet connectivity becomes available and initiate a background sync of unsynced records.
- **FR-015**: System MUST resume interrupted sync operations from the last successfully transferred record (no duplicate uploads).
- **FR-016**: System MUST track the sync status of each record (pending, in-progress, synced, failed).
- **FR-017**: System MUST expose an API/interface endpoint to receive synced data, suitable for integration with existing personnel management systems. The cloud backend is implemented as AWS API Gateway → Lambda → SQS FIFO → Lambda → RDS PostgreSQL: the HTTP-facing Lambda validates each batch and enqueues it to an SQS FIFO queue for durable, idempotent processing by the same Lambda's SQS-triggered consumer (see `contracts/sync-api.md`). All resources are provisioned via Terraform.

**Backup Management**

- **FR-018**: System MUST display current backup status to the operator: last sync time, number of pending records, and any error states.
- **FR-019**: System MUST allow operators to manually trigger a retry of failed backup operations.
- **FR-020**: System MUST allow operators to cancel an in-progress backup.
- **FR-021**: System MUST notify the operator upon backup completion or failure.

**Security & Data Protection**

- **FR-022**: System MUST encrypt all personnel personally identifiable information at rest — full name, employee ID, facial embeddings, and stored face image files — using AES-256 with a device-bound key, such that the data is unreadable if device storage is extracted.

### Key Entities

- **Personnel Record**: Represents a registered individual; contains name, employee ID, role, registration date, and sync status. Associated with one or more facial image captures.
- **Facial Image**: A captured photo or encoding associated with a personnel record, stored securely on device; used as the reference template for matching.
- **Verification Record**: A log entry for each authorization attempt; contains timestamp, outcome (authorized/unauthorized/liveness-failed), matched personnel ID, confidence score, and sync status.
- **Backup Job**: Represents a sync attempt; tracks records included, bytes transferred, start/end time, status (in-progress/completed/failed), and any error messages.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Operators can register a new personnel profile (including photo capture) in under 2 minutes on first use.
- **SC-002**: Verification result (authorized or denied) is displayed to the operator within 5 seconds of initiating a check.
- **SC-003**: Liveness detection correctly rejects photo-based spoofing in at least 95% of test attempts.
- **SC-004**: Facial matching achieves at least 90% accuracy against enrolled personnel under typical field lighting conditions.
- **SC-005**: All locally stored records are automatically uploaded within 3 minutes of stable internet connectivity being restored, for datasets up to 500 verification records.
- **SC-006**: Failed backups are retried automatically without operator intervention and succeed on subsequent attempts when connectivity is stable.
- **SC-007**: System operates without crashes or data loss across a full working day (8+ hours) of offline use with 50+ personnel records.
- **SC-008**: Integration with an external personnel management system requires no modification to existing system data contracts.

## Clarifications

### Session 2026-05-27

- Q: Which IaC tool should manage AWS infrastructure? → A: Terraform (HCL, remote state in S3 + DynamoDB lock)
- Q: Which mobile platform and framework? → A: React Native (Expo bare) — Android + iOS, JS/TS, on-device TFLite inference via `react-native-fast-tflite`
- Q: Which on-device ML models power detection, recognition, and liveness? → A: A four-model open-source TFLite pipeline across three logical stages (see README): BlazeFace f16 (detection) → MobileFaceNet INT8 (128-d embedding) → dual-layer liveness — MiniFASNet/landmarks f16 (active blink/head-turn) + Antispoof INT8 (passive texture). Total footprint ~5 MB.
- Q: Which AWS services back the cloud sync endpoint? → A: API Gateway + Lambda + RDS PostgreSQL
- Q: How does the mobile app authenticate to the cloud API? → A: AWS Cognito Identity Pool (temporary IAM credentials via SigV4, no long-lived secrets on device)
- Q: How should the system handle an ambiguous/low-confidence facial match? → A: Display "Low Confidence — Secondary Check Required" and log outcome as inconclusive

## Assumptions

- ML models for facial recognition and liveness detection are provided as pre-built, open-source on-device TFLite binaries (bundled into `mobile/assets/models/`) — model development is out of scope. The pipeline is BlazeFace (detection) → MobileFaceNet INT8 (embedding) → MiniFASNet/landmarks + Antispoof (liveness), run via `react-native-fast-tflite`. See README.md for the full architecture and rationale.
- The device has a functional rear or front camera accessible via standard OS permissions.
- Operators are non-technical field staff; the UI must require no prior technical training.
- A single device is used by one operator at a time; multi-device concurrent sync conflict resolution is out of scope for this version.
- The cloud sync backend is built as part of this system: AWS API Gateway + Lambda + RDS PostgreSQL, provisioned via Terraform. The integration interface (API contracts) must remain stable for downstream personnel management system consumption.
- User authentication (login/password for the app itself) is out of scope; physical device security is assumed to be the access control layer.
- Cloud API access is secured via AWS Cognito Identity Pool. The app obtains temporary IAM credentials (SigV4-signed requests) at sync time; no long-lived API keys or secrets are stored on device. Cognito Identity Pool is provisioned via Terraform.
- Local data encryption at rest is required (FR-022): AES-256 over all PII fields (full name, employee ID, embeddings) and face image files, keyed by a device-bound secret. SQLCipher full-database encryption is the longer-term target; the prototype achieves equivalent coverage via field-level encryption because the chosen `expo-sqlite` engine does not bundle SQLCipher.
- The target deployment is a hackathon prototype intended for production integration; therefore, the integration interface must be clean and stable even if other areas remain prototype-grade.
- All AWS infrastructure MUST be defined and provisioned using Terraform (IaC). Remote state is stored in S3 with DynamoDB state locking. No manual console provisioning is permitted for reproducible resources.
- The mobile application is built with React Native (Expo bare workflow), targeting Android and iOS from a single JS/TS codebase. On-device ML integration uses TFLite models via `react-native-fast-tflite` (native C++ inference); MLKit is not used because it does not expose face embeddings for offline 1:N matching.
