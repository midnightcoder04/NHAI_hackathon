import { useSQLiteContext } from 'expo-sqlite';
import type { SQLiteBindValue } from 'expo-sqlite';
import type { FaceImage } from '../../models/FaceImage';
import { generateUUID } from '../../utils/uuid';
import { CryptoService } from '../../services/CryptoService';
import { useSyncOutboxRepository } from './SyncOutboxRepository';

// T073: the embedding is biometric PII — encrypt the BLOB at rest (AES-256-GCM).
async function embeddingToBlob(embedding: Float32Array | null): Promise<Uint8Array | null> {
  if (!embedding) return null;
  const bytes = new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  return CryptoService.encryptBytes(bytes);
}

async function blobToEmbedding(blob: unknown): Promise<Float32Array | null> {
  if (!blob) return null;
  const bytes = blob instanceof Uint8Array ? blob : blob instanceof ArrayBuffer ? new Uint8Array(blob) : null;
  if (!bytes) return null;
  let plain: Uint8Array;
  try {
    plain = await CryptoService.decryptBytes(bytes);
  } catch {
    plain = bytes; // tolerate a legacy (pre-encryption) plaintext embedding
  }
  return new Float32Array(plain.buffer, plain.byteOffset, Math.floor(plain.byteLength / 4));
}

async function rowToFaceImage(row: Record<string, unknown>): Promise<FaceImage> {
  return {
    id: row.id as string,
    personnelId: row.personnel_id as string,
    imagePath: row.image_path as string,
    embedding: await blobToEmbedding(row.embedding),
    s3Key: (row.s3_key as string | null) ?? undefined,
    createdAt: row.created_at as string,
    syncStatus: row.sync_status as FaceImage['syncStatus'],
  };
}

export function useFaceImageRepository() {
  const db = useSQLiteContext();
  const outbox = useSyncOutboxRepository();

  async function create(fi: Omit<FaceImage, 'id'>): Promise<FaceImage> {
    const id = generateUUID();
    const embeddingBlob = await embeddingToBlob(fi.embedding);
    const record: FaceImage = { ...fi, id };

    await db.withTransactionAsync(async () => {
      await db.runAsync(
        `INSERT INTO face_image (id, personnel_id, image_path, embedding, s3_key, created_at, sync_status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, fi.personnelId, fi.imagePath, embeddingBlob, fi.s3Key ?? null, fi.createdAt, fi.syncStatus] as SQLiteBindValue[],
      );
      await outbox.enqueue('face_image', id, {
        id,
        personnelId: fi.personnelId,
        imagePath: fi.imagePath,
        s3Key: fi.s3Key ?? null,
        createdAt: fi.createdAt,
      });
    });

    return record;
  }

  async function findByPersonnelId(personnelId: string): Promise<FaceImage[]> {
    const rows = await db.getAllAsync<Record<string, unknown>>(
      'SELECT * FROM face_image WHERE personnel_id = ? ORDER BY created_at DESC',
      [personnelId],
    );
    return Promise.all(rows.map(rowToFaceImage));
  }

  // Full enrolled gallery across all personnel — used by VerificationService to
  // build the candidate set for face matching.
  async function findAll(): Promise<FaceImage[]> {
    const rows = await db.getAllAsync<Record<string, unknown>>(
      'SELECT * FROM face_image ORDER BY created_at DESC',
    );
    return Promise.all(rows.map(rowToFaceImage));
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

  return { create, findByPersonnelId, findAll, update, deleteByPersonnelId };
}
