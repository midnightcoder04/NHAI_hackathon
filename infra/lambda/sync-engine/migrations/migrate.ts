import { readFileSync } from 'fs';
import { join } from 'path';
import { getPool, closePool } from '../src/db';

async function migrate(): Promise<void> {
  const pool = getPool();
  const sql = readFileSync(join(__dirname, '001_initial.sql'), 'utf-8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log('Migration 001_initial applied successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await closePool();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
