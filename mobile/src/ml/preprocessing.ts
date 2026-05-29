import { ANTISPOOF_MEAN, ANTISPOOF_STD } from '../constants';

/**
 * Pure pixel→tensor preprocessing for the four-stage pipeline, transcribed from
 * scripts/test_*.py. Each function takes an already-resized, interleaved RGB
 * buffer (`[r,g,b, r,g,b, …]`, one byte per channel) — the resize/crop from a
 * camera frame to the model's square input is the device step (frameProcessor.ts)
 * that feeds these. Outputs are the typed buffers the TFLite models expect.
 */

/** BlazeFace f16 — float32 RGB normalised to [-1, 1] (`px/127.5 - 1`). */
export function preprocessBlazeFace(rgb: Uint8Array | number[]): Float32Array {
  const out = new Float32Array(rgb.length);
  for (let i = 0; i < rgb.length; i++) out[i] = rgb[i] / 127.5 - 1.0;
  return out;
}

/**
 * Nearest-neighbour resize of an interleaved RGB buffer (`[r,g,b,…]`) from
 * `srcW×srcH` to `dstW×dstH`. Cheap, dependency-free downscaling of a camera
 * frame to a model's square input. (vision-camera-resize-plugin only supports the
 * v4 worklets-core pipeline, not VisionCamera 5 — so the frame worklet inlines an
 * equivalent of this; this exported copy is the canonical, unit-tested algorithm.)
 */
export function resizeRgbNearestNeighbor(
  src: Uint8Array | number[],
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Uint8Array {
  const out = new Uint8Array(dstW * dstH * 3);
  for (let y = 0; y < dstH; y++) {
    const sy = Math.min(srcH - 1, Math.floor((y * srcH) / dstH));
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(srcW - 1, Math.floor((x * srcW) / dstW));
      const si = (sy * srcW + sx) * 3;
      const di = (y * dstW + x) * 3;
      out[di] = src[si];
      out[di + 1] = src[si + 1];
      out[di + 2] = src[si + 2];
    }
  }
  return out;
}

/** FaceMesh f16 — float32 RGB normalised to [0, 1] (`px/255`). */
export function preprocessFaceMesh(rgb: Uint8Array | number[]): Float32Array {
  const out = new Float32Array(rgb.length);
  for (let i = 0; i < rgb.length; i++) out[i] = rgb[i] / 255.0;
  return out;
}

/** Antispoof — float32 RGB, ImageNet-normalised `((px/255) - mean) / std` per channel. */
export function preprocessAntispoof(rgb: Uint8Array | number[]): Float32Array {
  const out = new Float32Array(rgb.length);
  for (let i = 0; i < rgb.length; i++) {
    const c = i % 3;
    out[i] = (rgb[i] / 255.0 - ANTISPOOF_MEAN[c]) / ANTISPOOF_STD[c];
  }
  return out;
}

/**
 * MobileFaceNet INT8 input — `px/255` then affine-quantise to int8:
 * `q = round(x/scale + zeroPoint)` clipped to [-128, 127].
 */
export function quantizeEmbeddingInput(
  rgb: Uint8Array | number[],
  scale: number,
  zeroPoint: number,
): Int8Array {
  const out = new Int8Array(rgb.length);
  for (let i = 0; i < rgb.length; i++) {
    const x = rgb[i] / 255.0;
    out[i] = Math.max(-128, Math.min(127, Math.round(x / scale + zeroPoint)));
  }
  return out;
}

/**
 * MobileFaceNet INT8 output → 128-d unit embedding: dequantise
 * `v = scale·(q - zeroPoint)`, then L2-normalise. (Used by the real embedding
 * model in Phase 9 / T099.)
 */
export function dequantizeAndNormalize(
  raw: Int8Array | number[],
  scale: number,
  zeroPoint: number,
): Float32Array {
  const v = new Float32Array(raw.length);
  let norm = 0;
  for (let i = 0; i < raw.length; i++) {
    v[i] = scale * (raw[i] - zeroPoint);
    norm += v[i] * v[i];
  }
  const inv = 1 / (Math.sqrt(norm) + 1e-9);
  for (let i = 0; i < v.length; i++) v[i] *= inv;
  return v;
}

/** Softmax over the 2-logit Antispoof output; class 1 = real/live. */
export function softmax2(logits: Float32Array | number[]): [number, number] {
  const max = Math.max(logits[0], logits[1]);
  const e0 = Math.exp(logits[0] - max);
  const e1 = Math.exp(logits[1] - max);
  const sum = e0 + e1;
  return [e0 / sum, e1 / sum];
}

/** Antispoof real/live probability (class 1) from raw 2-logit output. */
export function antispoofRealProbability(logits: Float32Array | number[]): number {
  return softmax2(logits)[1];
}
