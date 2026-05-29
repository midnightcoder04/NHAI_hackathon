import { useSQLiteContext } from 'expo-sqlite';
import { usePersonnelRepository } from '../../src/db/repositories/PersonnelRepository';
import { useFaceImageRepository } from '../../src/db/repositories/FaceImageRepository';
import { makeTestDb, type TestDb } from '../helpers/testDb';
import { buildPersonnelInput, buildFaceImageInput } from '../helpers/fixtures';

const mockedUseContext = useSQLiteContext as jest.Mock;

describe('FaceImageRepository (integration, real node:sqlite)', () => {
  let db: TestDb;
  let personnelId: string;

  beforeEach(async () => {
    db = await makeTestDb();
    mockedUseContext.mockReturnValue(db);
    const p = await usePersonnelRepository().create(buildPersonnelInput());
    personnelId = p.id;
  });

  afterEach(() => db.closeSync());

  it('given_embedding_when_create_then_blob_round_trips_to_same_floats', async () => {
    const repo = useFaceImageRepository();
    const embedding = new Float32Array([0.1, -0.2, 0.3, 0.95]);
    await repo.create(buildFaceImageInput(personnelId, { embedding }));

    const [back] = await repo.findByPersonnelId(personnelId);
    expect(back.embedding).not.toBeNull();
    expect(back.embedding).toBeInstanceOf(Float32Array);
    expect(Array.from(back.embedding!)).toEqual(Array.from(embedding));
  });

  it('given_null_embedding_when_create_then_reads_back_null', async () => {
    const repo = useFaceImageRepository();
    await repo.create(buildFaceImageInput(personnelId, { embedding: null }));

    const [back] = await repo.findByPersonnelId(personnelId);
    expect(back.embedding).toBeNull();
  });

  it('given_face_image_when_update_then_s3Key_and_syncStatus_change', async () => {
    const repo = useFaceImageRepository();
    const created = await repo.create(buildFaceImageInput(personnelId));

    await repo.update(created.id, { s3Key: 'images/device-1/abc.jpg', syncStatus: 'synced' });
    const [back] = await repo.findByPersonnelId(personnelId);
    expect(back.s3Key).toBe('images/device-1/abc.jpg');
    expect(back.syncStatus).toBe('synced');
  });

  it('given_multiple_images_when_deleteByPersonnelId_then_all_removed', async () => {
    const repo = useFaceImageRepository();
    await repo.create(buildFaceImageInput(personnelId));
    await repo.create(buildFaceImageInput(personnelId));
    expect((await repo.findByPersonnelId(personnelId)).length).toBe(2);

    await repo.deleteByPersonnelId(personnelId);
    expect((await repo.findByPersonnelId(personnelId)).length).toBe(0);
  });

  it('given_orphan_personnelId_when_create_then_rejects_foreign_key_violation', async () => {
    const repo = useFaceImageRepository();
    await expect(
      repo.create(buildFaceImageInput('does-not-exist')),
    ).rejects.toThrow();
  });
});
