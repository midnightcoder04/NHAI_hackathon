/**
 * T092 — Integration tests for SyncOutboxRepository.
 * Uses real node:sqlite via makeTestDb() (Constitution III: no mocks for persistence).
 */
import { useSQLiteContext } from 'expo-sqlite';
import { useSyncOutboxRepository } from '../../src/db/repositories/SyncOutboxRepository';
import { makeTestDb, type TestDb } from '../helpers/testDb';

const mockedUseContext = useSQLiteContext as jest.Mock;

describe('SyncOutboxRepository (integration, real node:sqlite)', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await makeTestDb();
    mockedUseContext.mockReturnValue(db);
  });

  afterEach(() => db.closeSync());

  // T092-1: enqueue inserts a row with status='pending'
  it('given_valid_payload_when_enqueue_then_row_inserted_with_pending_status', async () => {
    const repo = useSyncOutboxRepository();
    await repo.enqueue('personnel', 'rec-001', { employeeId: 'EMP-1', fullName: 'Alice' });

    const rows = await db.getAllAsync<Record<string, unknown>>(
      "SELECT * FROM sync_outbox WHERE record_id = 'rec-001'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].record_type).toBe('personnel');
    expect(rows[0].record_id).toBe('rec-001');
    expect(rows[0].retry_count).toBe(0);
    expect(rows[0].dispatched_at).toBeNull();
    expect(rows[0].error_message).toBeNull();
    expect(typeof rows[0].idempotency_key).toBe('string');
    expect(typeof rows[0].payload_json).toBe('string');
  });

  // T092-2: enqueue with duplicate idempotency key is idempotent
  it('given_duplicate_enqueue_when_same_type_and_recordId_then_no_duplicate_row', async () => {
    const repo = useSyncOutboxRepository();
    await repo.enqueue('personnel', 'rec-dup', { fullName: 'Bob' });
    // second call must not throw and must not insert a duplicate row
    await expect(
      repo.enqueue('personnel', 'rec-dup', { fullName: 'Bob updated' }),
    ).resolves.toBeUndefined();

    const rows = await db.getAllAsync<Record<string, unknown>>(
      "SELECT * FROM sync_outbox WHERE record_id = 'rec-dup'",
    );
    expect(rows).toHaveLength(1);
  });

  // T092-3: dequeuePending returns pending entries in FIFO order and respects limit
  it('given_three_pending_entries_when_dequeuePending_limit_2_then_returns_two_oldest', async () => {
    const repo = useSyncOutboxRepository();

    // Insert with explicit enqueued_at to control ordering
    await db.runAsync(
      `INSERT INTO sync_outbox (id, record_type, record_id, idempotency_key, payload_json, enqueued_at, status, retry_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['id-1', 'personnel', 'r1', 'ik-1', '{}', '2026-05-30T10:00:00.000Z', 'pending', 0],
    );
    await db.runAsync(
      `INSERT INTO sync_outbox (id, record_type, record_id, idempotency_key, payload_json, enqueued_at, status, retry_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['id-2', 'personnel', 'r2', 'ik-2', '{}', '2026-05-30T10:01:00.000Z', 'pending', 0],
    );
    await db.runAsync(
      `INSERT INTO sync_outbox (id, record_type, record_id, idempotency_key, payload_json, enqueued_at, status, retry_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['id-3', 'personnel', 'r3', 'ik-3', '{}', '2026-05-30T10:02:00.000Z', 'pending', 0],
    );

    const results = await repo.dequeuePending(2);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('id-1');
    expect(results[1].id).toBe('id-2');
  });

  // T092-4: dequeuePending excludes non-pending entries
  it('given_mixed_status_entries_when_dequeuePending_then_only_pending_returned', async () => {
    const repo = useSyncOutboxRepository();
    await db.runAsync(
      `INSERT INTO sync_outbox (id, record_type, record_id, idempotency_key, payload_json, enqueued_at, status, retry_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['id-p', 'personnel', 'rp', 'ik-p', '{}', '2026-05-30T10:00:00.000Z', 'pending', 0],
    );
    await db.runAsync(
      `INSERT INTO sync_outbox (id, record_type, record_id, idempotency_key, payload_json, enqueued_at, status, retry_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['id-d', 'personnel', 'rd', 'ik-d', '{}', '2026-05-30T10:00:00.000Z', 'dispatched', 0],
    );
    await db.runAsync(
      `INSERT INTO sync_outbox (id, record_type, record_id, idempotency_key, payload_json, enqueued_at, status, retry_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['id-a', 'personnel', 'ra', 'ik-a', '{}', '2026-05-30T10:00:00.000Z', 'acknowledged', 0],
    );
    await db.runAsync(
      `INSERT INTO sync_outbox (id, record_type, record_id, idempotency_key, payload_json, enqueued_at, status, retry_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['id-f', 'personnel', 'rf', 'ik-f', '{}', '2026-05-30T10:00:00.000Z', 'failed', 0],
    );

    const results = await repo.dequeuePending(100);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('id-p');
  });

  // T092-5: markDispatched updates status and sets dispatched_at
  it('given_pending_entry_when_markDispatched_then_status_is_dispatched_and_dispatched_at_set', async () => {
    const repo = useSyncOutboxRepository();
    await db.runAsync(
      `INSERT INTO sync_outbox (id, record_type, record_id, idempotency_key, payload_json, enqueued_at, status, retry_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['id-md', 'personnel', 'r-md', 'ik-md', '{}', '2026-05-30T10:00:00.000Z', 'pending', 0],
    );

    await repo.markDispatched('id-md');

    const row = await db.getFirstAsync<Record<string, unknown>>(
      "SELECT * FROM sync_outbox WHERE id = 'id-md'",
    );
    expect(row?.status).toBe('dispatched');
    expect(typeof row?.dispatched_at).toBe('string');
    expect(row?.dispatched_at).not.toBeNull();
  });

  // T092-6: markAcknowledged updates status to acknowledged
  it('given_dispatched_entry_when_markAcknowledged_then_status_is_acknowledged', async () => {
    const repo = useSyncOutboxRepository();
    await db.runAsync(
      `INSERT INTO sync_outbox (id, record_type, record_id, idempotency_key, payload_json, enqueued_at, status, retry_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['id-ma', 'personnel', 'r-ma', 'ik-ma', '{}', '2026-05-30T10:00:00.000Z', 'dispatched', 0],
    );

    await repo.markAcknowledged('id-ma');

    const row = await db.getFirstAsync<Record<string, unknown>>(
      "SELECT * FROM sync_outbox WHERE id = 'id-ma'",
    );
    expect(row?.status).toBe('acknowledged');
  });

  // T092-7 & 8: markFailed increments retry_count, stores error_message, sets status='failed'
  it('given_pending_entry_when_markFailed_then_status_failed_retry_count_incremented_and_error_stored', async () => {
    const repo = useSyncOutboxRepository();
    await db.runAsync(
      `INSERT INTO sync_outbox (id, record_type, record_id, idempotency_key, payload_json, enqueued_at, status, retry_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['id-mf', 'personnel', 'r-mf', 'ik-mf', '{}', '2026-05-30T10:00:00.000Z', 'pending', 0],
    );

    await repo.markFailed('id-mf', 'Network timeout');

    const row = await db.getFirstAsync<Record<string, unknown>>(
      "SELECT * FROM sync_outbox WHERE id = 'id-mf'",
    );
    expect(row?.status).toBe('failed');
    expect(row?.retry_count).toBe(1);
    expect(row?.error_message).toBe('Network timeout');
  });

  it('given_previously_failed_entry_when_markFailed_again_then_retry_count_increments_further', async () => {
    const repo = useSyncOutboxRepository();
    await db.runAsync(
      `INSERT INTO sync_outbox (id, record_type, record_id, idempotency_key, payload_json, enqueued_at, status, retry_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['id-mf2', 'personnel', 'r-mf2', 'ik-mf2', '{}', '2026-05-30T10:00:00.000Z', 'pending', 2],
    );

    await repo.markFailed('id-mf2', 'Server error');

    const row = await db.getFirstAsync<Record<string, unknown>>(
      "SELECT * FROM sync_outbox WHERE id = 'id-mf2'",
    );
    expect(row?.retry_count).toBe(3);
    expect(row?.error_message).toBe('Server error');
  });

  // T092-9: countPending returns count of pending entries
  it('given_mix_of_statuses_when_countPending_then_returns_only_pending_count', async () => {
    const repo = useSyncOutboxRepository();
    await db.runAsync(
      `INSERT INTO sync_outbox (id, record_type, record_id, idempotency_key, payload_json, enqueued_at, status, retry_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['cp-1', 'personnel', 'rcp-1', 'ikcp-1', '{}', '2026-05-30T10:00:00.000Z', 'pending', 0],
    );
    await db.runAsync(
      `INSERT INTO sync_outbox (id, record_type, record_id, idempotency_key, payload_json, enqueued_at, status, retry_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['cp-2', 'personnel', 'rcp-2', 'ikcp-2', '{}', '2026-05-30T10:00:00.000Z', 'pending', 0],
    );
    await db.runAsync(
      `INSERT INTO sync_outbox (id, record_type, record_id, idempotency_key, payload_json, enqueued_at, status, retry_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['cp-3', 'personnel', 'rcp-3', 'ikcp-3', '{}', '2026-05-30T10:00:00.000Z', 'acknowledged', 0],
    );

    const count = await repo.countPending();
    expect(count).toBe(2);
  });

  // Test the returned SyncOutboxEntry shape from dequeuePending
  it('given_enqueued_entry_when_dequeuePending_then_entry_has_correct_shape', async () => {
    const repo = useSyncOutboxRepository();
    await repo.enqueue('face_image', 'fi-001', { personnelId: 'p-1', imagePath: '/tmp/img.jpg' });

    const [entry] = await repo.dequeuePending(10);
    expect(entry.recordType).toBe('face_image');
    expect(entry.recordId).toBe('fi-001');
    expect(entry.status).toBe('pending');
    expect(entry.retryCount).toBe(0);
    expect(typeof entry.idempotencyKey).toBe('string');
    expect(typeof entry.enqueuedAt).toBe('string');
    expect(JSON.parse(entry.payloadJson)).toMatchObject({ personnelId: 'p-1' });
    expect(entry.dispatchedAt).toBeUndefined();
    expect(entry.errorMessage).toBeUndefined();
  });
});
