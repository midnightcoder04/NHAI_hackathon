import type { FaceImage } from '../models/FaceImage';
import { FACE_MATCH_THRESHOLD } from '../constants';

export interface MatchResult {
  personnelId: string;
  score: number;
}

/**
 * Cosine similarity in [-1, 1]. Returns 0 (not NaN) for the degenerate cases —
 * a zero vector or mismatched lengths — so callers can treat 0 as "no signal".
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Highest-scoring enrolled candidate by cosine similarity, regardless of any
 * threshold. Candidates without a comparable embedding (null, or a different
 * dimensionality than the query) are skipped. Returns null only when no
 * scorable candidate exists. Callers map the raw score into outcome bands.
 */
export function scoreBest(query: Float32Array, candidates: FaceImage[]): MatchResult | null {
  let best: MatchResult | null = null;
  for (const c of candidates) {
    if (!c.embedding || c.embedding.length !== query.length) continue;
    const score = cosineSimilarity(query, c.embedding);
    if (!best || score > best.score) {
      best = { personnelId: c.personnelId, score };
    }
  }
  return best;
}

/**
 * Best match iff its score meets FACE_MATCH_THRESHOLD, else null (T034 contract).
 * The low-confidence band is intentionally NOT surfaced here — VerificationService
 * uses scoreBest to distinguish low_confidence from unauthorized.
 */
export function matchBest(query: Float32Array, candidates: FaceImage[]): MatchResult | null {
  const best = scoreBest(query, candidates);
  return best && best.score >= FACE_MATCH_THRESHOLD ? best : null;
}

export const FaceMatcher = { cosineSimilarity, scoreBest, matchBest };
