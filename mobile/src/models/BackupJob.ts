export type BackupStatus = 'in_progress' | 'completed' | 'failed' | 'cancelled';

export interface BackupJob {
  id: string;
  startedAt: string;
  completedAt?: string;
  status: BackupStatus;
  recordsPersonnel: number;
  recordsVerification: number;
  recordsImages: number;
  bytesTransferred: number;
  errorMessage?: string;
}
