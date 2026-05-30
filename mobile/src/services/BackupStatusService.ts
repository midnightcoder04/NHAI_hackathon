/**
 * T066: BackupStatusService — tracks backup job lifecycle and exposes
 * status aggregation (pending count + latest job).
 *
 * Plain functions (startJob, completeJob, failJob, cancelJob, getStatus) accept
 * a db as first arg so SyncService (T067) can call them without React hooks.
 * useBackupStatusService() is the hook wrapper for UI components.
 *
 * T072: push notifications for completeJob / failJob are wired here.
 */

import { useSQLiteContext } from 'expo-sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';
import * as Notifications from 'expo-notifications';
import { BackupJobRepository } from '../db/repositories/BackupJobRepository';
import type { BackupJob } from '../models/BackupJob';

export interface SyncJobSummary {
  recordsPersonnel: number;
  recordsVerification: number;
  recordsImages: number;
  bytesTransferred: number;
}

export interface BackupStatus {
  lastSyncTime?: string;
  pendingCount: number;
  latestJob: BackupJob | null;
}

type Db = Pick<SQLiteDatabase, 'runAsync' | 'getFirstAsync' | 'getAllAsync'>;

// ---------------------------------------------------------------------------
// T072: Notification helpers
// ---------------------------------------------------------------------------

async function scheduleLocalNotification(title: string, body: string): Promise<void> {
  try {
    const { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') return;
    await Notifications.scheduleNotificationAsync({
      content: { title, body },
      trigger: null,
    });
  } catch {
    // Notifications are best-effort — never block the sync path
  }
}

export async function requestNotificationPermission(): Promise<void> {
  const { status } = await Notifications.getPermissionsAsync();
  if (status === 'undetermined') {
    await Notifications.requestPermissionsAsync();
  }
}

// ---------------------------------------------------------------------------
// Plain functions (T066 implementation, T067 consumed by SyncService)
// ---------------------------------------------------------------------------

export async function startJob(db: Db): Promise<string> {
  const job = await BackupJobRepository.create(db as SQLiteDatabase, {
    startedAt: new Date().toISOString(),
    status: 'in_progress',
    recordsPersonnel: 0,
    recordsVerification: 0,
    recordsImages: 0,
    bytesTransferred: 0,
  });
  return job.id;
}

export async function completeJob(
  db: Db,
  id: string,
  summary: SyncJobSummary,
): Promise<void> {
  await BackupJobRepository.updateStatus(db as SQLiteDatabase, id, {
    status: 'completed',
    completedAt: new Date().toISOString(),
    recordsPersonnel: summary.recordsPersonnel,
    recordsVerification: summary.recordsVerification,
    recordsImages: summary.recordsImages,
    bytesTransferred: summary.bytesTransferred,
  });

  const total =
    summary.recordsPersonnel + summary.recordsVerification + summary.recordsImages;
  await scheduleLocalNotification(
    'Sync complete',
    `${total} record${total !== 1 ? 's' : ''} uploaded successfully.`,
  );
}

export async function failJob(db: Db, id: string, errorMessage: string): Promise<void> {
  await BackupJobRepository.updateStatus(db as SQLiteDatabase, id, {
    status: 'failed',
    completedAt: new Date().toISOString(),
    errorMessage,
  });
  await scheduleLocalNotification('Sync failed', errorMessage);
}

export async function cancelJob(db: Db, id: string): Promise<void> {
  await BackupJobRepository.updateStatus(db as SQLiteDatabase, id, {
    status: 'cancelled',
    completedAt: new Date().toISOString(),
  });
}

export async function getStatus(db: Db): Promise<BackupStatus> {
  const [latestJob, pendingRow] = await Promise.all([
    BackupJobRepository.findLatest(db as SQLiteDatabase),
    (db as SQLiteDatabase).getFirstAsync<{ cnt: number }>(
      "SELECT COUNT(*) AS cnt FROM sync_outbox WHERE status = 'pending'",
    ),
  ]);

  const pendingCount = pendingRow?.cnt ?? 0;
  const lastSyncTime =
    latestJob?.status === 'completed' ? latestJob.completedAt : undefined;

  return { lastSyncTime, pendingCount, latestJob };
}

// ---------------------------------------------------------------------------
// Hook wrapper for UI components
// ---------------------------------------------------------------------------

export function useBackupStatusService() {
  const db = useSQLiteContext();

  return {
    startJob: () => startJob(db),
    completeJob: (id: string, summary: SyncJobSummary) => completeJob(db, id, summary),
    failJob: (id: string, errorMessage: string) => failJob(db, id, errorMessage),
    cancelJob: (id: string) => cancelJob(db, id),
    getStatus: () => getStatus(db),
    requestNotificationPermission,
  };
}
