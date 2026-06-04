import { useSQLiteContext } from 'expo-sqlite';
import { usePersonnelRepository } from '../../src/db/repositories/PersonnelRepository';
import { useFaceImageRepository } from '../../src/db/repositories/FaceImageRepository';
import { makeTestDb, type TestDb } from '../helpers/testDb';
import { buildPersonnelInput, buildFaceImageInput } from '../helpers/fixtures';

const mockedUseContext = useSQLiteContext as jest.Mock;

describe('PersonnelRepository (integration, real node:sqlite)', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await makeTestDb();
    mockedUseContext.mockReturnValue(db);
  });

  afterEach(() => db.closeSync());

  it('given_input_when_create_then_persists_and_findById_returns_it', async () => {
    const repo = usePersonnelRepository();
    const created = await repo.create(buildPersonnelInput({ fullName: 'Asha Rao' }));

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/i);
    const found = await repo.findById(created.id);
    expect(found).not.toBeNull();
    expect(found?.fullName).toBe('Asha Rao');
    expect(found?.syncStatus).toBe('pending');
  });

  it('given_multiple_records_when_findAll_then_ordered_by_registeredAt_desc', async () => {
    const repo = usePersonnelRepository();
    await repo.create(buildPersonnelInput({ employeeId: 'E1', registeredAt: '2026-01-01T00:00:00Z' }));
    await repo.create(buildPersonnelInput({ employeeId: 'E2', registeredAt: '2026-02-01T00:00:00Z' }));

    const all = await repo.findAll();
    expect(all.map((p) => p.employeeId)).toEqual(['E2', 'E1']);
  });

  it('given_existing_record_when_update_then_fields_change', async () => {
    const repo = usePersonnelRepository();
    const p = await repo.create(buildPersonnelInput({ role: 'Inspector' }));

    await repo.update(p.id, { role: 'Supervisor', syncStatus: 'synced' });
    const found = await repo.findById(p.id);
    expect(found?.role).toBe('Supervisor');
    expect(found?.syncStatus).toBe('synced');
  });

  it('given_existing_record_when_delete_then_findById_returns_null', async () => {
    const repo = usePersonnelRepository();
    const p = await repo.create(buildPersonnelInput());

    await repo.delete(p.id);
    expect(await repo.findById(p.id)).toBeNull();
  });

  it('given_synced_personnel_with_face_image_when_delete_then_hard_deletes_and_cascades', async () => {
    const personnel = usePersonnelRepository();
    const faces = useFaceImageRepository();
    const p = await personnel.create(buildPersonnelInput());
    await faces.create(buildFaceImageInput(p.id));
    await personnel.update(p.id, { syncStatus: 'synced' }); // synced + no in-flight ⇒ safe to hard-delete

    expect((await faces.findByPersonnelId(p.id)).length).toBe(1);
    await personnel.delete(p.id);
    expect((await faces.findByPersonnelId(p.id)).length).toBe(0);
  });

  it('given_unsynced_personnel_when_delete_then_tombstoned_hidden_but_not_removed', async () => {
    const personnel = usePersonnelRepository();
    const faces = useFaceImageRepository();
    const p = await personnel.create(buildPersonnelInput()); // sync_status defaults to 'pending'
    await faces.create(buildFaceImageInput(p.id));

    await personnel.delete(p.id);

    // Hidden from the app (findById/findAll filter tombstoned)…
    expect(await personnel.findById(p.id)).toBeNull();
    expect((await personnel.findAll()).some((x) => x.id === p.id)).toBe(false);
    // …but the row is tombstoned (not removed) and its face image is NOT cascaded away.
    const raw = await db.getFirstAsync<{ tombstoned: number }>(
      'SELECT tombstoned FROM personnel WHERE id = ?',
      [p.id],
    );
    expect(raw?.tombstoned).toBe(1);
    expect((await faces.findByPersonnelId(p.id)).length).toBe(1);
  });

  it('given_duplicate_employeeId_when_create_then_rejects_unique_violation', async () => {
    const repo = usePersonnelRepository();
    await repo.create(buildPersonnelInput({ employeeId: 'DUP' }));
    await expect(repo.create(buildPersonnelInput({ employeeId: 'DUP' }))).rejects.toThrow();
  });
});
