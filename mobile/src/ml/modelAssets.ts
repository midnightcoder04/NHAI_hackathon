/* istanbul ignore file -- device-only TFLite asset wiring (Metro require of bundled
   .tflite files + native model load); exercised on-device, not under jest. */
import { Asset } from 'expo-asset';
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

/**
 * Resolve a `require('*.tflite')` asset to a real `file://` URL.
 *
 * fast-tflite 3's native `HybridAssetLoader.loadAsset(path)` does `URL(path).readBytes()`,
 * which only accepts a genuine URL. A `require(..)`'d asset resolves (via
 * `Image.resolveAssetSource`) to an `http://…` Metro URL in **dev** but to a bare Android
 * resource name (no scheme, e.g. `assets_models_blaze_face_short_range_float16`) in
 * **release** → `java.net.MalformedURLException: no protocol` → load rejects. So we
 * materialise the bundled model to a real on-disk file with expo-asset (which copies it
 * out of the APK in release) and hand fast-tflite that `file://` URL instead. This path
 * works identically in dev and release.
 */
async function modelUrl(moduleRef: number): Promise<{ url: string }> {
  const asset = Asset.fromModule(moduleRef);
  if (!asset.localUri) {
    await asset.downloadAsync();
  }
  return { url: asset.localUri ?? asset.uri };
}

// CPU/XNNPACK default (empty delegate list): reliable everywhere incl. emulators,
// which lack working TFLite GPU support. Per the model README these run CPU-first;
// callers can opt into a GPU delegate on real devices where it's a net win.
export const loadFaceDetectorModel = async (): Promise<BoxedTfliteModel> =>
  loadBoxedModel(await modelUrl(blazeFaceDetector));

export const loadFaceLandmarksModel = async (): Promise<BoxedTfliteModel> =>
  loadBoxedModel(await modelUrl(faceLandmarks));

export const loadAntispoofModel = async (): Promise<BoxedTfliteModel> =>
  loadBoxedModel(await modelUrl(antispoof));

export const loadEmbeddingModel = async (): Promise<BoxedTfliteModel> =>
  loadBoxedModel(await modelUrl(mobileFaceNetEmbedding));
