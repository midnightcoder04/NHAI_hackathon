/**
 * T088 (write-first, precedes T034): FaceMatcher cosine-similarity correctness,
 * acceptance at >= FACE_MATCH_THRESHOLD, the low-confidence band, and null on no-match.
 */
import { FaceMatcher, cosineSimilarity, scoreBest } from '../../../src/ml/FaceMatcher';
import { FACE_MATCH_THRESHOLD, FACE_LOW_CONFIDENCE_THRESHOLD } from '../../../src/constants';
import { buildFaceImageInput } from '../../helpers/fixtures';
import type { FaceImage } from '../../../src/models/FaceImage';

// Build a FaceImage candidate with a chosen personnelId + embedding.
const candidate = (personnelId: string, embedding: Float32Array | null): FaceImage => ({
  id: `fi-${personnelId}`,
  ...buildFaceImageInput(personnelId, { embedding }),
});

// Unit query vector along x; candidates' cosine vs this equals their x-component
// when they are unit vectors, which lets us place scores in exact bands.
const QUERY = new Float32Array([1, 0]);
const unit = (cos: number) => new Float32Array([cos, Math.sqrt(1 - cos * cos)]);

describe('FaceMatcher.cosineSimilarity', () => {
  it('given_identical_vectors_then_similarity_is_1', () => {
    expect(cosineSimilarity(new Float32Array([1, 2, 3]), new Float32Array([1, 2, 3]))).toBeCloseTo(1);
  });

  it('given_orthogonal_vectors_then_similarity_is_0', () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0);
  });

  it('given_opposite_vectors_then_similarity_is_minus_1', () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([-1, 0]))).toBeCloseTo(-1);
  });

  it('given_scaled_vectors_then_similarity_is_scale_invariant', () => {
    expect(cosineSimilarity(new Float32Array([1, 2, 3]), new Float32Array([2, 4, 6]))).toBeCloseTo(1);
  });

  it('given_a_zero_vector_then_returns_0_without_NaN', () => {
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 0]))).toBe(0);
  });

  it('given_mismatched_lengths_then_returns_0', () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0, 0]))).toBe(0);
  });
});

describe('FaceMatcher.scoreBest', () => {
  it('given_multiple_candidates_then_returns_highest_scoring', () => {
    const best = scoreBest(QUERY, [candidate('low', unit(0.55)), candidate('high', unit(0.95))]);
    expect(best?.personnelId).toBe('high');
    expect(best?.score).toBeCloseTo(0.95);
  });

  it('given_candidate_with_null_embedding_then_skips_it', () => {
    const best = scoreBest(QUERY, [candidate('null', null), candidate('ok', unit(0.8))]);
    expect(best?.personnelId).toBe('ok');
  });

  it('given_candidate_with_mismatched_embedding_length_then_skips_it', () => {
    const best = scoreBest(QUERY, [
      candidate('wrongLen', new Float32Array([0.1, 0.2, 0.3])),
      candidate('ok', unit(0.7)),
    ]);
    expect(best?.personnelId).toBe('ok');
  });

  it('given_no_candidates_then_returns_null', () => {
    expect(scoreBest(QUERY, [])).toBeNull();
  });

  it('given_only_unscorable_candidates_then_returns_null', () => {
    expect(scoreBest(QUERY, [candidate('a', null), candidate('b', new Float32Array([1, 2, 3]))])).toBeNull();
  });
});

describe('FaceMatcher.matchBest', () => {
  it('given_score_at_or_above_threshold_then_returns_match', () => {
    const match = FaceMatcher.matchBest(QUERY, [candidate('p1', unit(0.9))]);
    expect(match?.personnelId).toBe('p1');
    expect(match?.score).toBeGreaterThanOrEqual(FACE_MATCH_THRESHOLD);
  });

  it('given_best_below_threshold_then_returns_null', () => {
    const match = FaceMatcher.matchBest(QUERY, [candidate('p1', unit(0.42))]);
    expect(match).toBeNull();
  });

  it('given_low_confidence_band_then_scoreBest_exposes_it_while_matchBest_is_null', () => {
    const candidates = [candidate('p1', unit(0.42))];
    const raw = scoreBest(QUERY, candidates);
    expect(raw?.score).toBeGreaterThanOrEqual(FACE_LOW_CONFIDENCE_THRESHOLD);
    expect(raw!.score).toBeLessThan(FACE_MATCH_THRESHOLD);
    expect(FaceMatcher.matchBest(QUERY, candidates)).toBeNull();
  });
});
