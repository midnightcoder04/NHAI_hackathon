/**
 * Real-SQLite test database for integration tests (T081).
 *
 * Backed by Node 24's built-in `node:sqlite` (`DatabaseSync`) — a real SQLite engine,
 * not a mock — so repository/migration tests exercise genuine SQL, constraints, FK
 * cascades and BLOB round-trips (Constitution III). Exposes the subset of the
 * `expo-sqlite` `SQLiteDatabase` async API that the app's repositories use.
 */
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../../src/db/migrations';

export interface TestDb {
  raw: DatabaseSync;
  execAsync(sql: string): Promise<void>;
  runAsync(
    sql: string,
    params?: unknown[],
  ): Promise<{ lastInsertRowId: number; changes: number }>;
  getAllAsync<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  getFirstAsync<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  withTransactionAsync(fn: () => Promise<void>): Promise<void>;
  closeSync(): void;
}

function bind(params?: unknown[]): unknown[] {
  return params ?? [];
}

function createAdapter(raw: DatabaseSync): TestDb {
  return {
    raw,
    async execAsync(sql) {
      raw.exec(sql);
    },
    async runAsync(sql, params) {
      const result = raw.prepare(sql).run(...(bind(params) as never[]));
      return {
        lastInsertRowId: Number(result.lastInsertRowid),
        changes: Number(result.changes),
      };
    },
    async getAllAsync(sql, params) {
      return raw.prepare(sql).all(...(bind(params) as never[])) as never;
    },
    async getFirstAsync(sql, params) {
      const row = raw.prepare(sql).get(...(bind(params) as never[]));
      return (row ?? null) as never;
    },
    async withTransactionAsync(fn) {
      raw.exec('BEGIN');
      try {
        await fn();
        raw.exec('COMMIT');
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    },
    closeSync() {
      raw.close();
    },
  };
}

/** Fresh in-memory database with all migrations applied. One per test. */
export async function makeTestDb(): Promise<TestDb> {
  const raw = new DatabaseSync(':memory:');
  const db = createAdapter(raw);
  // runMigrations only references the SQLiteDatabase *type* (erased at runtime) and
  // calls execAsync, which the adapter implements.
  await runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
  return db;
}
