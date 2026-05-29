/* istanbul ignore file -- device-only VisionCamera 5 frame-output worklet binding;
   runs on the camera frame thread, not under jest. Pure pieces it relies on
   (FaceDetector decode, preprocessing, LivenessDetector) are tested separately. */
import { useFrameOutput, type CameraFrameOutput, type Frame } from 'react-native-vision-camera';
import { runOnJS } from 'react-native-worklets';
import type { BoxedTfliteModel } from './tfliteRuntime';
import { decodeBlazeFace, parseDetection } from './FaceDetector';
import { BLAZEFACE_INPUT_SIZE } from '../constants';
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
