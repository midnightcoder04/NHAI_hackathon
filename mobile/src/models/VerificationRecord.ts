import type { SyncStatus } from './Personnel';

export type VerificationOutcome =
  | 'authorized'
  | 'unauthorized'
  | 'liveness_failed'
  | 'low_confidence'
  | 'quality_insufficient';

export interface VerificationRecord {
  id: string;
  personnelIdMatched?: string;
  initiatedAt: string;
  completedAt: string;
  outcome: VerificationOutcome;
  confidenceScore?: number;
  operatorContext?: string;
  deviceId: string;
  syncStatus: SyncStatus;
}
