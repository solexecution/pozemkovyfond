/**
 * Export compact Parquet files for DuckDB WASM / GitHub Pages.
 */
import { DuckDBInstance } from '@duckdb/node-api';
import path from 'path';
import { mkdirSync, existsSync, statSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'pzf.duckdb');
const OUT_DIR = path.join(__dirname, 'data').replace(/\\/g, '/');

function mb(file) {
  return (statSync(file).size / 1024 / 1024).toFixed(2);
}

async function queryRows(conn, sql) {
  const res = await conn.run(sql);
  const rows = [];
  for (let i = 0; i < res.chunkCount; i++) {
    rows.push(...res.getChunk(i).getRows());
  }
  return rows;
}

async function main() {
  mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  const db = await DuckDBInstance.create(DB_PATH, { threads: '4', memory_limit: '4GB' });
  const conn = await db.connect();

  const tables = await queryRows(conn, `
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'main' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  console.log('Tables:', tables.map(r => r[0]).join(', '));

  for (const [t] of tables) {
    const [cnt] = (await queryRows(conn, `SELECT COUNT(*) FROM ${t}`))[0];
    const cols = await queryRows(conn, `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${t}' ORDER BY ordinal_position`);
    console.log(`\n${t}: ${Number(cnt).toLocaleString()} rows`);
    for (const [c, typ] of cols) console.log(`  - ${c} ${typ}`);
  }

  console.log('\nExporting parquet...');

  await conn.run(`
    COPY (
      SELECT id, katastralne_uzemie, poradove_cislo, lv, meno_vlastnika, meno_norm, ku_norm
      FROM unknown_owners
    ) TO '${OUT_DIR}/unknown_owners.parquet'
    (FORMAT PARQUET, COMPRESSION ZSTD, COMPRESSION_LEVEL 9, ROW_GROUP_SIZE 200000)
  `);
  console.log(`unknown_owners.parquet  ${mb(path.join(__dirname, 'data', 'unknown_owners.parquet'))} MB`);

  await conn.run(`
    COPY (
      SELECT id, lv, vlastnik_lv, cislo_ku, nazov_ku, crz, datum_ucinnosti, year, vlastnik_norm, ku_norm
      FROM transferred_rights
    ) TO '${OUT_DIR}/transferred_rights.parquet'
    (FORMAT PARQUET, COMPRESSION ZSTD, COMPRESSION_LEVEL 9)
  `);
  console.log(`transferred_rights.parquet  ${mb(path.join(__dirname, 'data', 'transferred_rights.parquet'))} MB`);

  for (const t of ['lv_details', 'lv_parcels', 'lv_owners']) {
    try {
      const [cnt] = (await queryRows(conn, `SELECT COUNT(*) FROM ${t}`))[0];
      if (Number(cnt) > 0) {
        await conn.run(`
          COPY ${t} TO '${OUT_DIR}/${t}.parquet'
          (FORMAT PARQUET, COMPRESSION ZSTD, COMPRESSION_LEVEL 9)
        `);
        console.log(`${t}.parquet  ${mb(path.join(__dirname, 'data', `${t}.parquet`))} MB  (${Number(cnt)} rows)`);
      } else {
        console.log(`${t}: empty, skip`);
      }
    } catch (e) {
      console.log(`${t}: ${e.message}`);
    }
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
