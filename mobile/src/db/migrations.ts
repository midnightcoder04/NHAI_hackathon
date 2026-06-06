import * as SQLite from 'expo-sqlite';
import { ALL_DDL } from './schema';

export async function runMigrations(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync('PRAGMA journal_mode = WAL;');
  await db.execAsync('PRAGMA foreign_keys = ON;');

  for (const ddl of ALL_DDL) {
    await db.execAsync(ddl);
  }

  // T077: add tombstoned column to existing databases (idempotent via IF NOT EXISTS workaround)
  await db.execAsync(
    `ALTER TABLE personnel ADD COLUMN tombstoned INTEGER NOT NULL DEFAULT 0`,
  ).catch(() => {
    // Column already exists — safe to ignore
  });
}
