import React, { useCallback, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { ActivityIndicator, Banner, Button, Snackbar, Text } from 'react-native-paper';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
} from 'react-native-vision-camera';
import { usePersonnelRepository } from '../db/repositories/PersonnelRepository';
import { useVerificationService, type VerificationEvidence } from '../services/VerificationService';
import { useFrameDimsSmokeTest } from '../ml/frameProcessor';
import type { Personnel } from '../models/Personnel';
import type { VerificationRecord } from '../models/VerificationRecord';
import VerificationResultOverlay from '../components/VerificationResultOverlay';

// Placeholder device identity; the real per-install device id is provided by
// AuthService / Cognito Identity in Phase 5 (T046).
const DEVICE_ID = 'local-device';

/**
 * Captures verification evidence from the live frame stream.
 *
 * NATIVE WIRING (T032/T033, completed at build time — not exercised by jest):
 * a `useFrameProcessor` worklet runs the boxed BlazeFace + landmarks + antispoof
 * models per frame, accumulating a short buffer; on "Start Verification" the
 * buffer is reduced via `FaceDetector.detectFace` + `LivenessDetector.check`, and
 * the aligned ROI is passed to `EmbeddingModel.extractEmbedding`. The result is
 * the `VerificationEvidence` consumed by VerificationService (T036).
 *
 * Injected as a prop so the screen flow is testable without the worklet runtime.
 */
export type CaptureEvidence = () => Promise<VerificationEvidence>;

const captureEvidenceUnavailable: CaptureEvidence = async () => {
  throw new Error('Frame-processor capture not available in this build');
};

export interface VerificationScreenProps {
  captureEvidence?: CaptureEvidence;
}

type Phase = 'idle' | 'capturing';

export default function VerificationScreen({
  captureEvidence = captureEvidenceUnavailable,
}: VerificationScreenProps) {
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('front');
  const personnelRepo = usePersonnelRepository();
  const { verify } = useVerificationService();
  // T032 frame-output worklet: streams frames off the camera thread (currently a
  // dims smoke test; the boxed-model detection path attaches here next).
  const frameOutput = useFrameDimsSmokeTest();

  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<VerificationRecord | null>(null);
  const [matched, setMatched] = useState<Personnel | null>(null);
  const [snackMsg, setSnackMsg] = useState('');

  const startVerification = useCallback(async () => {
    setPhase('capturing');
    try {
      const evidence = await captureEvidence();
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
  }, [captureEvidence, verify, personnelRepo]);

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
          {phase === 'capturing' ? 'Please blink' : 'Position face in frame'}
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
