import type { PoolClient } from 'pg';

export interface VerificationRecord {
  id: string;
  personnelIdMatched: string | null;
  initiatedAt: string;
  completedAt: string;
  outcome: 'authorized' | 'unauthorized' | 'liveness_failed' | 'quality_insufficient';
  confidenceScore: number | null;
  operatorContext: string | null;
  deviceId: string;
  idempotencyKey: string;
}

/**
 * Idempotent insert of verification records.
 * ON CONFLICT (id, device_id) DO NOTHING — safe to replay.
 * Returns the count of newly inserted rows.
 */
export async function processVerifications(
  records: VerificationRecord[],
  client: PoolClient,
): Promise<number> {
  if (records.length === 0) return 0;

  let inserted = 0;

  for (const r of records) {
    const result = await client.query(
      `INSERT INTO verification_record
         (id, personnel_id_matched, initiated_at, completed_at, outcome,
          confidence_score, operator_context, device_id, synced_at)
       VALUES
         ($1, $2, $3::timestamptz, $4::timestamptz, $5, $6, $7, $8, NOW())
       ON CONFLICT (id, device_id) DO NOTHING
       RETURNING id`,
      [
        r.id,
        r.personnelIdMatched ?? null,
        r.initiatedAt,
        r.completedAt,
        r.outcome,
        r.confidenceScore ?? null,
        r.operatorContext ?? null,
        r.deviceId,
      ],
    );
    if (result.rowCount && result.rowCount > 0) {
      inserted++;
    }
  }

  return inserted;
}
