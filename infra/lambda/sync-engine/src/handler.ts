import {
  SQSClient,
  SendMessageCommand,
  SendMessageCommandOutput,
} from '@aws-sdk/client-sqs';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  SQSEvent,
  SQSBatchResponse,
} from 'aws-lambda';

import { getPool } from './db';
import { processPersonnel } from './processors/PersonnelProcessor';
import { processVerifications } from './processors/VerificationProcessor';
import { processFaceImages } from './processors/FaceImageProcessor';
import { notifyWebhook } from './processors/WebhookNotifier';

// ---------------------------------------------------------------------------
// AWS clients (lazy-initialised, re-used across warm invocations)
// ---------------------------------------------------------------------------
const sqs = new SQSClient({ region: process.env.AWS_REGION ?? 'ap-south-1' });
const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'ap-south-1' });

const QUEUE_URL = process.env.SQS_QUEUE_URL ?? '';
const BUCKET = process.env.FACE_IMAGES_BUCKET ?? '';
const PRESIGN_EXPIRY_SECONDS = 15 * 60; // 15 minutes

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ValidationError {
  field: string;
  issue: string;
}

interface SyncBatchBody {
  deviceId: string;
  batchId: string;
  sentAt: string;
  personnel?: unknown[];
  verificationRecords?: unknown[];
  faceImages?: unknown[];
}

function validateBatchBody(body: unknown): {
  valid: boolean;
  errors: ValidationError[];
  parsed?: SyncBatchBody;
} {
  const errors: ValidationError[] = [];

  if (!body || typeof body !== 'object') {
    return { valid: false, errors: [{ field: 'body', issue: 'must be a JSON object' }] };
  }

  const b = body as Record<string, unknown>;

  if (typeof b['deviceId'] !== 'string' || !UUID_RE.test(b['deviceId'] as string)) {
    errors.push({ field: 'deviceId', issue: 'must be a UUID' });
  }
  if (typeof b['batchId'] !== 'string' || !UUID_RE.test(b['batchId'] as string)) {
    errors.push({ field: 'batchId', issue: 'must be a UUID' });
  }
  if (typeof b['sentAt'] !== 'string' || isNaN(Date.parse(b['sentAt'] as string))) {
    errors.push({ field: 'sentAt', issue: 'must be an ISO-8601 date string' });
  }

  const personnel = Array.isArray(b['personnel']) ? b['personnel'] : [];
  const verificationRecords = Array.isArray(b['verificationRecords'])
    ? b['verificationRecords']
    : [];
  const faceImages = Array.isArray(b['faceImages']) ? b['faceImages'] : [];

  if (personnel.length > 100) {
    errors.push({ field: 'personnel', issue: 'max 100 records per batch' });
  }
  if (verificationRecords.length > 500) {
    errors.push({ field: 'verificationRecords', issue: 'max 500 records per batch' });
  }
  if (faceImages.length > 200) {
    errors.push({ field: 'faceImages', issue: 'max 200 records per batch' });
  }

  // All faceImages must have s3Key populated
  for (let i = 0; i < faceImages.length; i++) {
    const fi = faceImages[i] as Record<string, unknown>;
    if (!fi['s3Key'] || typeof fi['s3Key'] !== 'string' || fi['s3Key'] === '') {
      errors.push({
        field: `faceImages[${i}].s3Key`,
        issue: 'must be populated (upload image before submitting metadata)',
      });
    }
  }

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    errors: [],
    parsed: {
      deviceId: b['deviceId'] as string,
      batchId: b['batchId'] as string,
      sentAt: b['sentAt'] as string,
      personnel,
      verificationRecords,
      faceImages,
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP handler — POST /sync/batch
// ---------------------------------------------------------------------------

async function handleSyncBatch(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  let rawBody: unknown;
  try {
    rawBody = JSON.parse(event.body ?? '{}');
  } catch {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'VALIDATION_ERROR',
        message: 'Request body is not valid JSON',
        details: [],
      }),
    };
  }

  const { valid, errors, parsed } = validateBatchBody(rawBody);
  if (!valid || !parsed) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: errors,
      }),
    };
  }

  // Enqueue to SQS FIFO
  let sqsResult: SendMessageCommandOutput;
  try {
    sqsResult = await sqs.send(
      new SendMessageCommand({
        QueueUrl: QUEUE_URL,
        MessageBody: JSON.stringify(rawBody),
        MessageGroupId: parsed.deviceId,
        MessageDeduplicationId: parsed.batchId,
      }),
    );
  } catch (err: unknown) {
    const e = err as { name?: string };
    // FIFO deduplication: SQS rejects a duplicate MessageDeduplicationId within
    // the 5-minute deduplication window.
    if (e.name === 'MessageAlreadyInflight' || e.name === 'AWS.SimpleQueueService.NonExistentQueue') {
      return {
        statusCode: 409,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'DUPLICATE_BATCH',
          batchId: parsed.batchId,
          message: 'Batch already processed',
        }),
      };
    }
    console.error('[handler] SQS SendMessage error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'INTERNAL_ERROR', message: 'Failed to enqueue batch' }),
    };
  }

  const receivedAt = new Date().toISOString();
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      batchId: parsed.batchId,
      receivedAt,
      queueMessageId: sqsResult.MessageId ?? '',
      accepted: {
        personnel: (parsed.personnel ?? []).length,
        verificationRecords: (parsed.verificationRecords ?? []).length,
        faceImages: (parsed.faceImages ?? []).length,
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// HTTP handler — PUT /sync/images/presign
// ---------------------------------------------------------------------------

interface PresignRequestImage {
  faceImageId: string;
  contentType: string;
  contentLength: number;
}

interface PresignRequestBody {
  deviceId: string;
  images: PresignRequestImage[];
}

async function handlePresign(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  let body: PresignRequestBody;
  try {
    body = JSON.parse(event.body ?? '{}') as PresignRequestBody;
  } catch {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'VALIDATION_ERROR', message: 'Invalid JSON body' }),
    };
  }

  if (!body.deviceId || !Array.isArray(body.images)) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'VALIDATION_ERROR',
        message: 'deviceId and images[] are required',
      }),
    };
  }

  const expiresAt = new Date(Date.now() + PRESIGN_EXPIRY_SECONDS * 1000).toISOString();

  const presignedUrls = await Promise.all(
    body.images.map(async (img) => {
      const s3Key = `images/${body.deviceId}/${img.faceImageId}.jpg`;
      const uploadUrl = await getSignedUrl(
        s3 as any,
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: s3Key,
          ContentType: img.contentType ?? 'image/jpeg',
          ContentLength: img.contentLength,
        }),
        { expiresIn: PRESIGN_EXPIRY_SECONDS },
      );
      return { faceImageId: img.faceImageId, s3Key, uploadUrl, expiresAt };
    }),
  );

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ presignedUrls }),
  };
}

// ---------------------------------------------------------------------------
// SQS event handler — processes one message per invocation
// ---------------------------------------------------------------------------

async function handleSQSEvent(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];

  for (const record of event.Records) {
    let body: SyncBatchBody;
    try {
      body = JSON.parse(record.body) as SyncBatchBody;
    } catch (err) {
      console.error('[handler] Failed to parse SQS message body:', err);
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }

    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const personnelCount = await processPersonnel(
        (body.personnel ?? []) as Parameters<typeof processPersonnel>[0],
        client,
        body.deviceId,
      );

      const verificationsCount = await processVerifications(
        (body.verificationRecords ?? []) as Parameters<typeof processVerifications>[0],
        client,
      );

      const imagesCount = await processFaceImages(
        (body.faceImages ?? []) as Parameters<typeof processFaceImages>[0],
        client,
        body.deviceId,
      );

      // Audit log
      await client.query(
        `INSERT INTO sync_job_log
           (batch_id, device_id, received_at, processed_at, status,
            personnel_upserted, verifications_inserted, images_registered)
         VALUES ($1, $2, NOW(), NOW(), 'completed', $3, $4, $5)
         ON CONFLICT (batch_id) DO UPDATE SET
           processed_at = NOW(),
           status = 'completed',
           personnel_upserted = EXCLUDED.personnel_upserted,
           verifications_inserted = EXCLUDED.verifications_inserted,
           images_registered = EXCLUDED.images_registered`,
        [body.batchId, body.deviceId, personnelCount, verificationsCount, imagesCount],
      );

      await client.query('COMMIT');

      // Webhook notification (best-effort, non-fatal)
      await notifyWebhook({
        batchId: body.batchId,
        deviceId: body.deviceId,
        processedAt: new Date().toISOString(),
        summary: {
          personnelUpserted: personnelCount,
          verificationsInserted: verificationsCount,
          imagesRegistered: imagesCount,
        },
      });

      console.log(
        `[handler] batch ${body.batchId} processed: ` +
          `${personnelCount} personnel, ${verificationsCount} verifications, ${imagesCount} images`,
      );
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      console.error(`[handler] Failed to process batch ${body.batchId}:`, err);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    } finally {
      client.release();
    }
  }

  return { batchItemFailures };
}

// ---------------------------------------------------------------------------
// Lambda entry point — detects trigger type by event shape
// ---------------------------------------------------------------------------

export async function handler(
  event: APIGatewayProxyEventV2 | SQSEvent,
): Promise<APIGatewayProxyResultV2 | SQSBatchResponse | void> {
  // SQS events have Records[0].body (string) with no routeKey
  if ('Records' in event && Array.isArray(event.Records) && event.Records[0]?.body !== undefined) {
    return handleSQSEvent(event as SQSEvent);
  }

  // API Gateway v2 events have routeKey
  const httpEvent = event as APIGatewayProxyEventV2;
  const routeKey = httpEvent.routeKey ?? '';

  if (routeKey === 'POST /sync/batch') {
    return handleSyncBatch(httpEvent);
  }
  if (routeKey === 'PUT /sync/images/presign') {
    return handlePresign(httpEvent);
  }

  return {
    statusCode: 404,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: 'NOT_FOUND', message: `Unknown route: ${routeKey}` }),
  };
}
