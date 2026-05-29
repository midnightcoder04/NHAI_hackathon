// NOTE: VisionCamera 5 + react-native-fast-tflite 3 are built on Nitro, NOT
// react-native-worklets. Do NOT add `react-native-worklets/plugin` here — that
// package isn't in the dependency graph, and adding the plugin breaks the jest run.
// Frame processing uses Nitro frame outputs + NitroModules.box() (see src/ml/tfliteRuntime.ts).
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
  };
};
