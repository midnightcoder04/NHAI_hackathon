/**
 * T089 (write-first, precedes T033): LivenessDetector dual-layer logic.
 *
 * Active layer  — eye-aspect-ratio (EAR) blink detection across
 *                 LIVENESS_BLINK_FRAMES consecutive frames.
 * Passive layer — Antispoof texture classifier real-probability gate.
 * Fusion        — spoof / live / inconclusive from mocked model outputs.
 *
 * The model runners (landmarks + antispoof TFLite) are injected as deps so the
 * pure decision logic is testable without the native frame-processor runtime.
 */
import {
  eyeAspectRatio,
  detectBlink,
  fuseLiveness,
  passiveLiveness,
  faceMovement,
  aggregateRealProb,
  reduceCapture,
  reduceCaptureDetailed,
  passiveLivenessDetailed,
  check,
  extractEyeLandmarks,
  EAR_RIGHT_EYE_INDICES,
  EAR_LEFT_EYE_INDICES,
  type Point,
  type EyeLandmarks,
  type LivenessDeps,
  type CaptureFrameSample,
} from '../../../src/ml/LivenessDetector';
import { LIVENESS_BLINK_FRAMES, LIVENESS_ANTISPOOF_REAL_THRESHOLD } from '../../../src/constants';

// p1..p6 in the dlib/MediaPipe EAR convention: p1,p4 = horizontal corners;
// (p2,p6) and (p3,p5) = the two vertical pairs.
const eye = (verticalGap: number): Point[] => [
  { x: 0, y: 0 }, // p1 left corner
  { x: 1, y: verticalGap / 2 }, // p2 top
  { x: 3, y: verticalGap / 2 }, // p3 top
  { x: 4, y: 0 }, // p4 right corner
  { x: 3, y: -verticalGap / 2 }, // p5 bottom
  { x: 1, y: -verticalGap / 2 }, // p6 bottom
];

const OPEN_EYE = eye(2); // EAR = (2 + 2) / (2 * 4) = 0.5  → open
const CLOSED_EYE = eye(0.2); // EAR = (0.2 + 0.2) / (2 * 4) = 0.05 → closed

const eyes = (e: Point[]): EyeLandmarks => ({ left: e, right: e });

interface FakeFrame {
  open: boolean;
  real: number;
  face?: boolean;
}

const deps = (over: Partial<LivenessDeps<FakeFrame>> = {}): LivenessDeps<FakeFrame> => ({
  runLandmarks: (f) => (f.face === false ? null : eyes(f.open ? OPEN_EYE : CLOSED_EYE)),
  runAntispoof: (f) => f.real,
  ...over,
});

const frame = (open: boolean, real = 0.9, face = true): FakeFrame => ({ open, real, face });

describe('eyeAspectRatio', () => {
  it('given_open_eye_then_high_ratio', () => {
    expect(eyeAspectRatio(OPEN_EYE)).toBeCloseTo(0.5);
  });

  it('given_closed_eye_then_low_ratio_below_blink_threshold', () => {
    expect(eyeAspectRatio(CLOSED_EYE)).toBeLessThan(0.2);
  });

  it('given_degenerate_zero_width_eye_then_zero', () => {
    const degenerate: Point[] = [
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: 1 },
      { x: 0, y: 0 },
      { x: 0, y: -1 },
      { x: 0, y: -1 },
    ];
    expect(eyeAspectRatio(degenerate)).toBe(0);
  });
});

describe('detectBlink', () => {
  it('given_open_closed_open_series_then_blink_detected', () => {
    expect(detectBlink([0.5, 0.05, 0.5])).toBe(true);
  });

  it('given_all_open_series_then_no_blink', () => {
    expect(detectBlink([0.5, 0.5, 0.5])).toBe(false);
  });

  it('given_fewer_than_blink_frames_then_no_blink', () => {
    expect(detectBlink([0.5, 0.05])).toBe(false);
  });

  it('uses_LIVENESS_BLINK_FRAMES_as_the_minimum_window', () => {
    const justEnough = Array(LIVENESS_BLINK_FRAMES).fill(0.5);
    justEnough[1] = 0.05; // a dip in the middle
    expect(detectBlink(justEnough)).toBe(true);
  });
});

describe('fuseLiveness', () => {
  it('given_low_real_probability_then_spoof_regardless_of_blink', () => {
    // gate is ≈0 now, so a "spoof" texture reading must be ~zero (see threshold note).
    expect(fuseLiveness(true, 0)).toBe('spoof');
  });

  it('given_real_face_and_blink_then_live', () => {
    expect(fuseLiveness(true, 0.9)).toBe('live');
  });

  it('given_real_face_but_no_blink_then_inconclusive', () => {
    expect(fuseLiveness(false, 0.9)).toBe('inconclusive');
  });
});

describe('check (frame stream fusion)', () => {
  it('given_blink_and_real_texture_then_live', () => {
    const frames = [frame(true), frame(false), frame(true)];
    expect(check(frames, deps())).toBe('live');
  });

  it('given_printed_photo_low_texture_then_spoof', () => {
    const frames = [frame(true, 0), frame(false, 0), frame(true, 0)];
    expect(check(frames, deps())).toBe('spoof');
  });

  it('given_real_texture_but_no_blink_then_inconclusive', () => {
    const frames = [frame(true), frame(true), frame(true)];
    expect(check(frames, deps())).toBe('inconclusive');
  });

  it('given_too_few_frames_then_inconclusive', () => {
    expect(check([frame(true)], deps())).toBe('inconclusive');
  });

  it('given_no_face_in_any_frame_then_inconclusive', () => {
    const frames = [frame(true, 0.9, false), frame(false, 0.9, false), frame(true, 0.9, false)];
    expect(check(frames, deps())).toBe('inconclusive');
  });
});

describe('passiveLiveness (antispoof-only verdict — least-compute layer)', () => {
  it('given_no_frames_then_inconclusive', () => {
    expect(passiveLiveness([])).toBe('inconclusive');
  });

  it('given_high_mean_real_probability_then_live', () => {
    expect(passiveLiveness([0.9, 0.8, 0.95])).toBe('live');
  });

  it('given_below_threshold_mean_real_probability_then_spoof', () => {
    // With the gate effectively disabled (≈0.001) only a ~zero reading is a spoof.
    expect(passiveLiveness([0, 0, 0])).toBe('spoof');
  });

  it('uses_LIVENESS_ANTISPOOF_REAL_THRESHOLD_as_the_boundary', () => {
    // a mean just over the gate → live, just under → spoof (threshold-relative so it
    // tracks LIVENESS_ANTISPOOF_REAL_THRESHOLD instead of hard-coding the value; clamped
    // to [0,1] since the gate is now ≈0).
    const t = LIVENESS_ANTISPOOF_REAL_THRESHOLD;
    expect(passiveLiveness([Math.min(1, t + 0.05), Math.min(1, t + 0.05)])).toBe('live');
    expect(passiveLiveness([Math.max(0, t - 0.05), Math.max(0, t - 0.05)])).toBe('spoof');
  });
});

describe('faceMovement', () => {
  const pt = (cx: number, cy: number, size = 100): CaptureFrameSample => ({
    facePresent: true,
    ear: null,
    realProb: 0.9,
    cx,
    cy,
    size,
  });

  it('given_fewer_than_two_located_faces_then_zero', () => {
    expect(faceMovement([])).toBe(0);
    expect(faceMovement([pt(10, 10)])).toBe(0);
  });

  it('given_moving_centre_then_ratio_of_travel_to_face_size', () => {
    // centre travels 120px horizontally, mean size 100 → ratio 1.2
    expect(faceMovement([pt(0, 50), pt(60, 50), pt(120, 50)])).toBeCloseTo(1.2, 5);
  });

  it('given_only_jitter_then_near_zero', () => {
    expect(faceMovement([pt(100, 100), pt(101, 100), pt(100, 101)])).toBeLessThan(0.04);
  });
});

describe('reduceCapture (window → liveness verdict: movement OR blink, antispoof gates)', () => {
  const cap = (
    over: Partial<CaptureFrameSample> = {},
  ): CaptureFrameSample => ({ facePresent: true, ear: null, realProb: 0.9, cx: 100, cy: 100, size: 100, ...over });
  const absent: CaptureFrameSample = { facePresent: false, ear: null, realProb: null, cx: null, cy: null, size: null };
  const still = (n: number, realProb = 0.9): CaptureFrameSample[] =>
    Array.from({ length: n }, () => cap({ realProb })); // face held perfectly still (no movement)
  const moving = (n: number, realProb = 0.9): CaptureFrameSample[] =>
    Array.from({ length: n }, (_, i) => cap({ cx: 100 + i * 30, realProb })); // centre drifts

  it('given_no_samples_then_inconclusive', () => {
    expect(reduceCapture([])).toBe('inconclusive');
  });

  it('given_too_few_face_frames_then_inconclusive', () => {
    expect(reduceCapture(moving(3))).toBe('inconclusive'); // < LIVENESS_MIN_FACE_FRAMES (4)
  });

  it('given_head_movement_and_real_texture_then_live', () => {
    expect(reduceCapture(moving(5))).toBe('live');
  });

  it('given_blink_and_real_texture_even_without_movement_then_live', () => {
    // EAR open→closed→open on a still face (no movement) still passes via the blink OR-branch.
    const blink = [cap({ ear: 0.5 }), cap({ ear: 0.05 }), cap({ ear: 0.5 }), cap({ ear: 0.5 })];
    expect(reduceCapture(blink)).toBe('live');
  });

  it('given_movement_but_low_texture_then_spoof_passive_dominates', () => {
    expect(reduceCapture(moving(5, 0))).toBe('spoof');
  });

  it('given_real_texture_but_no_movement_and_no_blink_then_inconclusive', () => {
    expect(reduceCapture(still(5))).toBe('inconclusive');
  });

  it('given_face_not_held_for_enough_of_the_window_then_inconclusive_continuity_gate', () => {
    // 4 moving frames + 4 absent → presence 0.5 < 0.6 ⇒ possible swap/pull-away.
    expect(reduceCapture([...moving(4), absent, absent, absent, absent])).toBe('inconclusive');
  });
});

describe('aggregateRealProb (trimmed-mean antispoof, anti-fluctuation)', () => {
  it('given_empty_then_zero', () => {
    expect(aggregateRealProb([])).toBe(0);
  });

  it('given_fewer_than_four_then_plain_mean', () => {
    expect(aggregateRealProb([0.2, 0.8])).toBeCloseTo(0.5);
  });

  it('given_four_or_more_then_drops_lowest_and_highest', () => {
    // [0.0, 0.9, 0.9, 0.9, 1.0] → trim 0.0 and 1.0 → mean(0.9,0.9,0.9) = 0.9.
    expect(aggregateRealProb([0.9, 0.0, 0.9, 1.0, 0.9])).toBeCloseTo(0.9);
  });

  it('given_a_single_outlier_spike_then_verdict_is_not_flipped', () => {
    // One jittery low frame among a live plateau stays above the 0.85 gate.
    expect(aggregateRealProb([0.95, 0.96, 0.05, 0.97, 0.95])).toBeGreaterThan(0.85);
  });
});

describe('reduceCaptureDetailed (verdict + specific failing-layer reason)', () => {
  const cap = (over: Partial<CaptureFrameSample> = {}): CaptureFrameSample => ({
    facePresent: true,
    ear: null,
    realProb: 0.9,
    cx: 100,
    cy: 100,
    size: 100,
    ...over,
  });
  const absent: CaptureFrameSample = {
    facePresent: false,
    ear: null,
    realProb: null,
    cx: null,
    cy: null,
    size: null,
  };
  const still = (n: number, realProb = 0.9): CaptureFrameSample[] =>
    Array.from({ length: n }, () => cap({ realProb }));
  const moving = (n: number, realProb = 0.9): CaptureFrameSample[] =>
    Array.from({ length: n }, (_, i) => cap({ cx: 100 + i * 30, realProb }));

  it('given_no_samples_then_inconclusive_no_face', () => {
    expect(reduceCaptureDetailed([])).toEqual({ result: 'inconclusive', reason: 'no_face' });
  });

  it('given_face_absent_for_most_of_window_then_no_face', () => {
    expect(reduceCaptureDetailed([...moving(4), absent, absent, absent, absent])).toEqual({
      result: 'inconclusive',
      reason: 'no_face',
    });
  });

  it('given_low_texture_then_spoof_reason', () => {
    expect(reduceCaptureDetailed(moving(5, 0))).toEqual({ result: 'spoof', reason: 'spoof' });
  });

  it('given_real_texture_but_no_active_signal_then_no_movement_reason', () => {
    expect(reduceCaptureDetailed(still(5))).toEqual({
      result: 'inconclusive',
      reason: 'no_movement',
    });
  });

  it('given_movement_and_real_texture_then_live', () => {
    expect(reduceCaptureDetailed(moving(5))).toEqual({ result: 'live', reason: 'live' });
  });

  it('reduceCapture_stays_in_sync_with_the_detailed_result', () => {
    expect(reduceCapture(moving(5))).toBe(reduceCaptureDetailed(moving(5)).result);
    expect(reduceCapture(moving(5, 0))).toBe(reduceCaptureDetailed(moving(5, 0)).result);
  });
});

describe('passiveLivenessDetailed (Phase-3 burst: antispoof-only, active already passed)', () => {
  it('given_no_frames_then_inconclusive_no_face', () => {
    expect(passiveLivenessDetailed([])).toEqual({ result: 'inconclusive', reason: 'no_face' });
  });

  it('given_high_aggregate_real_prob_then_live', () => {
    expect(passiveLivenessDetailed([0.95, 0.96, 0.97, 0.95])).toEqual({
      result: 'live',
      reason: 'live',
    });
  });

  it('given_low_aggregate_real_prob_then_spoof', () => {
    expect(passiveLivenessDetailed([0, 0, 0, 0])).toEqual({
      result: 'spoof',
      reason: 'spoof',
    });
  });

  it('given_a_single_jittery_low_frame_then_still_live_trimmed_mean', () => {
    // The trimmed mean drops the one 0.05 spike → the live plateau survives the gate.
    expect(passiveLivenessDetailed([0.95, 0.96, 0.05, 0.97, 0.95]).result).toBe('live');
  });
});

describe('extractEyeLandmarks (FaceMesh 478-pt → EAR)', () => {
  it('reads_6_points_per_eye_at_the_mediapipe_indices', () => {
    const mesh = new Float32Array(478 * 3);
    // tag landmark k with x=k so we can confirm the right indices are read
    for (let k = 0; k < 478; k++) mesh[k * 3] = k;
    const eyes = extractEyeLandmarks(mesh);
    expect(eyes.right).toHaveLength(6);
    expect(eyes.left).toHaveLength(6);
    expect(eyes.right.map((p) => p.x)).toEqual([...EAR_RIGHT_EYE_INDICES]);
    expect(eyes.left.map((p) => p.x)).toEqual([...EAR_LEFT_EYE_INDICES]);
  });

  it('produces_eye_geometry_whose_EAR_reads_open_when_lids_are_apart', () => {
    const mesh = new Float32Array(478 * 3);
    const set = (k: number, x: number, y: number) => {
      mesh[k * 3] = x;
      mesh[k * 3 + 1] = y;
    };
    // Lay out the right eye as a wide-open eye: corners apart on x, lids apart on y.
    const [p1, p2, p3, p4, p5, p6] = EAR_RIGHT_EYE_INDICES;
    set(p1, 0, 0);
    set(p4, 4, 0);
    set(p2, 1, 1);
    set(p3, 3, 1);
    set(p5, 3, -1);
    set(p6, 1, -1);
    const { right } = extractEyeLandmarks(mesh);
    expect(eyeAspectRatio(right)).toBeCloseTo(0.5); // (2+2)/(2*4)
  });
});
