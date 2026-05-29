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
  generateBlazeFaceAnchors,
  decodeBlazeFace,
  runFaceDetection,
  type DetectionCandidate,
} from '../../../src/ml/FaceDetector';
import { FACE_MIN_QUALITY_SCORE, BLAZEFACE_NUM_ANCHORS } from '../../../src/constants';

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

// --- BlazeFace raw-output decode (mirrors scripts/test_blazeface_f16.py) ---

// One anchor (index `i`) gets a high score; row regressors place a w×h box centred
// on that anchor. All other anchors score far below threshold.
const buildRawOutput = (
  i: number,
  { score = 10, w = 0.2, h = 0.2 }: { score?: number; w?: number; h?: number } = {},
) => {
  const scores = new Float32Array(BLAZEFACE_NUM_ANCHORS).fill(-10);
  scores[i] = score;
  const regressors = new Float32Array(BLAZEFACE_NUM_ANCHORS * 16); // zeros: cx=cy=anchor, kps=anchor
  regressors[i * 16 + 2] = w * 128; // width  (decode divides by 128)
  regressors[i * 16 + 3] = h * 128; // height
  return { scores, regressors };
};

describe('generateBlazeFaceAnchors', () => {
  it('produces_896_anchors_512_from_16x16_plus_384_from_8x8', () => {
    const anchors = generateBlazeFaceAnchors();
    expect(anchors).toHaveLength(896);
    expect(anchors[0]).toEqual({ x: 0.5 / 16, y: 0.5 / 16 }); // first 16×16 cell
    expect(anchors[512]).toEqual({ x: 0.5 / 8, y: 0.5 / 8 }); // first 8×8 cell
  });
});

describe('decodeBlazeFace', () => {
  it('given_one_high_score_anchor_then_one_candidate_in_frame_pixels', () => {
    const { scores, regressors } = buildRawOutput(0);
    const dets = decodeBlazeFace(scores, regressors, { width: 100, height: 100 }, { padX: 0, padY: 0 });
    expect(dets).toHaveLength(1);
    // anchor[0] centre = 0.03125; box 0.2 wide → x1 clips to 0, x2 = 0.13125
    expect(dets[0].boundingBox.x).toBeCloseTo(0);
    expect(dets[0].boundingBox.width).toBeCloseTo(13.125, 2);
    expect(dets[0].landmarks).toHaveLength(6);
    expect(dets[0].score).toBeGreaterThan(0.99);
  });

  it('applies_vertical_padding_to_expand_the_box', () => {
    const { scores, regressors } = buildRawOutput(300, { w: 0.1, h: 0.1 });
    const noPad = decodeBlazeFace(scores, regressors, { width: 100, height: 100 }, { padX: 0, padY: 0 });
    const padded = decodeBlazeFace(scores, regressors, { width: 100, height: 100 }, { padX: 0, padY: 0.5 });
    expect(padded[0].boundingBox.height).toBeGreaterThan(noPad[0].boundingBox.height);
  });

  it('suppresses_overlapping_duplicates_via_nms', () => {
    // anchors 0 and 1 share a centre (16×16 grid ×2) → identical boxes → IoU 1.
    const scores = new Float32Array(BLAZEFACE_NUM_ANCHORS).fill(-10);
    scores[0] = 10;
    scores[1] = 8;
    const regressors = new Float32Array(BLAZEFACE_NUM_ANCHORS * 16);
    for (const i of [0, 1]) {
      regressors[i * 16 + 2] = 0.2 * 128;
      regressors[i * 16 + 3] = 0.2 * 128;
    }
    const dets = decodeBlazeFace(scores, regressors, { width: 100, height: 100 }, { padX: 0, padY: 0 });
    expect(dets).toHaveLength(1);
    expect(dets[0].score).toBeGreaterThan(0.99); // the higher-scoring anchor survives
  });

  it('given_all_scores_below_threshold_then_empty', () => {
    const scores = new Float32Array(BLAZEFACE_NUM_ANCHORS).fill(-10);
    const regressors = new Float32Array(BLAZEFACE_NUM_ANCHORS * 16);
    expect(decodeBlazeFace(scores, regressors, { width: 100, height: 100 })).toEqual([]);
  });
});

describe('runFaceDetection', () => {
  it('disambiguates_score_vs_regressor_outputs_by_length_in_any_order', () => {
    const { scores, regressors } = buildRawOutput(0);
    const frame = { width: 200, height: 200 };
    // model output order shouldn't matter: regressors first, scores second.
    const model = { runSync: () => [regressors.buffer, scores.buffer] };
    const face = runFaceDetection(model, new ArrayBuffer(8), frame, { padX: 0, padY: 0 });
    expect(face).not.toBeNull();
    expect(face?.landmarks).toHaveLength(6);
    expect(face?.qualityScore).toBeGreaterThan(0);
  });

  it('returns_null_when_no_face_detected', () => {
    const scores = new Float32Array(BLAZEFACE_NUM_ANCHORS).fill(-10);
    const regressors = new Float32Array(BLAZEFACE_NUM_ANCHORS * 16);
    const model = { runSync: () => [scores.buffer, regressors.buffer] };
    expect(runFaceDetection(model, new ArrayBuffer(8), { width: 200, height: 200 })).toBeNull();
  });
});
