import type { SyncStatus } from './Personnel';

export interface FaceImage {
  id: string;
  personnelId: string;
  imagePath: string;
  embedding: Float32Array | null;
  s3Key?: string;
  createdAt: string;
  syncStatus: SyncStatus;
}
