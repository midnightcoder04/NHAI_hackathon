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

/**
 * Area-averaging (box-filter) resize of an interleaved RGB buffer (`[r,g,b,…]`) from
 * `srcW×srcH` to `dstW×dstH`. Unlike {@link resizeRgbNearestNeighbor}, each destination
 * pixel is the MEAN of the source pixels in its footprint — the correct anti-alias for
 * DOWNscaling, and what `cv2.resize`/`PIL.BILINEAR` give in scripts/test_liveness.py +
 * validate_antispoof.py.
 *
 * This matters specifically for the texture-based antispoof model: nearest-neighbour
 * decimation ALIASES the high-frequency print/screen texture the model keys on, and the
 * alias pattern is phase-sensitive — it shifts with the sub-pixel position of the crop
 * box, so the detector's frame-to-frame box jitter makes `realProb` flicker on a face
 * held perfectly still (the "unstable liveness" symptom). Box-filtering integrates the
 * whole footprint, so the same jitter only nudges the value smoothly. The frame-processor
 * worklet inlines a crop-region equivalent of this for the antispoof input.
 *
 * For UPscaling (footprint < 1 px) it degenerates to a single-pixel (nearest) sample.
 */
export function resizeRgbAreaAverage(
  src: Uint8Array | number[],
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Uint8Array {
  const out = new Uint8Array(dstW * dstH * 3);
  for (let y = 0; y < dstH; y++) {
    const syStart = Math.floor((y * srcH) / dstH);
    let syEnd = Math.floor(((y + 1) * srcH) / dstH);
    if (syEnd <= syStart) syEnd = syStart + 1;
    for (let x = 0; x < dstW; x++) {
      const sxStart = Math.floor((x * srcW) / dstW);
      let sxEnd = Math.floor(((x + 1) * srcW) / dstW);
      if (sxEnd <= sxStart) sxEnd = sxStart + 1;
      let r = 0;
      let g = 0;
      let b = 0;
      let cnt = 0;
      for (let sy = syStart; sy < syEnd; sy++) {
        for (let sx = sxStart; sx < sxEnd; sx++) {
          const si = (sy * srcW + sx) * 3;
          r += src[si];
          g += src[si + 1];
          b += src[si + 2];
          cnt++;
        }
      }
      const di = (y * dstW + x) * 3;
      out[di] = Math.round(r / cnt);
      out[di + 1] = Math.round(g / cnt);
      out[di + 2] = Math.round(b / cnt);
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

/**
 * Antispoof — float32 **RGB**, plain `px/255` ([0,1]); NO channel swap, NO ImageNet
 * mean/std. Calibrated against a REAL presentation-attack set (LiveSpoofDataset,
 * `scripts/compare_antispoof_variants.py` + `investigate_antispoof_crop.py`): RGB+/255
 * separates live from spoof at ROC-AUC ≈0.81, whereas BGR+/255 (a prior fix tuned on
 * *synthetic* recaptures, which did not transfer) inverts to AUC ≈0.26. The model is
 * also crop-sensitive — it wants the face small with border (see ANTISPOOF_CROP_SCALE).
 * Input is interleaved RGB `[r,g,b,…]`; output stays RGB.
 */
export function preprocessAntispoof(rgb: Uint8Array | number[]): Float32Array {
  const out = new Float32Array(rgb.length);
  for (let i = 0; i < rgb.length; i++) out[i] = rgb[i] / 255.0;
  return out;
}

/**
 * Canonical 5-point ArcFace template (the first four points: subject-right eye,
 * subject-left eye, nose, mouth-centre) in the 112×112 MobileFaceNet input frame.
 * MobileFaceNet (ArcFace family) is trained on faces similarity-warped so these
 * landmarks land here; feeding a raw, unaligned detector box (squashed to 112²)
 * is the single biggest recognition-accuracy leak — on LFW, adding this alignment
 * lifts ROC-AUC 0.79→0.96 (scripts/validate_recognition_lfw.py --align). BlazeFace
 * keypoint order is [R-eye, L-eye, nose, mouth, R-ear, L-ear], so its first four
 * map straight onto this template.
 */
const ARCFACE_CANONICAL_112: ReadonlyArray<readonly [number, number]> = [
  [38.2946, 51.6963], // subject-right eye
  [73.5318, 51.5014], // subject-left eye
  [56.0252, 71.7366], // nose
  [56.1396, 92.2848], // mouth-centre
];

/**
 * Crop-tightness multiplier applied to the template about its centroid (1.0 = bare
 * ArcFace). An LFW crop-scale sweep (scripts/sweep_crop_margin.py) found MobileFaceNet
 * separates best when the face fills ~15% MORE of the 112² frame than the bare
 * template: looser crops (more hair/forehead/background — identity-noise that is
 * shared across different people) hurt monotonically (AUC 0.95→0.65 toward 0.55×),
 * while tightening peaks at ≈1.15× (ROC-AUC 0.948→0.959, best-acc 91.1→91.8%; beyond
 * ~1.2× the outer eye/mouth landmarks start clipping the frame and it falls off).
 */
export const ARCFACE_CROP_TIGHTEN = 1.15;

/** Scale a template uniformly about its centroid (used to derive the shipped crop). */
function tightenTemplate(
  tpl: ReadonlyArray<readonly [number, number]>,
  s: number,
): Array<readonly [number, number]> {
  const cx = tpl.reduce((acc, p) => acc + p[0], 0) / tpl.length;
  const cy = tpl.reduce((acc, p) => acc + p[1], 0) / tpl.length;
  return tpl.map((p) => [cx + s * (p[0] - cx), cy + s * (p[1] - cy)] as const);
}

/**
 * The SHIPPED template: canonical ArcFace tightened {@link ARCFACE_CROP_TIGHTEN}×
 * about its centroid (≈(56.0, 66.8)). The frame-processor worklet inlines the same
 * pre-computed coordinates (kept in sync). Numerically ≈
 * [[35.64,49.43],[76.16,49.21],[56.03,72.48],[56.16,96.11]].
 */
export const ARCFACE_TEMPLATE_112: ReadonlyArray<readonly [number, number]> =
  tightenTemplate(ARCFACE_CANONICAL_112, ARCFACE_CROP_TIGHTEN);

export interface SimilarityTransform {
  a: number; // scale·cosθ   forward matrix is [[a, -b, tx], [b, a, ty]]
  b: number; // scale·sinθ
  tx: number;
  ty: number;
}

/**
 * Least-squares 2D similarity transform (uniform scale + rotation + translation,
 * no reflection) mapping `src`→`dst`, via the closed-form complex formulation:
 * the optimal multiplier c = Σ conj(aᵢ)·bᵢ / Σ|aᵢ|² over mean-centred points.
 * This is the reflection-free 2D Umeyama solution without any SVD, so it runs
 * cheaply inside the frame-processor worklet (which inlines an equivalent). `src`
 * and `dst` are equal-length arrays of [x, y]. Returns the forward affine.
 */
export function solveSimilarityTransform(
  src: ReadonlyArray<readonly [number, number]>,
  dst: ReadonlyArray<readonly [number, number]>,
): SimilarityTransform {
  const n = Math.min(src.length, dst.length);
  let smx = 0;
  let smy = 0;
  let dmx = 0;
  let dmy = 0;
  for (let i = 0; i < n; i++) {
    smx += src[i][0];
    smy += src[i][1];
    dmx += dst[i][0];
    dmy += dst[i][1];
  }
  smx /= n;
  smy /= n;
  dmx /= n;
  dmy /= n;
  let numRe = 0;
  let numIm = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const aX = src[i][0] - smx;
    const aY = src[i][1] - smy;
    const bX = dst[i][0] - dmx;
    const bY = dst[i][1] - dmy;
    // conj(a)·b = (aX − i·aY)(bX + i·bY)
    numRe += aX * bX + aY * bY;
    numIm += aX * bY - aY * bX;
    den += aX * aX + aY * aY;
  }
  const inv = den > 1e-12 ? 1 / den : 0;
  const a = numRe * inv;
  const b = numIm * inv;
  return { a, b, tx: dmx - (a * smx - b * smy), ty: dmy - (b * smx + a * smy) };
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

/** Softmax over the 2-logit Antispoof output. **class 0 = real/live, class 1 = attack** —
 * determined from held-out real PAD data (scripts/compare_antispoof_variants.py); the
 * earlier class-1-as-real assumption was wrong and inverted the gate on real spoofs. */
export function softmax2(logits: Float32Array | number[]): [number, number] {
  const max = Math.max(logits[0], logits[1]);
  const e0 = Math.exp(logits[0] - max);
  const e1 = Math.exp(logits[1] - max);
  const sum = e0 + e1;
  return [e0 / sum, e1 / sum];
}

/** Antispoof real/live probability (class 0) from raw 2-logit output. */
export function antispoofRealProbability(logits: Float32Array | number[]): number {
  return softmax2(logits)[0];
}
