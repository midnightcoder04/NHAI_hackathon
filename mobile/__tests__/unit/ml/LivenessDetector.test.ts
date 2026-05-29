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
  check,
  extractEyeLandmarks,
  EAR_RIGHT_EYE_INDICES,
  EAR_LEFT_EYE_INDICES,
  type Point,
  type EyeLandmarks,
  type LivenessDeps,
} from '../../../src/ml/LivenessDetector';
import { LIVENESS_BLINK_FRAMES } from '../../../src/constants';

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
    expect(fuseLiveness(true, 0.1)).toBe('spoof');
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
    const frames = [frame(true, 0.1), frame(false, 0.1), frame(true, 0.1)];
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
