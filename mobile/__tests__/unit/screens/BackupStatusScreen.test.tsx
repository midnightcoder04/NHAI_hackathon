/**
 * T097 (write-first, precedes T068): BackupStatusScreen — Retry visible only when
 * status='failed'; Cancel visible only when status='in_progress'.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';
import type { BackupJob } from '../../../src/models/BackupJob';

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }),
  useFocusEffect: (cb: () => void) => {
    const React = require('react');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mock: run the focus cb once
    React.useEffect(() => { cb(); }, []);
  },
}));

// ---- BackupStatusService mock -----------------------------------------------

const mockGetStatus = jest.fn();
const mockCancelJob = jest.fn();
jest.mock('../../../src/services/BackupStatusService', () => ({
  useBackupStatusService: () => ({
    getStatus: mockGetStatus,
    startJob: jest.fn(),
    completeJob: jest.fn(),
    failJob: jest.fn(),
    cancelJob: mockCancelJob,
  }),
}));

// ---- SyncService mock -------------------------------------------------------
// jest.fn() must be created inside the factory (not captured from outer scope)
// because jest.mock is hoisted above variable declarations.
jest.mock('../../../src/services/SyncService', () => ({
  triggerSync: jest.fn(),
  requestCancel: jest.fn(),
}));
// Retrieve stable references after mock registration
const mockTriggerSync = jest.requireMock('../../../src/services/SyncService')
  .triggerSync as jest.Mock;
const mockRequestCancel = jest.requireMock('../../../src/services/SyncService')
  .requestCancel as jest.Mock;

// ---- expo-sqlite (useSQLiteContext) mock ------------------------------------

jest.mock('expo-sqlite', () => ({
  useSQLiteContext: () => ({}),
}));

// ---- helpers ----------------------------------------------------------------

const baseJob = (overrides: Partial<BackupJob> = {}): BackupJob => ({
  id: 'job-1',
  startedAt: '2026-05-30T10:00:00.000Z',
  status: 'in_progress',
  recordsPersonnel: 0,
  recordsVerification: 0,
  recordsImages: 0,
  bytesTransferred: 0,
  ...overrides,
});

const statusOf = (job: BackupJob | null) => ({
  pendingCount: 3,
  latestJob: job,
  lastSyncTime: job?.completedAt,
});

import BackupStatusScreen from '../../../src/screens/BackupStatusScreen';

const renderScreen = () =>
  render(
    <PaperProvider>
      <BackupStatusScreen />
    </PaperProvider>,
  );

// ---- tests ------------------------------------------------------------------

describe('BackupStatusScreen', () => {
  beforeEach(() => {
    mockGetStatus.mockReset();
    mockTriggerSync.mockReset();
    mockRequestCancel.mockReset();
    mockCancelJob.mockReset();
  });

  it('given_status_failed_when_rendered_then_retry_button_is_visible', async () => {
    mockGetStatus.mockResolvedValue(statusOf(baseJob({ status: 'failed', errorMessage: 'Timeout' })));
    renderScreen();
    expect(await screen.findByText(/retry/i)).toBeTruthy();
  });

  it('given_status_in_progress_when_rendered_then_cancel_button_is_visible', async () => {
    mockGetStatus.mockResolvedValue(statusOf(baseJob({ status: 'in_progress' })));
    renderScreen();
    expect(await screen.findByText(/cancel/i)).toBeTruthy();
  });

  it('given_status_completed_when_rendered_then_neither_retry_nor_cancel_is_visible', async () => {
    mockGetStatus.mockResolvedValue(
      statusOf(baseJob({ status: 'completed', completedAt: '2026-05-30T10:01:00.000Z' })),
    );
    renderScreen();
    // Wait for the "Status: Completed" label to appear, then assert buttons absent
    await screen.findByText('Status: Completed');
    expect(screen.queryByText(/retry/i)).toBeNull();
    expect(screen.queryByText(/cancel/i)).toBeNull();
  });

  it('given_no_job_when_rendered_then_shows_no_recent_backup_message', async () => {
    mockGetStatus.mockResolvedValue({ pendingCount: 0, latestJob: null, lastSyncTime: undefined });
    renderScreen();
    expect(await screen.findByText(/no recent backup/i)).toBeTruthy();
  });

  it('given_retry_pressed_when_status_failed_then_triggers_sync', async () => {
    mockGetStatus.mockResolvedValue(statusOf(baseJob({ status: 'failed' })));
    mockTriggerSync.mockResolvedValue(undefined);
    renderScreen();

    fireEvent.press(await screen.findByText(/retry/i));

    await waitFor(() => expect(mockTriggerSync).toHaveBeenCalled());
  });

  it('given_cancel_pressed_when_status_in_progress_then_requests_cancel', async () => {
    const job = baseJob({ status: 'in_progress' });
    mockGetStatus.mockResolvedValue(statusOf(job));
    mockCancelJob.mockResolvedValue(undefined);
    renderScreen();

    fireEvent.press(await screen.findByText(/cancel/i));

    await waitFor(() => expect(mockRequestCancel).toHaveBeenCalled());
  });

  it('shows pending record count', async () => {
    mockGetStatus.mockResolvedValue({ pendingCount: 7, latestJob: null, lastSyncTime: undefined });
    renderScreen();
    expect(await screen.findByText(/7/)).toBeTruthy();
  });

  it('shows error message when status is failed', async () => {
    mockGetStatus.mockResolvedValue(
      statusOf(baseJob({ status: 'failed', errorMessage: 'Connection refused' })),
    );
    renderScreen();
    expect(await screen.findByText(/connection refused/i)).toBeTruthy();
  });
});
