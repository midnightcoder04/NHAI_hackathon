import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
import type { PoolClient } from 'pg';

export interface FaceImageRecord {
  id: string;
  personnelId: string;
  s3Key: string;
  createdAt: string;
  idempotencyKey: string;
}

const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'ap-south-1' });
const BUCKET = process.env.FACE_IMAGES_BUCKET ?? '';

/**
 * Optional S3 existence check. Returns true if the object exists or if the
 * check cannot be performed (bucket not configured). Failures are non-fatal.
 */
async function s3KeyExists(s3Key: string): Promise<boolean> {
  if (!BUCKET) return true; // skip check when bucket not configured
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: s3Key }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Idempotent insert of face image metadata records.
 * ON CONFLICT (id) DO NOTHING — safe to replay.
 * Optionally performs an S3 HEAD check; records whose key is missing are
 * skipped (logged) rather than failing the whole batch.
 * Returns the count of newly inserted rows.
 */
export async function processFaceImages(
  records: FaceImageRecord[],
  client: PoolClient,
  deviceId: string,
): Promise<number> {
  if (records.length === 0) return 0;

  let inserted = 0;

  for (const r of records) {
    // Optional S3 check — skip if key is not accessible
    const exists = await s3KeyExists(r.s3Key);
    if (!exists) {
      console.warn(`[FaceImageProcessor] s3Key not found, skipping: ${r.s3Key}`);
      continue;
    }

    const result = await client.query(
      `INSERT INTO face_image (id, personnel_id, s3_key, created_at, device_id, synced_at)
       VALUES ($1, $2, $3, $4::timestamptz, $5, NOW())
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [r.id, r.personnelId, r.s3Key, r.createdAt, deviceId],
    );
    if (result.rowCount && result.rowCount > 0) {
      inserted++;
    }
  }

  return inserted;
}
