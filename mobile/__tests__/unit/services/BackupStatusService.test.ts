/**
 * T096 (write-first, precedes T066): BackupStatusService — start/complete/fail/cancel
 * lifecycle and getStatus() aggregation. Plain functions receive db as first arg;
 * the hook wrapper (useBackupStatusService) supplies db via useSQLiteContext().
 */
import {
  startJob,
  completeJob,
  failJob,
  cancelJob,
  completeBackupNow,
  getStatus,
  type SyncJobSummary,
} from '../../../src/services/BackupStatusService';
import type { BackupJob } from '../../../src/models/BackupJob';

// ---- dependency mocks -------------------------------------------------------

const mockCreate = jest.fn<Promise<BackupJob>, [Omit<BackupJob, 'id'>]>();
const mockUpdateStatus = jest.fn<Promise<void>, [string, Partial<BackupJob>]>();
const mockFindLatest = jest.fn<Promise<BackupJob | null>, []>();

jest.mock('../../../src/db/repositories/BackupJobRepository', () => ({
  BackupJobRepository: {
    create: (_db: unknown, job: Omit<BackupJob, 'id'>) => mockCreate(job),
    updateStatus: (_db: unknown, id: string, fields: Partial<BackupJob>) =>
      mockUpdateStatus(id, fields),
    findLatest: (_db: unknown) => mockFindLatest(),
    findAll: jest.fn(),
  },
}));

// getStatus queries sync_outbox directly via db.getFirstAsync
const mockDb = {
  runAsync: jest.fn(),
  getFirstAsync: jest.fn(),
  getAllAsync: jest.fn(),
};

// ---- helpers ----------------------------------------------------------------

const baseJob = (): BackupJob => ({
  id: 'job-1',
  startedAt: '2026-05-30T10:00:00.000Z',
  status: 'in_progress',
  recordsPersonnel: 0,
  recordsVerification: 0,
  recordsImages: 0,
  bytesTransferred: 0,
});

const summary = (): SyncJobSummary => ({
  recordsPersonnel: 2,
  recordsVerification: 5,
  recordsImages: 1,
  bytesTransferred: 102400,
});

// ---- tests ------------------------------------------------------------------

beforeEach(() => {
  mockCreate.mockReset();
  mockUpdateStatus.mockReset();
  mockFindLatest.mockReset();
  mockDb.runAsync.mockReset();
  mockDb.getFirstAsync.mockReset();
  mockDb.getAllAsync.mockReset();
});

describe('BackupStatusService.startJob', () => {
  it('creates a backup_job with in_progress status and returns its id', async () => {
    const job = baseJob();
    mockCreate.mockResolvedValue(job);

    const id = await startJob(mockDb as never);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'in_progress' }),
    );
    expect(id).toBe(job.id);
  });

  it('sets startedAt to the current ISO timestamp', async () => {
    const before = new Date().toISOString();
    mockCreate.mockImplementation(async (input) => ({ ...input, id: 'j' }));

    await startJob(mockDb as never);

    const createdWith = mockCreate.mock.calls[0]![0]!;
    expect(createdWith.startedAt >= before).toBe(true);
  });
});

describe('BackupStatusService.completeJob', () => {
  it('updates the job to completed with summary fields', async () => {
    mockUpdateStatus.mockResolvedValue(undefined);
    const s = summary();

    await completeJob(mockDb as never, 'job-1', s);

    expect(mockUpdateStatus).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({
        status: 'completed',
        recordsPersonnel: s.recordsPersonnel,
        recordsVerification: s.recordsVerification,
        recordsImages: s.recordsImages,
        bytesTransferred: s.bytesTransferred,
      }),
    );
  });

  it('sets completedAt timestamp', async () => {
    mockUpdateStatus.mockResolvedValue(undefined);
    const before = new Date().toISOString();

    await completeJob(mockDb as never, 'job-1', summary());

    const updatedWith = mockUpdateStatus.mock.calls[0]![1]!;
    expect(updatedWith.completedAt).toBeDefined();
    expect(updatedWith.completedAt! >= before).toBe(true);
  });
});

describe('BackupStatusService.failJob', () => {
  it('updates the job to failed with the error message', async () => {
    mockUpdateStatus.mockResolvedValue(undefined);

    await failJob(mockDb as never, 'job-1', 'Network timeout');

    expect(mockUpdateStatus).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({
        status: 'failed',
        errorMessage: 'Network timeout',
      }),
    );
  });
});

describe('BackupStatusService.cancelJob', () => {
  it('updates the job to cancelled', async () => {
    mockUpdateStatus.mockResolvedValue(undefined);

    await cancelJob(mockDb as never, 'job-1');

    expect(mockUpdateStatus).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'cancelled' }),
    );
  });
});

describe('BackupStatusService.getStatus', () => {
  it('returns pendingCount from sync_outbox and the latest job', async () => {
    const job: BackupJob = {
      ...baseJob(),
      status: 'completed',
      completedAt: '2026-05-30T10:01:00.000Z',
    };
    mockFindLatest.mockResolvedValue(job);
    mockDb.getFirstAsync.mockResolvedValue({ cnt: 3 });

    const status = await getStatus(mockDb as never);

    expect(status.pendingCount).toBe(3);
    expect(status.latestJob).toEqual(job);
  });

  it('returns lastSyncTime as completedAt of latest completed job', async () => {
    const completedAt = '2026-05-30T10:01:00.000Z';
    mockFindLatest.mockResolvedValue({ ...baseJob(), status: 'completed', completedAt });
    mockDb.getFirstAsync.mockResolvedValue({ cnt: 0 });

    const status = await getStatus(mockDb as never);

    expect(status.lastSyncTime).toBe(completedAt);
  });

  it('returns undefined lastSyncTime when latest job is not completed', async () => {
    mockFindLatest.mockResolvedValue(baseJob()); // in_progress
    mockDb.getFirstAsync.mockResolvedValue({ cnt: 2 });

    const status = await getStatus(mockDb as never);

    expect(status.lastSyncTime).toBeUndefined();
  });

  it('handles no jobs existing', async () => {
    mockFindLatest.mockResolvedValue(null);
    mockDb.getFirstAsync.mockResolvedValue({ cnt: 0 });

    const status = await getStatus(mockDb as never);

    expect(status.latestJob).toBeNull();
    expect(status.lastSyncTime).toBeUndefined();
    expect(status.pendingCount).toBe(0);
  });
});

describe('BackupStatusService.completeBackupNow', () => {
  it('clears the pending queue and records a completed job', async () => {
    mockDb.getFirstAsync.mockResolvedValue({ cnt: 5 });
    mockCreate.mockResolvedValue({ ...baseJob(), id: 'job-x' });

    const cleared = await completeBackupNow(mockDb as never);

    expect(cleared).toBe(5);
    expect(mockDb.runAsync).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM sync_outbox'));
    expect(mockUpdateStatus).toHaveBeenCalledWith(
      'job-x',
      expect.objectContaining({ status: 'completed' }),
    );
  });

  it('is a no-op when nothing is pending', async () => {
    mockDb.getFirstAsync.mockResolvedValue({ cnt: 0 });

    const cleared = await completeBackupNow(mockDb as never);

    expect(cleared).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockDb.runAsync).not.toHaveBeenCalled();
  });
});
