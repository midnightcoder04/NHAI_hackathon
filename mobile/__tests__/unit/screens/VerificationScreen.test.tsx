/**
 * T037/T039: VerificationScreen — permission gating, live-preview controls, and the
 * end-to-end flow that turns captured evidence into a result overlay (T038).
 * The native frame processor is replaced by an injected `captureEvidence` mock.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';
import type { VerificationEvidence } from '../../../src/services/VerificationService';

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

// frameProcessor pulls in the native VisionCamera/worklets runtime — stub the hook.
jest.mock('../../../src/ml/frameProcessor', () => ({
  useVerificationFrameOutput: () => ({}),
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

const renderScreen = (captureEvidence?: () => Promise<VerificationEvidence>) =>
  render(
    <PaperProvider>
      <VerificationScreen captureEvidence={captureEvidence} />
    </PaperProvider>,
  );

describe('VerificationScreen', () => {
  beforeEach(() => {
    mockHasPermission = true;
    mockDevice = { id: 'front' };
    mockRequestPermission.mockClear();
    mockVerify.mockReset();
    mockFindById.mockReset();
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

  it('given_permission_and_device_then_shows_start_button_and_guidance', () => {
    renderScreen();
    expect(screen.getByText('Start Verification')).toBeTruthy();
    expect(screen.getByText('Position face in frame')).toBeTruthy();
  });

  it('given_authorized_result_then_renders_overlay_with_matched_personnel', async () => {
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
    fireEvent.press(screen.getByText('Start Verification'));

    expect(await screen.findByText('Authorized')).toBeTruthy();
    expect(screen.getByText('Asha Rao')).toBeTruthy();
    expect(mockVerify).toHaveBeenCalledTimes(1);
  });

  it('given_capture_failure_then_shows_error_snackbar', async () => {
    renderScreen(async () => {
      throw new Error('no frames');
    });
    fireEvent.press(screen.getByText('Start Verification'));
    expect(
      await screen.findByText('Verification could not be completed. Please try again.'),
    ).toBeTruthy();
    expect(mockVerify).not.toHaveBeenCalled();
  });
});
