/**
 * T090 (write-first, precedes T036 + T041): VerificationService outcome mapping —
 * all five FR-009 outcomes including the quality_insufficient gate (T041) — plus
 * persistence + outbox enqueue in evaluateVerification.
 */
import {
  decideOutcome,
  evaluateVerification,
  useVerificationService,
  type VerificationEvidence,
  type EvaluateDeps,
} from '../../../src/services/VerificationService';
import { buildFaceImageInput } from '../../helpers/fixtures';
import type { FaceImage } from '../../../src/models/FaceImage';
import type { VerificationRecord } from '../../../src/models/VerificationRecord';
import { useFaceImageRepository } from '../../../src/db/repositories/FaceImageRepository';
import { useVerificationRepository } from '../../../src/db/repositories/VerificationRepository';

jest.mock('../../../src/db/repositories/FaceImageRepository', () => ({
  useFaceImageRepository: jest.fn(),
}));
jest.mock('../../../src/db/repositories/VerificationRepository', () => ({
  useVerificationRepository: jest.fn(),
}));

const QUERY = new Float32Array([1, 0]);
// Unit vector whose cosine with QUERY equals `cos`, to place scores in exact bands.
const unit = (cos: number) => new Float32Array([cos, Math.sqrt(1 - cos * cos)]);

const candidate = (personnelId: string, embedding: Float32Array): FaceImage => ({
  id: `fi-${personnelId}`,
  ...buildFaceImageInput(personnelId, { embedding }),
});

const goodFace = {
  boundingBox: { x: 0, y: 0, width: 100, height: 100 },
  landmarks: [],
  qualityScore: 0.9,
};

const evidence = (over: Partial<VerificationEvidence> = {}): VerificationEvidence => ({
  face: goodFace,
  liveness: 'live',
  queryEmbedding: QUERY,
  ...over,
});

describe('VerificationService.decideOutcome', () => {
  it('given_no_detected_face_then_quality_insufficient', () => {
    expect(decideOutcome(evidence({ face: null }), []).outcome).toBe('quality_insufficient');
  });

  it('given_quality_below_min_then_quality_insufficient_gate_short_circuits', () => {
    const lowQuality = { ...goodFace, qualityScore: 0.3 };
    // Even with a perfect match available, the gate wins and matching is not run.
    const res = decideOutcome(evidence({ face: lowQuality }), [candidate('p1', unit(1))]);
    expect(res.outcome).toBe('quality_insufficient');
    expect(res.personnelIdMatched).toBeUndefined();
  });

  it('given_spoof_liveness_then_liveness_failed', () => {
    expect(decideOutcome(evidence({ liveness: 'spoof' }), [candidate('p1', unit(1))]).outcome).toBe(
      'liveness_failed',
    );
  });

  it('given_inconclusive_liveness_then_liveness_failed', () => {
    expect(decideOutcome(evidence({ liveness: 'inconclusive' }), []).outcome).toBe('liveness_failed');
  });

  it('given_no_face_takes_precedence_over_failed_liveness', () => {
    expect(decideOutcome(evidence({ face: null, liveness: 'spoof' }), []).outcome).toBe(
      'quality_insufficient',
    );
  });

  it('given_match_at_or_above_threshold_then_authorized_with_id_and_score', () => {
    const res = decideOutcome(evidence(), [candidate('p1', unit(0.95))]);
    expect(res.outcome).toBe('authorized');
    expect(res.personnelIdMatched).toBe('p1');
    expect(res.confidenceScore).toBeCloseTo(0.95);
  });

  it('given_best_in_low_confidence_band_then_low_confidence_without_matched_id', () => {
    const res = decideOutcome(evidence(), [candidate('p1', unit(0.55))]);
    expect(res.outcome).toBe('low_confidence');
    expect(res.personnelIdMatched).toBeUndefined();
    expect(res.confidenceScore).toBeCloseTo(0.55);
  });

  it('given_best_below_low_confidence_then_unauthorized', () => {
    const res = decideOutcome(evidence(), [candidate('p1', unit(0.2))]);
    expect(res.outcome).toBe('unauthorized');
    expect(res.personnelIdMatched).toBeUndefined();
  });

  it('given_no_enrolled_candidates_then_unauthorized', () => {
    expect(decideOutcome(evidence(), []).outcome).toBe('unauthorized');
  });
});

describe('VerificationService.evaluateVerification', () => {
  const makeDeps = (candidates: FaceImage[], withEnqueue = true): EvaluateDeps & {
    saveRecord: jest.Mock;
    enqueueOutbox?: jest.Mock;
    loadCandidates: jest.Mock;
  } => {
    const saveRecord = jest.fn(
      async (vr: Omit<VerificationRecord, 'id'>): Promise<VerificationRecord> => ({ ...vr, id: 'vr-1' }),
    );
    const enqueueOutbox = jest.fn(async () => {});
    return {
      loadCandidates: jest.fn(async () => candidates),
      saveRecord,
      ...(withEnqueue ? { enqueueOutbox } : {}),
      deviceId: 'dev-1',
      initiatedAt: '2026-05-29T00:00:00.000Z',
      operatorContext: 'gate-A',
      now: () => '2026-05-29T00:00:05.000Z',
    };
  };

  it('given_authorized_evidence_then_persists_mapped_record_and_enqueues', async () => {
    const deps = makeDeps([candidate('p1', unit(0.95))]);
    const rec = await evaluateVerification(evidence(), deps);

    expect(deps.loadCandidates).toHaveBeenCalledTimes(1);
    expect(rec.outcome).toBe('authorized');
    expect(rec.personnelIdMatched).toBe('p1');
    expect(rec.initiatedAt).toBe('2026-05-29T00:00:00.000Z');
    expect(rec.completedAt).toBe('2026-05-29T00:00:05.000Z');
    expect(rec.deviceId).toBe('dev-1');
    expect(rec.operatorContext).toBe('gate-A');
    expect(rec.syncStatus).toBe('pending');
    expect(deps.saveRecord).toHaveBeenCalledTimes(1);
    expect(deps.enqueueOutbox).toHaveBeenCalledWith(rec);
  });

  it('given_no_enqueue_dependency_then_still_persists_without_throwing', async () => {
    const deps = makeDeps([], false);
    const rec = await evaluateVerification(evidence(), deps);
    expect(rec.outcome).toBe('unauthorized');
    expect(deps.saveRecord).toHaveBeenCalledTimes(1);
  });
});

describe('useVerificationService', () => {
  it('given_run_context_when_verify_then_wires_repositories_and_threads_context', async () => {
    const findAll = jest.fn(async () => [candidate('p1', unit(0.95))]);
    const create = jest.fn(
      async (vr: Omit<VerificationRecord, 'id'>): Promise<VerificationRecord> => ({ ...vr, id: 'vr-9' }),
    );
    (useFaceImageRepository as jest.Mock).mockReturnValue({ findAll });
    (useVerificationRepository as jest.Mock).mockReturnValue({ create });

    const { verify } = useVerificationService();
    const rec = await verify(evidence(), {
      deviceId: 'dev-7',
      initiatedAt: '2026-05-29T00:00:00.000Z',
      operatorContext: 'gate-B',
    });

    expect(findAll).toHaveBeenCalledTimes(1); // loadCandidates -> FaceImageRepository.findAll
    expect(create).toHaveBeenCalledTimes(1); // saveRecord -> VerificationRepository.create
    expect(rec.id).toBe('vr-9');
    expect(rec.outcome).toBe('authorized');
    expect(rec.personnelIdMatched).toBe('p1');
    expect(rec.deviceId).toBe('dev-7');
    expect(rec.operatorContext).toBe('gate-B');
  });
});
