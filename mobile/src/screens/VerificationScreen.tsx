import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { Banner, Snackbar, Text } from 'react-native-paper';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
} from 'react-native-vision-camera';
import { usePersonnelRepository } from '../db/repositories/PersonnelRepository';
import { useVerificationService, type VerificationEvidence } from '../services/VerificationService';
import {
  useVerificationFrameOutput,
  type FrameMode,
  type VerificationFrameSample,
} from '../ml/frameProcessor';
import {
  loadFaceDetectorModel,
  loadFaceLandmarksModel,
  loadAntispoofModel,
  loadEmbeddingModel,
} from '../ml/modelAssets';
import {
  LivenessDetector,
  type CaptureFrameSample,
  type LivenessReason,
  type LivenessResult,
} from '../ml/LivenessDetector';
import { EmbeddingModel } from '../ml/EmbeddingModel';
import {
  EMBEDDING_DIM,
  FACE_MIN_QUALITY_SCORE,
  FACE_GOOD_QUALITY_SCORE,
  LIVENESS_BLINK_FRAMES,
  LIVENESS_MOVE_RATIO_THRESHOLD,
  LIVENESS_INTERACTION_WINDOW_MS,
  LIVENESS_EXECUTION_BURST_FRAMES,
  LIVENESS_EXECUTION_MAX_MS,
  VERIFY_TRIGGER_PRESENT_FRAMES,
  VERIFY_REARM_ABSENCE_FRAMES,
  VERIFY_REARM_COOLDOWN_MS,
} from '../constants';
import type { BoxedTfliteModel } from '../ml/tfliteRuntime';
import type { DetectedFace } from '../services/VerificationService';
import type { Personnel } from '../models/Personnel';
import type { VerificationRecord } from '../models/VerificationRecord';
import VerificationStatusBanner from '../components/VerificationStatusBanner';

// Placeholder device identity; the real per-install device id is provided by
// AuthService / Cognito Identity in Phase 5 (T046).
const DEVICE_ID = 'local-device';

/**
 * Continuous, hands-free verification — a staged, blink-triggered pipeline that runs the
 * heavy models only when they're needed and keeps the per-attempt COMPUTE under the 1 s
 * budget (decoupled from the generous wall-clock "wait for the human to blink"):
 *
 *   Phase 1 searching  (mode 'detect')   — BlazeFace only. Wait for ONE large, centered,
 *                                           good-quality face held for a few frames.
 *   Phase 2 interacting (mode 'interact')— prompt "Blink to verify"; run FaceMesh (EAR)
 *                                           over the Interaction Window. A detected blink
 *                                           (primary) — or natural head movement (fallback)
 *                                           — advances to Phase 3. No blink/movement in the
 *                                           window ⇒ timeout → back to Phase 1.
 *   Phase 3 executing   (mode 'execute')  — the one-shot Execution Window: a short BURST of
 *                                           frames runs Antispoof + MobileFaceNet on the
 *                                           SAME buffers. Antispoof is aggregated (trimmed
 *                                           mean — robust to single-frame jitter); the
 *                                           sharpest frame's embedding is matched. Banner.
 *   …then re-arm (subject leaves, or a short cooldown) → Phase 1, forever.
 *
 * `captureEvidence` is an optional override so the flow is testable without the worklet.
 */
export type CaptureEvidence = () => Promise<VerificationEvidence>;

export interface VerificationScreenProps {
  captureEvidence?: CaptureEvidence;
}

type Phase = 'searching' | 'interacting' | 'executing';

const MODE: Record<Phase, FrameMode> = {
  searching: 'detect',
  interacting: 'interact',
  executing: 'execute',
};

const coarseReason = (liveness: LivenessResult): LivenessReason =>
  liveness === 'live' ? 'live' : liveness === 'spoof' ? 'spoof' : 'no_movement';

export default function VerificationScreen({ captureEvidence }: VerificationScreenProps) {
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('front');
  const personnelRepo = usePersonnelRepository();
  const { verify } = useVerificationService();

  const [phase, setPhase] = useState<Phase>('searching');
  const [result, setResult] = useState<VerificationRecord | null>(null);
  const [matched, setMatched] = useState<Personnel | null>(null);
  const [livenessReason, setLivenessReason] = useState<LivenessReason | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [snackMsg, setSnackMsg] = useState('');

  // All four models load best-effort. BlazeFace is required (Phase 1); FaceMesh backs the
  // blink check (Phase 2); Antispoof + MobileFaceNet back the execution burst (Phase 3). A
  // missing liveness model fails closed (that layer can't pass → liveness_failed).
  const [detectorModel, setDetectorModel] = useState<BoxedTfliteModel | null>(null);
  const [landmarksModel, setLandmarksModel] = useState<BoxedTfliteModel | null>(null);
  const [antispoofModel, setAntispoofModel] = useState<BoxedTfliteModel | null>(null);
  const [embedderModel, setEmbedderModel] = useState<BoxedTfliteModel | null>(null);
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
      .catch(() => console.warn('[verify] landmarks model failed to load; blink check disabled'));
    loadAntispoofModel()
      .then((m) => {
        if (!cancelled) setAntispoofModel(m);
      })
      .catch(() => console.warn('[verify] antispoof model failed to load; passive layer disabled'));
    loadEmbeddingModel()
      .then((m) => {
        if (!cancelled) setEmbedderModel(m);
      })
      .catch(() => console.warn('[verify] embedding model failed to load; matching disabled'));
    return () => {
      cancelled = true;
    };
  }, []);

  // --- State-machine refs: mutated per frame in onSample (no re-render on the hot path).
  //     phaseRef mirrors `phase` for SYNCHRONOUS reads so transitions take effect on the
  //     very next sample, not after a React render. ---
  const phaseRef = useRef<Phase>('searching');
  const armedRef = useRef(true); // ready to start the FIRST scan immediately
  const absentStreakRef = useRef(0);
  const goodStreakRef = useRef(0); // consecutive good (large+centered) faces, Phase 1
  const lastResultAtRef = useRef(0);
  const finishingRef = useRef(false);
  // Phase 2 (blink wait) evidence.
  const interactStartRef = useRef(0);
  const interactSamplesRef = useRef<CaptureFrameSample[]>([]);
  // Phase 3 (execution burst) evidence.
  const execStartRef = useRef(0);
  const execRealProbsRef = useRef<number[]>([]);
  const bestExecFaceRef = useRef<DetectedFace | null>(null);
  const bestExecEmbeddingRef = useRef<number[] | null>(null);

  const enterInteracting = useCallback(() => {
    armedRef.current = false;
    goodStreakRef.current = 0;
    interactStartRef.current = Date.now();
    interactSamplesRef.current = [];
    phaseRef.current = 'interacting';
    setPhase('interacting');
    setResult(null);
    setMatched(null);
    setLivenessReason(null);
    setNotice(null);
  }, []);

  const enterExecuting = useCallback(() => {
    execStartRef.current = Date.now();
    execRealProbsRef.current = [];
    bestExecFaceRef.current = null;
    bestExecEmbeddingRef.current = null;
    phaseRef.current = 'executing';
    setPhase('executing');
  }, []);

  const backToSearching = useCallback((reArm: boolean) => {
    phaseRef.current = 'searching';
    setPhase('searching');
    goodStreakRef.current = 0;
    if (reArm) armedRef.current = true;
  }, []);

  // End-of-burst: reduce the burst's antispoof + embedding into evidence, match, and show
  // the banner. Stored in a ref so the per-frame onSample stays stable while still calling
  // the latest closure over verify / personnelRepo / the capture override.
  const finalizeRef = useRef<() => Promise<void>>(async () => {});
  finalizeRef.current = async () => {
    try {
      let evidence: VerificationEvidence;
      let reason: LivenessReason;
      if (captureEvidence) {
        evidence = await captureEvidence();
        reason = coarseReason(evidence.liveness);
      } else {
        // Active (blink/movement) already passed in Phase 2 → only the passive antispoof
        // gate remains, aggregated over the burst.
        const detailed = LivenessDetector.passiveLivenessDetailed(execRealProbsRef.current);
        reason = detailed.reason;
        const raw = bestExecEmbeddingRef.current;
        const queryEmbedding = raw
          ? EmbeddingModel.finalizeEmbedding(raw)
          : new Float32Array(EMBEDDING_DIM);
        evidence = { face: bestExecFaceRef.current, liveness: detailed.result, queryEmbedding };
      }
      const record = await verify(evidence, {
        deviceId: DEVICE_ID,
        initiatedAt: new Date().toISOString(),
      });
      const person = record.personnelIdMatched
        ? await personnelRepo.findById(record.personnelIdMatched)
        : null;
      setMatched(person);
      setResult(record);
      setLivenessReason(record.outcome === 'liveness_failed' ? reason : null);
      setNotice(null);
    } catch {
      setSnackMsg('Verification could not be completed. Please try again.');
    } finally {
      lastResultAtRef.current = Date.now();
      finishingRef.current = false;
    }
  };

  const onSample = useCallback(
    (sample: VerificationFrameSample) => {
      const { face, ear, realProb, embedding } = sample;
      const present = face != null && face.qualityScore >= FACE_MIN_QUALITY_SCORE;
      const goodFace = face != null && face.qualityScore >= FACE_GOOD_QUALITY_SCORE;
      const now = Date.now();
      absentStreakRef.current = present ? 0 : absentStreakRef.current + 1;
      const box = face?.boundingBox;
      const asCaptureSample = (): CaptureFrameSample => ({
        facePresent: face != null,
        ear,
        realProb: null,
        cx: box ? box.x + box.width / 2 : null,
        cy: box ? box.y + box.height / 2 : null,
        size: box ? Math.max(box.width, box.height) : null,
      });

      switch (phaseRef.current) {
        case 'searching': {
          if (!armedRef.current) {
            // Re-arm to keep scanning continuously: either the subject left the frame, OR
            // a cooldown elapsed since the last result (so it re-scans without requiring
            // the person to step away). The growing record count is handled by the backup
            // sync clearing the queue, not by suppressing re-scans.
            const left = absentStreakRef.current >= VERIFY_REARM_ABSENCE_FRAMES;
            const cooled =
              lastResultAtRef.current > 0 &&
              now - lastResultAtRef.current >= VERIFY_REARM_COOLDOWN_MS;
            if (left || cooled) armedRef.current = true;
          }
          goodStreakRef.current = goodFace ? goodStreakRef.current + 1 : 0;
          if (
            armedRef.current &&
            !finishingRef.current &&
            goodStreakRef.current >= VERIFY_TRIGGER_PRESENT_FRAMES
          ) {
            enterInteracting();
          }
          return;
        }

        case 'interacting': {
          interactSamplesRef.current.push(asCaptureSample());
          // Subject walked away mid-wait → abandon and re-arm for the next person.
          if (absentStreakRef.current >= VERIFY_REARM_ABSENCE_FRAMES) {
            backToSearching(true);
            return;
          }
          // PRIMARY: a blink (EAR open→closed→open).
          const earSeries = interactSamplesRef.current
            .map((s) => s.ear)
            .filter((e): e is number => e !== null);
          if (
            earSeries.length >= LIVENESS_BLINK_FRAMES &&
            LivenessDetector.detectBlink(earSeries)
          ) {
            enterExecuting();
            return;
          }
          // Window elapsed → FALLBACK to natural head movement, else time out.
          if (now - interactStartRef.current >= LIVENESS_INTERACTION_WINDOW_MS) {
            if (
              LivenessDetector.faceMovement(interactSamplesRef.current) >=
              LIVENESS_MOVE_RATIO_THRESHOLD
            ) {
              enterExecuting();
              return;
            }
            lastResultAtRef.current = now; // brief cooldown before auto-retry
            backToSearching(false);
            setNotice('Liveness check timed out — please try again');
          }
          return;
        }

        case 'executing': {
          if (
            face &&
            embedding &&
            (!bestExecFaceRef.current || face.qualityScore > bestExecFaceRef.current.qualityScore)
          ) {
            bestExecFaceRef.current = face;
            bestExecEmbeddingRef.current = embedding;
          }
          if (realProb !== null) execRealProbsRef.current.push(realProb);
          const enough = execRealProbsRef.current.length >= LIVENESS_EXECUTION_BURST_FRAMES;
          const overtime = now - execStartRef.current >= LIVENESS_EXECUTION_MAX_MS;
          if ((enough || overtime) && !finishingRef.current) {
            finishingRef.current = true;
            phaseRef.current = 'searching';
            setPhase('searching');
            void finalizeRef.current();
          }
          return;
        }
      }
    },
    [enterInteracting, enterExecuting, backToSearching],
  );

  const frameOutput = useVerificationFrameOutput(
    {
      detector: detectorModel,
      landmarks: landmarksModel,
      antispoof: antispoofModel,
      embedder: embedderModel,
    },
    MODE[phase],
    onSample,
  );

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
      <Camera style={StyleSheet.absoluteFill} device={device} isActive outputs={[frameOutput]} />

      <View style={styles.guidanceOverlay} pointerEvents="none">
        <Text variant="titleMedium" style={styles.guidanceText}>
          {phase === 'interacting'
            ? 'Blink to verify'
            : phase === 'executing'
              ? 'Hold still…'
              : 'Position face in frame to verify'}
        </Text>
      </View>

      {phase === 'interacting' ? (
        <VerificationStatusBanner status="prompt" message="Blink to verify" />
      ) : phase === 'executing' ? (
        <VerificationStatusBanner status="scanning" />
      ) : notice ? (
        <VerificationStatusBanner status="notice" message={notice} />
      ) : result ? (
        <VerificationStatusBanner
          status="result"
          outcome={result.outcome}
          livenessReason={livenessReason}
          personnel={matched}
          confidenceScore={result.confidenceScore}
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
});
