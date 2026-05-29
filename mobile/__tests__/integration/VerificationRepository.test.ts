/**
 * T091 (write-first, precedes T035): VerificationRepository against real node:sqlite —
 * create/findAll/findByPersonnelId, ordering, CHECK constraint, and the
 * ON DELETE SET NULL behaviour of personnel_id_matched.
 */
import { useSQLiteContext } from 'expo-sqlite';
import { useVerificationRepository } from '../../src/db/repositories/VerificationRepository';
import { usePersonnelRepository } from '../../src/db/repositories/PersonnelRepository';
import { makeTestDb, type TestDb } from '../helpers/testDb';
import { buildVerificationInput, buildPersonnelInput } from '../helpers/fixtures';

const mockedUseContext = useSQLiteContext as jest.Mock;

describe('VerificationRepository (integration, real node:sqlite)', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await makeTestDb();
    mockedUseContext.mockReturnValue(db);
  });

  afterEach(() => db.closeSync());

  it('given_input_when_create_then_persists_with_generated_uuid', async () => {
    const repo = useVerificationRepository();
    const created = await repo.create(buildVerificationInput({ outcome: 'unauthorized' }));

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/i);
    const all = await repo.findAll();
    expect(all.length).toBe(1);
    expect(all[0].outcome).toBe('unauthorized');
    expect(all[0].syncStatus).toBe('pending');
  });

  it('given_authorized_match_when_create_then_stores_personnelIdMatched_and_confidence', async () => {
    const personnel = usePersonnelRepository();
    const repo = useVerificationRepository();
    const p = await personnel.create(buildPersonnelInput());

    const created = await repo.create(
      buildVerificationInput({ outcome: 'authorized', personnelIdMatched: p.id, confidenceScore: 0.91 }),
    );
    const found = (await repo.findByPersonnelId(p.id))[0];
    expect(found.id).toBe(created.id);
    expect(found.personnelIdMatched).toBe(p.id);
    expect(found.confidenceScore).toBeCloseTo(0.91);
  });

  it('given_no_match_when_create_then_personnelIdMatched_is_undefined', async () => {
    const repo = useVerificationRepository();
    await repo.create(buildVerificationInput({ outcome: 'unauthorized' }));
    const all = await repo.findAll();
    expect(all[0].personnelIdMatched).toBeUndefined();
    expect(all[0].confidenceScore).toBeUndefined();
  });

  it('given_multiple_records_when_findAll_then_ordered_by_initiatedAt_desc', async () => {
    const repo = useVerificationRepository();
    await repo.create(buildVerificationInput({ initiatedAt: '2026-01-01T00:00:00Z' }));
    await repo.create(buildVerificationInput({ initiatedAt: '2026-02-01T00:00:00Z' }));

    const all = await repo.findAll();
    expect(all.map((v) => v.initiatedAt)).toEqual(['2026-02-01T00:00:00Z', '2026-01-01T00:00:00Z']);
  });

  it('given_records_for_different_personnel_when_findByPersonnelId_then_filters', async () => {
    const personnel = usePersonnelRepository();
    const repo = useVerificationRepository();
    const a = await personnel.create(buildPersonnelInput());
    const b = await personnel.create(buildPersonnelInput());
    await repo.create(buildVerificationInput({ outcome: 'authorized', personnelIdMatched: a.id }));
    await repo.create(buildVerificationInput({ outcome: 'authorized', personnelIdMatched: b.id }));

    const forA = await repo.findByPersonnelId(a.id);
    expect(forA.length).toBe(1);
    expect(forA[0].personnelIdMatched).toBe(a.id);
  });

  it('given_invalid_outcome_when_create_then_check_constraint_rejects', async () => {
    const repo = useVerificationRepository();
    await expect(repo.create(buildVerificationInput({ outcome: 'bogus' as never }))).rejects.toThrow();
  });

  it('given_matched_personnel_deleted_then_personnelIdMatched_set_null', async () => {
    const personnel = usePersonnelRepository();
    const repo = useVerificationRepository();
    const p = await personnel.create(buildPersonnelInput());
    await repo.create(buildVerificationInput({ outcome: 'authorized', personnelIdMatched: p.id }));

    await personnel.delete(p.id);
    const all = await repo.findAll();
    expect(all[0].personnelIdMatched).toBeUndefined();
  });
});
