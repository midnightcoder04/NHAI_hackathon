import React from 'react';
import { render, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
let mockRouteParams: Record<string, unknown> = {};
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack }),
  useRoute: () => ({ params: mockRouteParams }),
}));

// Camera mocked so the real <Camera> never mounts: no permission + no device →
// the screen renders its permission-placeholder branch.
jest.mock('react-native-vision-camera', () => ({
  Camera: () => null,
  useCameraDevice: () => undefined,
  // canRequestPermission=true → openCamera will call requestPermission() then open the modal,
  // which renders the placeholder since hasPermission stays false after the mock resolves.
  useCameraPermission: () => ({ hasPermission: false, canRequestPermission: true, requestPermission: jest.fn() }),
  usePhotoOutput: () => ({ capturePhotoToFile: jest.fn() }),
}));

const mockCreate = jest.fn();
const mockUpdate = jest.fn();
const mockFindById = jest.fn();
jest.mock('../../../src/db/repositories/PersonnelRepository', () => ({
  usePersonnelRepository: () => ({
    create: mockCreate,
    update: mockUpdate,
    delete: jest.fn(),
    findById: mockFindById,
  }),
}));
jest.mock('../../../src/db/repositories/FaceImageRepository', () => ({
  useFaceImageRepository: () => ({ create: jest.fn() }),
}));
jest.mock('../../../src/ml/EmbeddingModel', () => ({
  EmbeddingModel: { finalizeEmbedding: jest.fn(() => new Float32Array(128)) },
}));
// frameProcessor pulls in the native worklets runtime; modelAssets require()s .tflite.
jest.mock('../../../src/ml/frameProcessor', () => ({
  useVerificationFrameOutput: () => ({}),
}));
jest.mock('../../../src/ml/modelAssets', () => ({
  loadFaceDetectorModel: () => new Promise(() => {}),
  loadEmbeddingModel: () => new Promise(() => {}),
}));

import PersonnelDetailScreen from '../../../src/screens/PersonnelDetailScreen';

const renderScreen = () =>
  render(
    <PaperProvider>
      <PersonnelDetailScreen />
    </PaperProvider>,
  );

describe('PersonnelDetailScreen', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockGoBack.mockClear();
    mockCreate.mockReset();
    mockUpdate.mockReset();
    mockFindById.mockReset();
    mockRouteParams = {};
  });

  it('given_no_personnelId_when_rendered_then_in_create_mode', () => {
    renderScreen();
    expect(screen.getByText('Register Personnel')).toBeTruthy();
    expect(screen.queryByText('Save Changes')).toBeNull();
  });

  it('given_personnelId_when_rendered_then_loads_record_in_edit_mode', async () => {
    mockRouteParams = { personnelId: 'p1' };
    mockFindById.mockResolvedValue({
      id: 'p1',
      fullName: 'Asha Rao',
      employeeId: 'E1',
      role: 'Inspector',
      registeredAt: '',
      updatedAt: '',
      syncStatus: 'pending',
    });
    renderScreen();
    expect(await screen.findByText('Save Changes')).toBeTruthy();
    await waitFor(() => expect(screen.getByDisplayValue('Asha Rao')).toBeTruthy());
  });

  it('given_empty_required_fields_when_save_then_shows_validation_and_does_not_create', async () => {
    renderScreen();
    fireEvent.press(screen.getByText('Register Personnel'));
    expect(await screen.findByText('All fields are required.')).toBeTruthy();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('given_no_inline_camera_when_rendered_then_form_inputs_are_present', () => {
    // The live camera is never mounted inline behind the form — the inputs must be
    // present and unobstructed on first render (regression: camera overlapped fields).
    renderScreen();
    expect(screen.getByText('Capture Photo')).toBeTruthy();
    expect(screen.queryByText('Camera permission required for photo capture.')).toBeNull();
  });

  it('given_no_camera_permission_when_camera_opened_then_shows_permission_placeholder', async () => {
    renderScreen();
    fireEvent.press(screen.getByText('Capture Photo'));
    expect(await screen.findByText('Camera permission required for photo capture.')).toBeTruthy();
  });
});
