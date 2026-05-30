import type { PoolClient } from 'pg';

export interface PersonnelRecord {
  id: string;
  employeeId: string;
  fullName: string;
  role: string;
  registeredAt: string;
  updatedAt: string;
  idempotencyKey: string;
}

/**
 * Upsert personnel records with newest-wins semantics.
 * ON CONFLICT (employee_id) DO UPDATE only when the incoming updated_at is newer.
 * Returns the number of rows actually written (inserted or updated).
 */
export async function processPersonnel(
  records: PersonnelRecord[],
  client: PoolClient,
  deviceId: string,
): Promise<number> {
  if (records.length === 0) return 0;

  let upserted = 0;

  for (const r of records) {
    const result = await client.query(
      `INSERT INTO personnel (id, employee_id, full_name, role, registered_at, updated_at, device_id, synced_at)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7, NOW())
       ON CONFLICT (employee_id)
         DO UPDATE SET
           full_name     = EXCLUDED.full_name,
           role          = EXCLUDED.role,
           updated_at    = EXCLUDED.updated_at,
           device_id     = EXCLUDED.device_id,
           synced_at     = NOW()
         WHERE EXCLUDED.updated_at > personnel.updated_at
       RETURNING id`,
      [r.id, r.employeeId, r.fullName, r.role, r.registeredAt, r.updatedAt, deviceId],
    );
    if (result.rowCount && result.rowCount > 0) {
      upserted++;
    }
  }

  return upserted;
}
