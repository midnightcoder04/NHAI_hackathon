# NHAI Innovation Hackathon 7.0 Submission


## 1. Executive Summary
This proposal outlines a highly optimized, lightweight, and entirely offline facial recognition and liveness detection system designed for seamless integration into the Datalake 3.0 React Native application. Built strictly using open-source technologies, the solution guarantees sub-second authentication in zero-network environments while maintaining a model footprint of under 10 MB.

### Project Overview

NHAI Innovation Hackathon 7.0 submission — an offline-first facial recognition and liveness detection system for integration into the **Datalake 3.0 React Native application**. Designed for zero-network environments on mid-range field devices (e.g., Snapdragon 665, 3GB RAM).

## Core Architecture

### AI Inference Pipeline (Three-Stage TFLite)

Selective quantization — f16 where stability matters, INT8 where NNAPI acceleration is viable; total footprint ~4.75 MB:

1. **Face Detection** — Google BlazeFace f16 (~0.22 MB, `blaze_face_short_range_float16.tflite`): bounding box + 6 landmarks; f16 chosen over INT8 to avoid degenerate 8×8 anchor quantization that causes frame-to-frame jitter
2. **Face Recognition** — MobileFaceNet INT8 (~1.5 MB, `MobileFaceNet_new_latest_int8.tflite`): 128-dim embedding, cosine similarity threshold ~0.6–0.7; NNAPI/Hexagon DSP acceleration
3. **Dual-Layer Liveness Detection** (~3.0 MB):
   - *Active*: MiniFASNet f16 (~2.4 MB, `MiniFASNetV2_float16.tflite`) — geometric landmark tracking for blink/smile/head-turn
   - *Passive*: Antispoof INT8 (~0.63 MB, `antispoof_128x128_int8.tflite`) — texture classifier for photo/screen replay detection

Performance budget: ~210ms total (BlazeFace f16 ~20ms + MobileFaceNet INT8 ~60ms + MiniFASNet f16 ~100ms + Antispoof INT8 ~30ms)

### Camera & Frame Processing

- **react-native-vision-camera v4+** with Frame Processors on a dedicated worklet thread
- Camera configured at 640×480 @ ~15 FPS
- Models run as native C++ directly on the frame stream to bypass the JS bridge bottleneck

### Offline Storage & Sync

- **react-native-sqlite-storage + SQLCipher** — AES-256 encrypted local storage for auth logs (timestamp, GPS, confidence, liveness result) and facial embeddings
- **@react-native-community/netinfo** — monitors connectivity
- **react-native-background-fetch / Android WorkManager** — triggers batch upload to AWS API Gateway on reconnect
- **Purge logic**: local records deleted only after `200 OK` with committed record IDs; exponential backoff on failure

### React Native Integration

The native models are exposed to JS via either:
- react-native-vision-camera worklets (preferred)
- A thin Swift/Kotlin native module with an `authenticate(frameData)` API

## Key Design Constraints

- Total model size: ≤20 MB (target ~9 MB)
- End-to-end latency: <1 second
- Fully offline-capable — no network dependency for authentication
- Open-source models only
- Zero data loss guarantee for sync queue

## Implementation Note: TFLite Delegate Configuration
When bridging MobileFaceNet to React Native, pay close attention to TFLite delegate settings. Force it to run on the CPU via the XNNPACK delegate first to ensure stability before evaluating GPU acceleration.



## FAQ

### 1. Why float16 for BlazeFace instead of INT8?

Benchmarked at 0.52 ms (INT8) vs 0.58 ms (float16) — a 0.06 ms difference that is irrelevant against the ~340 ms total budget.

The INT8 model's 8×8 anchor grid has degenerate post-training quantization, causing bounding boxes to jitter visibly frame-to-frame even on a stationary face. The float16 variant eliminates this with no meaningful speed cost.

**Tradeoff:** +0.06 ms/frame for stable, jitter-free detections.

### 2. Why float16 for MediaPipe Face Mesh  ?

Face Mesh is a coordinate regression model. It outputs exact pixel coordinates. Converting 32-bit floating-point math (FP32) to INT8 forces the model to round its numbers aggressively. In Face Mesh, rounding errors manifest as physical "jitter"—the predicted landmarks on the eyes and mouth will vibrate or drift erratically across frames. Because the model requires sub-pixel precision to accurately map 478 dense points, standard Post-Training Quantization (PTQ) will completely ruin its accuracy. 

TLDR: It is highly sensitive.

### 3. Requirements of INT8 models?

NNAPI / Hexagon DSP (Requires enableAndroidGpuLibraries in config INT8 models) , plugin + Android API 27+   