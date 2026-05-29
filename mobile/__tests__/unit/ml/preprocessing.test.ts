/**
 * Model preprocessing math, transcribed from scripts/test_*.py. Verifies the
 * exact normalisation/quantisation each TFLite stage expects.
 */
import {
  preprocessBlazeFace,
  preprocessFaceMesh,
  preprocessAntispoof,
  quantizeEmbeddingInput,
  dequantizeAndNormalize,
  softmax2,
  antispoofRealProbability,
} from '../../../src/ml/preprocessing';
import { ANTISPOOF_MEAN, ANTISPOOF_STD } from '../../../src/constants';

describe('preprocessBlazeFace ([-1,1])', () => {
  it('maps_0_to_-1_and_255_to_1', () => {
    const out = preprocessBlazeFace([0, 255, 127.5]);
    expect(out[0]).toBeCloseTo(-1);
    expect(out[1]).toBeCloseTo(1);
    expect(out[2]).toBeCloseTo(0);
  });
});

describe('preprocessFaceMesh ([0,1])', () => {
  it('maps_0_to_0_and_255_to_1', () => {
    const out = preprocessFaceMesh([0, 255]);
    expect(out[0]).toBeCloseTo(0);
    expect(out[1]).toBeCloseTo(1);
  });
});

describe('preprocessAntispoof (ImageNet)', () => {
  it('applies_per_channel_mean_std', () => {
    const out = preprocessAntispoof([0, 0, 0, 255, 255, 255]);
    for (let c = 0; c < 3; c++) {
      expect(out[c]).toBeCloseTo((0 - ANTISPOOF_MEAN[c]) / ANTISPOOF_STD[c]);
      expect(out[3 + c]).toBeCloseTo((1 - ANTISPOOF_MEAN[c]) / ANTISPOOF_STD[c]);
    }
  });
});

describe('quantizeEmbeddingInput (int8)', () => {
  it('quantises_round_x_over_scale_plus_zp_and_clips', () => {
    const scale = 1 / 256; // 0.00390625
    const zp = -128;
    // px=255 → x=1.0 → round(256 + -128) = 128 → clipped to 127
    // px=0   → x=0   → round(0 + -128) = -128
    const out = quantizeEmbeddingInput([255, 0], scale, zp);
    expect(out[0]).toBe(127);
    expect(out[1]).toBe(-128);
    expect(out).toBeInstanceOf(Int8Array);
  });
});

describe('dequantizeAndNormalize', () => {
  it('dequantises_then_returns_a_unit_vector', () => {
    const v = dequantizeAndNormalize([10, 0, 0, 0], 0.5, 0);
    const norm = Math.sqrt([...v].reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
    expect(v[0]).toBeCloseTo(1); // only the first component is non-zero
  });
});

describe('softmax2 / antispoofRealProbability', () => {
  it('sums_to_one_and_favours_the_larger_logit', () => {
    const [p0, p1] = softmax2([0, 2]);
    expect(p0 + p1).toBeCloseTo(1);
    expect(p1).toBeGreaterThan(p0);
  });

  it('real_probability_is_class_1', () => {
    expect(antispoofRealProbability([5, -5])).toBeLessThan(0.5); // spoof-leaning
    expect(antispoofRealProbability([-5, 5])).toBeGreaterThan(0.5); // real-leaning
  });
});
