import { useSQLiteContext } from 'expo-sqlite';
import type { SQLiteBindValue } from 'expo-sqlite';
import type { SyncOutboxEntry, SyncOutboxRecordType } from '../../models/SyncOutboxEntry';
import { generateUUID } from '../../utils/uuid';
import { computeIdempotencyKey } from '../../utils/idempotency';

function rowToSyncOutboxEntry(row: Record<string, unknown>): SyncOutboxEntry {
  return {
    id: row.id as string,
    recordType: row.record_type as SyncOutboxEntry['recordType'],
    recordId: row.record_id as string,
    idempotencyKey: row.idempotency_key as string,
    payloadJson: row.payload_json as string,
    enqueuedAt: row.enqueued_at as string,
    dispatchedAt: (row.dispatched_at as string | null) ?? undefined,
    status: row.status as SyncOutboxEntry['status'],
    retryCount: row.retry_count as number,
    errorMessage: (row.error_message as string | null) ?? undefined,
  };
}

export function useSyncOutboxRepository() {
  const db = useSQLiteContext();

  /**
   * Enqueue a record for sync. Uses INSERT OR IGNORE with a UNIQUE idempotency_key
   * so duplicate calls for the same (type, recordId) pair are silently ignored.
   */
  async function enqueue(
    type: SyncOutboxRecordType,
    recordId: string,
    payload: object,
  ): Promise<void> {
    const id = generateUUID();
    const idempotencyKey = await computeIdempotencyKey([type, recordId]);
    const payloadJson = JSON.stringify(payload);
    const enqueuedAt = new Date().toISOString();

    await db.runAsync(
      `INSERT OR IGNORE INTO sync_outbox
         (id, record_type, record_id, idempotency_key, payload_json, enqueued_at, status, retry_count)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0)`,
      [id, type, recordId, idempotencyKey, payloadJson, enqueuedAt] as SQLiteBindValue[],
    );
  }

  /**
   * Return up to `limit` pending entries in FIFO order (oldest enqueued_at first).
   */
  async function dequeuePending(limit: number): Promise<SyncOutboxEntry[]> {
    const rows = await db.getAllAsync<Record<string, unknown>>(
      `SELECT * FROM sync_outbox
       WHERE status = 'pending'
       ORDER BY enqueued_at ASC
       LIMIT ?`,
      [limit],
    );
    return rows.map(rowToSyncOutboxEntry);
  }

  /**
   * Mark an entry as dispatched and record the current timestamp.
   */
  async function markDispatched(id: string): Promise<void> {
    const dispatchedAt = new Date().toISOString();
    await db.runAsync(
      `UPDATE sync_outbox SET status = 'dispatched', dispatched_at = ? WHERE id = ?`,
      [dispatchedAt, id] as SQLiteBindValue[],
    );
  }

  /**
   * Mark an entry as acknowledged (successful server-side processing).
   */
  async function markAcknowledged(id: string): Promise<void> {
    await db.runAsync(
      `UPDATE sync_outbox SET status = 'acknowledged' WHERE id = ?`,
      [id] as SQLiteBindValue[],
    );
  }

  /**
   * Mark an entry as failed, increment retry_count, and store the error message.
   */
  async function markFailed(id: string, errorMessage: string): Promise<void> {
    await db.runAsync(
      `UPDATE sync_outbox
       SET status = 'failed', retry_count = retry_count + 1, error_message = ?
       WHERE id = ?`,
      [errorMessage, id] as SQLiteBindValue[],
    );
  }

  /**
   * Return the number of pending outbox entries.
   */
  async function countPending(): Promise<number> {
    const row = await db.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM sync_outbox WHERE status = 'pending'`,
    );
    return row?.cnt ?? 0;
  }

  return { enqueue, dequeuePending, markDispatched, markAcknowledged, markFailed, countPending };
}
