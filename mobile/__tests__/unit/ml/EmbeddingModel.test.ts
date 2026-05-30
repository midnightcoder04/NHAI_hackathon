/**
 * T099 (write-first): real MobileFaceNet INT8 embedding.
 *
 * Pure `extractEmbeddingFromRoi` takes a 112×112×3 RGB ROI + an injected model runner,
 * quantises (q = px-128 per the model's si=1/255, zi=-128), runs the int8 model, then
 * dequantises + L2-normalises the int8 [128] output → a 128-d unit embedding. The runner
 * is injected so the logic is testable without the native TFLite runtime; the worklet
 * inlines the same steps on the frame thread.
 */
import { extractEmbeddingFromRoi, finalizeEmbedding } from '../../../src/ml/EmbeddingModel';
import { EMBEDDING_DIM, EMBEDDING_INPUT_SIZE } from '../../../src/constants';

const l2 = (v: ArrayLike<number>): number => {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
};

const fixedRoi = (): Uint8Array => {
  const a = new Uint8Array(EMBEDDING_INPUT_SIZE * EMBEDDING_INPUT_SIZE * 3);
  for (let i = 0; i < a.length; i++) a[i] = i % 256;
  return a;
};

describe('extractEmbeddingFromRoi (MobileFaceNet INT8)', () => {
  it('quantises input as px-128, runs the model, returns a deterministic 128-d unit embedding', () => {
    let seen: Int8Array | null = null;
    const modelOut = new Int8Array(EMBEDDING_DIM).fill(64);
    const runner = {
      runSync: (bufs: ArrayBuffer[]) => {
        seen = new Int8Array(bufs[0]);
        return [modelOut.buffer];
      },
    };

    const roi = fixedRoi();
    const e = extractEmbeddingFromRoi(roi, runner);

    expect(e).toHaveLength(EMBEDDING_DIM);
    expect(l2(e)).toBeCloseTo(1, 5); // L2-normalised

    // Quantisation: q = px - 128 (clipped to int8).
    expect(seen).not.toBeNull();
    expect(seen!).toHaveLength(EMBEDDING_INPUT_SIZE * EMBEDDING_INPUT_SIZE * 3);
    expect(seen![0]).toBe(0 - 128); // px=0 → -128
    expect(seen![300]).toBe((300 % 256) - 128);

    // Deterministic for a fixed fixture.
    const e2 = extractEmbeddingFromRoi(roi, runner);
    expect(Array.from(e2)).toEqual(Array.from(e));
  });

  it('finalizeEmbedding dequantises the int8 output and L2-normalises', () => {
    const raw = new Int8Array(EMBEDDING_DIM); // all zero…
    raw[0] = 127; // …except one axis
    const e = finalizeEmbedding(raw);
    expect(l2(e)).toBeCloseTo(1, 5);
    expect(e[0]).toBeCloseTo(1, 5); // single non-zero component → unit vector on axis 0
  });

  it('finalizeEmbedding of an all-zero output is a safe zero vector (no NaN)', () => {
    const e = finalizeEmbedding(new Int8Array(EMBEDDING_DIM));
    expect(e).toHaveLength(EMBEDDING_DIM);
    expect(Array.from(e).some((x) => Number.isNaN(x))).toBe(false);
  });
});
