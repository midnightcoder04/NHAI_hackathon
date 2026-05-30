/**
 * T094 — Unit tests for Lambda processors
 * All DB interactions use a mocked pg.PoolClient.
 * AWS SDK clients inside FaceImageProcessor are mocked via jest.mock.
 */

// Mock the S3 client used by FaceImageProcessor so no real AWS calls happen
jest.mock('@aws-sdk/client-s3', () => {
  const mockSend = jest.fn().mockResolvedValue({});
  return {
    S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
    HeadObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
    PutObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
    __mockSend: mockSend,
  };
});

import { processPersonnel, PersonnelRecord } from '../src/processors/PersonnelProcessor';
import { processVerifications, VerificationRecord } from '../src/processors/VerificationProcessor';
import { processFaceImages, FaceImageRecord } from '../src/processors/FaceImageProcessor';

// ---------------------------------------------------------------------------
// Mock pg.PoolClient factory
// ---------------------------------------------------------------------------

function makeClient(queryRows: Record<string, unknown>[][] = []) {
  let callIndex = 0;
  const query = jest.fn().mockImplementation(() => {
    const rows = queryRows[callIndex] ?? [];
    callIndex++;
    return Promise.resolve({ rows, rowCount: rows.length });
  });
  return { query } as unknown as import('pg').PoolClient;
}

// Helper: always-returns-one-row client (simulating a successful insert/upsert)
function makeInsertClient(count = 1) {
  // Each call returns `count` rows so rowCount > 0
  const rows = Array.from({ length: count }, (_, i) => ({ id: `id-${i}` }));
  const query = jest.fn().mockResolvedValue({ rows, rowCount: count });
  return { query } as unknown as import('pg').PoolClient;
}

// ---------------------------------------------------------------------------
// PersonnelProcessor
// ---------------------------------------------------------------------------

describe('PersonnelProcessor', () => {
  const sample: PersonnelRecord = {
    id: 'aaaa0000-0000-0000-0000-000000000001',
    employeeId: 'EMP001',
    fullName: 'Alice Smith',
    role: 'Engineer',
    registeredAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    idempotencyKey: 'key-abc',
  };

  test('upserts record and returns count 1 when row is written', async () => {
    const client = makeInsertClient(1);
    const result = await processPersonnel([sample], client, 'device-1');
    expect(result).toBe(1);
    expect(client.query).toHaveBeenCalledTimes(1);
    const sql: string = (client.query as jest.Mock).mock.calls[0][0];
    // Confirm newest-wins WHERE clause is present
    expect(sql).toMatch(/WHERE EXCLUDED\.updated_at > personnel\.updated_at/);
  });

  test('upserts multiple records and sums counts', async () => {
    const records: PersonnelRecord[] = [
      { ...sample, id: 'id-1', employeeId: 'EMP001' },
      { ...sample, id: 'id-2', employeeId: 'EMP002' },
    ];
    const client = makeInsertClient(1); // each call returns rowCount=1
    const result = await processPersonnel(records, client, 'device-1');
    expect(result).toBe(2);
    expect(client.query).toHaveBeenCalledTimes(2);
  });

  test('returns 0 and skips DB when records array is empty (no-op)', async () => {
    const client = makeInsertClient(0);
    const result = await processPersonnel([], client, 'device-1');
    expect(result).toBe(0);
    expect(client.query).not.toHaveBeenCalled();
  });

  test('returns 0 when ON CONFLICT fires and no row is updated (rowCount=0)', async () => {
    // rowCount=0 means the WHERE clause in DO UPDATE prevented the write
    const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const client = { query } as unknown as import('pg').PoolClient;
    const result = await processPersonnel([sample], client, 'device-1');
    expect(result).toBe(0);
  });

  test('SQL uses ON CONFLICT (employee_id) DO UPDATE', async () => {
    const client = makeInsertClient(1);
    await processPersonnel([sample], client, 'device-1');
    const sql: string = (client.query as jest.Mock).mock.calls[0][0];
    expect(sql).toMatch(/ON CONFLICT \(employee_id\)/i);
    expect(sql).toMatch(/DO UPDATE SET/i);
  });
});

// ---------------------------------------------------------------------------
// VerificationProcessor
// ---------------------------------------------------------------------------

describe('VerificationProcessor', () => {
  const sample: VerificationRecord = {
    id: 'bbbb0000-0000-0000-0000-000000000001',
    personnelIdMatched: 'aaaa0000-0000-0000-0000-000000000001',
    initiatedAt: '2026-05-01T10:00:00Z',
    completedAt: '2026-05-01T10:00:01Z',
    outcome: 'authorized',
    confidenceScore: 0.92,
    operatorContext: null,
    deviceId: 'device-1',
    idempotencyKey: 'key-xyz',
  };

  test('inserts record and returns count 1', async () => {
    const client = makeInsertClient(1);
    const result = await processVerifications([sample], client);
    expect(result).toBe(1);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  test('idempotent insert — uses ON CONFLICT (id, device_id) DO NOTHING', async () => {
    const client = makeInsertClient(1);
    await processVerifications([sample], client);
    const sql: string = (client.query as jest.Mock).mock.calls[0][0];
    expect(sql).toMatch(/ON CONFLICT \(id, device_id\) DO NOTHING/i);
  });

  test('returns 0 when ON CONFLICT fires (duplicate record, rowCount=0)', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const client = { query } as unknown as import('pg').PoolClient;
    const result = await processVerifications([sample], client);
    expect(result).toBe(0);
  });

  test('handles empty array (no-op, no DB call)', async () => {
    const client = makeInsertClient(0);
    const result = await processVerifications([], client);
    expect(result).toBe(0);
    expect(client.query).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// FaceImageProcessor
// ---------------------------------------------------------------------------

describe('FaceImageProcessor', () => {
  // Unset FACE_IMAGES_BUCKET so the optional S3 HEAD check is skipped
  beforeEach(() => {
    delete process.env.FACE_IMAGES_BUCKET;
  });

  const sample: FaceImageRecord = {
    id: 'cccc0000-0000-0000-0000-000000000001',
    personnelId: 'aaaa0000-0000-0000-0000-000000000001',
    s3Key: 'images/device-1/cccc0000-0000-0000-0000-000000000001.jpg',
    createdAt: '2026-05-01T09:00:00Z',
    idempotencyKey: 'key-img',
  };

  test('inserts record and returns count 1', async () => {
    const client = makeInsertClient(1);
    const result = await processFaceImages([sample], client, 'device-1');
    expect(result).toBe(1);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  test('idempotent insert — uses ON CONFLICT (id) DO NOTHING', async () => {
    const client = makeInsertClient(1);
    await processFaceImages([sample], client, 'device-1');
    const sql: string = (client.query as jest.Mock).mock.calls[0][0];
    expect(sql).toMatch(/ON CONFLICT \(id\) DO NOTHING/i);
  });

  test('returns 0 when ON CONFLICT fires (duplicate id, rowCount=0)', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const client = { query } as unknown as import('pg').PoolClient;
    const result = await processFaceImages([sample], client, 'device-1');
    expect(result).toBe(0);
  });

  test('handles empty array (no-op, no DB call)', async () => {
    const client = makeInsertClient(0);
    const result = await processFaceImages([], client, 'device-1');
    expect(result).toBe(0);
    expect(client.query).not.toHaveBeenCalled();
  });
});
