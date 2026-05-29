import type { FaceImage } from '../models/FaceImage';
import type { VerificationOutcome, VerificationRecord } from '../models/VerificationRecord';
import { useFaceImageRepository } from '../db/repositories/FaceImageRepository';
import { useVerificationRepository } from '../db/repositories/VerificationRepository';
import { scoreBest } from '../ml/FaceMatcher';
import { FACE_MATCH_THRESHOLD, FACE_LOW_CONFIDENCE_THRESHOLD, FACE_MIN_QUALITY_SCORE } from '../constants';

export interface DetectedFace {
  boundingBox: { x: number; y: number; width: number; height: number };
  landmarks: Array<{ x: number; y: number }>;
  qualityScore: number;
}

export type LivenessResult = 'live' | 'spoof' | 'inconclusive';

/**
 * Evidence gathered from the live camera frame stream. FaceDetector (T032),
 * LivenessDetector (T033), and EmbeddingModel run inside the VisionCamera v5
 * frame-processor/worklet context and are captured by VerificationScreen (T037);
 * this service maps that evidence to an outcome and persists it.
 */
export interface VerificationEvidence {
  face: DetectedFace | null;
  liveness: LivenessResult;
  queryEmbedding: Float32Array;
}

export interface OutcomeDecision {
  outcome: VerificationOutcome;
  personnelIdMatched?: string;
  confidenceScore?: number;
}

export interface EvaluateDeps {
  loadCandidates: () => Promise<FaceImage[]>;
  saveRecord: (vr: Omit<VerificationRecord, 'id'>) => Promise<VerificationRecord>;
  enqueueOutbox?: (record: VerificationRecord) => Promise<void>;
  deviceId: string;
  initiatedAt: string;
  operatorContext?: string;
  now?: () => string;
}

/**
 * Pure decision: maps evidence (+ the enrolled gallery) to one of the five FR-009
 * outcomes. Order matters — the T041 image-quality gate runs first, then liveness,
 * then identity matching.
 */
export function decideOutcome(evidence: VerificationEvidence, candidates: FaceImage[]): OutcomeDecision {
  const { face, liveness, queryEmbedding } = evidence;

  // T041 quality gate: no usable face → reposition; matching/liveness not run.
  if (!face || face.qualityScore < FACE_MIN_QUALITY_SCORE) {
    return { outcome: 'quality_insufficient' };
  }

  // Liveness must be positively established; both spoof and inconclusive fail.
  if (liveness !== 'live') {
    return { outcome: 'liveness_failed' };
  }

  const best = scoreBest(queryEmbedding, candidates);
  if (best && best.score >= FACE_MATCH_THRESHOLD) {
    return { outcome: 'authorized', personnelIdMatched: best.personnelId, confidenceScore: best.score };
  }
  if (best && best.score >= FACE_LOW_CONFIDENCE_THRESHOLD) {
    // Near-miss: record the score for audit but assert no matched identity.
    return { outcome: 'low_confidence', confidenceScore: best.score };
  }
  return { outcome: 'unauthorized' };
}

/**
 * Orchestrates a single verification: load the enrolled gallery, decide the
 * outcome, persist a VerificationRecord, and enqueue it for sync (when an
 * enqueue dependency is provided — a no-op stub until SyncOutboxRepository lands).
 */
export async function evaluateVerification(
  evidence: VerificationEvidence,
  deps: EvaluateDeps,
): Promise<VerificationRecord> {
  const candidates = await deps.loadCandidates();
  const decision = decideOutcome(evidence, candidates);
  const now = deps.now ?? (() => new Date().toISOString());

  const record = await deps.saveRecord({
    personnelIdMatched: decision.personnelIdMatched,
    initiatedAt: deps.initiatedAt,
    completedAt: now(),
    outcome: decision.outcome,
    confidenceScore: decision.confidenceScore,
    operatorContext: deps.operatorContext,
    deviceId: deps.deviceId,
    syncStatus: 'pending',
  });

  if (deps.enqueueOutbox) {
    await deps.enqueueOutbox(record);
  }
  return record;
}

/**
 * Hook wiring the pure orchestration to the real repositories. VerificationScreen
 * (T037) supplies the evidence captured from the frame-processor pipeline plus the
 * run context (deviceId, initiatedAt, operatorContext).
 */
export function useVerificationService() {
  const faces = useFaceImageRepository();
  const verifications = useVerificationRepository();

  async function verify(
    evidence: VerificationEvidence,
    ctx: { deviceId: string; initiatedAt: string; operatorContext?: string },
  ): Promise<VerificationRecord> {
    return evaluateVerification(evidence, {
      loadCandidates: () => faces.findAll(),
      saveRecord: (vr) => verifications.create(vr),
      // enqueueOutbox is wired in Phase 5 (T045); omitted here so the call no-ops.
      deviceId: ctx.deviceId,
      initiatedAt: ctx.initiatedAt,
      operatorContext: ctx.operatorContext,
    });
  }

  return { verify };
}
