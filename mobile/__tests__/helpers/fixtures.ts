/**
 * Fixture builders for domain entities (T081). Each call produces a unique
 * `employee_id` etc. so fixtures don't collide on UNIQUE constraints.
 */
import type { Personnel } from '../../src/models/Personnel';
import type { FaceImage } from '../../src/models/FaceImage';
import type { VerificationRecord } from '../../src/models/VerificationRecord';

let counter = 0;
const next = () => ++counter;

export function buildPersonnelInput(
  overrides: Partial<Omit<Personnel, 'id'>> = {},
): Omit<Personnel, 'id'> {
  const n = next();
  return {
    employeeId: `EMP-${n}`,
    fullName: `Person ${n}`,
    role: 'Inspector',
    registeredAt: '2026-05-29T00:00:00.000Z',
    updatedAt: '2026-05-29T00:00:00.000Z',
    syncStatus: 'pending',
    ...overrides,
  };
}

export function buildFaceImageInput(
  personnelId: string,
  overrides: Partial<Omit<FaceImage, 'id'>> = {},
): Omit<FaceImage, 'id'> {
  const n = next();
  return {
    personnelId,
    imagePath: `/doc/face_images/${personnelId}_${n}.jpg`,
    embedding: new Float32Array([0.1, 0.2, 0.3, 0.4]),
    createdAt: '2026-05-29T00:00:00.000Z',
    syncStatus: 'pending',
    ...overrides,
  };
}

export function buildVerificationInput(
  overrides: Partial<Omit<VerificationRecord, 'id'>> = {},
): Omit<VerificationRecord, 'id'> {
  return {
    initiatedAt: '2026-05-29T00:00:00.000Z',
    completedAt: '2026-05-29T00:00:01.000Z',
    outcome: 'authorized',
    deviceId: 'device-1',
    syncStatus: 'pending',
    ...overrides,
  };
}
