/* istanbul ignore file -- device-only VisionCamera 5 frame-output worklet binding;
   runs on the camera frame thread, not under jest. Pure pieces it calls
   (FaceDetector decode, preprocessing, LivenessDetector) are tested separately. */
import { useFrameOutput, type CameraFrameOutput, type Frame } from 'react-native-vision-camera';
import { runOnJS } from 'react-native-worklets';
import type { BoxedTfliteModel } from './tfliteRuntime';
import { runFaceDetection } from './FaceDetector';
import type { DetectedFace } from '../services/VerificationService';

/**
 * VisionCamera 5 frame-output binding.
 *
 * v5 core is Nitro, but the `onFrame` callback is a **worklet** running on the
 * CameraFrameOutput's own thread (requires react-native-worklets +
 * react-native-vision-camera-worklets, wired via the babel plugin). Boxed TFLite
 * models (NitroModules.box, see tfliteRuntime/modelAssets) are `unbox()`-ed inside
 * the worklet so inference runs on the frame thread without blocking JS/UI.
 *
 * Pixel path: request `pixelFormat: 'rgb'`; `frame.getPixelBuffer()` returns the
 * full-resolution RGB bytes. The model needs a square `INPUT_SIZE²` crop — that
 * resize is the one remaining device dependency (add `vision-camera-resize-plugin`
 * or a worklet resize), after which `preprocessBlazeFace(...)` →
 * `runFaceDetection(model.unbox(), input, dims)` (all already unit-tested) yields
 * the `DetectedFace`. Liveness mirrors this with the landmarks + antispoof models.
 */

export interface FrameDims {
  width: number;
  height: number;
}

/**
 * Smoke-test frame output (T032 milestone): logs each frame's dimensions on the
 * worklet thread and forwards them to JS. Attach to `<Camera outputs={[output]} />`.
 * Proves the frame-output worklet pipeline is live end-to-end on device.
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
 * Face-detection frame output (next step after the resize dependency lands).
 * `model` is the boxed BlazeFace model; `onFace` receives the best `DetectedFace`
 * (or null) per processed frame on the JS thread.
 *
 * NOTE: the `preprocessBlazeFace(resize(rgb))` step is the device piece still
 * pending a resize utility; the decode/run path it feeds (`runFaceDetection`) is
 * already unit-tested in FaceDetector.test.ts.
 */
export function useFaceDetectionFrameOutput(
  model: BoxedTfliteModel,
  onFace: (face: DetectedFace | null) => void,
): CameraFrameOutput {
  const boxed = model.boxed;
  return useFrameOutput({
    pixelFormat: 'rgb',
    onFrame: (frame: Frame) => {
      'worklet';
      try {
        const dims: FrameDims = { width: frame.width, height: frame.height };
        const rgb = frame.getPixelBuffer();
        // TODO(device): resize `rgb` (dims) → BLAZEFACE_INPUT_SIZE² RGB, then:
        //   const input = preprocessBlazeFace(resized).buffer;
        //   const face = runFaceDetection(boxed.unbox(), input, dims);
        //   runOnJS(onFace)(face);
        void boxed;
        void rgb;
        void dims;
        void onFace;
        void runFaceDetection;
      } finally {
        frame.dispose();
      }
    },
  });
}
