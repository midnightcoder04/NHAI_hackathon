import * as SQLite from 'expo-sqlite';
import { ALL_DDL } from './schema';

/** Idempotently add a column to an existing table (no-op if it already exists). */
async function ensureColumn(
  db: SQLite.SQLiteDatabase,
  table: string,
  column: string,
  declaration: string,
): Promise<void> {
  const cols = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => c.name === column)) {
    await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  }
}

export async function runMigrations(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync('PRAGMA journal_mode = WAL;');
  await db.execAsync('PRAGMA foreign_keys = ON;');

  for (const ddl of ALL_DDL) {
    await db.execAsync(ddl);
  }

  // T077: additive migration for DBs created before `personnel.tombstoned` existed
  // (CREATE TABLE IF NOT EXISTS won't alter an existing table). Idempotent.
  await ensureColumn(db, 'personnel', 'tombstoned', 'INTEGER NOT NULL DEFAULT 0');
}
