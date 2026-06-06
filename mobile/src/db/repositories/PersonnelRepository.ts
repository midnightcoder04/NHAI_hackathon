import { useSQLiteContext } from 'expo-sqlite';
import type { SQLiteBindValue } from 'expo-sqlite';
import type { Personnel } from '../../models/Personnel';
import { generateUUID } from '../../utils/uuid';
import { useSyncOutboxRepository } from './SyncOutboxRepository';
import { encryptString, decryptString } from '../../services/CryptoService';

async function rowToPersonnel(row: Record<string, unknown>): Promise<Personnel> {
  return {
    id: row.id as string,
    employeeId: row.employee_id as string,
    fullName: await decryptString(row.full_name as string).catch(() => row.full_name as string),
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

    const encFullName = await encryptString(p.fullName);

    await db.withTransactionAsync(async () => {
      await db.runAsync(
        `INSERT INTO personnel (id, employee_id, full_name, role, registered_at, updated_at, sync_status, sync_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, p.employeeId, encFullName, p.role, p.registeredAt, p.updatedAt, p.syncStatus, p.syncError ?? null] as SQLiteBindValue[],
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

    if (fields.fullName !== undefined) { setClauses.push('full_name = ?'); values.push(await encryptString(fields.fullName)); }
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
        // Fetch the current record to build the full outbox payload.
        // PII fields in DB are encrypted; read the plaintext from the update fields
        // or fall back to decrypting the persisted row.
        const row = await db.getFirstAsync<Record<string, unknown>>(
          'SELECT * FROM personnel WHERE id = ?',
          [id],
        );
        if (row) {
          const p = await rowToPersonnel(row);
          await outbox.enqueue('personnel', id, {
            id,
            employeeId: fields.employeeId ?? p.employeeId,
            fullName: fields.fullName ?? p.fullName,
            role: fields.role ?? p.role,
            registeredAt: p.registeredAt,
            updatedAt,
          });
        }
      }
    });
  }

  async function deleteById(id: string): Promise<void> {
    // T077: if a sync is actively dispatching for this record (status='dispatched'),
    // tombstone it so the in-flight HTTP request completes without hitting a missing FK.
    // Pending (not yet dispatched) outbox entries are removed immediately with the row.
    const dispatching = await db.getFirstAsync<{ status: string }>(
      `SELECT status FROM sync_outbox WHERE record_type = 'personnel' AND record_id = ? AND status = 'dispatched'`,
      [id],
    );

    if (dispatching) {
      // Sync is actively in-flight — hide from UI but keep row for FK integrity
      await db.runAsync('UPDATE personnel SET tombstoned = 1 WHERE id = ?', [id]);
    } else {
      // No active dispatch — remove any pending outbox entries and hard-delete
      await db.runAsync(
        `DELETE FROM sync_outbox WHERE record_type = 'personnel' AND record_id = ? AND status = 'pending'`,
        [id],
      );
      await db.runAsync('DELETE FROM personnel WHERE id = ?', [id]);
    }
  }

  async function findAll(): Promise<Personnel[]> {
    const rows = await db.getAllAsync<Record<string, unknown>>(
      'SELECT * FROM personnel WHERE tombstoned IS NULL OR tombstoned = 0 ORDER BY registered_at DESC',
    );
    return Promise.all(rows.map(rowToPersonnel));
  }

  async function findById(id: string): Promise<Personnel | null> {
    const row = await db.getFirstAsync<Record<string, unknown>>(
      'SELECT * FROM personnel WHERE id = ?',
      [id],
    );
    return row ? rowToPersonnel(row) : null;
  }

  return { create, update, delete: deleteById, findAll, findById };
}
