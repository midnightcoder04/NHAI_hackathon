import {
  LIVENESS_BLINK_FRAMES,
  LIVENESS_EAR_CLOSED_THRESHOLD,
  LIVENESS_ANTISPOOF_REAL_THRESHOLD,
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

export const LivenessDetector = { eyeAspectRatio, detectBlink, fuseLiveness, check };
