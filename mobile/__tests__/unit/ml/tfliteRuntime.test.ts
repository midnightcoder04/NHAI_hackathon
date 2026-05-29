/**
 * T032 native runtime: the boxed-model loader wires fast-tflite's `loadTensorflowModel`
 * to `NitroModules.box()` (VisionCamera 5 / fast-tflite 3 are Nitro-based — no worklets).
 * The native modules are stubbed in jest.setup.js; this verifies the loader contract.
 */
import { loadBoxedModel, DEFAULT_DELEGATES } from '../../../src/ml/tfliteRuntime';
import { loadTensorflowModel } from 'react-native-fast-tflite';
import { NitroModules } from 'react-native-nitro-modules';

describe('loadBoxedModel', () => {
  beforeEach(() => {
    (loadTensorflowModel as jest.Mock).mockClear();
    (NitroModules.box as jest.Mock).mockClear();
  });

  it('defaults_to_cpu_xnnpack_delegates', () => {
    expect(DEFAULT_DELEGATES).toEqual([]);
  });

  it('loads_the_model_and_returns_a_boxed_handle', async () => {
    const source = 1234 as unknown as number; // metro asset id
    const result = await loadBoxedModel(source);

    expect(loadTensorflowModel).toHaveBeenCalledWith(source, DEFAULT_DELEGATES);
    expect(NitroModules.box).toHaveBeenCalledWith(result.model);
    // The boxed handle unboxes back to the same model on the frame-processing runtime.
    expect(result.boxed.unbox()).toBe(result.model);
  });

  it('forwards_explicit_delegates', async () => {
    await loadBoxedModel(1 as unknown as number, ['android-gpu']);
    expect(loadTensorflowModel).toHaveBeenCalledWith(1, ['android-gpu']);
  });
});
