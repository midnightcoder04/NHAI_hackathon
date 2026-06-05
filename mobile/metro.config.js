// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// Bundle on-device TFLite model assets (BlazeFace, MobileFaceNet, MiniFASNet, Antispoof).
config.resolver.assetExts.push('tflite');

module.exports = config;
