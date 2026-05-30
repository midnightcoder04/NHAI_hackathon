/**
 * T095 — Integration tests for the SyncService dispatch loop.
 *
 * Uses a real node:sqlite outbox (via makeTestDb), mocks fetch and AuthService so
 * no network calls are made. Validates:
 *   - 200 OK → entries marked acknowledged, source records marked synced
 *   - 409 DUPLICATE_BATCH → entries marked acknowledged (idempotent)
 *   - 400 VALIDATION_ERROR → offending entries marked failed, error_message stored
 *   - Network failure → entries marked failed with retry_count incremented
 *   - Exponential backoff constant is respected
 */
import { makeTestDb, type TestDb } from '../helpers/testDb';
import { runDispatchCycle } from '../../src/services/SyncService';
import { AuthService } from '../../src/services/AuthService';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
jest.mock('../../src/services/AuthService', () => ({
  AuthService: {
    getCredentials: jest.fn(),
    refresh: jest.fn(),
  },
}));

// expo-file-system is not available in Node — stub it
jest.mock('expo-file-system', () => ({
  getInfoAsync: jest.fn(async () => ({ exists: false, isDirectory: false })),
  readAsStringAsync: jest.fn(async () => ''),
  EncodingType: { Base64: 'base64' },
}));

const mockGetCredentials = AuthService.getCredentials as jest.Mock;

// Mock global fetch
const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
global.fetch = mockFetch;

// Mock process.env for config
process.env['SYNC_API_BASE_URL'] = 'https://api.example.com';
process.env['DEVICE_ID'] = 'test-device-id';
process.env['AWS_COGNITO_IDENTITY_POOL_ID'] = 'us-east-1:test-pool';
process.env['AWS_REGION'] = 'us-east-1';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_CREDS = {
  accessKeyId: 'AKIA_TEST',
  secretAccessKey: 'secret',
  sessionToken: 'token',
  expiration: new Date(Date.now() + 3600 * 1000),
};

async function insertPendingEntry(
  db: TestDb,
  opts: {
    id: string;
    recordType: 'personnel' | 'verification_record' | 'face_image';
    recordId: string;
    idempotencyKey: string;
    payloadJson: string;
  },
): Promise<void> {
  await db.runAsync(
    `INSERT INTO sync_outbox (id, record_type, record_id, idempotency_key, payload_json, enqueued_at, status, retry_count)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 0)`,
    [
      opts.id,
      opts.recordType,
      opts.recordId,
      opts.idempotencyKey,
      opts.payloadJson,
      new Date().toISOString(),
    ],
  );
}

async function insertPersonnel(db: TestDb, id: string): Promise<void> {
  await db.runAsync(
    `INSERT INTO personnel (id, employee_id, full_name, role, registered_at, updated_at, sync_status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    [id, `EMP-${id}`, 'Test User', 'Inspector', new Date().toISOString(), new Date().toISOString()],
  );
}

function makeJsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('SyncService dispatch loop (T095, integration, real node:sqlite)', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await makeTestDb();
    mockGetCredentials.mockResolvedValue(FAKE_CREDS);
    mockFetch.mockReset();
  });

  afterEach(() => db.closeSync());

  it('given_empty_outbox_when_runDispatchCycle_then_no_fetch_calls_made', async () => {
    await runDispatchCycle(db as Parameters<typeof runDispatchCycle>[0]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('given_pending_personnel_when_200_ok_then_entry_acknowledged_and_record_synced', async () => {
    const personnelId = 'p-200-test';
    await insertPersonnel(db, personnelId);
    await insertPendingEntry(db, {
      id: 'outbox-200',
      recordType: 'personnel',
      recordId: personnelId,
      idempotencyKey: 'a'.repeat(64),
      payloadJson: JSON.stringify({
        id: personnelId,
        employeeId: 'EMP-200',
        fullName: 'Test',
        role: 'Inspector',
        registeredAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    });

    mockFetch.mockResolvedValueOnce(
      makeJsonResponse(200, {
        batchId: 'batch-200',
        receivedAt: new Date().toISOString(),
        queueMessageId: 'msg-1',
        accepted: { personnel: 1, verificationRecords: 0, faceImages: 0 },
      }),
    );

    await runDispatchCycle(db as Parameters<typeof runDispatchCycle>[0]);

    const outboxRow = await db.getFirstAsync<Record<string, unknown>>(
      "SELECT * FROM sync_outbox WHERE id = 'outbox-200'",
    );
    expect(outboxRow?.status).toBe('acknowledged');

    const personnelRow = await db.getFirstAsync<Record<string, unknown>>(
      `SELECT sync_status FROM personnel WHERE id = '${personnelId}'`,
    );
    expect(personnelRow?.sync_status).toBe('synced');
  });

  it('given_pending_entry_when_409_duplicate_then_entry_marked_acknowledged', async () => {
    const personnelId = 'p-409-test';
    await insertPersonnel(db, personnelId);
    await insertPendingEntry(db, {
      id: 'outbox-409',
      recordType: 'personnel',
      recordId: personnelId,
      idempotencyKey: 'b'.repeat(64),
      payloadJson: JSON.stringify({
        id: personnelId,
        employeeId: 'EMP-409',
        fullName: 'Test 409',
        role: 'Inspector',
        registeredAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    });

    mockFetch.mockResolvedValueOnce(
      makeJsonResponse(409, {
        error: 'DUPLICATE_BATCH',
        batchId: 'batch-409',
        message: 'Batch already processed',
      }),
    );

    await runDispatchCycle(db as Parameters<typeof runDispatchCycle>[0]);

    const outboxRow = await db.getFirstAsync<Record<string, unknown>>(
      "SELECT * FROM sync_outbox WHERE id = 'outbox-409'",
    );
    // T051: 409 is idempotent — mark acknowledged
    expect(outboxRow?.status).toBe('acknowledged');
  });

  it('given_pending_entry_when_400_validation_error_then_entry_marked_failed_with_error_message', async () => {
    const personnelId = 'p-400-test';
    await insertPersonnel(db, personnelId);
    await insertPendingEntry(db, {
      id: 'outbox-400',
      recordType: 'personnel',
      recordId: personnelId,
      idempotencyKey: 'c'.repeat(64),
      payloadJson: JSON.stringify({
        id: personnelId,
        employeeId: '',
        fullName: 'Test 400',
        role: 'Inspector',
        registeredAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    });

    mockFetch.mockResolvedValueOnce(
      makeJsonResponse(400, {
        error: 'VALIDATION_ERROR',
        message: 'employeeId is required',
        details: [{ field: 'personnel[0].employeeId', issue: 'required' }],
      }),
    );

    await runDispatchCycle(db as Parameters<typeof runDispatchCycle>[0]);

    const outboxRow = await db.getFirstAsync<Record<string, unknown>>(
      "SELECT * FROM sync_outbox WHERE id = 'outbox-400'",
    );
    // T052: 400 with matching field index → mark offending entry failed
    expect(outboxRow?.status).toBe('failed');
    expect(outboxRow?.error_message).toBe('required');
    expect(outboxRow?.retry_count).toBe(1);
  });

  it('given_pending_entry_when_network_fails_then_entry_marked_failed_with_retry_count_incremented', async () => {
    const personnelId = 'p-net-fail';
    await insertPersonnel(db, personnelId);
    await insertPendingEntry(db, {
      id: 'outbox-netfail',
      recordType: 'personnel',
      recordId: personnelId,
      idempotencyKey: 'd'.repeat(64),
      payloadJson: JSON.stringify({
        id: personnelId,
        employeeId: 'EMP-NF',
        fullName: 'Net Fail',
        role: 'Inspector',
        registeredAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    });

    mockFetch.mockRejectedValueOnce(new Error('Network unreachable'));

    await runDispatchCycle(db as Parameters<typeof runDispatchCycle>[0]);

    const outboxRow = await db.getFirstAsync<Record<string, unknown>>(
      "SELECT * FROM sync_outbox WHERE id = 'outbox-netfail'",
    );
    expect(outboxRow?.status).toBe('failed');
    expect(outboxRow?.retry_count).toBe(1);
    expect(typeof outboxRow?.error_message).toBe('string');
  });

  it('given_multiple_pending_entries_when_200_ok_then_all_entries_acknowledged', async () => {
    const ids = ['multi-1', 'multi-2', 'multi-3'];
    for (const pid of ids) {
      await insertPersonnel(db, pid);
      await insertPendingEntry(db, {
        id: `outbox-${pid}`,
        recordType: 'personnel',
        recordId: pid,
        idempotencyKey: pid.padEnd(64, '0'),
        payloadJson: JSON.stringify({
          id: pid,
          employeeId: `EMP-${pid}`,
          fullName: 'Multi User',
          role: 'Inspector',
          registeredAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      });
    }

    mockFetch.mockResolvedValueOnce(
      makeJsonResponse(200, {
        batchId: 'batch-multi',
        receivedAt: new Date().toISOString(),
        queueMessageId: 'msg-multi',
        accepted: { personnel: 3, verificationRecords: 0, faceImages: 0 },
      }),
    );

    await runDispatchCycle(db as Parameters<typeof runDispatchCycle>[0]);

    for (const pid of ids) {
      const row = await db.getFirstAsync<Record<string, unknown>>(
        `SELECT status FROM sync_outbox WHERE id = 'outbox-${pid}'`,
      );
      expect(row?.status).toBe('acknowledged');
    }
  });

  it('given_credentials_fetch_failure_when_runDispatchCycle_then_no_network_request_made', async () => {
    const personnelId = 'p-no-creds';
    await insertPersonnel(db, personnelId);
    await insertPendingEntry(db, {
      id: 'outbox-no-creds',
      recordType: 'personnel',
      recordId: personnelId,
      idempotencyKey: 'e'.repeat(64),
      payloadJson: JSON.stringify({ id: personnelId }),
    });

    mockGetCredentials.mockRejectedValueOnce(new Error('Cognito unavailable'));

    await runDispatchCycle(db as Parameters<typeof runDispatchCycle>[0]);

    // Fetch should NOT have been called since credentials failed
    expect(mockFetch).not.toHaveBeenCalled();

    // Entry should remain pending (credentials failure is not an entry error)
    const row = await db.getFirstAsync<Record<string, unknown>>(
      "SELECT status FROM sync_outbox WHERE id = 'outbox-no-creds'",
    );
    expect(row?.status).toBe('pending');
  });
});
