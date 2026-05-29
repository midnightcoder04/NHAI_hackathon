import {
  FACE_DETECTION_SCORE_THRESHOLD,
  FACE_QUALITY_TARGET_AREA_RATIO,
  MODEL_FACE_DETECTOR,
  BLAZEFACE_INPUT_SIZE,
  BLAZEFACE_SCORE_THRESHOLD,
  BLAZEFACE_IOU_THRESHOLD,
  BLAZEFACE_BOX_PAD_X,
  BLAZEFACE_BOX_PAD_Y,
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

// ---------------------------------------------------------------------------
// BlazeFace short-range f16 output decode — mirrors gen_anchors/decode/nms in
// scripts/test_blazeface_f16.py. Turns the model's raw (classificators,
// regressors) tensors into DetectionCandidate[] in frame-pixel coordinates.
// ---------------------------------------------------------------------------

/**
 * The 896 BlazeFace anchor centres (normalised 0..1): 16×16 grid ×2 (512) then
 * 8×8 grid ×6 (384). Order matches the model's output rows.
 */
export function generateBlazeFaceAnchors(): Point[] {
  const anchors: Point[] = [];
  for (let n = 0; n < 16 * 16; n++) {
    const r = Math.floor(n / 16);
    const c = n % 16;
    const p = { x: (c + 0.5) / 16, y: (r + 0.5) / 16 };
    anchors.push(p, p); // 2 anchors per cell
  }
  for (let n = 0; n < 8 * 8; n++) {
    const r = Math.floor(n / 8);
    const c = n % 8;
    const p = { x: (c + 0.5) / 8, y: (r + 0.5) / 8 };
    for (let k = 0; k < 6; k++) anchors.push(p); // 6 anchors per cell
  }
  return anchors;
}

const BLAZEFACE_ANCHORS = generateBlazeFaceAnchors();

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-Math.max(-50, Math.min(50, x))));

interface NormBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function iou(a: NormBox, b: NormBox): number {
  const xx1 = Math.max(a.x1, b.x1);
  const yy1 = Math.max(a.y1, b.y1);
  const xx2 = Math.min(a.x2, b.x2);
  const yy2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, xx2 - xx1) * Math.max(0, yy2 - yy1);
  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
  return inter / (areaA + areaB - inter + 1e-9);
}

export interface BlazeFaceDecodeOptions {
  scoreThreshold?: number;
  iouThreshold?: number;
  padX?: number;
  padY?: number;
}

/**
 * Decode raw BlazeFace output into DetectionCandidate[] in frame-pixel coords.
 *
 * @param scores     raw classificator logits, length = BLAZEFACE_NUM_ANCHORS (896)
 * @param regressors raw box/keypoint regressors, length = 896 × 16 (row-major)
 * @param frame      output frame dims to scale normalised coords back into
 */
export function decodeBlazeFace(
  scores: Float32Array | number[],
  regressors: Float32Array | number[],
  frame: FrameDims,
  opts: BlazeFaceDecodeOptions = {},
): DetectionCandidate[] {
  const scoreThr = opts.scoreThreshold ?? BLAZEFACE_SCORE_THRESHOLD;
  const iouThr = opts.iouThreshold ?? BLAZEFACE_IOU_THRESHOLD;
  const padX = opts.padX ?? BLAZEFACE_BOX_PAD_X;
  const padY = opts.padY ?? BLAZEFACE_BOX_PAD_Y;
  const S = BLAZEFACE_INPUT_SIZE;

  type Raw = { box: NormBox; landmarks: Point[]; score: number };
  const raws: Raw[] = [];

  for (let i = 0; i < BLAZEFACE_ANCHORS.length; i++) {
    const conf = sigmoid(scores[i]);
    if (conf <= scoreThr) continue;
    const a = BLAZEFACE_ANCHORS[i];
    const o = i * 16;
    const cx = regressors[o] / S + a.x;
    const cy = regressors[o + 1] / S + a.y;
    const w = regressors[o + 2] / S;
    const h = regressors[o + 3] / S;
    let x1 = cx - w / 2;
    let y1 = cy - h / 2;
    let x2 = cx + w / 2;
    let y2 = cy + h / 2;
    // clip + drop degenerate boxes (matches the Python valid-area filter)
    x1 = Math.max(0, Math.min(1, x1));
    y1 = Math.max(0, Math.min(1, y1));
    x2 = Math.max(0, Math.min(1, x2));
    y2 = Math.max(0, Math.min(1, y2));
    if (x2 - x1 <= 1e-3 || y2 - y1 <= 1e-3) continue;

    const landmarks: Point[] = [];
    for (let k = 0; k < 6; k++) {
      landmarks.push({
        x: regressors[o + 4 + k * 2] / S + a.x,
        y: regressors[o + 5 + k * 2] / S + a.y,
      });
    }
    raws.push({ box: { x1, y1, x2, y2 }, landmarks, score: conf });
  }

  // Greedy NMS by descending score.
  raws.sort((p, q) => q.score - p.score);
  const kept: Raw[] = [];
  for (const r of raws) {
    if (kept.every((k) => iou(r.box, k.box) < iouThr)) kept.push(r);
  }

  return kept.map((r) => {
    // Expand the tight BlazeFace box per side, then scale to frame pixels.
    const pw = (r.box.x2 - r.box.x1) * padX;
    const ph = (r.box.y2 - r.box.y1) * padY;
    const x1 = Math.max(0, Math.min(1, r.box.x1 - pw));
    const y1 = Math.max(0, Math.min(1, r.box.y1 - ph));
    const x2 = Math.max(0, Math.min(1, r.box.x2 + pw));
    const y2 = Math.max(0, Math.min(1, r.box.y2 + ph));
    return {
      boundingBox: {
        x: x1 * frame.width,
        y: y1 * frame.height,
        width: (x2 - x1) * frame.width,
        height: (y2 - y1) * frame.height,
      },
      landmarks: r.landmarks.map((p) => ({ x: p.x * frame.width, y: p.y * frame.height })),
      score: r.score,
    };
  });
}

/** Minimal boxed-TFLite surface needed to run detection (see tfliteRuntime). */
export interface TfliteRunner {
  runSync(input: ArrayBuffer[]): ArrayBuffer[];
}

/**
 * Run the boxed BlazeFace model on a preprocessed input buffer and reduce its
 * output to the single best DetectedFace. The two output tensors are
 * disambiguated by length (896 scores vs 896×16 regressors), so output ordering
 * doesn't matter. Called on the frame-processing runtime (see frameProcessor.ts).
 */
export function runFaceDetection(
  model: TfliteRunner,
  input: ArrayBuffer,
  frame: FrameDims,
  opts: BlazeFaceDecodeOptions = {},
): DetectedFace | null {
  const outputs = model.runSync([input]).map((b) => new Float32Array(b));
  const [scores, regressors] =
    outputs[0].length <= outputs[1].length ? [outputs[0], outputs[1]] : [outputs[1], outputs[0]];
  return parseDetection(decodeBlazeFace(scores, regressors, frame, opts), frame);
}

export const FaceDetector = {
  modelAsset: MODEL_FACE_DETECTOR,
  computeQualityScore,
  selectBestDetection,
  parseDetection,
  detectFace,
  generateBlazeFaceAnchors,
  decodeBlazeFace,
  runFaceDetection,
};
