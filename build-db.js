/**
 * build-db.js
 * Ingests all PZF CSV and XLSX files into a DuckDB database (pzf.duckdb)
 * Run: node build-db.js
 */

import { DuckDBInstance } from '@duckdb/node-api';
import XLSX from 'xlsx';
import { existsSync, unlinkSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_PATH = path.join(__dirname, 'pzf.duckdb');
const DATA_DIR = __dirname;

// CSV files (UTF-8 with BOM, semicolon-delimited)
const CSV_FILES = [
  'A_G-Nezisteni-vlastnici-k-30.06.2026.csv',
  'H_J-Nezisteni-vlastnici-k-30.06.2026.csv',
  'K_L-Nezisteni-vlastnici-k-30.06.2026.csv',
  'M_O-Nezisteni-vlastnici-k-30.06.2026.csv',
  'P_R-Nezisteni-vlastnici-k-30.06.2026.csv',
  'S_U-Nezisteni-vlastnici-k-30.06.2026.csv',
  'V_Z-Nezisteni-vlastnici-k-30.06.2026.csv',
];

// XLSX files
const XLSX_FILES = [
  { file: 'NVDatumUcinn2022.xlsx', year: 2022 },
  { file: 'Nezisteni-vlastnici_prevedene-pravo_2023.xlsx', year: 2023 },
  { file: 'Nezisteni-vlastnici_prevedene-pravo_2024.xlsx', year: 2024 },
  { file: 'Nezisteni-vlastnici_prevedene-pravo_2025.xlsx', year: 2025 },
];

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/** Helper: execute SQL query and get first row as array */
async function queryRow(conn, sql) {
  const res = await conn.run(sql);
  if (res.rowCount === 0) return [];
  const chunk = res.getChunk(0);
  const rows = chunk.getRows();
  return rows[0];
}

/** Helper: execute SQL query and get all rows */
async function queryRows(conn, sql) {
  const res = await conn.run(sql);
  const result = [];
  for (let i = 0; i < res.chunkCount; i++) {
    const chunk = res.getChunk(i);
    result.push(...chunk.getRows());
  }
  return result;
}

async function buildDatabase() {
  // Remove old DB if exists
  if (existsSync(DB_PATH)) {
    log('Removing old database...');
    unlinkSync(DB_PATH);
  }

  log('Opening DuckDB...');
  const instance = await DuckDBInstance.create(DB_PATH, {
    threads: '4',
    memory_limit: '4GB',
  });
  const conn = await instance.connect();

  // ── Create Tables ──────────────────────────────────────────────────────────
  log('Creating tables...');

  await conn.run(`
    CREATE TABLE IF NOT EXISTS unknown_owners (
      id                 BIGINT,
      katastralne_uzemie VARCHAR,
      poradove_cislo     BIGINT,
      lv                 BIGINT,
      meno_vlastnika     VARCHAR,
      source_file        VARCHAR
    )
  `);

  await conn.run(`
    CREATE TABLE IF NOT EXISTS transferred_rights (
      id              BIGINT,
      lv              BIGINT,
      vlastnik_lv     VARCHAR,
      cislo_ku        BIGINT,
      nazov_ku        VARCHAR,
      crz             VARCHAR,
      datum_ucinnosti VARCHAR,
      year            INTEGER
    )
  `);

  // ── Load CSVs via DuckDB's native CSV reader ───────────────────────────────
  log('Loading CSV files via DuckDB native reader...');
  let rowId = 1;

  for (const csvFile of CSV_FILES) {
    const csvPath = path.join(DATA_DIR, csvFile).replace(/\\/g, '/');
    log(`  Loading ${csvFile}...`);
    const before = (await queryRow(conn, 'SELECT COUNT(*) FROM unknown_owners'))[0];

    await conn.run(`
      INSERT INTO unknown_owners
      SELECT
        (ROW_NUMBER() OVER ()) + ${Number(before)} as id,
        "KATASTRÁLNE ÚZEMIE"::VARCHAR        as katastralne_uzemie,
        "PORADOVÉ ČÍSLO"::BIGINT             as poradove_cislo,
        "LV"::BIGINT                         as lv,
        "MENO NEZNÁMEHO VLASTNÍKA"::VARCHAR  as meno_vlastnika,
        '${csvFile}'                         as source_file
      FROM read_csv(
        '${csvPath}',
        delim         = ';',
        header        = true,
        encoding      = 'utf-8',
        ignore_errors = true,
        columns       = {
          'KATASTRÁLNE ÚZEMIE':        'VARCHAR',
          'PORADOVÉ ČÍSLO':            'BIGINT',
          'LV':                        'BIGINT',
          'MENO NEZNÁMEHO VLASTNÍKA':  'VARCHAR'
        },
        nullstr       = ''
      )
    `);

    const after = (await queryRow(conn, 'SELECT COUNT(*) FROM unknown_owners'))[0];
    const added = Number(after) - Number(before);
    log(`    → ${added.toLocaleString()} rows loaded`);
  }

  const totalCsv = (await queryRow(conn, 'SELECT COUNT(*) FROM unknown_owners'))[0];
  log(`Total CSV rows: ${Number(totalCsv).toLocaleString()}`);

  // ── Load XLSX files ────────────────────────────────────────────────────────
  log('Loading XLSX files...');
  let totalXlsxRows = 0;
  let xlsxId = 1;

  const allXlsxRows = [];

  for (const { file, year } of XLSX_FILES) {
    const xlsxPath = path.join(DATA_DIR, file);
    log(`  Reading ${file} (year=${year})...`);

    const workbook = XLSX.readFile(xlsxPath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

    // Skip header row (index 0)
    for (let i = 1; i < rows.length; i++) {
      const [lv, vlastnik, cisloKu, nazovKu, crz, datumUcinnosti] = rows[i];
      allXlsxRows.push([
        xlsxId++,
        lv !== null && lv !== undefined ? BigInt(Math.round(Number(lv))) : null,
        vlastnik ? String(vlastnik) : null,
        cisloKu !== null && cisloKu !== undefined ? BigInt(Math.round(Number(cisloKu))) : null,
        nazovKu ? String(nazovKu) : null,
        crz ? String(crz) : null,
        datumUcinnosti ? String(datumUcinnosti) : null,
        year,
      ]);
    }
    log(`    → ${rows.length - 1} rows from ${file}`);
    totalXlsxRows += rows.length - 1;
  }

  // Batch insert XLSX rows in chunks of 1000 rows using VALUES
  log(`Inserting ${totalXlsxRows.toLocaleString()} XLSX rows...`);
  const BATCH_SIZE = 1000;
  let inserted = 0;

  for (let i = 0; i < allXlsxRows.length; i += BATCH_SIZE) {
    const batch = allXlsxRows.slice(i, i + BATCH_SIZE);
    const valueClauses = batch.map(row => {
      const [id, lv, vlastnik, cisloKu, nazovKu, crz, datum, year] = row;
      const esc = v => v === null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
      const num = v => v === null ? 'NULL' : String(v).replace(/n$/, '');
      return `(${num(id)}, ${num(lv)}, ${esc(vlastnik)}, ${num(cisloKu)}, ${esc(nazovKu)}, ${esc(crz)}, ${esc(datum)}, ${year})`;
    });
    await conn.run(`INSERT INTO transferred_rights VALUES ${valueClauses.join(',')}`);
    inserted += batch.length;
  }
  log(`XLSX rows inserted: ${inserted.toLocaleString()}`);

  // ── Create Indexes ─────────────────────────────────────────────────────────
  log('Creating indexes...');
  await conn.run(`CREATE INDEX idx_uo_lv  ON unknown_owners(lv)`);
  await conn.run(`CREATE INDEX idx_uo_ku  ON unknown_owners(poradove_cislo)`);
  await conn.run(`CREATE INDEX idx_uo_name ON unknown_owners(meno_vlastnika)`);
  await conn.run(`CREATE INDEX idx_tr_lv  ON transferred_rights(lv)`);
  await conn.run(`CREATE INDEX idx_tr_ku  ON transferred_rights(cislo_ku)`);
  log('Indexes created.');

  // ── Create Summary Views ───────────────────────────────────────────────────
  log('Creating summary views...');

  await conn.run(`
    CREATE OR REPLACE VIEW v_top_katastralne AS
    SELECT
      katastralne_uzemie,
      poradove_cislo,
      COUNT(*)              AS owner_count,
      COUNT(DISTINCT lv)    AS unique_lv_count
    FROM unknown_owners
    GROUP BY katastralne_uzemie, poradove_cislo
    ORDER BY owner_count DESC
  `);

  await conn.run(`
    CREATE OR REPLACE VIEW v_transferred_by_year AS
    SELECT
      year,
      COUNT(*)                 AS transfer_count,
      COUNT(DISTINCT lv)       AS unique_lv,
      COUNT(DISTINCT cislo_ku) AS unique_ku
    FROM transferred_rights
    GROUP BY year
    ORDER BY year
  `);

  await conn.run(`
    CREATE OR REPLACE VIEW v_overlap AS
    SELECT
      uo.lv,
      uo.katastralne_uzemie,
      uo.poradove_cislo,
      COUNT(DISTINCT uo.id)  AS unknown_owner_count,
      COUNT(DISTINCT tr.id)  AS transferred_count,
      tr.nazov_ku
    FROM unknown_owners uo
    JOIN transferred_rights tr
      ON uo.lv = tr.lv
      AND uo.poradove_cislo = tr.cislo_ku
    GROUP BY uo.lv, uo.katastralne_uzemie, uo.poradove_cislo, tr.nazov_ku
    ORDER BY unknown_owner_count DESC
  `);

  await conn.run(`
    CREATE OR REPLACE VIEW v_transferred_top_ku AS
    SELECT
      nazov_ku,
      cislo_ku,
      COUNT(*)             AS transfer_count,
      COUNT(DISTINCT year) AS years_active,
      MIN(year)            AS first_year,
      MAX(year)            AS last_year
    FROM transferred_rights
    GROUP BY nazov_ku, cislo_ku
    ORDER BY transfer_count DESC
  `);

  // Alphabet distribution view
  await conn.run(`
    CREATE OR REPLACE VIEW v_alpha_distribution AS
    SELECT
      LEFT(katastralne_uzemie, 1) AS first_letter,
      COUNT(*)                    AS owner_count,
      COUNT(DISTINCT katastralne_uzemie) AS ku_count
    FROM unknown_owners
    WHERE katastralne_uzemie IS NOT NULL
    GROUP BY LEFT(katastralne_uzemie, 1)
    ORDER BY first_letter
  `);

  log('Views created.');

  // ── Verify ─────────────────────────────────────────────────────────────────
  log('Verifying database...');

  const totalUO   = (await queryRow(conn, 'SELECT COUNT(*) FROM unknown_owners'))[0];
  const uniqueKU  = (await queryRow(conn, 'SELECT COUNT(DISTINCT katastralne_uzemie) FROM unknown_owners'))[0];
  const totalTR   = (await queryRow(conn, 'SELECT COUNT(*) FROM transferred_rights'))[0];
  const overlapCt = (await queryRow(conn, 'SELECT COUNT(*) FROM v_overlap'))[0];

  log(`  total_unknown_owners  : ${Number(totalUO).toLocaleString()}`);
  log(`  unique_katastralne    : ${Number(uniqueKU).toLocaleString()}`);
  log(`  total_transferred     : ${Number(totalTR).toLocaleString()}`);
  log(`  overlap_lv_count      : ${Number(overlapCt).toLocaleString()}`);

  log(`✅ Database built successfully: ${DB_PATH}`);
}

buildDatabase().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
