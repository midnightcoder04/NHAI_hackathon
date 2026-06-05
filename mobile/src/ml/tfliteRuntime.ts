import {
  loadTensorflowModel,
  type ModelSource,
  type TensorflowModel,
  type TensorflowModelDelegate,
} from 'react-native-fast-tflite';
import { NitroModules, type BoxedHybridObject } from 'react-native-nitro-modules';

export type { ModelSource, TensorflowModel, TensorflowModelDelegate };

/**
 * A loaded TFLite model plus a boxed handle to it.
 *
 * VisionCamera 5 / fast-tflite 3 are built on **Nitro** (no `react-native-worklets`,
 * no babel plugin). The model is a Nitro `HybridObject`; to use it inside the camera's
 * frame-processing Runtime (a separate JS runtime/thread) the handle must be **boxed**
 * via `NitroModules.box()` and `unbox()`-ed on that runtime. `boxed` is that handle.
 */
export interface BoxedTfliteModel {
  model: TensorflowModel;
  boxed: BoxedHybridObject<TensorflowModel>;
}

/**
 * Default delegates = CPU/XNNPACK (the empty list). MobileFaceNet INT8 is fastest on
 * CPU/XNNPACK per the model README; callers can opt into `'android-gpu'`/`'core-ml'`
 * for the f16 detection/landmark models where the GPU delegate helps.
 */
export const DEFAULT_DELEGATES: TensorflowModelDelegate[] = [];

/**
 * Load a bundled `.tflite` model and box it for the frame-processing runtime.
 *
 * @param source `require('../../assets/models/x.tflite')` (numeric asset id) or `{ url }`.
 * @param delegates hardware delegates; defaults to CPU/XNNPACK.
 */
export async function loadBoxedModel(
  source: ModelSource,
  delegates: TensorflowModelDelegate[] = DEFAULT_DELEGATES,
): Promise<BoxedTfliteModel> {
  const model = await loadTensorflowModel(source, delegates);
  const boxed = NitroModules.box(model);
  return { model, boxed };
}
