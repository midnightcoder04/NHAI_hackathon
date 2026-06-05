import {
  EMBEDDING_INPUT_SCALE,
  EMBEDDING_INPUT_ZERO_POINT,
  EMBEDDING_OUTPUT_SCALE,
  EMBEDDING_OUTPUT_ZERO_POINT,
} from '../constants';
import { quantizeEmbeddingInput, dequantizeAndNormalize } from './preprocessing';

/** Minimal boxed-TFLite surface needed to run the embedding model (see tfliteRuntime). */
export interface EmbeddingRunner {
  runSync(inputs: ArrayBuffer[]): ArrayBuffer[];
}

/**
 * Dequantise + L2-normalise MobileFaceNet's raw int8 [128] output into a 128-d unit
 * embedding. Used on the JS thread to finalise the raw int8 vector the verification /
 * enrollment worklet emits (the worklet copies the native output to a plain array, which
 * survives the worklet→JS hop; the float math is cheap and stays here).
 */
export function finalizeEmbedding(raw: Int8Array | number[]): Float32Array {
  return dequantizeAndNormalize(raw, EMBEDDING_OUTPUT_SCALE, EMBEDDING_OUTPUT_ZERO_POINT);
}

/**
 * Pure MobileFaceNet INT8 embedding: a 112×112×3 RGB ROI → quantise (q = px-128, the
 * model's si=1/255 / zi=-128) → `runSync` → dequantise + L2-normalise → 128-d unit
 * vector. The model runner is injected so this is unit-testable without the native
 * runtime; the verification worklet inlines the identical steps on the frame thread so
 * the query embedding is bound to the same frame proven live (T099).
 */
export function extractEmbeddingFromRoi(
  rgb: Uint8Array | number[],
  runner: EmbeddingRunner,
): Float32Array {
  const q = quantizeEmbeddingInput(rgb, EMBEDDING_INPUT_SCALE, EMBEDDING_INPUT_ZERO_POINT);
  const out = runner.runSync([q.buffer as ArrayBuffer]);
  return finalizeEmbedding(new Int8Array(out[0]));
}

export const EmbeddingModel = { extractEmbeddingFromRoi, finalizeEmbedding };
