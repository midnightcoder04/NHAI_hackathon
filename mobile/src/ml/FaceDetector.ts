import {
  FACE_DETECTION_SCORE_THRESHOLD,
  FACE_QUALITY_TARGET_AREA_RATIO,
  MODEL_FACE_DETECTOR,
} from '../constants';
import type { DetectedFace } from '../services/VerificationService';

export type { DetectedFace };

export interface Point {
  x: number;
  y: number;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FrameDims {
  width: number;
  height: number;
}

/**
 * A single decoded BlazeFace detection: bounding box, the six BlazeFace keypoints
 * (eyes, nose, mouth, ears), and the detector's confidence in [0, 1].
 */
export interface DetectionCandidate {
  boundingBox: BoundingBox;
  landmarks: Point[];
  score: number;
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/**
 * Composite face-quality score in [0, 1] from three signals the operator can act
 * on: detector confidence, how much of the frame the face fills (too small = move
 * closer), and how centered it is. Weighted so a confident, reasonably sized,
 * centered face clears FACE_MIN_QUALITY_SCORE while tiny/off-center faces don't.
 */
export function computeQualityScore(candidate: DetectionCandidate, frame: FrameDims): number {
  const { boundingBox: box, score } = candidate;
  const frameArea = frame.width * frame.height;
  if (frameArea === 0) return 0;

  const areaRatio = (box.width * box.height) / frameArea;
  const sizeScore = clamp01(areaRatio / FACE_QUALITY_TARGET_AREA_RATIO);

  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const dx = (cx - frame.width / 2) / (frame.width / 2);
  const dy = (cy - frame.height / 2) / (frame.height / 2);
  const centerScore = 1 - clamp01(Math.hypot(dx, dy) / Math.SQRT2);

  return clamp01(0.5 * clamp01(score) + 0.3 * sizeScore + 0.2 * centerScore);
}

/**
 * Highest-confidence detection at or above FACE_DETECTION_SCORE_THRESHOLD, or null
 * when nothing clears the floor (no usable face in the frame).
 */
export function selectBestDetection(candidates: DetectionCandidate[]): DetectionCandidate | null {
  let best: DetectionCandidate | null = null;
  for (const c of candidates) {
    if (c.score < FACE_DETECTION_SCORE_THRESHOLD) continue;
    if (!best || c.score > best.score) best = c;
  }
  return best;
}

/**
 * Reduce a frame's decoded detections to the single DetectedFace consumed by
 * VerificationService (T036) — or null when there is no usable face. The T041
 * quality gate then decides whether qualityScore is high enough to proceed.
 */
export function parseDetection(
  candidates: DetectionCandidate[],
  frame: FrameDims,
): DetectedFace | null {
  const best = selectBestDetection(candidates);
  if (!best) return null;
  return {
    boundingBox: best.boundingBox,
    landmarks: best.landmarks,
    qualityScore: computeQualityScore(best, frame),
  };
}

/**
 * VisionCamera v5 frame-processor entry point.
 *
 * NATIVE WIRING (T032, completed at build time — not exercised by jest):
 *  1. Load BlazeFace (MODEL_FACE_DETECTOR) via react-native-fast-tflite and box it
 *     with `NitroModules.box(model)` so the worklet runtime can call it.
 *  2. Inside a `useFrameProcessor` worklet, convert the frame to the model's input
 *     tensor, run the boxed model, decode anchors → DetectionCandidate[].
 *  3. Call `parseDetection(candidates, { width: frame.width, height: frame.height })`
 *     and surface the result to JS (shared value / runOnJS).
 *
 * fast-tflite's v5 frame-processor path is community/undocumented — see plan.md
 * Complexity Tracking. This function is the JS-thread shim used by tests and by
 * the screen before the worklet is attached.
 */
export function detectFace(candidates: DetectionCandidate[], frame: FrameDims): DetectedFace | null {
  return parseDetection(candidates, frame);
}

export const FaceDetector = {
  modelAsset: MODEL_FACE_DETECTOR,
  computeQualityScore,
  selectBestDetection,
  parseDetection,
  detectFace,
};
