/**
 * optimize-db.js — Add pre-normalized search columns to DuckDB
 * Pre-computes strip_accents(LOWER(...)) so searches execute in ~20ms instead of 500ms+
 */
import { DuckDBInstance } from '@duckdb/node-api';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'pzf.duckdb');

async function main() {
  console.log(`⚡ Optimizing DuckDB database: ${DB_PATH}`);
  const db = await DuckDBInstance.create(DB_PATH);
  const conn = await db.connect();

  console.time('1. Optimize unknown_owners');
  await conn.run(`ALTER TABLE unknown_owners ADD COLUMN IF NOT EXISTS meno_norm VARCHAR;`);
  await conn.run(`ALTER TABLE unknown_owners ADD COLUMN IF NOT EXISTS ku_norm VARCHAR;`);
  await conn.run(`UPDATE unknown_owners SET meno_norm = strip_accents(LOWER(meno_vlastnika)), ku_norm = strip_accents(LOWER(katastralne_uzemie)) WHERE meno_norm IS NULL OR ku_norm IS NULL;`);
  console.timeEnd('1. Optimize unknown_owners');

  console.time('2. Optimize transferred_rights');
  await conn.run(`ALTER TABLE transferred_rights ADD COLUMN IF NOT EXISTS vlastnik_norm VARCHAR;`);
  await conn.run(`ALTER TABLE transferred_rights ADD COLUMN IF NOT EXISTS ku_norm VARCHAR;`);
  await conn.run(`UPDATE transferred_rights SET vlastnik_norm = strip_accents(LOWER(vlastnik_lv)), ku_norm = strip_accents(LOWER(nazov_ku)) WHERE vlastnik_norm IS NULL OR ku_norm IS NULL;`);
  console.timeEnd('2. Optimize transferred_rights');

  console.log('Checkpointing WAL...');
  await conn.run('CHECKPOINT');
  console.log('✅ Optimization complete! Database searches are now ultra-fast.');
}

main().catch(err => {
  console.error('❌ Optimization failed:', err);
  process.exit(1);
});
