/* istanbul ignore file -- device-only VisionCamera 5 frame-output worklet binding;
   runs on the camera frame thread, not under jest. Pure pieces it relies on
   (FaceDetector decode, preprocessing, LivenessDetector) are tested separately. */
import { useFrameOutput, type CameraFrameOutput, type Frame } from 'react-native-vision-camera';
import { runOnJS } from 'react-native-worklets';
import type { BoxedTfliteModel } from './tfliteRuntime';
import { decodeBlazeFace, parseDetection } from './FaceDetector';
import {
  BLAZEFACE_INPUT_SIZE,
  BLAZEFACE_SCORE_THRESHOLD,
  BLAZEFACE_BOX_PAD_Y,
  ANTISPOOF_INPUT_SIZE,
  ANTISPOOF_MEAN,
  ANTISPOOF_STD,
  FACEMESH_INPUT_SIZE,
} from '../constants';
import type { DetectedFace } from '../services/VerificationService';

// Throttle the per-frame "inference ran" diagnostic so it doesn't flood logcat.
let __inferenceLogCounter = 0;

/**
 * VisionCamera 5 frame-output binding.
 *
 * v5 core is Nitro, but `onFrame` is a **worklet** running on the CameraFrameOutput's
 * own thread (react-native-worklets + react-native-vision-camera-worklets, wired via
 * the babel plugin). The boxed BlazeFace model (NitroModules.box, see modelAssets) is
 * `unbox()`-ed inside the worklet so inference runs on the frame thread without
 * blocking JS/UI; raw output tensors are handed to JS via `runOnJS` for decoding
 * (the 896-anchor decode/NMS stays on the JS thread — see FaceDetector, unit-tested).
 *
 * vision-camera-resize-plugin only supports the v4 worklets-core pipeline, so the
 * frame→model-input resize+normalise is inlined here (mirrors
 * `resizeRgbNearestNeighbor` + `preprocessBlazeFace`, both unit-tested).
 */

export interface FrameDims {
  width: number;
  height: number;
}

/**
 * Smoke-test frame output (T032 milestone, VERIFIED on device): logs each frame's
 * dimensions on the worklet thread. Attach to `<Camera outputs={[output]} />`.
 */
export function useFrameDimsSmokeTest(onDims?: (dims: FrameDims) => void): CameraFrameOutput {
  return useFrameOutput({
    pixelFormat: 'rgb',
    onFrame: (frame: Frame) => {
      'worklet';
      const dims: FrameDims = { width: frame.width, height: frame.height };
      console.log(`[frameProcessor] frame ${dims.width}x${dims.height} (${frame.pixelFormat})`);
      if (onDims) runOnJS(onDims)(dims);
      frame.dispose(); // must dispose or the pipeline stalls / drops frames
    },
  });
}

/**
 * Face-detection frame output: runs BlazeFace on each frame on the worklet thread
 * and delivers the best `DetectedFace` (or null) per frame to `onFace` on the JS
 * thread. No-ops until `model` is loaded.
 */
export function useFaceDetectionFrameOutput(
  model: BoxedTfliteModel | null,
  onFace: (face: DetectedFace | null) => void,
): CameraFrameOutput {
  const boxed = model?.boxed ?? null;
  const S = BLAZEFACE_INPUT_SIZE;

  // JS-thread sink: decode raw tensors → DetectedFace (decode/NMS unit-tested).
  const handleOutputs = (out0: number[], out1: number[], w: number, h: number) => {
    const [scores, regressors] = out0.length <= out1.length ? [out0, out1] : [out1, out0];
    const dims = { width: w, height: h };
    const candidates = decodeBlazeFace(scores, regressors, dims);
    if (__inferenceLogCounter++ % 30 === 0) {
      console.log(
        `[frameProcessor] inference ok: ${scores.length} anchors, ${candidates.length} candidate(s)`,
      );
    }
    onFace(parseDetection(candidates, dims));
  };
  const handleError = (msg: string) => {
    console.warn(`[frameProcessor] detection error: ${msg}`);
  };

  return useFrameOutput({
    pixelFormat: 'rgb',
    onFrame: (frame: Frame) => {
      'worklet';
      if (!boxed) {
        frame.dispose();
        return;
      }
      const w = frame.width;
      const h = frame.height;
      try {
        const rgb = new Uint8Array(frame.getPixelBuffer());
        // inline nearest-neighbour resize → [-1,1] normalise into the model input
        const input = new Float32Array(S * S * 3);
        for (let y = 0; y < S; y++) {
          const sy = Math.min(h - 1, Math.floor((y * h) / S));
          for (let x = 0; x < S; x++) {
            const sx = Math.min(w - 1, Math.floor((x * w) / S));
            const si = (sy * w + sx) * 3;
            const di = (y * S + x) * 3;
            input[di] = rgb[si] / 127.5 - 1;
            input[di + 1] = rgb[si + 1] / 127.5 - 1;
            input[di + 2] = rgb[si + 2] / 127.5 - 1;
          }
        }
        const outputs = boxed.unbox().runSync([input.buffer]);
        // Copy native output buffers to plain arrays IN the worklet — native-backed
        // ArrayBuffers from runSync don't survive the worklet→JS runOnJS handoff
        // (they arrive empty), so the JS-thread decode would see 0 anchors.
        runOnJS(handleOutputs)(
          Array.from(new Float32Array(outputs[0])),
          Array.from(new Float32Array(outputs[1])),
          w,
          h,
        );
      } catch (e) {
        runOnJS(handleError)(String(e));
      } finally {
        frame.dispose();
      }
    },
  });
}

/** The boxed models the verification worklet needs (null until loaded). */
export interface VerificationModels {
  detector: BoxedTfliteModel | null;
  landmarks: BoxedTfliteModel | null;
  antispoof: BoxedTfliteModel | null;
}

/**
 * One frame's verification evidence. `face` (detection), `ear` (active blink layer,
 * FaceMesh eye-aspect-ratio), and `realProb` (passive antispoof liveness) are all
 * produced **in the same worklet pass on the same pixel buffer** — so they cannot be
 * sourced from different frames than each other or the match. `ear`/`realProb` are
 * null when liveness isn't being sampled (idle) or no face cleared the detection floor.
 */
export interface VerificationFrameSample {
  face: DetectedFace | null;
  ear: number | null;
  realProb: number | null;
}

/**
 * Verification frame output: detection every frame (cheap, for the live overlay)
 * plus — only while `sampleLiveness` is true (the "Start Verification" window) — BOTH
 * liveness layers on the **same** frame's face ROI: the ACTIVE blink layer (FaceMesh
 * f16 → eye-aspect-ratio) and the PASSIVE texture layer (Antispoof INT8).
 *
 * Running the heavy stack only during the ~1 s capture window keeps idle cost at
 * ~detection, and binding every model to the same pixel buffer as detection (and,
 * later, MobileFaceNet embedding — T099) closes the time-of-check/time-of-use spoofing
 * gap: the frame proven live is the frame identity is read from. The continuous-
 * presence gate that ties the whole window into one presentation lives in
 * `LivenessDetector.reduceCapture`.
 *
 * The single-best-anchor decode, ROI crops, FaceMesh EAR, and antispoof normalise+
 * softmax are inlined here (worklet thread) but mirror the unit-tested pure helpers
 * (`decodeBlazeFace`, `eyeAspectRatio`/`EAR_*_EYE_INDICES`, `preprocessFaceMesh`,
 * `preprocessAntispoof`, `antispoofRealProbability`).
 */
export function useVerificationFrameOutput(
  models: VerificationModels,
  sampleLiveness: boolean,
  onSample: (sample: VerificationFrameSample) => void,
): CameraFrameOutput {
  const detBoxed = models.detector?.boxed ?? null;
  const lmBoxed = models.landmarks?.boxed ?? null;
  const asBoxed = models.antispoof?.boxed ?? null;
  const runLiveness = sampleLiveness;
  const S = BLAZEFACE_INPUT_SIZE;
  const MESH = FACEMESH_INPUT_SIZE;
  const AS = ANTISPOOF_INPUT_SIZE;
  const scoreFloor = BLAZEFACE_SCORE_THRESHOLD;
  const padY = BLAZEFACE_BOX_PAD_Y;
  // Plain-number captures (avoid serialising arrays into the worklet).
  const m0 = ANTISPOOF_MEAN[0];
  const m1 = ANTISPOOF_MEAN[1];
  const m2 = ANTISPOOF_MEAN[2];
  const sd0 = ANTISPOOF_STD[0];
  const sd1 = ANTISPOOF_STD[1];
  const sd2 = ANTISPOOF_STD[2];

  const handleSample = (
    boxPx: number[] | null,
    score: number,
    ear: number | null,
    realProb: number | null,
    w: number,
    h: number,
  ) => {
    const dims = { width: w, height: h };
    let face: DetectedFace | null = null;
    if (boxPx) {
      face = parseDetection(
        [
          {
            boundingBox: { x: boxPx[0], y: boxPx[1], width: boxPx[2], height: boxPx[3] },
            landmarks: [],
            score,
          },
        ],
        dims,
      );
    }
    if (__inferenceLogCounter++ % 30 === 0) {
      console.log(
        `[frameProcessor] verify: face=${face ? face.qualityScore.toFixed(2) : 'none'} ` +
          `ear=${ear == null ? 'n/a' : ear.toFixed(3)} real=${realProb == null ? 'n/a' : realProb.toFixed(2)}`,
      );
    }
    onSample({ face, ear, realProb });
  };
  const handleError = (msg: string) => {
    console.warn(`[frameProcessor] verify error: ${msg}`);
  };

  return useFrameOutput({
    pixelFormat: 'rgb',
    onFrame: (frame: Frame) => {
      'worklet';
      if (!detBoxed) {
        frame.dispose();
        return;
      }
      const w = frame.width;
      const h = frame.height;
      try {
        const rgb = new Uint8Array(frame.getPixelBuffer());

        // 1) BlazeFace detection input: resize → [-1,1].
        const det = new Float32Array(S * S * 3);
        for (let y = 0; y < S; y++) {
          const sy = Math.min(h - 1, Math.floor((y * h) / S));
          for (let x = 0; x < S; x++) {
            const sx = Math.min(w - 1, Math.floor((x * w) / S));
            const si = (sy * w + sx) * 3;
            const di = (y * S + x) * 3;
            det[di] = rgb[si] / 127.5 - 1;
            det[di + 1] = rgb[si + 1] / 127.5 - 1;
            det[di + 2] = rgb[si + 2] / 127.5 - 1;
          }
        }
        const dOut = detBoxed.unbox().runSync([det.buffer]);
        const a0 = new Float32Array(dOut[0]);
        const a1 = new Float32Array(dOut[1]);
        const scores = a0.length <= a1.length ? a0 : a1;
        const regs = a0.length <= a1.length ? a1 : a0;

        // 2) Single best anchor (argmax of sigmoid score) — one face, no NMS.
        let bi = -1;
        let bs = -1;
        for (let i = 0; i < scores.length; i++) {
          const z = scores[i] < -50 ? -50 : scores[i] > 50 ? 50 : scores[i];
          const s = 1 / (1 + Math.exp(-z));
          if (s > bs) {
            bs = s;
            bi = i;
          }
        }
        if (bi < 0 || bs < scoreFloor) {
          // No usable face: report and bail. `finally` disposes the frame — do NOT
          // dispose here too, or the double-dispose null-derefs in Nitro disposeRaw.
          runOnJS(handleSample)(null, 0, null, null, w, h);
          return;
        }

        // Inline anchor centre for index bi (mirrors generateBlazeFaceAnchors:
        // 16×16 grid ×2 = 512, then 8×8 grid ×6 = 384).
        let ax: number;
        let ay: number;
        if (bi < 512) {
          const cell = Math.floor(bi / 2);
          ax = ((cell % 16) + 0.5) / 16;
          ay = (Math.floor(cell / 16) + 0.5) / 16;
        } else {
          const cell = Math.floor((bi - 512) / 6);
          ax = ((cell % 8) + 0.5) / 8;
          ay = (Math.floor(cell / 8) + 0.5) / 8;
        }
        const o = bi * 16;
        const cx = regs[o] / S + ax;
        const cy = regs[o + 1] / S + ay;
        const bw = regs[o + 2] / S;
        const bh = regs[o + 3] / S;

        // Padded reported box (matches decodeBlazeFace: padX=0, padY each side).
        let x1 = cx - bw / 2;
        let y1 = cy - bh / 2;
        let x2 = cx + bw / 2;
        let y2 = cy + bh / 2;
        x1 = x1 < 0 ? 0 : x1 > 1 ? 1 : x1;
        y1 = y1 < 0 ? 0 : y1 > 1 ? 1 : y1;
        x2 = x2 < 0 ? 0 : x2 > 1 ? 1 : x2;
        y2 = y2 < 0 ? 0 : y2 > 1 ? 1 : y2;
        const ph = (y2 - y1) * padY;
        const py1 = y1 - ph < 0 ? 0 : y1 - ph;
        const py2 = y2 + ph > 1 ? 1 : y2 + ph;
        const boxPx = [x1 * w, py1 * h, (x2 - x1) * w, (py2 - py1) * h];

        // 3) Liveness on the SAME frame (only during the capture window): the ACTIVE
        //    blink layer (FaceMesh → EAR) and the PASSIVE texture layer (Antispoof),
        //    both on this exact pixel buffer so neither can be sourced from a different
        //    frame than the other or the match.
        let ear: number | null = null;
        let realProb: number | null = null;
        if (runLiveness) {
          // 6 BlazeFace keypoints of the best anchor: 0/1 = eyes, 3 = mouth.
          const kpx0 = regs[o + 4] / S + ax;
          const kpy0 = regs[o + 5] / S + ay;
          const kpx1 = regs[o + 6] / S + ax;
          const kpy1 = regs[o + 7] / S + ay;
          const kpx3 = regs[o + 10] / S + ax;
          const kpy3 = regs[o + 11] / S + ay;

          // --- ACTIVE: FaceMesh on a 1.3× square crop centred on the eye↔mouth midpoint
          //     (mirrors face_crop in scripts/test_facemesh_f16.py). EAR is a ratio, so
          //     the crop-local [0,256] landmark space needs no remap. ---
          if (lmBoxed) {
            const ccx = (((kpx0 + kpx1) / 2 + kpx3) / 2) * w;
            const ccy = (((kpy0 + kpy1) / 2 + kpy3) / 2) * h;
            const side = Math.max(bw * w, bh * h) * 1.3;
            let x0 = Math.floor(ccx - side / 2);
            let y0 = Math.floor(ccy - side / 2);
            let x1c = Math.floor(ccx + side / 2);
            let y1c = Math.floor(ccy + side / 2);
            x0 = x0 < 0 ? 0 : x0;
            y0 = y0 < 0 ? 0 : y0;
            x1c = x1c > w ? w : x1c;
            y1c = y1c > h ? h : y1c;
            const cw = x1c - x0;
            const chh = y1c - y0;
            if (cw > 1 && chh > 1) {
              const mesh = new Float32Array(MESH * MESH * 3);
              for (let y = 0; y < MESH; y++) {
                const sy = y0 + Math.min(chh - 1, Math.floor((y * chh) / MESH));
                for (let x = 0; x < MESH; x++) {
                  const sx = x0 + Math.min(cw - 1, Math.floor((x * cw) / MESH));
                  const si = (sy * w + sx) * 3;
                  const di = (y * MESH + x) * 3;
                  mesh[di] = rgb[si] / 255;
                  mesh[di + 1] = rgb[si + 1] / 255;
                  mesh[di + 2] = rgb[si + 2] / 255;
                }
              }
              const mOut = lmBoxed.unbox().runSync([mesh.buffer]);
              // Landmarks = the largest output tensor (478×3 = 1434 floats).
              let lm = new Float32Array(mOut[0]);
              for (let i = 1; i < mOut.length; i++) {
                const c = new Float32Array(mOut[i]);
                if (c.length > lm.length) lm = c;
              }
              // EAR = (|p2-p6| + |p3-p5|) / (2|p1-p4|), averaged over both eyes, at the
              // MediaPipe indices (mirror EAR_*_EYE_INDICES / eyeAspectRatio).
              const RIGHT = [33, 160, 158, 133, 153, 144];
              const LEFT = [362, 385, 387, 263, 373, 380];
              let earSum = 0;
              let earCount = 0;
              for (let e = 0; e < 2; e++) {
                const idx = e === 0 ? RIGHT : LEFT;
                const a1 = idx[0] * 3;
                const a2 = idx[1] * 3;
                const a3 = idx[2] * 3;
                const a4 = idx[3] * 3;
                const a5 = idx[4] * 3;
                const a6 = idx[5] * 3;
                const hx = lm[a1] - lm[a4];
                const hy = lm[a1 + 1] - lm[a4 + 1];
                const horiz = Math.sqrt(hx * hx + hy * hy);
                if (horiz > 0) {
                  const u1x = lm[a2] - lm[a6];
                  const u1y = lm[a2 + 1] - lm[a6 + 1];
                  const u2x = lm[a3] - lm[a5];
                  const u2y = lm[a3 + 1] - lm[a5 + 1];
                  earSum +=
                    (Math.sqrt(u1x * u1x + u1y * u1y) + Math.sqrt(u2x * u2x + u2y * u2y)) /
                    (2 * horiz);
                  earCount++;
                }
              }
              if (earCount > 0) ear = earSum / earCount;
            }
          }

          // --- PASSIVE: Antispoof on a 1.5× box-centred crop (scaled_crop in
          //     scripts/test_liveness.py). ---
          if (asBoxed) {
            const bcx = cx * w;
            const bcy = cy * h;
            const side = Math.max(bw * w, bh * h) * 1.5;
            let x0 = Math.floor(bcx - side / 2);
            let y0 = Math.floor(bcy - side / 2);
            let x1c = Math.floor(bcx + side / 2);
            let y1c = Math.floor(bcy + side / 2);
            x0 = x0 < 0 ? 0 : x0;
            y0 = y0 < 0 ? 0 : y0;
            x1c = x1c > w ? w : x1c;
            y1c = y1c > h ? h : y1c;
            const cw = x1c - x0;
            const chh = y1c - y0;
            if (cw > 1 && chh > 1) {
              const asIn = new Float32Array(AS * AS * 3);
              for (let y = 0; y < AS; y++) {
                const sy = y0 + Math.min(chh - 1, Math.floor((y * chh) / AS));
                for (let x = 0; x < AS; x++) {
                  const sx = x0 + Math.min(cw - 1, Math.floor((x * cw) / AS));
                  const si = (sy * w + sx) * 3;
                  const di = (y * AS + x) * 3;
                  asIn[di] = (rgb[si] / 255 - m0) / sd0;
                  asIn[di + 1] = (rgb[si + 1] / 255 - m1) / sd1;
                  asIn[di + 2] = (rgb[si + 2] / 255 - m2) / sd2;
                }
              }
              const aOut = new Float32Array(asBoxed.unbox().runSync([asIn.buffer])[0]);
              const mx = aOut[0] > aOut[1] ? aOut[0] : aOut[1];
              const e0 = Math.exp(aOut[0] - mx);
              const e1 = Math.exp(aOut[1] - mx);
              realProb = e1 / (e0 + e1);
            }
          }
        }

        runOnJS(handleSample)(boxPx, bs, ear, realProb, w, h);
      } catch (e) {
        runOnJS(handleError)(String(e));
      } finally {
        frame.dispose();
      }
    },
  });
}
