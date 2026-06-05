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
  resizeRgbNearestNeighbor,
  resizeRgbAreaAverage,
  solveSimilarityTransform,
  ARCFACE_TEMPLATE_112,
} from '../../../src/ml/preprocessing';

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

describe('preprocessAntispoof (RGB + /255)', () => {
  it('keeps_rgb_order_and_scales_by_255', () => {
    // one pixel R=255,G=128,B=0 → interleaved output stays R,G,B / 255 (no swap)
    const out = preprocessAntispoof([255, 128, 0]);
    expect(out[0]).toBeCloseTo(255 / 255); // R
    expect(out[1]).toBeCloseTo(128 / 255); // G
    expect(out[2]).toBeCloseTo(0 / 255); // B
  });

  it('does_not_apply_imagenet_mean_std', () => {
    // black pixel → all zeros (ImageNet norm would give negative values)
    const out = preprocessAntispoof([0, 0, 0]);
    expect(out[0]).toBeCloseTo(0);
    expect(out[1]).toBeCloseTo(0);
    expect(out[2]).toBeCloseTo(0);
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

describe('resizeRgbNearestNeighbor', () => {
  it('downscales_2x2_to_1x1_by_nearest_sample', () => {
    // 2x2 RGB: TL red, TR green, BL blue, BR white
    const src = [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255];
    const out = resizeRgbNearestNeighbor(src, 2, 2, 1, 1);
    expect(out).toBeInstanceOf(Uint8Array);
    expect([...out]).toEqual([255, 0, 0]); // samples the top-left pixel
  });

  it('produces_dstW*dstH*3_bytes_and_preserves_a_solid_colour', () => {
    const src = new Uint8Array(4 * 4 * 3).fill(120);
    const out = resizeRgbNearestNeighbor(src, 4, 4, 2, 2);
    expect(out).toHaveLength(2 * 2 * 3);
    expect([...out].every((v) => v === 120)).toBe(true);
  });
});

describe('resizeRgbAreaAverage (box-filter anti-alias)', () => {
  it('downscales_2x2_to_1x1_by_averaging_the_footprint', () => {
    // 2x2 RGB: TL red, TR green, BL blue, BR white → 1x1 = channel-wise mean.
    const src = [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255];
    const out = resizeRgbAreaAverage(src, 2, 2, 1, 1);
    expect(out).toBeInstanceOf(Uint8Array);
    // R: (255+0+0+255)/4=127.5→128; G: (0+255+0+255)/4=127.5→128; B: (0+0+255+255)/4→128
    expect([...out]).toEqual([128, 128, 128]);
  });

  it('produces_dstW*dstH*3_bytes_and_preserves_a_solid_colour', () => {
    const src = new Uint8Array(4 * 4 * 3).fill(120);
    const out = resizeRgbAreaAverage(src, 4, 4, 2, 2);
    expect(out).toHaveLength(2 * 2 * 3);
    expect([...out].every((v) => v === 120)).toBe(true);
  });

  it('averages_a_gradient_rather_than_point_sampling_it', () => {
    // 1x4 horizontal gradient (grey) → 1x2: each output = mean of its two source px,
    // unlike nearest which would copy one endpoint of each half.
    const src = [0, 0, 0, 100, 100, 100, 200, 200, 200, 255, 255, 255];
    const area = resizeRgbAreaAverage(src, 4, 1, 2, 1);
    const nn = resizeRgbNearestNeighbor(src, 4, 1, 2, 1);
    expect([...area]).toEqual([50, 50, 50, 228, 228, 228]); // (0+100)/2, (200+255)/2→227.5→228
    expect([...nn]).toEqual([0, 0, 0, 200, 200, 200]); // nearest picks an endpoint
  });

  it('degenerates_to_nearest_when_upscaling', () => {
    // footprint < 1 px → single-sample; 1x1 → 2x2 just replicates the pixel.
    const out = resizeRgbAreaAverage([10, 20, 30], 1, 1, 2, 2);
    expect([...out]).toEqual([10, 20, 30, 10, 20, 30, 10, 20, 30, 10, 20, 30]);
  });
});

describe('solveSimilarityTransform (5-point ArcFace alignment)', () => {
  const apply = (
    t: { a: number; b: number; tx: number; ty: number },
    [x, y]: readonly [number, number],
  ): [number, number] => [t.a * x - t.b * y + t.tx, t.b * x + t.a * y + t.ty];

  it('recovers_a_known_scale_rotation_translation', () => {
    // a = s·cosθ, b = s·sinθ for s=2, θ=30°; plus translation (10, 5)
    const a = 2 * Math.cos(Math.PI / 6);
    const b = 2 * Math.sin(Math.PI / 6);
    const known = { a, b, tx: 10, ty: 5 };
    const src = [
      [0, 0],
      [1, 0],
      [0, 1],
      [2, 3],
    ] as const;
    const dst = src.map((p) => apply(known, p));
    const got = solveSimilarityTransform(src, dst);
    expect(got.a).toBeCloseTo(a, 5);
    expect(got.b).toBeCloseTo(b, 5);
    expect(got.tx).toBeCloseTo(10, 5);
    expect(got.ty).toBeCloseTo(5, 5);
  });

  it('maps_template_to_itself_as_identity', () => {
    const t = solveSimilarityTransform(ARCFACE_TEMPLATE_112, ARCFACE_TEMPLATE_112);
    expect(t.a).toBeCloseTo(1, 6);
    expect(t.b).toBeCloseTo(0, 6);
    expect(t.tx).toBeCloseTo(0, 4);
    expect(t.ty).toBeCloseTo(0, 4);
  });

  it('forward_maps_aligned_keypoints_onto_the_template', () => {
    // a face whose keypoints are the template under a 1.4× / 15° / shift similarity
    const a = 1.4 * Math.cos(Math.PI / 12);
    const b = 1.4 * Math.sin(Math.PI / 12);
    const enc = { a, b, tx: -7, ty: 12 };
    const faceKps = ARCFACE_TEMPLATE_112.map((p) => apply(enc, p));
    const t = solveSimilarityTransform(faceKps, ARCFACE_TEMPLATE_112);
    faceKps.forEach((p, i) => {
      const [mx, my] = apply(t, p);
      expect(mx).toBeCloseTo(ARCFACE_TEMPLATE_112[i][0], 3);
      expect(my).toBeCloseTo(ARCFACE_TEMPLATE_112[i][1], 3);
    });
  });
});

describe('softmax2 / antispoofRealProbability', () => {
  it('sums_to_one_and_favours_the_larger_logit', () => {
    const [p0, p1] = softmax2([0, 2]);
    expect(p0 + p1).toBeCloseTo(1);
    expect(p1).toBeGreaterThan(p0);
  });

  it('real_probability_is_class_0', () => {
    expect(antispoofRealProbability([5, -5])).toBeGreaterThan(0.5); // class 0 high → real
    expect(antispoofRealProbability([-5, 5])).toBeLessThan(0.5); // class 1 high → attack
  });
});
