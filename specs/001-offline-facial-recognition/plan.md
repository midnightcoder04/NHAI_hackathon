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

**Profiling Results**: Memory/CPU profile on a mid-range device (Snapdragon 665 / 3 GB RAM) is still _[pending]_ (task T102). The offline portions of the T100 benchmark have been measured below: **SC-004 face-matching accuracy** (external LFW dataset), **SC-002 per-stage inference latency** (dev CPU), and **SC-003 anti-spoof** (harness + proxy — certification still needs real PAD data).

_MobileFaceNet INT8 recognition accuracy — external validation (2026-06-05)_

- **Harness**: `scripts/validate_recognition_lfw.py` simulates the device pipeline in Python (ai_edge_litert) — `sklearn.datasets.fetch_lfw_pairs(subset='test')` (1000 pairs, 500 same / 500 different) → **BlazeFace** short-range f16 detect/crop → **MobileFaceNet** INT8 112×112 → 128-d L2-normed embedding → cosine. Exact quant/anchor/decode conventions reused from `scripts/test_blazeface_f16.py` + `test_recognition.py`. BlazeFace detected a face in **96.3 %** of images. ~25 ms/pair on CPU.

| Pipeline variant | ROC-AUC | Acc @ gate | Best acc (threshold) | SC-004 (≥ 90 %) |
|---|---|---|---|---|
| Old as-shipped (raw BlazeFace box → squashed 112²) | 0.794 | 71.3 % @ 0.65 | 73.4 % @ 0.69 | ❌ below target |
| + 5-pt ArcFace align (canonical 112² template) | 0.950 | — | 91.2 % @ 0.43 | ✅ meets target |
| **NOW SHIPPED: align + 1.15× tightened crop @ 0.45 gate** | **0.961** | **90.9 % @ 0.45** (prec 98.3 % / rec 83.2 %) | 92.0 % @ 0.41 | ✅ meets target |
| Reference: SVD-umeyama + bilinear warp | **0.963** | — | 92.4 % @ 0.42 | ✅ meets target |

**Finding 1 — RESOLVED (2026-06-05): 5-point ArcFace alignment is now implemented on-device.** MobileFaceNet (ArcFace family) expects faces similarity-warped to a canonical 112² template; the old worklet fed the raw BlazeFace box (the dominant accuracy leak). The fix lands a closed-form 2D-similarity solve (`solveSimilarityTransform` + `ARCFACE_TEMPLATE_112` in `mobile/src/ml/preprocessing.ts`, complex least-squares = reflection-free Umeyama, no SVD) inlined into the `frameProcessor.ts` IDENTITY block (per-pixel inverse-warp + nearest-neighbour sample, with a degenerate-keypoint fallback to the box crop). The **exact shipped math** is mirrored in `validate_recognition_lfw.py` (`--align --align-method similarity-nearest`).

**Finding 1b — RESOLVED (2026-06-06): crop tightened 1.15× + model comparison.** A crop-tightness sweep (`scripts/sweep_crop_margin.py`, BlazeFace cached once, only the warp scale varies) tested the hypothesis that the detector hand-off was too tight (skipping forehead/hair). The opposite holds: **looser crops hurt monotonically** (AUC 0.95→0.65 toward 0.55× as hair/background — identity-noise shared across people — inflates impostor similarity), and a *slight tighten* helps, peaking at **≈1.15× about the template centroid** (AUC 0.950→0.961, best-acc 91.1→91.8 %); beyond ~1.2× the outer landmarks clip. Shipped via `ARCFACE_CROP_TIGHTEN = 1.15` (derives `ARCFACE_TEMPLATE_112` from the canonical points; worklet inlines the same coords). A model comparison (`scripts/compare_mfn_variants.py`) also measured the **float32 (192-d) and a float16 sim (`make_fp16.py`)** exports at AUC **0.968** (best-acc 93.8 %) — ~+0.02 over int8 — but they require a 128→192-d embedding-schema migration + full re-enrollment, so **int8 was retained** as the better cost/benefit (the tightened crop is the free win).

**Finding 2 — RESOLVED (2026-06-06): `FACE_MATCH_THRESHOLD` recalibrated 0.65 → 0.45.** Alignment widened class separation but lowered absolute cosines, so the old 0.65 gave precision 100 % / recall **47 %** (over half of genuine users read not-authorised). The operating point was chosen from the FAR/FRR curve (`scripts/threshold_report.py`): **0.45 → FAR ≈ 1.4 % / FRR ≈ 16.8 % / accuracy 90.9 % (meets SC-004 at the gate), precision 98.3 %**; recall recovered 47 %→83 %. `FACE_LOW_CONFIDENCE_THRESHOLD` moved 0.5 → 0.40 in lockstep (kept below the match gate). Caveat: LFW is a hard benchmark (look-alike impostors), so field FAR should be lower — **re-confirm on real field/PAD captures** before final sign-off, alongside SC-003.

> Note: LFW is unconstrained-pose/lighting and harder than the frontal field use-case, so these are conservative lower bounds; the aligned ~0.95 AUC is the meaningful separability signal.

_Per-stage inference benchmark — dev CPU (2026-06-05)_

- **Harness**: `scripts/benchmark_models.py` warms up then times (50 iters) a forward pass of each pipeline model with the exact input dtype/shape/normalisation the worklet feeds, on the dev machine (ai_edge_litert + XNNPACK, **CPU-only — not** the Snapdragon 665 target; on-device profiling stays T102).

| Stage | Model | Plan budget | Dev-CPU mean / p95 |
|---|---|---|---|
| BlazeFace (detect) | `blaze_face_short_range_float16` | ~20 ms | 0.6 / 0.6 ms |
| MobileFaceNet (embed) | `MobileFaceNet_new_latest_int8` | ~60 ms | 11.4 / 11.6 ms |
| FaceMesh (active liveness) | `face_landmarks_detector_float16` | ~100 ms | 2.4 / 2.5 ms |
| Antispoof (passive liveness) | `antispoof_128x128_int8` | ~30 ms | 2.2 / 2.3 ms |
| **Per-verification total** | — | **~210 ms** | **~16.6 / 17 ms (Σ)** |

SC-002 (< 1 s end-to-end): **PASS** on dev CPU with wide margin (Σ p95 ≈ 17 ms ≪ 1000 ms); the four stages also sit under the ~210 ms inference budget. Caveat: this is a no-NNAPI CPU upper bound — the binding latency check is the on-device profile (T102). One actionable note: the bundled **INT8 antispoof is *slower* on dev CPU (2.2 ms) than its f16/f32 siblings (0.9 ms)** — INT8 only pays off with the NNAPI/GPU integer path, so confirm the delegate is active on-device or the f16 variant may be the better pick.

_Anti-spoof (passive liveness) validation — SC-003 (2026-06-05)_

- **Harness**: `scripts/validate_antispoof.py` simulates the device's PASSIVE path (`frameProcessor.ts` + `test_liveness.py`): BlazeFace f16 detect → **1.5× box-centred crop** → Antispoof 128² (ImageNet-norm → softmax → `realProb = p[real]`) gated at `LIVENESS_ANTISPOOF_REAL_THRESHOLD = 0.5`. Reports the ISO/IEC 30107-3 PAD metrics (APCER/BPCER/ACER). Two modes: **certification** (`--live-dir`/`--spoof-dir` on a real presentation-attack capture set) and **proxy** (default: real LFW faces as bona-fide + synthetic print/screen recapture artefacts as attacks).
- **As-shipped result (PROXY, 300 bona-fide + 300 synthetic attacks):** ROC-AUC **0.51** (≈ random); at the 0.5 gate spoof-rejection 54 %, **BPCER 49 %** (nearly half of genuine LFW faces wrongly rejected); the model emits near-binary `realProb` (clustered at 0.0/1.0) that does **not** track the label.

**⚠️ Root cause found — the app's antispoof preprocessing is wrong (`scripts/diagnose_antispoof.py`).** A model-variant × colour × normalisation sweep (int8/f16/f32 × {rgb,bgr} × {imagenet,unit,signed,raw}) on genuine faces shows:

| Config | genuine→real | sep AUC | logit saturation |
|---|---|---|---|
| **As-shipped** — int8, **RGB**, **ImageNet** mean/std | 46 % | 0.47 | 68 % (confident-wrong) |
| **Correct** — int8, **BGR**, **plain /255** ([0,1]) | **98 %** | **0.74** | **0 %** |

- **Model variant is NOT the issue** — int8 ≈ float16 ≈ float32 within ±0.01 AUC under any fixed preprocessing; switching variant alone changes nothing. (Side note for the latency/size trade-off, not accuracy.)
- **Preprocessing WAS the issue (now fixed)** — the model expects **BGR channel order + plain `/255` normalisation**, not the RGB + ImageNet mean/std the worklet copied from `test_liveness.py`. Correcting it lifts genuine acceptance **46 % → 98 %** (BPCER 49 % → **0 %**), separation AUC **0.47 → 0.74**, and de-saturates the logits (gap 31.6 → 5.4). The old config was near the *worst* of all 24 combinations.

**Finding — PREPROCESSING FIX (2026-06-05), ⚠️ LATER SUPERSEDED.** The synthetic-proxy sweep above concluded **BGR + /255** and shipped it. On real PAD data (next finding) that turned out to be **wrong** — the synthetic recapture artefacts were not representative, so the BGR result did not transfer.

**Finding — SC-003 CERTIFIED on real PAD data; antispoof re-corrected (2026-06-06).** A real presentation-attack set arrived (`LiveSpoofDataset/` — 3,062 live + 3,107 spoof, pre-cropped 112² faces). Re-evaluating against ground truth (`scripts/compare_antispoof_variants.py`, `investigate_antispoof_crop.py`, held-out train/test split) overturns the synthetic conclusion on two counts:

| Config (on real PAD) | ROC-AUC | spoof-rej @0.5 | BPCER @0.5 |
|---|---|---|---|
| Shipped at the time — **BGR**, `realProb = p[1]` | **0.26** (inverted!) | 13 % | 40 % |
| Corrected — **RGB + /255**, `realProb = p[0]` (class 0 = real) | **0.81** | 67 % | 16 % |

- **Two compounding bugs**, both proven on a held-out split (train AUC 0.820 → test 0.807, not overfit): (i) preprocessing is **RGB + /255**, not BGR; (ii) the **class index was flipped — class 0 = real**, not class 1. The shipped gate was *worse than random*: accepting ~87 % of spoofs while rejecting ~40 % of genuine users.
- **Model variant still irrelevant** — on real data int8 ≈ float16 ≈ float32 within **AUC 0.0003** (pairwise corr ≥ 0.999). No accuracy from switching variants; int8 retained.
- **Crop framing matters** — the model wants the face small with border (Silent-Face family). A crop-scale sweep put the optimum near **2.0×** (vs the old 1.5×), AUC ≈ 0.81 → 0.84. Shipped as `ANTISPOOF_CROP_SCALE = 2.0` (proxy-derived via reflect-pad on the pre-cropped set; confirm exact value on real frames).
- **APPLIED:** `preprocessAntispoof` (RGB + /255), `antispoofRealProbability` (`p[0]`), the inlined worklet (RGB order, `realProb = e0/(e0+e1)`, `ANTISPOOF_CROP_SCALE`), `test_liveness.py`, `validate_antispoof.py`, and `preprocessing.test.ts` all updated (jest green, tsc clean).

> **SC-003 is now CERTIFIED on real data — and FAILS.** Even fully corrected, the model tops out at **ROC-AUC ≈ 0.81–0.84 / ~67–74 % spoof-rejection**; reaching 95 % spoof-rejection requires a gate (~0.998) that **rejects ~75 % of genuine users**. That is a **model-capability gap, not an operating-point one** — SC-003 (≥ 95 %) needs a **stronger passive anti-spoof model**, not threshold tuning. The current model is now at least correctly wired (un-broken) and provides a meaningful, if insufficient, passive layer atop the active blink/movement liveness.

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
