import { createHash } from 'crypto';
import { computeIdempotencyKey } from '../../../src/utils/idempotency';

describe('computeIdempotencyKey', () => {
  it('given_same_parts_when_computed_twice_then_keys_are_equal', async () => {
    const a = await computeIdempotencyKey(['personnel', 'id-1', '2026-05-29']);
    const b = await computeIdempotencyKey(['personnel', 'id-1', '2026-05-29']);
    expect(a).toBe(b);
  });

  it('given_reordered_parts_when_computed_then_keys_differ', async () => {
    const a = await computeIdempotencyKey(['a', 'b']);
    const b = await computeIdempotencyKey(['b', 'a']);
    expect(a).not.toBe(b);
  });

  it('given_parts_when_computed_then_equals_sha256_of_colon_joined_input', async () => {
    const parts = ['id-1', 'device-1', '2026-05-29T00:00:00Z'];
    const expected = createHash('sha256').update(parts.join(':')).digest('hex');
    expect(await computeIdempotencyKey(parts)).toBe(expected);
  });

  it('given_any_input_when_computed_then_returns_64_hex_chars', async () => {
    expect(await computeIdempotencyKey(['x'])).toMatch(/^[0-9a-f]{64}$/);
  });
});
