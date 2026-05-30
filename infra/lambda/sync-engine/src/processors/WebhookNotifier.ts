export interface WebhookSummary {
  personnelUpserted: number;
  verificationsInserted: number;
  imagesRegistered: number;
}

export interface WebhookPayload {
  batchId: string;
  deviceId: string;
  processedAt: string;
  summary: WebhookSummary;
}

/**
 * POSTs a sync.batch.completed event to the configured WEBHOOK_URL.
 * No-op when the env var is absent or empty.
 */
export async function notifyWebhook(payload: WebhookPayload): Promise<void> {
  const url = process.env.WEBHOOK_URL;
  if (!url) return;

  const body = JSON.stringify({
    event: 'sync.batch.completed',
    batchId: payload.batchId,
    deviceId: payload.deviceId,
    processedAt: payload.processedAt,
    summary: payload.summary,
  });

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  } catch (err) {
    console.error('[WebhookNotifier] network error posting webhook:', err);
    return; // non-fatal — don't fail the Lambda
  }

  if (!response.ok) {
    console.warn(
      `[WebhookNotifier] webhook responded ${response.status} ${response.statusText}`,
    );
    // Still non-fatal — webhook delivery is best-effort (FR-017)
  }
}
