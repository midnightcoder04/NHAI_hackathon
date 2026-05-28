import { useSQLiteContext } from 'expo-sqlite';
import type { SQLiteBindValue } from 'expo-sqlite';
import type { FaceImage } from '../../models/FaceImage';

function embeddingToBlob(embedding: Float32Array | null): Uint8Array | null {
  if (!embedding) return null;
  return new Uint8Array(embedding.buffer);
}

function blobToEmbedding(blob: unknown): Float32Array | null {
  if (!blob) return null;
  if (blob instanceof Uint8Array) return new Float32Array(blob.buffer);
  if (blob instanceof ArrayBuffer) return new Float32Array(blob);
  return null;
}

function rowToFaceImage(row: Record<string, unknown>): FaceImage {
  return {
    id: row.id as string,
    personnelId: row.personnel_id as string,
    imagePath: row.image_path as string,
    embedding: blobToEmbedding(row.embedding),
    s3Key: (row.s3_key as string | null) ?? undefined,
    createdAt: row.created_at as string,
    syncStatus: row.sync_status as FaceImage['syncStatus'],
  };
}

export function useFaceImageRepository() {
  const db = useSQLiteContext();

  async function create(fi: Omit<FaceImage, 'id'>): Promise<FaceImage> {
    const { generateUUID } = await import('../../utils/uuid');
    const id = generateUUID();
    const embeddingBlob = embeddingToBlob(fi.embedding);
    await db.runAsync(
      `INSERT INTO face_image (id, personnel_id, image_path, embedding, s3_key, created_at, sync_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, fi.personnelId, fi.imagePath, embeddingBlob, fi.s3Key ?? null, fi.createdAt, fi.syncStatus] as SQLiteBindValue[],
    );
    return { ...fi, id };
  }

  async function findByPersonnelId(personnelId: string): Promise<FaceImage[]> {
    const rows = await db.getAllAsync<Record<string, unknown>>(
      'SELECT * FROM face_image WHERE personnel_id = ? ORDER BY created_at DESC',
      [personnelId],
    );
    return rows.map(rowToFaceImage);
  }

  async function update(
    id: string,
    fields: Partial<Pick<FaceImage, 's3Key' | 'syncStatus'>>,
  ): Promise<void> {
    const setClauses: string[] = [];
    const values: SQLiteBindValue[] = [];

    if (fields.s3Key !== undefined) { setClauses.push('s3_key = ?'); values.push(fields.s3Key); }
    if (fields.syncStatus !== undefined) { setClauses.push('sync_status = ?'); values.push(fields.syncStatus); }

    if (setClauses.length === 0) return;
    values.push(id);
    await db.runAsync(`UPDATE face_image SET ${setClauses.join(', ')} WHERE id = ?`, values);
  }

  async function deleteByPersonnelId(personnelId: string): Promise<void> {
    await db.runAsync('DELETE FROM face_image WHERE personnel_id = ?', [personnelId]);
  }

  return { create, findByPersonnelId, update, deleteByPersonnelId };
}
