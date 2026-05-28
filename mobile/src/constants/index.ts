// Face matching: cosine similarity acceptance threshold for MobileFaceNet INT8.
// README specifies ~0.6–0.7 for this model; 0.65 is the tuned midpoint.
export const FACE_MATCH_THRESHOLD = 0.65;
// Between this and FACE_MATCH_THRESHOLD a candidate is inconclusive (low-confidence,
// "Secondary Check Required"); below it there is no match (unauthorized).
export const FACE_LOW_CONFIDENCE_THRESHOLD = 0.5;
// Minimum face quality (0..1) from the detector to run liveness + matching.
export const FACE_MIN_QUALITY_SCORE = 0.4;

export const LIVENESS_BLINK_FRAMES = 3;

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
