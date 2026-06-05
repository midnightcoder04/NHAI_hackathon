// VisionCamera 5 core is Nitro (react-native-nitro-modules/-image), but its
// `useFrameOutput` onFrame callback is a **worklet** — so the frame-output binding
// (src/ml/frameProcessor.ts) needs react-native-worklets + react-native-vision-camera-worklets.
// The worklets plugin MUST be last in the plugins list. Version pinned to Expo SDK 55's
// blessed react-native-worklets@0.7.4 (expo-modules-core peer ^0.7.4 || ^0.8.0).
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['react-native-worklets/plugin'],
  };
};
