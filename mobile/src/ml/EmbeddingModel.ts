// Place mobilefacenet.tflite in mobile/assets/models/ and configure metro.config.js
// to include 'tflite' in assetExts before production use.
// This stub returns a zeroed 128-float array until the model asset is integrated.

async function extractEmbedding(_imagePath: string): Promise<Float32Array> {
  return new Float32Array(128);
}

export const EmbeddingModel = { extractEmbedding };
