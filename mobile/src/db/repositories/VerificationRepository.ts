import { useSQLiteContext } from 'expo-sqlite';
import type { SQLiteBindValue } from 'expo-sqlite';
import type { VerificationRecord } from '../../models/VerificationRecord';
import { generateUUID } from '../../utils/uuid';
import { useSyncOutboxRepository } from './SyncOutboxRepository';

function rowToVerificationRecord(row: Record<string, unknown>): VerificationRecord {
  return {
    id: row.id as string,
    personnelIdMatched: (row.personnel_id_matched as string | null) ?? undefined,
    initiatedAt: row.initiated_at as string,
    completedAt: row.completed_at as string,
    outcome: row.outcome as VerificationRecord['outcome'],
    confidenceScore: (row.confidence_score as number | null) ?? undefined,
    operatorContext: (row.operator_context as string | null) ?? undefined,
    deviceId: row.device_id as string,
    syncStatus: row.sync_status as VerificationRecord['syncStatus'],
  };
}

export function useVerificationRepository() {
  const db = useSQLiteContext();
  const outbox = useSyncOutboxRepository();

  async function create(vr: Omit<VerificationRecord, 'id'>): Promise<VerificationRecord> {
    const id = generateUUID();
    const record: VerificationRecord = { ...vr, id };

    await db.withTransactionAsync(async () => {
      await db.runAsync(
        `INSERT INTO verification_record
           (id, personnel_id_matched, initiated_at, completed_at, outcome, confidence_score, operator_context, device_id, sync_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          vr.personnelIdMatched ?? null,
          vr.initiatedAt,
          vr.completedAt,
          vr.outcome,
          vr.confidenceScore ?? null,
          vr.operatorContext ?? null,
          vr.deviceId,
          vr.syncStatus,
        ] as SQLiteBindValue[],
      );
      await outbox.enqueue('verification_record', id, {
        id,
        personnelIdMatched: vr.personnelIdMatched ?? null,
        initiatedAt: vr.initiatedAt,
        completedAt: vr.completedAt,
        outcome: vr.outcome,
        confidenceScore: vr.confidenceScore ?? null,
        operatorContext: vr.operatorContext ?? null,
        deviceId: vr.deviceId,
      });
    });

    return record;
  }

  async function findAll(): Promise<VerificationRecord[]> {
    const rows = await db.getAllAsync<Record<string, unknown>>(
      'SELECT * FROM verification_record ORDER BY initiated_at DESC',
    );
    return rows.map(rowToVerificationRecord);
  }

  async function findByPersonnelId(personnelId: string): Promise<VerificationRecord[]> {
    const rows = await db.getAllAsync<Record<string, unknown>>(
      'SELECT * FROM verification_record WHERE personnel_id_matched = ? ORDER BY initiated_at DESC',
      [personnelId],
    );
    return rows.map(rowToVerificationRecord);
  }

  return { create, findAll, findByPersonnelId };
}
