import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { ActivityIndicator, Banner, Button, Snackbar, Text } from 'react-native-paper';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
} from 'react-native-vision-camera';
import { usePersonnelRepository } from '../db/repositories/PersonnelRepository';
import { useVerificationService, type VerificationEvidence } from '../services/VerificationService';
import { useVerificationFrameOutput, type VerificationFrameSample } from '../ml/frameProcessor';
import { loadFaceDetectorModel, loadFaceLandmarksModel, loadAntispoofModel } from '../ml/modelAssets';
import { LivenessDetector, type CaptureFrameSample } from '../ml/LivenessDetector';
import { EmbeddingModel } from '../ml/EmbeddingModel';
import { LIVENESS_CAPTURE_WINDOW_MS } from '../constants';
import type { BoxedTfliteModel } from '../ml/tfliteRuntime';
import type { DetectedFace } from '../services/VerificationService';
import type { Personnel } from '../models/Personnel';
import type { VerificationRecord } from '../models/VerificationRecord';
import VerificationResultOverlay from '../components/VerificationResultOverlay';

// Placeholder device identity; the real per-install device id is provided by
// AuthService / Cognito Identity in Phase 5 (T046).
const DEVICE_ID = 'local-device';

/**
 * Captures verification evidence from the live frame stream.
 *
 * The `useVerificationFrameOutput` worklet (frameProcessor.ts) runs BlazeFace
 * detection and — during the "Start Verification" window — the Antispoof passive
 * liveness model on the SAME frame buffer. The screen collects those per-frame
 * samples and reduces them via `LivenessDetector.passiveLiveness`; `EmbeddingModel`
 * (zeroed stub until T099) supplies the query embedding. The result is the
 * `VerificationEvidence` consumed by VerificationService (T036).
 *
 * Overridable as a prop so the screen flow is testable without the worklet runtime.
 */
export type CaptureEvidence = () => Promise<VerificationEvidence>;

export interface VerificationScreenProps {
  captureEvidence?: CaptureEvidence;
}

type Phase = 'idle' | 'capturing';

export default function VerificationScreen({ captureEvidence }: VerificationScreenProps) {
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('front');
  const personnelRepo = usePersonnelRepository();
  const { verify } = useVerificationService();

  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<VerificationRecord | null>(null);
  const [matched, setMatched] = useState<Personnel | null>(null);
  const [snackMsg, setSnackMsg] = useState('');

  // Load the boxed models. BlazeFace is required (detection + the live overlay); the
  // FaceMesh (active blink) and Antispoof (passive texture) models back the two liveness
  // layers — load best-effort, but a missing model means that layer can't pass, so the
  // verdict falls to inconclusive (fail-closed). Embedding (MobileFaceNet) is still a
  // zeroed stub until T099; it must run in the same worklet pass when it lands so the
  // matched identity stays bound to the same frame proven live.
  const [detectorModel, setDetectorModel] = useState<BoxedTfliteModel | null>(null);
  const [landmarksModel, setLandmarksModel] = useState<BoxedTfliteModel | null>(null);
  const [antispoofModel, setAntispoofModel] = useState<BoxedTfliteModel | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadFaceDetectorModel()
      .then((m) => {
        if (!cancelled) setDetectorModel(m);
      })
      .catch(() => setSnackMsg('Failed to load face detection model.'));
    loadFaceLandmarksModel()
      .then((m) => {
        if (!cancelled) setLandmarksModel(m);
      })
      .catch(() => console.warn('[verify] landmarks model failed to load; blink disabled'));
    loadAntispoofModel()
      .then((m) => {
        if (!cancelled) setAntispoofModel(m);
      })
      .catch(() => console.warn('[verify] antispoof model failed to load; passive layer disabled'));
    return () => {
      cancelled = true;
    };
  }, []);

  // Per-frame liveness evidence from the worklet, gathered during the capture window
  // only. Each sample carries face presence + EAR (active) + antispoof real-prob
  // (passive); `reduceCapture` fuses the window with a continuous-presence gate.
  const samplesRef = useRef<CaptureFrameSample[]>([]);
  const bestFaceRef = useRef<DetectedFace | null>(null);

  const onSample = useCallback((sample: VerificationFrameSample) => {
    const { face, ear, realProb } = sample;
    if (face && (!bestFaceRef.current || face.qualityScore > bestFaceRef.current.qualityScore)) {
      bestFaceRef.current = face;
    }
    const buf = samplesRef.current;
    buf.push({ facePresent: face != null, ear, realProb });
    if (buf.length > 90) buf.shift();
  }, []);

  // Detection runs every frame (cheap, for the overlay); the liveness stack (FaceMesh
  // blink + antispoof) runs only while 'capturing'. All layers are fused on the SAME
  // frame buffer inside the worklet (see frameProcessor) — no swap window between checks.
  const frameOutput = useVerificationFrameOutput(
    { detector: detectorModel, landmarks: landmarksModel, antispoof: antispoofModel },
    phase === 'capturing',
    onSample,
  );

  // Default capture: gather same-frame detection + dual-layer liveness evidence across
  // the ~1 s window, then reduce to VerificationEvidence. Overridable via prop (tests).
  const captureFromFrames = useCallback<CaptureEvidence>(async () => {
    samplesRef.current = [];
    bestFaceRef.current = null;
    await new Promise((resolve) => setTimeout(resolve, LIVENESS_CAPTURE_WINDOW_MS));
    const face = bestFaceRef.current;
    const liveness = LivenessDetector.reduceCapture(samplesRef.current);
    const queryEmbedding = await EmbeddingModel.extractEmbedding('');
    return { face, liveness, queryEmbedding };
  }, []);

  const effectiveCapture = captureEvidence ?? captureFromFrames;

  const startVerification = useCallback(async () => {
    setPhase('capturing');
    try {
      const evidence = await effectiveCapture();
      const record = await verify(evidence, {
        deviceId: DEVICE_ID,
        initiatedAt: new Date().toISOString(),
      });
      const person = record.personnelIdMatched
        ? await personnelRepo.findById(record.personnelIdMatched)
        : null;
      setMatched(person);
      setResult(record);
    } catch {
      setSnackMsg('Verification could not be completed. Please try again.');
    } finally {
      setPhase('idle');
    }
  }, [effectiveCapture, verify, personnelRepo]);

  const dismissResult = useCallback(() => {
    setResult(null);
    setMatched(null);
  }, []);

  // T039: camera permission denied → guide the operator to grant it.
  if (!hasPermission) {
    return (
      <View style={styles.container}>
        <Banner
          visible
          icon="camera-off"
          actions={[
            { label: 'Grant Permission', onPress: requestPermission },
            { label: 'Open Settings', onPress: () => Linking.openSettings() },
          ]}
        >
          Camera access is required to verify personnel on-site.
        </Banner>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={styles.centered}>
        <Text>No front camera available on this device.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Camera
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={!result}
        outputs={[frameOutput]}
      />

      <View style={styles.guidanceOverlay} pointerEvents="none">
        <Text variant="titleMedium" style={styles.guidanceText}>
          {phase === 'capturing' ? 'Blink now' : 'Position face in frame'}
        </Text>
      </View>

      <View style={styles.controls}>
        {phase === 'capturing' ? (
          <ActivityIndicator animating size="large" color="white" accessibilityLabel="Verifying" />
        ) : (
          <Button
            mode="contained"
            onPress={startVerification}
            style={styles.startBtn}
            accessibilityLabel="Start verification"
          >
            Start Verification
          </Button>
        )}
      </View>

      {result ? (
        <VerificationResultOverlay
          outcome={result.outcome}
          personnel={matched}
          confidenceScore={result.confidenceScore}
          onDismiss={dismissResult}
        />
      ) : null}

      <Snackbar visible={Boolean(snackMsg)} onDismiss={() => setSnackMsg('')} duration={3000}>
        {snackMsg}
      </Snackbar>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'black' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  guidanceOverlay: {
    position: 'absolute',
    top: 48,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  guidanceText: {
    color: 'white',
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    overflow: 'hidden',
  },
  controls: {
    position: 'absolute',
    bottom: 48,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  startBtn: { minWidth: 220 },
});
