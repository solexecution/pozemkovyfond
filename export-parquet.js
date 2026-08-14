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

  console.log('\nExporting parquet + search indexes...');

  await conn.run(`
    COPY (
      SELECT id, katastralne_uzemie, poradove_cislo, lv, meno_vlastnika, meno_norm, ku_norm
      FROM unknown_owners
      ORDER BY meno_norm, ku_norm, lv
    ) TO '${OUT_DIR}/unknown_owners.parquet'
    (FORMAT PARQUET, COMPRESSION ZSTD, COMPRESSION_LEVEL 22, ROW_GROUP_SIZE 150000)
  `);
  console.log(`unknown_owners.parquet  ${mb(path.join(__dirname, 'data', 'unknown_owners.parquet'))} MB`);

  await conn.run(`
    COPY (
      SELECT
        split_part(meno_norm, ' ', 1) AS token,
        COUNT(*) AS recs,
        COUNT(DISTINCT meno_vlastnika) AS names,
        COUNT(DISTINCT katastralne_uzemie) AS places,
        COUNT(DISTINCT lv) AS lvs
      FROM unknown_owners
      WHERE meno_norm IS NOT NULL AND length(split_part(meno_norm, ' ', 1)) >= 2
      GROUP BY 1
    ) TO '${OUT_DIR}/surnames.parquet'
    (FORMAT PARQUET, COMPRESSION ZSTD, COMPRESSION_LEVEL 22)
  `);
  console.log(`surnames.parquet  ${mb(path.join(__dirname, 'data', 'surnames.parquet'))} MB`);

  await conn.run(`
    COPY (
      SELECT
        katastralne_uzemie,
        poradove_cislo,
        ANY_VALUE(ku_norm) AS ku_norm,
        COUNT(*) AS recs,
        COUNT(DISTINCT meno_vlastnika) AS names,
        COUNT(DISTINCT lv) AS lvs
      FROM unknown_owners
      GROUP BY katastralne_uzemie, poradove_cislo
    ) TO '${OUT_DIR}/places_agg.parquet'
    (FORMAT PARQUET, COMPRESSION ZSTD, COMPRESSION_LEVEL 9)
  `);
  console.log(`places_agg.parquet  ${mb(path.join(__dirname, 'data', 'places_agg.parquet'))} MB`);

  await conn.run(`
    COPY (
      SELECT token, katastralne_uzemie, poradove_cislo, recs, names, lvs
      FROM (
        SELECT
          unnest(regexp_split_to_array(ku_norm, '[\s,;./-]+')) AS token,
          katastralne_uzemie, poradove_cislo, recs, names, lvs
        FROM read_parquet('${OUT_DIR}/places_agg.parquet')
      )
      WHERE token IS NOT NULL AND length(token) >= 2
    ) TO '${OUT_DIR}/place_tokens.parquet'
    (FORMAT PARQUET, COMPRESSION ZSTD, COMPRESSION_LEVEL 9)
  `);
  console.log(`place_tokens.parquet  ${mb(path.join(__dirname, 'data', 'place_tokens.parquet'))} MB`);

  const stats = await queryRows(conn, `
    SELECT
      (SELECT COUNT(*) FROM unknown_owners) AS total_unknown_owners,
      (SELECT COUNT(DISTINCT katastralne_uzemie) FROM unknown_owners) AS unique_katastralne,
      (SELECT COUNT(DISTINCT lv) FROM unknown_owners) AS unique_lv_uo,
      (SELECT COUNT(DISTINCT meno_vlastnika) FROM unknown_owners) AS unique_names,
      (SELECT COUNT(*) FROM transferred_rights) AS total_transferred,
      (SELECT COUNT(DISTINCT lv) FROM transferred_rights) AS unique_lv_tr,
      (SELECT COUNT(DISTINCT nazov_ku) FROM transferred_rights) AS unique_ku_tr,
      (SELECT COUNT(*) FROM (
        SELECT 1 FROM unknown_owners uo
        JOIN transferred_rights tr ON uo.lv = tr.lv AND uo.poradove_cislo = tr.cislo_ku
        GROUP BY uo.lv, uo.poradove_cislo
      )) AS overlap_count
  `);
  const statsObj = {};
  const statRow = stats[0] || [];
  const statKeys = ['total_unknown_owners','unique_katastralne','unique_lv_uo','unique_names','total_transferred','unique_lv_tr','unique_ku_tr','overlap_count'];
  statKeys.forEach((k, i) => { statsObj[k] = Number(statRow[i]); });
  const { writeFileSync } = await import('fs');
  writeFileSync(path.join(__dirname, 'data', 'stats.json'), JSON.stringify(statsObj));
  console.log('stats.json', statsObj);

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
