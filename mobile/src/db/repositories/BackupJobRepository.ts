import { useSQLiteContext } from 'expo-sqlite';
import type { SQLiteBindValue } from 'expo-sqlite';
import type { BackupJob } from '../../models/BackupJob';
import { generateUUID } from '../../utils/uuid';

function rowToBackupJob(row: Record<string, unknown>): BackupJob {
  return {
    id: row.id as string,
    startedAt: row.started_at as string,
    completedAt: (row.completed_at as string | null) ?? undefined,
    status: row.status as BackupJob['status'],
    recordsPersonnel: row.records_personnel as number,
    recordsVerification: row.records_verification as number,
    recordsImages: row.records_images as number,
    bytesTransferred: row.bytes_transferred as number,
    errorMessage: (row.error_message as string | null) ?? undefined,
  };
}

/** Plain-DB versions used by SyncService (no React hooks). */
export const BackupJobRepository = {
  async create(
    db: Pick<ReturnType<typeof useSQLiteContext>, 'runAsync' | 'getFirstAsync'>,
    job: Omit<BackupJob, 'id'>,
  ): Promise<BackupJob> {
    const id = generateUUID();
    await db.runAsync(
      `INSERT INTO backup_job
         (id, started_at, completed_at, status,
          records_personnel, records_verification, records_images,
          bytes_transferred, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        job.startedAt,
        job.completedAt ?? null,
        job.status,
        job.recordsPersonnel,
        job.recordsVerification,
        job.recordsImages,
        job.bytesTransferred,
        job.errorMessage ?? null,
      ] as SQLiteBindValue[],
    );
    return { ...job, id };
  },

  async updateStatus(
    db: Pick<ReturnType<typeof useSQLiteContext>, 'runAsync'>,
    id: string,
    fields: Partial<BackupJob>,
  ): Promise<void> {
    const setClauses: string[] = [];
    const values: SQLiteBindValue[] = [];

    if (fields.status !== undefined) { setClauses.push('status = ?'); values.push(fields.status); }
    if (fields.completedAt !== undefined) { setClauses.push('completed_at = ?'); values.push(fields.completedAt); }
    if (fields.errorMessage !== undefined) { setClauses.push('error_message = ?'); values.push(fields.errorMessage); }
    if (fields.recordsPersonnel !== undefined) { setClauses.push('records_personnel = ?'); values.push(fields.recordsPersonnel); }
    if (fields.recordsVerification !== undefined) { setClauses.push('records_verification = ?'); values.push(fields.recordsVerification); }
    if (fields.recordsImages !== undefined) { setClauses.push('records_images = ?'); values.push(fields.recordsImages); }
    if (fields.bytesTransferred !== undefined) { setClauses.push('bytes_transferred = ?'); values.push(fields.bytesTransferred); }

    if (setClauses.length === 0) return;

    values.push(id);
    await db.runAsync(
      `UPDATE backup_job SET ${setClauses.join(', ')} WHERE id = ?`,
      values,
    );
  },

  async findLatest(
    db: Pick<ReturnType<typeof useSQLiteContext>, 'getFirstAsync'>,
  ): Promise<BackupJob | null> {
    const row = await db.getFirstAsync<Record<string, unknown>>(
      'SELECT * FROM backup_job ORDER BY started_at DESC LIMIT 1',
    );
    return row ? rowToBackupJob(row) : null;
  },

  async findAll(
    db: Pick<ReturnType<typeof useSQLiteContext>, 'getAllAsync'>,
    limit: number,
  ): Promise<BackupJob[]> {
    const rows = await db.getAllAsync<Record<string, unknown>>(
      'SELECT * FROM backup_job ORDER BY started_at DESC LIMIT ?',
      [limit],
    );
    return rows.map(rowToBackupJob);
  },
};

/** Hook-based version for use in React components. */
export function useBackupJobRepository() {
  const db = useSQLiteContext();

  return {
    create: (job: Omit<BackupJob, 'id'>) => BackupJobRepository.create(db, job),
    updateStatus: (id: string, fields: Partial<BackupJob>) =>
      BackupJobRepository.updateStatus(db, id, fields),
    findLatest: () => BackupJobRepository.findLatest(db),
    findAll: (limit: number) => BackupJobRepository.findAll(db, limit),
  };
}
