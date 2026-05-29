// Metro bundles `.tflite` files as assets (see metro.config.js `assetExts`), so a
// `require()`/`import` of a model resolves to its numeric asset id — the `number`
// form of fast-tflite's `ModelSource`. This declaration makes that typecheck.
declare module '*.tflite' {
  const asset: number;
  export default asset;
}
