export type SyncStatus = 'pending' | 'synced' | 'failed';

export interface Personnel {
  id: string;
  employeeId: string;
  fullName: string;
  role: string;
  registeredAt: string;
  updatedAt: string;
  syncStatus: SyncStatus;
  syncError?: string;
}
