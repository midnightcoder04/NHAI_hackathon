export type SyncOutboxRecordType = 'personnel' | 'face_image' | 'verification_record';
export type SyncOutboxStatus = 'pending' | 'dispatched' | 'acknowledged' | 'failed';

export interface SyncOutboxEntry {
  id: string;
  recordType: SyncOutboxRecordType;
  recordId: string;
  idempotencyKey: string;
  payloadJson: string;
  enqueuedAt: string;
  dispatchedAt?: string;
  status: SyncOutboxStatus;
  retryCount: number;
  errorMessage?: string;
}
