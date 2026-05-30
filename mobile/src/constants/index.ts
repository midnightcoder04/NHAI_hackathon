// Face matching: cosine similarity acceptance threshold for MobileFaceNet INT8.
// README specifies ~0.6–0.7 for this model; 0.65 is the tuned midpoint.
export const FACE_MATCH_THRESHOLD = 0.65;
// Between this and FACE_MATCH_THRESHOLD a candidate is inconclusive (low-confidence,
// "Secondary Check Required"); below it there is no match (unauthorized).
export const FACE_LOW_CONFIDENCE_THRESHOLD = 0.5;
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
export const LIVENESS_ANTISPOOF_REAL_THRESHOLD = 0.5;
// Max time the frame-processor gathers evidence on "Start Verification" before giving
// up. The capture polls and EXITS EARLY the instant it has a confident live/spoof
// verdict (see LIVENESS_CAPTURE_POLL_MS), so a cooperative scan usually finishes well
// under this — this is just the worst-case ceiling.
export const LIVENESS_CAPTURE_WINDOW_MS = 2000;
// How often the capture loop re-checks the accumulated frames for a confident verdict.
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

// Antispoof passive-liveness ImageNet normalisation (RGB), per test_liveness.py.
export const ANTISPOOF_MEAN: readonly [number, number, number] = [0.485, 0.456, 0.406];
export const ANTISPOOF_STD: readonly [number, number, number] = [0.229, 0.224, 0.225];
