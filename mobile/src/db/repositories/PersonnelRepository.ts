import { useSQLiteContext } from 'expo-sqlite';
import type { SQLiteBindValue } from 'expo-sqlite';
import type { Personnel } from '../../models/Personnel';
import { generateUUID } from '../../utils/uuid';

function rowToPersonnel(row: Record<string, unknown>): Personnel {
  return {
    id: row.id as string,
    employeeId: row.employee_id as string,
    fullName: row.full_name as string,
    role: row.role as string,
    registeredAt: row.registered_at as string,
    updatedAt: row.updated_at as string,
    syncStatus: row.sync_status as Personnel['syncStatus'],
    syncError: (row.sync_error as string | null) ?? undefined,
  };
}

export function usePersonnelRepository() {
  const db = useSQLiteContext();

  async function create(p: Omit<Personnel, 'id'>): Promise<Personnel> {
    const id = generateUUID();
    await db.runAsync(
      `INSERT INTO personnel (id, employee_id, full_name, role, registered_at, updated_at, sync_status, sync_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, p.employeeId, p.fullName, p.role, p.registeredAt, p.updatedAt, p.syncStatus, p.syncError ?? null] as SQLiteBindValue[],
    );
    return { ...p, id };
  }

  async function update(
    id: string,
    fields: Partial<Pick<Personnel, 'fullName' | 'employeeId' | 'role' | 'syncStatus' | 'syncError'>>,
  ): Promise<void> {
    const updatedAt = new Date().toISOString();
    const setClauses: string[] = ['updated_at = ?'];
    const values: SQLiteBindValue[] = [updatedAt];

    if (fields.fullName !== undefined) { setClauses.push('full_name = ?'); values.push(fields.fullName); }
    if (fields.employeeId !== undefined) { setClauses.push('employee_id = ?'); values.push(fields.employeeId); }
    if (fields.role !== undefined) { setClauses.push('role = ?'); values.push(fields.role); }
    if (fields.syncStatus !== undefined) { setClauses.push('sync_status = ?'); values.push(fields.syncStatus); }
    if (fields.syncError !== undefined) { setClauses.push('sync_error = ?'); values.push(fields.syncError); }

    values.push(id);
    await db.runAsync(`UPDATE personnel SET ${setClauses.join(', ')} WHERE id = ?`, values);
  }

  async function deleteById(id: string): Promise<void> {
    await db.runAsync('DELETE FROM personnel WHERE id = ?', [id]);
  }

  async function findAll(): Promise<Personnel[]> {
    const rows = await db.getAllAsync<Record<string, unknown>>(
      'SELECT * FROM personnel ORDER BY registered_at DESC',
    );
    return rows.map(rowToPersonnel);
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
