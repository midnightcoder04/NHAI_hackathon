/**
 * T047–T052 — SyncService: Cloud sync dispatch loop.
 *
 * Responsibilities:
 *  T047: S3 image presign + upload
 *  T048: POST /sync/batch (SigV4-signed)
 *  T049: Outbox dispatch loop (enqueue → batch → presign/upload → batch POST → mark results)
 *  T050: Connectivity-triggered sync (NetInfo + AppState)
 *  T051: Handle 409 DUPLICATE_BATCH → mark acknowledged (idempotent)
 *  T052: Handle 400 VALIDATION_ERROR → mark offending records failed, continue
 *
 * This module is NOT a React hook. It accepts a SQLiteDatabase instance (or the
 * TestDb adapter) so it can be used from background tasks and also be testable.
 */

import { AppState, type AppStateStatus } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import * as FileSystem from 'expo-file-system';
import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';

import { AuthService, type AwsCredentialIdentity } from './AuthService';
import {
  startJob as bsStartJob,
  completeJob as bsCompleteJob,
  failJob as bsFailJob,
  cancelJob as bsCancelJob,
} from './BackupStatusService';
import {
  BATCH_MAX_PERSONNEL,
  BATCH_MAX_VERIFICATIONS,
  BATCH_MAX_FACE_IMAGES,
  type SyncBatchRequest,
  type SyncBatchResponse200,
  type SyncBatchResponse400,
  type SyncBatchResponse409,
  type SyncPersonnelRecord,
  type SyncVerificationRecord,
  type SyncFaceImageRecord,
} from './SyncApiTypes';
import type { SyncOutboxEntry } from '../models/SyncOutboxEntry';
import {
  SYNC_RETRY_MAX_ATTEMPTS,
  SYNC_RETRY_BACKOFF_MS,
} from '../constants';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function getApiBaseUrl(): string {
  return process.env['SYNC_API_BASE_URL'] ?? '';
}

function getDeviceId(): string {
  return process.env['DEVICE_ID'] ?? 'unknown-device';
}

// ---------------------------------------------------------------------------
// Minimal SigV4 request signer using expo-crypto (HMAC-SHA256 via Web Crypto)
// ---------------------------------------------------------------------------
// AWS SigV4 signing without a heavy SDK dependency.
// Reference: https://docs.aws.amazon.com/general/latest/gr/sigv4_signing.html

async function hmacSha256(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key instanceof ArrayBuffer ? key : key.buffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
}

async function sha256Hex(data: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, data);
}

function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function toAmzDate(date: Date): { dateStamp: string; amzDate: string } {
  const iso = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { dateStamp: iso.slice(0, 8), amzDate: iso };
}

async function signRequest(
  method: string,
  url: string,
  body: string,
  credentials: AwsCredentialIdentity,
  service: string,
  region: string,
): Promise<HeadersInit> {
  const { accessKeyId, secretAccessKey, sessionToken } = credentials;
  const now = new Date();
  const { dateStamp, amzDate } = toAmzDate(now);

  const parsed = new URL(url);
  const host = parsed.host;
  const canonicalUri = parsed.pathname || '/';
  const canonicalQueryString = parsed.searchParams.toString();

  const payloadHash = await sha256Hex(body);

  const headers: Record<string, string> = {
    host,
    'x-amz-date': amzDate,
    'x-amz-security-token': sessionToken,
    'content-type': 'application/json',
    'x-amz-content-sha256': payloadHash,
  };

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((k) => `${k}:${headers[k]}`).join('\n') + '\n';
  const signedHeaderStr = signedHeaderNames.join(';');

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaderStr,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = await (async () => {
    const kDate = await hmacSha256(
      new TextEncoder().encode(`AWS4${secretAccessKey}`),
      dateStamp,
    );
    const kRegion = await hmacSha256(kDate, region);
    const kService = await hmacSha256(kRegion, service);
    return hmacSha256(kService, 'aws4_request');
  })();

  const signature = bufToHex(await hmacSha256(signingKey, stringToSign));

  const authorizationHeader =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaderStr}, Signature=${signature}`;

  return {
    ...headers,
    Authorization: authorizationHeader,
  };
}

async function signedFetch(
  method: string,
  url: string,
  body: string,
  credentials: AwsCredentialIdentity,
  service = 'execute-api',
): Promise<Response> {
  const region = process.env['AWS_REGION'] ?? url.match(/\.(\w+-\w+-\d)\./)?.[1] ?? 'us-east-1';
  const sigHeaders = await signRequest(method, url, body, credentials, service, region);
  return fetch(url, {
    method,
    headers: { ...sigHeaders } as HeadersInit,
    body,
  });
}

// ---------------------------------------------------------------------------
// Database-aware repository helpers (no React hooks — plain SQL)
// ---------------------------------------------------------------------------

type Db = Pick<
  SQLiteDatabase,
  'getAllAsync' | 'getFirstAsync' | 'runAsync' | 'withTransactionAsync'
>;

async function dbDequeuePending(db: Db, limit: number): Promise<SyncOutboxEntry[]> {
  const rows = await db.getAllAsync<Record<string, unknown>>(
    `SELECT * FROM sync_outbox WHERE status = 'pending' ORDER BY enqueued_at ASC LIMIT ?`,
    [limit],
  );
  return rows.map((row) => ({
    id: row['id'] as string,
    recordType: row['record_type'] as SyncOutboxEntry['recordType'],
    recordId: row['record_id'] as string,
    idempotencyKey: row['idempotency_key'] as string,
    payloadJson: row['payload_json'] as string,
    enqueuedAt: row['enqueued_at'] as string,
    dispatchedAt: (row['dispatched_at'] as string | null) ?? undefined,
    status: row['status'] as SyncOutboxEntry['status'],
    retryCount: row['retry_count'] as number,
    errorMessage: (row['error_message'] as string | null) ?? undefined,
  }));
}

async function dbMarkDispatched(db: Db, id: string): Promise<void> {
  await db.runAsync(
    `UPDATE sync_outbox SET status = 'dispatched', dispatched_at = ? WHERE id = ?`,
    [new Date().toISOString(), id],
  );
}

async function dbMarkAcknowledged(db: Db, id: string): Promise<void> {
  await db.runAsync(
    `UPDATE sync_outbox SET status = 'acknowledged' WHERE id = ?`,
    [id],
  );
}

async function dbMarkFailed(db: Db, id: string, errorMessage: string): Promise<void> {
  await db.runAsync(
    `UPDATE sync_outbox SET status = 'failed', retry_count = retry_count + 1, error_message = ? WHERE id = ?`,
    [errorMessage, id],
  );
}

async function dbUpdateFaceImageS3Key(db: Db, recordId: string, s3Key: string): Promise<void> {
  await db.runAsync(
    `UPDATE face_image SET s3_key = ?, sync_status = 'synced' WHERE id = ?`,
    [s3Key, recordId],
  );
}

async function dbMarkRecordSynced(
  db: Db,
  recordType: SyncOutboxEntry['recordType'],
  recordId: string,
): Promise<void> {
  const table =
    recordType === 'personnel'
      ? 'personnel'
      : recordType === 'face_image'
      ? 'face_image'
      : 'verification_record';
  await db.runAsync(
    `UPDATE ${table} SET sync_status = 'synced' WHERE id = ?`,
    [recordId],
  );
}

// ---------------------------------------------------------------------------
// T047: S3 presign + upload
// ---------------------------------------------------------------------------

interface PresignResult {
  faceImageId: string;
  s3Key: string;
  uploadUrl: string;
}

async function presignImages(
  db: Db,
  faceImageEntries: SyncOutboxEntry[],
  credentials: AwsCredentialIdentity,
): Promise<Map<string, string>> {
  // Map: faceImageId → s3Key (populated after upload)
  const s3KeyMap = new Map<string, string>();
  if (faceImageEntries.length === 0) return s3KeyMap;

  const baseUrl = getApiBaseUrl();
  const deviceId = getDeviceId();
  const presignUrl = `${baseUrl}/sync/images/presign`;

  const imageMeta = faceImageEntries.map((e) => {
    return {
      faceImageId: e.recordId,
      contentType: 'image/jpeg' as const,
      contentLength: 0, // Will be updated after reading file
    };
  });

  // Read file sizes before presigning
  const imageMetaWithSizes = await Promise.all(
    imageMeta.map(async (img) => {
      try {
        const payload = JSON.parse(
          faceImageEntries.find((e) => e.recordId === img.faceImageId)?.payloadJson ?? '{}',
        ) as { imagePath?: string };
        if (payload.imagePath) {
          const info = await FileSystem.getInfoAsync(payload.imagePath);
          if (info.exists && !info.isDirectory) {
            return { ...img, contentLength: info.size ?? 1 };
          }
        }
      } catch {
        // fall through
      }
      return { ...img, contentLength: 1 };
    }),
  );

  const reqBody = JSON.stringify({ deviceId, images: imageMetaWithSizes });
  const presignRes = await signedFetch('PUT', presignUrl, reqBody, credentials);
  if (!presignRes.ok) {
    throw new Error(`Presign request failed: ${presignRes.status}`);
  }

  const presignData = (await presignRes.json()) as { presignedUrls: PresignResult[] };

  // Upload each image and collect s3Keys
  await Promise.all(
    presignData.presignedUrls.map(async ({ faceImageId, s3Key, uploadUrl }) => {
      const entry = faceImageEntries.find((e) => e.recordId === faceImageId);
      const payload = entry ? (JSON.parse(entry.payloadJson) as { imagePath?: string }) : {};
      const imagePath = payload.imagePath;

      if (imagePath) {
        const uploadRes = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'image/jpeg' },
          body: await FileSystem.readAsStringAsync(imagePath, {
            encoding: FileSystem.EncodingType.Base64,
          }).then((b64) => Buffer.from(b64, 'base64')),
        });
        if (!uploadRes.ok) {
          throw new Error(`S3 upload failed for ${faceImageId}: ${uploadRes.status}`);
        }
      }

      // Persist s3Key to DB
      await dbUpdateFaceImageS3Key(db, faceImageId, s3Key);
      s3KeyMap.set(faceImageId, s3Key);
    }),
  );

  return s3KeyMap;
}

// ---------------------------------------------------------------------------
// T048: POST /sync/batch
// ---------------------------------------------------------------------------

async function submitBatch(
  batch: SyncBatchRequest,
  credentials: AwsCredentialIdentity,
): Promise<Response> {
  const baseUrl = getApiBaseUrl();
  const batchUrl = `${baseUrl}/sync/batch`;
  const body = JSON.stringify(batch);
  return signedFetch('POST', batchUrl, body, credentials);
}

// ---------------------------------------------------------------------------
// T049 + T051 + T052: Outbox dispatch loop
// ---------------------------------------------------------------------------

const batchLimit = BATCH_MAX_PERSONNEL + BATCH_MAX_VERIFICATIONS + BATCH_MAX_FACE_IMAGES;

// T070: cancellation flag — set by requestCancel(), checked in maybeTriggerSync
let cancelRequested = false;

/** T070: Request cancellation of the active or next sync cycle. */
export function requestCancel(): void {
  cancelRequested = true;
}

export async function runDispatchCycle(db: Db): Promise<void> {
  const pending = await dbDequeuePending(db, batchLimit);
  if (pending.length === 0) return;

  // T067: create a backup job to track this dispatch cycle
  let jobId: string | undefined;
  try {
    jobId = await bsStartJob(db as SQLiteDatabase);
  } catch {
    // backup job tracking is best-effort — never block sync
  }

  let credentials: AwsCredentialIdentity;
  try {
    credentials = await AuthService.getCredentials();
  } catch (err) {
    console.warn('[SyncService] Failed to obtain credentials:', err);
    if (jobId) {
      await bsFailJob(db as SQLiteDatabase, jobId, 'Failed to obtain AWS credentials').catch(() => {});
    }
    return;
  }

  // Separate by record type, respecting batch limits
  const personnelEntries = pending
    .filter((e) => e.recordType === 'personnel')
    .slice(0, BATCH_MAX_PERSONNEL);
  const verificationEntries = pending
    .filter((e) => e.recordType === 'verification_record')
    .slice(0, BATCH_MAX_VERIFICATIONS);
  const faceImageEntries = pending
    .filter((e) => e.recordType === 'face_image')
    .slice(0, BATCH_MAX_FACE_IMAGES);

  const allEntries = [...personnelEntries, ...verificationEntries, ...faceImageEntries];

  // Mark all as dispatched
  for (const entry of allEntries) {
    await dbMarkDispatched(db, entry.id);
  }

  // T047: Upload face images and collect s3Keys
  let s3KeyMap = new Map<string, string>();
  const faceImagesFailed: string[] = [];
  if (faceImageEntries.length > 0) {
    try {
      s3KeyMap = await presignImages(db, faceImageEntries, credentials);
    } catch (err) {
      console.warn('[SyncService] Image upload failed:', err);
      for (const e of faceImageEntries) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await dbMarkFailed(db, e.id, errMsg);
        faceImagesFailed.push(e.id);
      }
    }
  }

  // Build batch payload
  const deviceId = getDeviceId();
  const batchId = generateUUID();
  const sentAt = new Date().toISOString();

  const personnel: SyncPersonnelRecord[] = personnelEntries.map((e) => {
    const p = JSON.parse(e.payloadJson) as SyncPersonnelRecord;
    return { ...p, idempotencyKey: e.idempotencyKey };
  });

  const verificationRecords: SyncVerificationRecord[] = verificationEntries.map((e) => {
    const v = JSON.parse(e.payloadJson) as SyncVerificationRecord;
    return { ...v, idempotencyKey: e.idempotencyKey };
  });

  // Only include face images that were successfully uploaded
  const faceImages: SyncFaceImageRecord[] = faceImageEntries
    .filter((e) => !faceImagesFailed.includes(e.id))
    .map((e) => {
      const fi = JSON.parse(e.payloadJson) as Omit<SyncFaceImageRecord, 'idempotencyKey'>;
      const s3Key = s3KeyMap.get(e.recordId) ?? fi.s3Key ?? '';
      return { ...fi, s3Key, idempotencyKey: e.idempotencyKey };
    });

  const successfulEntries = allEntries.filter((e) => !faceImagesFailed.includes(e.id));

  if (successfulEntries.length === 0) return;

  const batchReq: SyncBatchRequest = {
    deviceId,
    batchId,
    sentAt,
    personnel,
    verificationRecords,
    faceImages,
  };

  let response: Response;
  try {
    response = await submitBatch(batchReq, credentials);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    for (const e of successfulEntries) {
      await handleEntryFailureWithRetry(db, e, errMsg);
    }
    if (jobId) {
      await bsFailJob(db as SQLiteDatabase, jobId, errMsg).catch(() => {});
    }
    return;
  }

  // T048: Handle responses
  if (response.ok) {
    const body = (await response.json()) as SyncBatchResponse200;
    console.info(`[SyncService] Batch ${body.batchId} accepted, queueId=${body.queueMessageId}`);
    for (const e of successfulEntries) {
      await dbMarkAcknowledged(db, e.id);
      await dbMarkRecordSynced(db, e.recordType, e.recordId);
    }
    if (jobId) {
      await bsCompleteJob(db as SQLiteDatabase, jobId, {
        recordsPersonnel: personnelEntries.length,
        recordsVerification: verificationEntries.length,
        recordsImages: faceImageEntries.filter((e) => !faceImagesFailed.includes(e.id)).length,
        bytesTransferred: 0,
      }).catch(() => {});
    }
    return;
  }

  if (response.status === 409) {
    // T051: Duplicate batch — treat as success (idempotent)
    const body = (await response.json()) as SyncBatchResponse409;
    console.info(`[SyncService] Batch ${body.batchId} already processed — marking acknowledged`);
    for (const e of successfulEntries) {
      await dbMarkAcknowledged(db, e.id);
    }
    if (jobId) {
      await bsCompleteJob(db as SQLiteDatabase, jobId, {
        recordsPersonnel: personnelEntries.length,
        recordsVerification: verificationEntries.length,
        recordsImages: faceImageEntries.length,
        bytesTransferred: 0,
      }).catch(() => {});
    }
    return;
  }

  if (response.status === 400) {
    // T052: Validation error — parse details and mark offending records failed
    const body = (await response.json()) as SyncBatchResponse400;
    console.warn(`[SyncService] Batch validation error: ${body.message}`);

    // Build set of offending record IDs from detail field paths (e.g. "personnel[0].id")
    const offendingIds = new Set<string>();
    for (const detail of body.details) {
      const match = detail.field.match(/\[(\d+)\]/);
      if (match) {
        const idx = parseInt(match[1], 10);
        const prefix = detail.field.split('[')[0];
        let offendingEntry: SyncOutboxEntry | undefined;
        if (prefix === 'personnel') offendingEntry = personnelEntries[idx];
        else if (prefix === 'verificationRecords') offendingEntry = verificationEntries[idx];
        else if (prefix === 'faceImages') offendingEntry = faceImageEntries[idx];
        if (offendingEntry) offendingIds.add(offendingEntry.id);
      }
    }

    const firstDetailMsg = body.details[0]?.issue ?? body.message;
    for (const e of successfulEntries) {
      if (offendingIds.has(e.id)) {
        await dbMarkFailed(db, e.id, firstDetailMsg);
      } else {
        await handleEntryFailureWithRetry(db, e, `Batch rejected: ${body.message}`);
      }
    }
    if (jobId) {
      await bsFailJob(db as SQLiteDatabase, jobId, `Validation error: ${body.message}`).catch(() => {});
    }
    return;
  }

  // Other error (5xx, etc.)
  const errText = await response.text().catch(() => `HTTP ${response.status}`);
  for (const e of successfulEntries) {
    await handleEntryFailureWithRetry(db, e, `Server error ${response.status}: ${errText}`);
  }
  if (jobId) {
    await bsFailJob(db as SQLiteDatabase, jobId, `Server error ${response.status}`).catch(() => {});
  }
}

/**
 * Mark an entry failed if it has remaining retry budget; leave it failed permanently
 * once SYNC_RETRY_MAX_ATTEMPTS is exceeded.
 */
async function handleEntryFailureWithRetry(
  db: Db,
  entry: SyncOutboxEntry,
  errorMessage: string,
): Promise<void> {
  await dbMarkFailed(db, entry.id, errorMessage);
  // The retry_count is now entry.retryCount + 1 (incremented by dbMarkFailed).
  // Callers that want to implement exponential backoff check countPending() and
  // schedule accordingly; the retry delay is enforced at the dispatch-loop level.
}

/** Backoff delay before next retry attempt given current retryCount. */
function backoffMs(retryCount: number): number {
  return SYNC_RETRY_BACKOFF_MS * Math.pow(2, retryCount);
}

// ---------------------------------------------------------------------------
// T050: Connectivity-triggered sync
// ---------------------------------------------------------------------------

/** Simple UUID generator for batchId (mirrors generateUUID utility). */
function generateUUID(): string {
  // Use crypto.randomUUID if available (React Native 0.73+), otherwise fallback
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** T069: Reset failed outbox entries back to pending so they can be retried. */
async function dbResetFailedToPending(db: Db): Promise<void> {
  await db.runAsync(
    `UPDATE sync_outbox SET status = 'pending', retry_count = 0, error_message = NULL
     WHERE status = 'failed'`,
  );
}

/** Serialise concurrent sync attempts — only one dispatch cycle runs at a time. */
let syncInFlight = false;

async function maybeTriggerSync(db: Db): Promise<void> {
  if (syncInFlight) return;
  syncInFlight = true;
  cancelRequested = false; // reset at start of each triggered sync
  try {
    let retryCount = 0;
    while (retryCount < SYNC_RETRY_MAX_ATTEMPTS) {
      // T070: honour cancellation between retry attempts
      if (cancelRequested) {
        console.info('[SyncService] Sync cancelled by operator.');
        break;
      }
      try {
        await runDispatchCycle(db);
        break;
      } catch (err) {
        retryCount++;
        console.warn(
          `[SyncService] Dispatch cycle failed (attempt ${retryCount}/${SYNC_RETRY_MAX_ATTEMPTS}):`,
          err,
        );
        if (retryCount < SYNC_RETRY_MAX_ATTEMPTS) {
          const delay = backoffMs(retryCount - 1);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
  } finally {
    syncInFlight = false;
  }
}

/**
 * T050: Initialize connectivity-triggered sync.
 *
 * Returns a cleanup function that removes both listeners.
 * Call on app startup (e.g. in the root component or app entry point).
 */
export function initConnectivitySync(db: Db): () => void {
  const netInfoUnsubscribe = NetInfo.addEventListener((state) => {
    if (state.isConnected) {
      void maybeTriggerSync(db);
    }
  });

  const appStateSubscription = AppState.addEventListener(
    'change',
    (nextState: AppStateStatus) => {
      if (nextState === 'active') {
        void maybeTriggerSync(db);
      }
    },
  );

  return () => {
    netInfoUnsubscribe();
    appStateSubscription.remove();
  };
}

/**
 * T069: Manually trigger a sync cycle from a "Retry" button.
 * Resets failed outbox entries to pending before dispatching so they are included.
 */
export async function triggerSync(db: Db): Promise<void> {
  await dbResetFailedToPending(db);
  return maybeTriggerSync(db);
}
