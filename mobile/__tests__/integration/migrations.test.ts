import { makeTestDb, type TestDb } from '../helpers/testDb';
import { runMigrations } from '../../src/db/migrations';

describe('migrations + schema (integration, real node:sqlite)', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await makeTestDb();
  });

  afterEach(() => db.closeSync());

  it('given_migrations_run_when_querying_schema_then_all_five_tables_exist', async () => {
    const rows = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    );
    expect(rows.map((r) => r.name).sort()).toEqual([
      'backup_job',
      'face_image',
      'personnel',
      'sync_outbox',
      'verification_record',
    ]);
  });

  it('given_migrations_run_when_querying_indexes_then_expected_indexes_exist', async () => {
    const rows = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'",
    );
    expect(rows.map((r) => r.name)).toEqual(
      expect.arrayContaining([
        'idx_personnel_sync',
        'idx_personnel_employee_id',
        'idx_face_image_personnel',
        'idx_face_image_sync',
        'idx_verification_sync',
        'idx_backup_job_status',
        'idx_outbox_status',
      ]),
    );
  });

  it('given_already_migrated_db_when_rerun_then_idempotent', async () => {
    await expect(
      runMigrations(db as unknown as Parameters<typeof runMigrations>[0]),
    ).resolves.toBeUndefined();
  });

  it('given_invalid_sync_status_when_insert_then_check_constraint_rejects', async () => {
    await expect(
      db.runAsync(
        "INSERT INTO personnel (id,employee_id,full_name,role,registered_at,updated_at,sync_status) VALUES ('x','E','N','R','t','t','bogus')",
      ),
    ).rejects.toThrow();
  });

  it('given_invalid_outcome_when_insert_then_check_constraint_rejects', async () => {
    await expect(
      db.runAsync(
        "INSERT INTO verification_record (id,initiated_at,completed_at,outcome,device_id) VALUES ('v','t','t','nope','d')",
      ),
    ).rejects.toThrow();
  });

  it('given_foreign_keys_enabled_when_delete_parent_then_child_cascades', async () => {
    await db.runAsync(
      "INSERT INTO personnel (id,employee_id,full_name,role,registered_at,updated_at,sync_status) VALUES ('p1','E1','N','R','t','t','pending')",
    );
    await db.runAsync(
      "INSERT INTO face_image (id,personnel_id,image_path,created_at,sync_status) VALUES ('f1','p1','/x','t','pending')",
    );
    await db.runAsync("DELETE FROM personnel WHERE id='p1'");
    const left = await db.getAllAsync("SELECT * FROM face_image WHERE personnel_id='p1'");
    expect(left.length).toBe(0);
  });
});
