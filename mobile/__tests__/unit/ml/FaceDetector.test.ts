/**
 * T032 (FaceDetector) pure-logic tests. The BlazeFace TFLite inference + anchor
 * decoding run inside the native VisionCamera v5 frame processor; these tests
 * cover the JS-side detection selection + quality scoring that gate verification
 * (feeds the T041 quality gate via VerificationService).
 */
import {
  computeQualityScore,
  selectBestDetection,
  parseDetection,
  type DetectionCandidate,
} from '../../../src/ml/FaceDetector';
import { FACE_MIN_QUALITY_SCORE } from '../../../src/constants';

const FRAME = { width: 1000, height: 1000 };

const candidate = (over: Partial<DetectionCandidate> = {}): DetectionCandidate => ({
  boundingBox: { x: 400, y: 400, width: 200, height: 200 }, // centered, ~4% area
  landmarks: Array.from({ length: 6 }, () => ({ x: 500, y: 500 })),
  score: 0.95,
  ...over,
});

describe('computeQualityScore', () => {
  it('given_large_centered_confident_face_then_high_quality', () => {
    const big = candidate({ boundingBox: { x: 300, y: 300, width: 400, height: 400 } });
    const q = computeQualityScore(big, FRAME);
    expect(q).toBeGreaterThan(FACE_MIN_QUALITY_SCORE);
    expect(q).toBeLessThanOrEqual(1);
  });

  it('given_tiny_off_center_low_confidence_face_then_low_quality', () => {
    const tiny = candidate({
      boundingBox: { x: 10, y: 10, width: 40, height: 40 },
      score: 0.55,
    });
    expect(computeQualityScore(tiny, FRAME)).toBeLessThan(FACE_MIN_QUALITY_SCORE);
  });

  it('clamps_into_the_unit_interval', () => {
    const q = computeQualityScore(candidate({ score: 1 }), FRAME);
    expect(q).toBeGreaterThanOrEqual(0);
    expect(q).toBeLessThanOrEqual(1);
  });
});

describe('selectBestDetection', () => {
  it('given_multiple_candidates_then_picks_highest_score', () => {
    const best = selectBestDetection([
      candidate({ score: 0.6 }),
      candidate({ score: 0.92 }),
      candidate({ score: 0.71 }),
    ]);
    expect(best?.score).toBe(0.92);
  });

  it('given_all_below_detection_threshold_then_null', () => {
    expect(selectBestDetection([candidate({ score: 0.2 }), candidate({ score: 0.1 })])).toBeNull();
  });

  it('given_no_candidates_then_null', () => {
    expect(selectBestDetection([])).toBeNull();
  });
});

describe('parseDetection', () => {
  it('given_no_candidates_then_null', () => {
    expect(parseDetection([], FRAME)).toBeNull();
  });

  it('given_a_valid_detection_then_returns_DetectedFace_with_quality_and_geometry', () => {
    const face = parseDetection([candidate()], FRAME);
    expect(face).not.toBeNull();
    expect(face?.boundingBox).toEqual({ x: 400, y: 400, width: 200, height: 200 });
    expect(face?.landmarks).toHaveLength(6);
    expect(face?.qualityScore).toBeGreaterThan(0);
    expect(face?.qualityScore).toBeLessThanOrEqual(1);
  });
});
