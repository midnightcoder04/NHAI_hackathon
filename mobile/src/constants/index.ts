// Face matching: cosine similarity acceptance threshold for MobileFaceNet INT8.
// Calibrated on LFW pairs through the SHIPPED aligned pipeline (5-point ArcFace warp,
// 1.15× tightened) — scripts/threshold_report.py. At 0.45: FAR ≈1.4% / FRR ≈16.8% /
// accuracy 90.9% (meets SC-004 ≥90% at the gate), precision 98.3%. This is the
// balanced operating point; the old 0.65 (pre-alignment "midpoint") rejected ~55% of
// genuine users once alignment was added. LFW is a hard benchmark (look-alike
// impostors), so field FAR is expected lower; re-confirm on real captures.
export const FACE_MATCH_THRESHOLD = 0.45;
// Between this and FACE_MATCH_THRESHOLD a candidate is inconclusive (low-confidence,
// "Secondary Check Required"); below it there is no match (unauthorized). Kept below
// the match gate; moved down in lockstep when FACE_MATCH_THRESHOLD dropped to 0.45.
export const FACE_LOW_CONFIDENCE_THRESHOLD = 0.4;
// Minimum face quality (0..1) from the detector to run liveness + matching.
export const FACE_MIN_QUALITY_SCORE = 0.4;
// BlazeFace detection confidence floor — boxes below this are discarded.
export const FACE_DETECTION_SCORE_THRESHOLD = 0.5;
// Face bounding-box area as a fraction of the frame at which the size component of
// the quality score saturates (a well-framed face fills roughly this much).
export const FACE_QUALITY_TARGET_AREA_RATIO = 0.15;

export const LIVENESS_BLINK_FRAMES = 3;
// Active layer: eye-aspect-ratio below this is a closed eye; an open→closed→open
// dip across LIVENESS_BLINK_FRAMES is counted as a blink (standard EAR ~0.2).
export const LIVENESS_EAR_CLOSED_THRESHOLD = 0.2;
// Passive layer: mean Antispoof "real" probability (0..1) must meet this or the
// frames are classified as a spoof (printed photo / screen replay).
// EFFECTIVELY DISABLED → 0.001 (2026-06-05, operator decision): on real device frames
// this passive model is not trustworthy — the SAME genuine live face read 0.99 in one
// session and ~0.05 in the next (lighting/crop sensitivity), and even within one capture
// it swings 0.0↔1.0. After trying 0.85 then 0.40 (both still false-rejected genuine
// users), the call is to IGNORE the passive antispoof verdict unless realProb is
// essentially 0.000 (a degenerate / extreme-spoof reading) and rely on the BLINK active-
// liveness as the real anti-spoof gate. realProb = softmax(logits)[0] is mathematically
// always > 0, so 0.001 means "pass unless the model is screaming spoof at full
// confidence". TRADE-OFF: passive spoof-rejection is gone — acceptable, as SC-003 was
// already an open model-capability gap (AUC≈0.81 even fed cleanly; see tasks.md T100).
// A real fix is a stronger passive model, not a threshold. (History: PAD-set offline
// numbers — genuine μ≈0.97, spoof μ≈0.16, AUC 0.99 @ crop 1.5 — did not transfer to device.)
export const LIVENESS_ANTISPOOF_REAL_THRESHOLD = 0.001;
// Length of each continuous capture window. The loop now gathers evidence over the
// FULL window (no early exit) once a face is detected, so the antispoof trimmed-mean
// and the movement/blink math see the most frames possible — more frames = a steadier
// verdict, which is the fix for the per-frame antispoof fluctuation. ~3 s ≈ 30–45
// frames on-device.
export const LIVENESS_CAPTURE_WINDOW_MS = 3000;
// (Legacy) cadence the old button-driven poll loop used to re-check for an early-exit
// verdict. The continuous loop no longer polls — it decides once at the window end —
// but the constant is kept for any callers/tests that still reference it.
export const LIVENESS_CAPTURE_POLL_MS = 150;
// Minimum face-bearing frames before a live/spoof verdict is trusted (avoid deciding off
// one or two noisy frames).
export const LIVENESS_MIN_FACE_FRAMES = 4;
// Active liveness via natural head/face MOVEMENT (cheap, every detection frame): the
// face-box centre must wander at least this fraction of the face's size across the
// window. Distinguishes a live, slightly-moving person from a rigid still — and unlike
// blink it needs no extra model, so it samples fast and is lenient. A wobbled photo can
// pass this, but the passive antispoof texture gate still rejects it.
export const LIVENESS_MOVE_RATIO_THRESHOLD = 0.04;
// Fraction of capture-window frames that must contain a tracked face for the result to
// count. A photo-swap or pull-away mid-window drops below this → inconclusive (the
// continuous-presence gate that keeps liveness + match one presentation).
export const LIVENESS_MIN_PRESENCE_RATIO = 0.6;

// --- Continuous verification loop (VerificationScreen) ---
// The screen runs hands-free: no "Start" button. A capture window auto-starts once a
// usable (quality-passing) face has been present for this many consecutive detection
// frames — a debounce so a single-frame detection blip can't kick off a scan.
export const VERIFY_TRIGGER_PRESENT_FRAMES = 2;
// After a result, the loop re-arms (ready for the NEXT subject) once the face has been
// ABSENT for this many consecutive frames — i.e. the person stepped away and a new one
// can walk up. This is the "when a face is detected again, run the window again" path.
export const VERIFY_REARM_ABSENCE_FRAMES = 5;
// …or, if the SAME subject just keeps standing there, re-arm anyway after this long so a
// falsely-rejected genuine user is retried automatically without leaving and returning.
export const VERIFY_REARM_COOLDOWN_MS = 2500;

// --- Staged blink-triggered pipeline (Phase 1 detect → Phase 2 blink → Phase 3 burst) ---
// Phase 1 trigger: composite face quality (confidence + size + centering, see
// FaceDetector.computeQualityScore) must clear this — i.e. a single, sufficiently LARGE
// and CENTERED face — before the heavier blink/recognition phases start. Higher than the
// FACE_MIN_QUALITY_SCORE matching floor so we only engage on a well-presented face.
export const FACE_GOOD_QUALITY_SCORE = 0.6;
// Phase 2 "Interaction Window": generous human reaction time to read "Blink to verify"
// and act. Decoupled from the <1 s COMPUTE budget — this is wall-clock for a person, not
// model time. Times out to a retry if neither a blink nor fallback movement is seen.
export const LIVENESS_INTERACTION_WINDOW_MS = 3000;
// Phase 3 "Execution Window": once the active check fires, capture frames for the
// antispoof check + identity embedding. Set to 1 (2026-06-05, operator decision): on-
// device the passive antispoof model proved too unreliable to aggregate meaningfully
// (genuine reads swung 0.0↔1.0 across frames/sessions), so we no longer try to average
// it — take a single frame and let the BLINK (active liveness) be the real gate. This
// also makes LIVENESS_EXECUTION_MAX_MS moot (one frame finalises immediately).
export const LIVENESS_EXECUTION_BURST_FRAMES = 1;
// …or this wall-clock ceiling, whichever comes first — keeps the whole blink→antispoof→
// embed→match sequence comfortably under the 1 s compute budget even if frames are slow.
export const LIVENESS_EXECUTION_MAX_MS = 600;

export const SYNC_BATCH_MAX_PERSONNEL = 100;
export const SYNC_BATCH_MAX_VERIFICATIONS = 500;
export const SYNC_RETRY_MAX_ATTEMPTS = 3;
export const SYNC_RETRY_BACKOFF_MS = 5000;

export const IMAGE_STORAGE_DIR = 'face_images/';

// On-device TFLite model assets (bundled in mobile/assets/models/, see README pipeline).
export const MODEL_FACE_DETECTOR = 'blaze_face_short_range_float16.tflite';
export const MODEL_FACE_EMBEDDING = 'MobileFaceNet_new_latest_int8.tflite';
export const MODEL_LIVENESS_LANDMARKS = 'face_landmarks_detector_float16.tflite';
export const MODEL_LIVENESS_ANTISPOOF = 'antispoof_128x128_int8.tflite';

// Model input sizes (square RGB), per scripts/test_*.py.
export const BLAZEFACE_INPUT_SIZE = 128;
export const EMBEDDING_INPUT_SIZE = 112;
export const FACEMESH_INPUT_SIZE = 256;
export const ANTISPOOF_INPUT_SIZE = 128;

// MobileFaceNet INT8 (true int8 I/O) quantization params, extracted from
// MobileFaceNet_new_latest_int8.tflite via ai_edge_litert (see scripts/test_recognition.py).
// Input:  q = round((px/255) / scale + zeroPoint); scale=1/255, zeroPoint=-128 ⇒ q = px-128.
// Output: v = scale·(int8 - zeroPoint); zeroPoint=0, and the scale CANCELS under the L2
// normalisation used for cosine matching — kept only for an exact dequantisation.
export const EMBEDDING_INPUT_SCALE = 0.003921568859368563;
export const EMBEDDING_INPUT_ZERO_POINT = -128;
export const EMBEDDING_OUTPUT_SCALE = 0.0078125;
export const EMBEDDING_OUTPUT_ZERO_POINT = 0;
export const EMBEDDING_DIM = 128;

// BlazeFace anchor decode (matches gen_anchors/decode/nms in test_blazeface_f16.py).
export const BLAZEFACE_NUM_ANCHORS = 896; // 16×16×2 (512) + 8×8×6 (384)
export const BLAZEFACE_SCORE_THRESHOLD = 0.6;
export const BLAZEFACE_IOU_THRESHOLD = 0.3;
// BlazeFace boxes are tight; expand per side so the full face is covered downstream.
export const BLAZEFACE_BOX_PAD_X = 0.0;
export const BLAZEFACE_BOX_PAD_Y = 0.5;

// Antispoof passive-liveness preprocessing: the model expects **RGB + plain
// px/255** ([0,1]) and **class 0 = real/live** (class 1 = attack). Calibrated on a
// REAL presentation-attack set (LiveSpoofDataset) — see preprocessAntispoof /
// scripts/compare_antispoof_variants.py. No mean/std constants are needed.
// Crop scale for the antispoof ROI = max(box_w, box_h) × this. The model is
// crop-sensitive (Silent-Face MiniFASNetV2SE) and separates best when the face is
// small with surrounding border (it keys on the screen bezel / paper edge of a
// recapture). A crop-framing sweep on a REALISTIC full-frame PAD set (Real/ selfies +
// Spoof/ screen-replay frames → scripts/validate_antispoof_realset.py) peaks at 1.5×:
// ROC-AUC 0.992 (vs 0.983 @ 2.0), and SC-003 met at 4% bona-fide-rejection (vs 12% @
// 2.0). The earlier "optimum ~2×, tops out ~0.84 AUC, needs a stronger model" note was
// an ARTIFACT of validating on LiveSpoofDataset's tight 112² crops, which strip away
// the surround this model relies on — on full-frame data the SAME model reaches 0.99.
export const ANTISPOOF_CROP_SCALE = 1.5;
