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
// On "Start Verification", how long the frame-processor runs the full liveness stack
// (FaceMesh blink + Antispoof) on each frame to gather evidence bound to the same
// instant as the match. Kept to ~1 s for the sub-second auth target (SC-002): a short
// burst whose first frames each go through ALL models, enough to catch a blink.
export const LIVENESS_CAPTURE_WINDOW_MS = 1000;
// Fraction of capture-window frames that must contain a tracked face for the result to
// count. A photo-swap or pull-away mid-window drops below this → inconclusive (this is
// the continuous-presence gate that keeps blink + antispoof + match one presentation).
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
