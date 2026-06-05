import { generateUUID } from '../../../src/utils/uuid';

const RFC4122_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('generateUUID', () => {
  it('given_called_when_generating_then_returns_rfc4122_v4_shape', () => {
    expect(generateUUID()).toMatch(RFC4122_V4);
  });

  it('given_many_calls_when_generating_then_values_are_unique', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateUUID()));
    expect(ids.size).toBe(1000);
  });
});
