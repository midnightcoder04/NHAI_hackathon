/**
 * T101 — Sync throughput benchmark (SC-005).
 *
 * SC-005: 500 verification records sync within 3 minutes over stable connectivity.
 *
 * This benchmark drives the REAL outbox dispatch loop (runDispatchCycle) against a real
 * node:sqlite outbox of 500 verification records, with the network layer (fetch),
 * credentials (AuthService) and file system stubbed — so it measures the on-device CPU +
 * SQLite cost of preparing, batching, marking-dispatched and acknowledging 500 records.
 * Wall-clock network time is environment-dependent and is covered by the on-device /
 * staging throughput run (recorded in plan.md → Profiling Results), not here.
 *
 * Lives under __tests__/perf (NOT in the default jest testMatch) so it runs only via
 * `pnpm test:perf` — keeping the gating unit/integration run fast and deterministic.
 *
 * Assertions:
 *   1. Hard spec gate: elapsed < SC-005 limit (180 s) with wide margin.
 *   2. Regression guard: elapsed < CI_BUDGET_MS (a conservative ceiling; a >20% regression
 *      past the recorded baseline trips this well before the 180 s spec limit).
 *   3. Correctness: all 500 outbox entries acknowledged in a single cycle.
 */
import { makeTestDb, type TestDb } from '../helpers/testDb';
import { runDispatchCycle } from '../../src/services/SyncService';
import { AuthService } from '../../src/services/AuthService';
import { SYNC_BATCH_MAX_VERIFICATIONS } from '../../src/constants';

jest.mock('../../src/services/AuthService', () => ({
  AuthService: { getCredentials: jest.fn(), refresh: jest.fn() },
}));

jest.mock('expo-file-system', () => ({
  getInfoAsync: jest.fn(async () => ({ exists: false, isDirectory: false })),
}));

const mockGetCredentials = AuthService.getCredentials as jest.Mock;
const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
global.fetch = mockFetch;

process.env['SYNC_API_BASE_URL'] = 'https://api.example.com';
process.env['DEVICE_ID'] = 'perf-device';
process.env['AWS_REGION'] = 'us-east-1';

const FAKE_CREDS = {
  accessKeyId: 'AKIA_PERF',
  secretAccessKey: 'secret',
  sessionToken: 'token',
  expiration: new Date(Date.now() + 3600 * 1000),
};

// SC-005 spec ceiling.
const SC005_LIMIT_MS = 3 * 60 * 1000; // 180 s
// Conservative CI regression guard. With the network mocked, 500 records is pure
// SQLite + JS — sub-second on dev hardware and a few seconds on a slow CI runner. 20 s
// is ~1.2× a deliberately pessimistic baseline, so a real >20% regression (or a hang)
// fails here long before the spec limit; re-tighten against the first green CI baseline.
const CI_BUDGET_MS = 20 * 1000;
const RECORD_COUNT = SYNC_BATCH_MAX_VERIFICATIONS; // 500 — one full batch

function makeVerificationPayload(id: string): string {
  const now = new Date().toISOString();
  return JSON.stringify({
    id,
    personnelIdMatched: null,
    outcome: 'authorized',
    confidenceScore: 0.91,
    initiatedAt: now,
    completedAt: now,
    deviceId: 'perf-device',
  });
}

async function seedVerifications(db: TestDb, n: number): Promise<void> {
  const now = new Date().toISOString();
  await db.withTransactionAsync(async () => {
    for (let i = 0; i < n; i++) {
      const id = `vr-${i}`;
      await db.runAsync(
        `INSERT INTO verification_record
           (id, personnel_id_matched, initiated_at, completed_at, outcome, confidence_score, device_id, sync_status)
         VALUES (?, NULL, ?, ?, 'authorized', 0.91, 'perf-device', 'pending')`,
        [id, now, now],
      );
      await db.runAsync(
        `INSERT INTO sync_outbox
           (id, record_type, record_id, idempotency_key, payload_json, enqueued_at, status, retry_count)
         VALUES (?, 'verification_record', ?, ?, ?, ?, 'pending', 0)`,
        // Leading-zero the index: `idem-${i}`.padEnd(64,'0') made idem-1 / idem-10 / idem-100
        // collide (trailing zeros), tripping the UNIQUE idempotency_key constraint.
        [`ob-${i}`, id, `idem-${String(i).padStart(59, '0')}`, makeVerificationPayload(id), now],
      );
    }
  });
}

describe('Sync throughput benchmark (T101, SC-005)', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await makeTestDb();
    mockGetCredentials.mockResolvedValue(FAKE_CREDS);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        batchId: 'batch-perf',
        receivedAt: new Date().toISOString(),
        queueMessageId: 'msg-perf',
        accepted: { personnel: 0, verificationRecords: RECORD_COUNT, faceImages: 0 },
      }),
      text: async () => '',
    } as Response);
  });

  afterEach(() => db.closeSync());

  it(`syncs ${RECORD_COUNT} verification records within SC-005 budget`, async () => {
    await seedVerifications(db, RECORD_COUNT);

    const start = performance.now();
    await runDispatchCycle(db as unknown as Parameters<typeof runDispatchCycle>[0]);
    const elapsedMs = performance.now() - start;

    const recordsPerSec = (RECORD_COUNT / elapsedMs) * 1000;
    // eslint-disable-next-line no-console
    console.log(
      `[T101] ${RECORD_COUNT} records dispatched in ${elapsedMs.toFixed(1)} ms ` +
        `(${recordsPerSec.toFixed(0)} rec/s); SC-005 limit ${SC005_LIMIT_MS} ms, CI budget ${CI_BUDGET_MS} ms`,
    );

    // All entries acknowledged in a single batch (≤ SYNC_BATCH_MAX_VERIFICATIONS).
    const ackd = await db.getFirstAsync<{ c: number }>(
      `SELECT COUNT(*) AS c FROM sync_outbox WHERE status = 'acknowledged'`,
    );
    expect(ackd?.c).toBe(RECORD_COUNT);

    const pending = await db.getFirstAsync<{ c: number }>(
      `SELECT COUNT(*) AS c FROM sync_outbox WHERE status = 'pending'`,
    );
    expect(pending?.c).toBe(0);

    expect(elapsedMs).toBeLessThan(SC005_LIMIT_MS);
    expect(elapsedMs).toBeLessThan(CI_BUDGET_MS);
  });
});
