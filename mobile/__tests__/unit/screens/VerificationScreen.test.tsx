/**
 * VerificationScreen — permission gating + the staged blink-triggered loop:
 *   Phase 1 (detect)  a good face held a few frames → Phase 2
 *   Phase 2 (interact) a blink (EAR open→closed→open) → Phase 3
 *   Phase 3 (execute)  a burst → evidence → result banner; loop never stops.
 * The native frame processor is mocked so the test captures the screen's per-frame
 * `onSample` and drives the machine; `captureEvidence` injects deterministic evidence.
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';
import type { VerificationEvidence } from '../../../src/services/VerificationService';
import type { VerificationFrameSample } from '../../../src/ml/frameProcessor';
import {
  LIVENESS_EXECUTION_BURST_FRAMES,
  LIVENESS_INTERACTION_WINDOW_MS,
} from '../../../src/constants';

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }),
}));

let mockHasPermission = true;
let mockDevice: unknown = { id: 'front' };
const mockRequestPermission = jest.fn();
jest.mock('react-native-vision-camera', () => ({
  Camera: () => null,
  useCameraDevice: () => mockDevice,
  useCameraPermission: () => ({
    hasPermission: mockHasPermission,
    requestPermission: mockRequestPermission,
  }),
}));

const mockVerify = jest.fn();
jest.mock('../../../src/services/VerificationService', () => ({
  useVerificationService: () => ({ verify: mockVerify }),
}));

// frameProcessor pulls in the native VisionCamera/worklets runtime — stub the hook and
// capture the screen's onSample so the test can feed it frame samples.
const mockFrameProcessor: { onSample: ((s: VerificationFrameSample) => void) | null } = {
  onSample: null,
};
jest.mock('../../../src/ml/frameProcessor', () => ({
  useVerificationFrameOutput: (
    _models: unknown,
    _mode: unknown,
    onSample: (s: VerificationFrameSample) => void,
  ) => {
    mockFrameProcessor.onSample = onSample;
    return {};
  },
}));
// modelAssets require()s native .tflite assets — stub the loaders.
jest.mock('../../../src/ml/modelAssets', () => ({
  loadFaceDetectorModel: () => new Promise(() => {}), // never resolves in tests
  loadFaceLandmarksModel: () => new Promise(() => {}),
  loadAntispoofModel: () => new Promise(() => {}),
  loadEmbeddingModel: () => new Promise(() => {}),
}));

const mockFindById = jest.fn();
jest.mock('../../../src/db/repositories/PersonnelRepository', () => ({
  usePersonnelRepository: () => ({ findById: mockFindById }),
}));

import VerificationScreen from '../../../src/screens/VerificationScreen';

const evidence: VerificationEvidence = {
  face: { boundingBox: { x: 0, y: 0, width: 100, height: 100 }, landmarks: [], qualityScore: 0.9 },
  liveness: 'live',
  queryEmbedding: new Float32Array([1, 0]),
};

const detFace = { boundingBox: { x: 0, y: 0, width: 100, height: 100 }, landmarks: [], qualityScore: 0.9 };
const goodFace = (ear: number | null = null, realProb: number | null = null): VerificationFrameSample => ({
  face: detFace,
  ear,
  realProb,
  embedding: realProb !== null ? [1, 2, 3] : null,
});

const feed = (s: VerificationFrameSample, n = 1) =>
  act(() => {
    for (let i = 0; i < n; i++) mockFrameProcessor.onSample?.(s);
  });

// Phase 1: hold a good face → Phase 2.  Phase 2: EAR open→closed→open = a blink → Phase 3.
const detectFaceAndBlink = () => {
  feed(goodFace(), 2); // good-face streak → interacting
  feed(goodFace(0.5)); // EAR open
  feed(goodFace(0.05)); // EAR closed
  feed(goodFace(0.5)); // EAR open → blink detected → executing
};

// Phase 3: deliver a full burst of frames carrying antispoof + embedding, then flush the
// finalize promise chain (capture → verify → findById).
const runBurst = async () => {
  feed(goodFace(null, 0.95), LIVENESS_EXECUTION_BURST_FRAMES - 1);
  await act(async () => {
    mockFrameProcessor.onSample?.(goodFace(null, 0.95));
  });
};

const renderScreen = (captureEvidence?: () => Promise<VerificationEvidence>) =>
  render(
    <PaperProvider>
      <VerificationScreen captureEvidence={captureEvidence} />
    </PaperProvider>,
  );

describe('VerificationScreen', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockHasPermission = true;
    mockDevice = { id: 'front' };
    mockRequestPermission.mockClear();
    mockVerify.mockReset();
    mockFindById.mockReset();
    mockFrameProcessor.onSample = null;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('given_no_permission_then_shows_permission_banner_with_grant_action', () => {
    mockHasPermission = false;
    renderScreen();
    expect(screen.getByText('Camera access is required to verify personnel on-site.')).toBeTruthy();
    fireEvent.press(screen.getByText('Grant Permission'));
    expect(mockRequestPermission).toHaveBeenCalledTimes(1);
  });

  it('given_no_front_camera_then_shows_unavailable_message', () => {
    mockDevice = undefined;
    renderScreen();
    expect(screen.getByText('No front camera available on this device.')).toBeTruthy();
  });

  it('given_permission_and_device_then_runs_hands_free_with_guidance_and_no_button', () => {
    renderScreen();
    expect(screen.getByText('Position face in frame to verify')).toBeTruthy();
    expect(screen.queryByText('Start Verification')).toBeNull();
  });

  it('given_a_good_face_then_prompts_to_blink', () => {
    renderScreen(async () => evidence);
    feed(goodFace(), 2);
    // Shown in both the top guidance and the bottom prompt banner.
    expect(screen.getAllByText('Blink to verify').length).toBeGreaterThan(0);
  });

  it('given_a_blink_then_runs_execution_and_shows_authorized_with_personnel', async () => {
    mockVerify.mockResolvedValue({
      id: 'vr-1',
      outcome: 'authorized',
      personnelIdMatched: 'p1',
      confidenceScore: 0.92,
      initiatedAt: '',
      completedAt: '',
      deviceId: 'local-device',
      syncStatus: 'pending',
    });
    mockFindById.mockResolvedValue({ id: 'p1', fullName: 'Asha Rao', role: 'Inspector' });

    renderScreen(async () => evidence);
    detectFaceAndBlink();
    await runBurst();

    expect(screen.getByText('Authorized')).toBeTruthy();
    expect(screen.getByText('Asha Rao · Inspector')).toBeTruthy();
    expect(mockVerify).toHaveBeenCalledTimes(1);
  });

  it('given_spoof_evidence_then_banner_shows_potential_spoof', async () => {
    mockVerify.mockResolvedValue({
      id: 'vr-2',
      outcome: 'liveness_failed',
      initiatedAt: '',
      completedAt: '',
      deviceId: 'local-device',
      syncStatus: 'pending',
    });

    renderScreen(async () => ({ ...evidence, liveness: 'spoof' }));
    detectFaceAndBlink();
    await runBurst();

    expect(screen.getByText('Liveness Check Failed — Potential Spoof')).toBeTruthy();
  });

  it('given_no_blink_or_movement_in_the_window_then_times_out', () => {
    renderScreen(async () => evidence);
    feed(goodFace(), 2); // → interacting
    // Hold an open-eyed, motionless face past the interaction window: no blink, no movement.
    feed(goodFace(0.5), 3);
    act(() => {
      jest.advanceTimersByTime(LIVENESS_INTERACTION_WINDOW_MS + 100);
    });
    feed(goodFace(0.5)); // first sample after the deadline triggers the timeout

    expect(screen.getByText('Liveness check timed out — please try again')).toBeTruthy();
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('given_capture_failure_then_shows_error_snackbar', async () => {
    renderScreen(async () => {
      throw new Error('no frames');
    });
    detectFaceAndBlink();
    await runBurst();

    expect(screen.getByText('Verification could not be completed. Please try again.')).toBeTruthy();
    expect(mockVerify).not.toHaveBeenCalled();
  });
});
