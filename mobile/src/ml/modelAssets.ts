/* istanbul ignore file -- device-only TFLite asset wiring (Metro require of bundled
   .tflite files + native model load); exercised on-device, not under jest. */
import { loadBoxedModel, type BoxedTfliteModel } from './tfliteRuntime';
import blazeFaceDetector from '../../assets/models/blaze_face_short_range_float16.tflite';
import mobileFaceNetEmbedding from '../../assets/models/MobileFaceNet_new_latest_int8.tflite';
import faceLandmarks from '../../assets/models/face_landmarks_detector_float16.tflite';
import antispoof from '../../assets/models/antispoof_128x128_int8.tflite';

/**
 * The four bundled on-device models, each loaded as a Nitro-boxed TFLite model ready
 * to be `unbox()`-ed inside the VisionCamera 5 frame-processing runtime.
 *
 *  - BlazeFace f16   → detection (T032)           — GPU delegate helps
 *  - landmarks f16   → active liveness / EAR (T033)
 *  - Antispoof INT8  → passive liveness (T033)
 *  - MobileFaceNet INT8 → 128-d embedding (T099)  — CPU/XNNPACK fastest
 */
export const loadFaceDetectorModel = (): Promise<BoxedTfliteModel> =>
  loadBoxedModel(blazeFaceDetector, ['android-gpu', 'core-ml']);

export const loadFaceLandmarksModel = (): Promise<BoxedTfliteModel> =>
  loadBoxedModel(faceLandmarks, ['android-gpu', 'core-ml']);

export const loadAntispoofModel = (): Promise<BoxedTfliteModel> => loadBoxedModel(antispoof);

export const loadEmbeddingModel = (): Promise<BoxedTfliteModel> =>
  loadBoxedModel(mobileFaceNetEmbedding);
