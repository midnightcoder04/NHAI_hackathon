import { useSQLiteContext } from 'expo-sqlite';
import type { SQLiteBindValue } from 'expo-sqlite';
import type { Personnel } from '../../models/Personnel';
import { generateUUID } from '../../utils/uuid';
import { CryptoService } from '../../services/CryptoService';
import { useSyncOutboxRepository } from './SyncOutboxRepository';

// T073: full_name is PII — encrypted at rest (AES-256-GCM). employee_id stays plaintext
// (it's the UNIQUE / RDS-upsert key); decryptString tolerates legacy plaintext rows.
async function rowToPersonnel(row: Record<string, unknown>): Promise<Personnel> {
  return {
    id: row.id as string,
    employeeId: row.employee_id as string,
    fullName: await CryptoService.decryptString(row.full_name as string),
    role: row.role as string,
    registeredAt: row.registered_at as string,
    updatedAt: row.updated_at as string,
    syncStatus: row.sync_status as Personnel['syncStatus'],
    syncError: (row.sync_error as string | null) ?? undefined,
  };
}

export function usePersonnelRepository() {
  const db = useSQLiteContext();
  const outbox = useSyncOutboxRepository();

  async function create(p: Omit<Personnel, 'id'>): Promise<Personnel> {
    const id = generateUUID();
    const record: Personnel = { ...p, id };

    await db.withTransactionAsync(async () => {
      await db.runAsync(
        `INSERT INTO personnel (id, employee_id, full_name, role, registered_at, updated_at, sync_status, sync_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          p.employeeId,
          await CryptoService.encryptString(p.fullName),
          p.role,
          p.registeredAt,
          p.updatedAt,
          p.syncStatus,
          p.syncError ?? null,
        ] as SQLiteBindValue[],
      );
      await outbox.enqueue('personnel', id, {
        id,
        employeeId: p.employeeId,
        fullName: p.fullName,
        role: p.role,
        registeredAt: p.registeredAt,
        updatedAt: p.updatedAt,
      });
    });

    return record;
  }

  async function update(
    id: string,
    fields: Partial<Pick<Personnel, 'fullName' | 'employeeId' | 'role' | 'syncStatus' | 'syncError'>>,
  ): Promise<void> {
    const updatedAt = new Date().toISOString();
    const setClauses: string[] = ['updated_at = ?'];
    const values: SQLiteBindValue[] = [updatedAt];

    if (fields.fullName !== undefined) {
      setClauses.push('full_name = ?');
      values.push(await CryptoService.encryptString(fields.fullName));
    }
    if (fields.employeeId !== undefined) { setClauses.push('employee_id = ?'); values.push(fields.employeeId); }
    if (fields.role !== undefined) { setClauses.push('role = ?'); values.push(fields.role); }
    if (fields.syncStatus !== undefined) { setClauses.push('sync_status = ?'); values.push(fields.syncStatus); }
    if (fields.syncError !== undefined) { setClauses.push('sync_error = ?'); values.push(fields.syncError); }

    values.push(id);

    await db.withTransactionAsync(async () => {
      await db.runAsync(`UPDATE personnel SET ${setClauses.join(', ')} WHERE id = ?`, values);
      // Only enqueue if this is a data change (not just a sync status update)
      if (
        fields.fullName !== undefined ||
        fields.employeeId !== undefined ||
        fields.role !== undefined
      ) {
        // Fetch the current record to build the full payload
        const row = await db.getFirstAsync<Record<string, unknown>>(
          'SELECT * FROM personnel WHERE id = ?',
          [id],
        );
        if (row) {
          const p = await rowToPersonnel(row);
          await outbox.enqueue('personnel', id, {
            id,
            employeeId: p.employeeId,
            fullName: p.fullName,
            role: p.role,
            registeredAt: p.registeredAt,
            updatedAt,
          });
        }
      }
    });
  }

  // T077: hard-delete is only safe once a record is fully synced AND nothing is mid-flight
  // for it — otherwise a delete could race an in-flight upload or silently drop a record
  // the cloud never received. In those cases we tombstone (soft-delete) instead: the row
  // stays, hidden from the UI, and a best-effort tombstone is enqueued for the cloud.
  async function deleteById(id: string): Promise<void> {
    const row = await db.getFirstAsync<{ sync_status: string }>(
      'SELECT sync_status FROM personnel WHERE id = ?',
      [id],
    );
    if (!row) return;
    const inFlight = await db.getFirstAsync<{ one: number }>(
      `SELECT 1 AS one FROM sync_outbox
       WHERE record_type = 'personnel' AND record_id = ? AND status = 'dispatched'`,
      [id],
    );
    if (row.sync_status === 'synced' && !inFlight) {
      await db.runAsync('DELETE FROM personnel WHERE id = ?', [id]); // cascades to face_image
      return;
    }
    await db.withTransactionAsync(async () => {
      await db.runAsync(
        'UPDATE personnel SET tombstoned = 1, updated_at = ? WHERE id = ?',
        [new Date().toISOString(), id],
      );
      await outbox.enqueue('personnel', id, { id, tombstoned: true });
    });
  }

  async function findAll(): Promise<Personnel[]> {
    const rows = await db.getAllAsync<Record<string, unknown>>(
      'SELECT * FROM personnel WHERE tombstoned = 0 ORDER BY registered_at DESC',
    );
    return Promise.all(rows.map(rowToPersonnel));
  }

  async function findById(id: string): Promise<Personnel | null> {
    const row = await db.getFirstAsync<Record<string, unknown>>(
      'SELECT * FROM personnel WHERE id = ? AND tombstoned = 0',
      [id],
    );
    return row ? rowToPersonnel(row) : null;
  }

  // (full_name decrypt happens in rowToPersonnel; employee_id stays plaintext for lookups)

  return { create, update, delete: deleteById, findAll, findById };
}
