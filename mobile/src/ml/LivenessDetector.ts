import {
  LIVENESS_BLINK_FRAMES,
  LIVENESS_EAR_CLOSED_THRESHOLD,
  LIVENESS_ANTISPOOF_REAL_THRESHOLD,
  LIVENESS_MIN_PRESENCE_RATIO,
  LIVENESS_MIN_FACE_FRAMES,
  LIVENESS_MOVE_RATIO_THRESHOLD,
} from '../constants';
import type { LivenessResult } from '../services/VerificationService';

export type { LivenessResult };

export interface Point {
  x: number;
  y: number;
}

/**
 * Six landmarks per eye in the dlib/MediaPipe EAR convention:
 * [p1, p2, p3, p4, p5, p6] where p1/p4 are the horizontal corners and
 * (p2,p6) + (p3,p5) are the two vertical pairs.
 */
export interface EyeLandmarks {
  left: Point[];
  right: Point[];
}

/**
 * Injected model runners so the fusion logic is unit-testable without the native
 * frame-processor runtime. In production these are the boxed TFLite models run
 * inside the VisionCamera v5 worklet (T032 setup):
 *  - runLandmarks: MiniFASNet/landmarks f16 (MODEL_LIVENESS_LANDMARKS) → eye points
 *  - runAntispoof: Antispoof INT8 (MODEL_LIVENESS_ANTISPOOF) on the 128×128 ROI
 *                  → probability the texture is a real (live) face, in [0, 1].
 */
export interface LivenessDeps<F> {
  runLandmarks: (frame: F) => EyeLandmarks | null;
  runAntispoof: (frame: F) => number;
  blinkFrames?: number;
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Eye-aspect-ratio: EAR = (|p2-p6| + |p3-p5|) / (2·|p1-p4|). High when the eye is
 * open, near zero when closed. Returns 0 for a degenerate (zero-width) eye.
 */
export function eyeAspectRatio(eye: Point[]): number {
  if (eye.length < 6) return 0;
  const [p1, p2, p3, p4, p5, p6] = eye;
  const horizontal = dist(p1, p4);
  if (horizontal === 0) return 0;
  return (dist(p2, p6) + dist(p3, p5)) / (2 * horizontal);
}

/**
 * A blink is an open → closed → open transition observed within the EAR series.
 * Requires at least `blinkFrames` samples so a single noisy frame can't trigger it.
 */
export function detectBlink(
  earSeries: number[],
  blinkFrames: number = LIVENESS_BLINK_FRAMES,
): boolean {
  if (earSeries.length < blinkFrames) return false;
  let sawOpen = false;
  let sawClosedAfterOpen = false;
  for (const ear of earSeries) {
    const closed = ear < LIVENESS_EAR_CLOSED_THRESHOLD;
    if (!closed) {
      if (sawClosedAfterOpen) return true; // open after a closure → full blink cycle
      sawOpen = true;
    } else if (sawOpen) {
      sawClosedAfterOpen = true;
    }
  }
  return false;
}

/**
 * Fuse the two layers. The passive texture gate dominates: a low real-probability
 * is a spoof even if the active layer saw a "blink" (a wobbled photo). Otherwise a
 * confirmed blink is live; a real face with no confirmed blink is inconclusive.
 */
export function fuseLiveness(blinkDetected: boolean, realProbability: number): LivenessResult {
  if (realProbability < LIVENESS_ANTISPOOF_REAL_THRESHOLD) return 'spoof';
  if (blinkDetected) return 'live';
  return 'inconclusive';
}

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

/**
 * Passive-only liveness verdict from the Antispoof texture classifier alone — the
 * least-compute liveness layer (a single ~30 ms INT8 model, no multi-frame blink /
 * FaceMesh). `live` iff the mean real-probability across the captured frames clears
 * LIVENESS_ANTISPOOF_REAL_THRESHOLD; `spoof` if it doesn't; `inconclusive` when there
 * were no usable (face-bearing) frames.
 *
 * Because antispoof runs in the SAME frame-processor pass as detection (same pixel
 * buffer), this verdict is bound to the exact frames identity-matching will use —
 * closing the time-of-check/time-of-use gap that a separate "check liveness, then
 * wait for a new frame to match" flow would open.
 */
export function passiveLiveness(realProbabilities: readonly number[]): LivenessResult {
  if (realProbabilities.length === 0) return 'inconclusive';
  return mean([...realProbabilities]) >= LIVENESS_ANTISPOOF_REAL_THRESHOLD ? 'live' : 'spoof';
}

/**
 * One frame of the live capture window, as produced by the verification worklet:
 * whether a face was tracked, the face-box centre + size (for the MOVEMENT active
 * signal), the eye-aspect-ratio (optional blink signal, null when FaceMesh isn't run),
 * and the antispoof real-probability (passive layer, null if not sampled this frame).
 * `cx`/`cy`/`size` are in any consistent unit (e.g. frame pixels) — movement is measured
 * as a ratio to `size`, so it's scale-invariant.
 */
export interface CaptureFrameSample {
  facePresent: boolean;
  ear: number | null;
  realProb: number | null;
  cx: number | null;
  cy: number | null;
  size: number | null;
}

export interface ReduceCaptureOptions {
  blinkFrames?: number;
  minPresenceRatio?: number;
  minFaceFrames?: number;
  moveRatioThreshold?: number;
}

/**
 * Natural head/face movement across the window, as the face-box centre's travel
 * (bounding range of the centres) divided by the mean face size. Scale-invariant, and
 * derived purely from the detector box that every frame already produces — so it's the
 * cheap, fast-sampling active-liveness signal (a live person never holds perfectly
 * rigid; a still photo on a stand does). Returns 0 with fewer than two located faces.
 */
export function faceMovement(samples: readonly CaptureFrameSample[]): number {
  const pts = samples.filter(
    (s): s is CaptureFrameSample & { cx: number; cy: number; size: number } =>
      s.facePresent && s.cx !== null && s.cy !== null && s.size !== null && s.size > 0,
  );
  if (pts.length < 2) return 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let sizeSum = 0;
  for (const p of pts) {
    if (p.cx < minX) minX = p.cx;
    if (p.cx > maxX) maxX = p.cx;
    if (p.cy < minY) minY = p.cy;
    if (p.cy > maxY) maxY = p.cy;
    sizeSum += p.size;
  }
  const meanSize = sizeSum / pts.length;
  return meanSize > 0 ? Math.hypot(maxX - minX, maxY - minY) / meanSize : 0;
}

/**
 * Reduce a whole capture window to a single liveness verdict, fusing an ACTIVE layer
 * with the PASSIVE (antispoof texture) layer over evidence from one continuous,
 * face-tracked presentation:
 *
 *  1. **Continuity gate** — the face must be tracked across ≥ `minPresenceRatio` of the
 *     window's frames AND in ≥ `minFaceFrames` frames. A photo-swap or pull-away
 *     mid-window drops below this → inconclusive (keeps liveness + match one
 *     presentation, closing the time-of-check/time-of-use gap).
 *  2. **Passive (dominant)** — mean antispoof real-probability; below threshold ⇒ spoof,
 *     regardless of any active signal (a wobbled/− blinking photo is still a photo).
 *  3. **Active (lenient, OR of two signals)** — natural head **movement** (cheap, every
 *     frame) OR a **blink** (EAR dip, only when FaceMesh ran). Either confirms a live,
 *     interacting subject. Movement is primary because it samples fast and doesn't need
 *     the heavy landmark model; blink is a bonus when present.
 *  4. Real texture + an active signal ⇒ live; real texture but no active signal yet ⇒
 *     inconclusive (the caller keeps sampling / the operator moves slightly).
 */
export function reduceCapture(
  samples: readonly CaptureFrameSample[],
  opts: ReduceCaptureOptions = {},
): LivenessResult {
  const blinkFrames = opts.blinkFrames ?? LIVENESS_BLINK_FRAMES;
  const minPresence = opts.minPresenceRatio ?? LIVENESS_MIN_PRESENCE_RATIO;
  const minFaceFrames = opts.minFaceFrames ?? LIVENESS_MIN_FACE_FRAMES;
  const moveThreshold = opts.moveRatioThreshold ?? LIVENESS_MOVE_RATIO_THRESHOLD;
  if (samples.length === 0) return 'inconclusive';

  const present = samples.filter((s) => s.facePresent).length;
  if (present < minFaceFrames || present / samples.length < minPresence) return 'inconclusive';

  // Passive gate dominates: a low real-probability is a spoof no matter how it moved.
  const realProbs = samples.map((s) => s.realProb).filter((p): p is number => p !== null);
  if (realProbs.length > 0 && mean(realProbs) < LIVENESS_ANTISPOOF_REAL_THRESHOLD) return 'spoof';

  // Active: movement (primary) OR blink (bonus, when EAR present).
  const moved = faceMovement(samples) >= moveThreshold;
  const earSeries = samples.map((s) => s.ear).filter((e): e is number => e !== null);
  const blink = earSeries.length >= blinkFrames && detectBlink(earSeries, blinkFrames);
  return moved || blink ? 'live' : 'inconclusive';
}

/**
 * Run both liveness layers over a captured frame stream and fuse the result.
 * Returns 'inconclusive' when there aren't enough frames (or detected faces) to
 * make a determination — never a false 'live'.
 */
export function check<F>(frames: readonly F[], deps: LivenessDeps<F>): LivenessResult {
  const blinkFrames = deps.blinkFrames ?? LIVENESS_BLINK_FRAMES;
  if (frames.length < blinkFrames) return 'inconclusive';

  const eyeFrames = frames
    .map((f) => deps.runLandmarks(f))
    .filter((l): l is EyeLandmarks => l !== null);
  if (eyeFrames.length < blinkFrames) return 'inconclusive';

  const earSeries = eyeFrames.map(
    (e) => (eyeAspectRatio(e.left) + eyeAspectRatio(e.right)) / 2,
  );
  const blink = detectBlink(earSeries, blinkFrames);
  const realProbability = mean(frames.map((f) => deps.runAntispoof(f)));
  return fuseLiveness(blink, realProbability);
}

// MediaPipe FaceMesh 6-point EAR indices (p1/p4 = horizontal corners, (p2,p6)+(p3,p5)
// = vertical pairs) into the 478-landmark output of MODEL_LIVENESS_LANDMARKS.
export const EAR_RIGHT_EYE_INDICES = [33, 160, 158, 133, 153, 144] as const;
export const EAR_LEFT_EYE_INDICES = [362, 385, 387, 263, 373, 380] as const;

/**
 * Pull the two 6-point eye landmark sets (for EAR) out of the FaceMesh model's
 * flat output (`[x0,y0,z0, x1,y1,z1, …]`, 478 points). Pass the result frame-by-
 * frame to `check` via `runLandmarks`.
 */
export function extractEyeLandmarks(meshFlat: Float32Array | number[]): EyeLandmarks {
  const at = (k: number): Point => ({ x: meshFlat[k * 3], y: meshFlat[k * 3 + 1] });
  return {
    right: EAR_RIGHT_EYE_INDICES.map(at),
    left: EAR_LEFT_EYE_INDICES.map(at),
  };
}

export const LivenessDetector = {
  eyeAspectRatio,
  detectBlink,
  fuseLiveness,
  passiveLiveness,
  faceMovement,
  reduceCapture,
  check,
  extractEyeLandmarks,
};
