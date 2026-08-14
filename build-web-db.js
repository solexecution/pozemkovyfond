/**
 * Build a slim, ready-to-open DuckDB file for the GitHub Pages app.
 * Output: data/pzf.duckdb  (+ data/pzf.duckdb.gz)
 */
import { DuckDBInstance } from '@duckdb/node-api';
import { createReadStream, createWriteStream, existsSync, statSync, unlinkSync } from 'fs';
import { createGzip } from 'zlib';
import { pipeline } from 'stream/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, 'pzf.duckdb');
const OUT = path.join(__dirname, 'data', 'pzf.duckdb');
const OUT_GZ = path.join(__dirname, 'data', 'pzf.duckdb.gz');

function mb(file) {
  return (statSync(file).size / 1024 / 1024).toFixed(2);
}

async function queryRow(conn, sql) {
  const res = await conn.run(sql);
  if (!res.chunkCount) return [];
  return res.getChunk(0).getRows()[0];
}

async function main() {
  if (existsSync(OUT)) unlinkSync(OUT);
  if (existsSync(OUT + '.wal')) unlinkSync(OUT + '.wal');

  const src = await DuckDBInstance.create(SRC, { threads: '4', memory_limit: '4GB' });
  const conn = await src.connect();

  const outPath = OUT.replace(/\\/g, '/');
  await conn.run(`ATTACH '${outPath}' AS web`);

  console.log('Copying slim tables into web db...');
  await conn.run(`
    CREATE TABLE web.unknown_owners AS
    SELECT id, katastralne_uzemie, poradove_cislo, lv, meno_vlastnika, meno_norm, ku_norm
    FROM unknown_owners
    ORDER BY meno_norm, ku_norm, lv
  `);
  await conn.run(`
    CREATE TABLE web.transferred_rights AS
    SELECT id, lv, vlastnik_lv, cislo_ku, nazov_ku, crz, datum_ucinnosti, year, vlastnik_norm, ku_norm
    FROM transferred_rights
  `);
  await conn.run(`
    CREATE TABLE web.surnames AS
    SELECT split_part(meno_norm, ' ', 1) AS token,
           COUNT(*) AS recs,
           COUNT(DISTINCT meno_vlastnika) AS names,
           COUNT(DISTINCT katastralne_uzemie) AS places,
           COUNT(DISTINCT lv) AS lvs
    FROM unknown_owners
    WHERE meno_norm IS NOT NULL AND length(split_part(meno_norm, ' ', 1)) >= 2
    GROUP BY 1
  `);
  await conn.run(`
    CREATE TABLE web.places_agg AS
    SELECT katastralne_uzemie, poradove_cislo, ANY_VALUE(ku_norm) AS ku_norm,
           COUNT(*) AS recs, COUNT(DISTINCT meno_vlastnika) AS names, COUNT(DISTINCT lv) AS lvs
    FROM unknown_owners
    GROUP BY katastralne_uzemie, poradove_cislo
  `);
  await conn.run(`
    CREATE TABLE web.lv_co AS
    SELECT poradove_cislo, lv, COUNT(DISTINCT meno_vlastnika) AS names_on_lv
    FROM unknown_owners
    GROUP BY 1, 2
  `);
  await conn.run(`CREATE TABLE web.lv_details AS SELECT * FROM lv_details`);
  await conn.run(`CREATE TABLE web.lv_parcels AS SELECT * FROM lv_parcels`);
  await conn.run(`CREATE TABLE web.lv_owners AS SELECT * FROM lv_owners`);

  console.log('Indexes...');
  await conn.run(`CREATE INDEX idx_uo_meno ON web.unknown_owners(meno_norm)`);
  await conn.run(`CREATE INDEX idx_surnames ON web.surnames(token)`);
  await conn.run(`CREATE INDEX idx_places ON web.places_agg(ku_norm)`);
  await conn.run(`CREATE INDEX idx_lv_co ON web.lv_co(poradove_cislo, lv)`);

  await conn.run(`CHECKPOINT web`);
  await conn.run(`DETACH web`);

  console.log(`pzf.duckdb  ${mb(OUT)} MB`);

  console.log('Gzipping...');
  await pipeline(createReadStream(OUT), createGzip({ level: 9 }), createWriteStream(OUT_GZ));
  console.log(`pzf.duckdb.gz  ${mb(OUT_GZ)} MB`);

  const n = await queryRow(conn, `SELECT COUNT(*) FROM unknown_owners`);
  console.log('source unknown_owners', Number(n[0]));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
