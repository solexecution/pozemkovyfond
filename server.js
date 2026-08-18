/**
 * server.js — PZF Data Explorer API
 * Express + DuckDB native Node.js
 * Run: node server.js
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { parseLvText, parseVypisInput } from './lv_parser.js';
import { isLvVypisHtml } from './lv-html.js';
import cors from 'cors';
import { DuckDBInstance } from '@duckdb/node-api';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, 'pzf.duckdb');
const PORT = 3000;

const app = express();
app.use(cors());
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  next();
});
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(__dirname)); // serve index.html etc.

// ── Playwright Headless Browser Manager ──────────────────────────────────────
let playwrightContext = null;

async function getPlaywrightContext() {
  if (!playwrightContext) {
    const userDataDir = path.resolve('./.browser-data');
    playwrightContext = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled'
      ],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 }
    });
  }
  return playwrightContext;
}

/** Fetch official Kataster LV HTML using Playwright Headless Chrome */
async function fetchKatasterLvHtml(lv, ku) {
  const ctx = await getPlaywrightContext();
  const page = await ctx.newPage();
  try {
    const targetUrl = `https://kataster.skgeodesy.sk/Portal45/api/Bo/GeneratePrfPublic?prfNumber=${lv}&cadastralUnitCode=${ku}&outputType=html`;
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    // Wait for actual LV content or reCAPTCHA — avoids a fixed 1.5 s delay on fast loads
    await page.waitForSelector('table, .g-recaptcha', { timeout: 8000 }).catch(() => {});

    const html = await page.content();
    const text = await page.evaluate(() => document.body.innerText || '');
    return { html, text };
  } catch (e) {
    console.warn(`Playwright fetch failed for LV ${lv}:`, e.message);
    return { html: '', text: '' };
  } finally {
    await page.close().catch(() => {});
  }
}

// ── DuckDB Setup ──────────────────────────────────────────────────────────────
let db, conn;

async function initDb() {
  console.log(`Connecting to DuckDB: ${DB_PATH}`);
  db = await DuckDBInstance.create(DB_PATH, {
    threads: '4',
  });
  conn = await db.connect();
  console.log('DuckDB connected.');

  await conn.run(`
    CREATE TABLE IF NOT EXISTS lv_details (
      lv INTEGER,
      cislo_ku INTEGER,
      nazov_ku VARCHAR,
      okres VARCHAR,
      obec VARCHAR,
      pocet_parciel_c INTEGER,
      pocet_parciel_e INTEGER,
      celkova_vymera_m2 DOUBLE,
      pocet_vlastnikov INTEGER,
      fetched_at TIMESTAMP,
      PRIMARY KEY (lv, cislo_ku)
    )
  `);

  await conn.run(`
    CREATE TABLE IF NOT EXISTS lv_parcels (
      id VARCHAR PRIMARY KEY,
      lv INTEGER,
      cislo_ku INTEGER,
      register_type VARCHAR,
      parcel_no VARCHAR,
      vymera_m2 DOUBLE,
      druh_pozemku VARCHAR
    )
  `);

  await conn.run(`
    CREATE TABLE IF NOT EXISTS lv_owners (
      id VARCHAR PRIMARY KEY,
      lv INTEGER,
      cislo_ku INTEGER,
      poradove_cislo INTEGER,
      meno_vlastnika VARCHAR,
      datum_narodenia VARCHAR,
      podiel_str VARCHAR,
      podiel_num BIGINT,
      podiel_den BIGINT,
      podiel_decimal DOUBLE,
      titul_nadobudnutia VARCHAR
    )
  `);
}



async function queryObjects(sql) {
  const result = await conn.run(sql);
  const colNames = result.columnNames();
  const rows = [];
  for (let i = 0; i < result.chunkCount; i++) {
    const chunk = result.getChunk(i);
    const rawRows = chunk.getRows();
    for (const rawRow of rawRows) {
      const obj = {};
      for (let j = 0; j < colNames.length; j++) {
        const val = rawRow[j];
        obj[colNames[j]] = typeof val === 'bigint' ? Number(val) : val;
      }
      rows.push(obj);
    }
  }
  return rows;
}

// ── Helper: serialize BigInt in JSON ─────────────────────────────────────────
function jsonSafe(data) {
  return JSON.parse(JSON.stringify(data, (_, v) =>
    typeof v === 'bigint' ? Number(v) : v
  ));
}

/** GET /api/lv-preview — Proxy official Kataster LV HTML for embedded drawer preview */
app.get('/api/lv-preview', async (req, res) => {
  try {
    const lv = (req.query.lv || '').trim();
    const ku = (req.query.ku || '').trim();
    if (!lv || !ku) return res.status(400).send('<h3>Chýbajúce parametre LV alebo k.ú.</h3>');

    const targetUrl = `https://kataster.skgeodesy.sk/Portal45/api/Bo/GeneratePrfPublic?prfNumber=${encodeURIComponent(lv)}&cadastralUnitCode=${encodeURIComponent(ku)}&outputType=html`;

    let html = '';
    try {
      const response = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'sk-SK,sk;q=0.9,cs;q=0.8,en;q=0.7',
        }
      });
      html = await response.text();
    } catch (_) {}

    if (!isLvVypisHtml(html)) {
      const pwRes = await fetchKatasterLvHtml(lv, ku);
      if (isLvVypisHtml(pwRes.html)) html = pwRes.html;
    }

    if (!isLvVypisHtml(html)) {
      return res.status(502).send('');
    }

    const customStyle = `
      <style>
        body { font-family: Inter, system-ui, sans-serif !important; padding: 15px !important; color: #1e293b !important; background: #fff !important; }
        table { border-collapse: collapse !important; width: 100% !important; margin-bottom: 1rem !important; }
        th, td { border: 1px solid #cbd5e1 !important; padding: 6px 10px !important; font-size: 0.82rem !important; }
        th { background: #f1f5f9 !important; font-weight: 600 !important; }
        b, strong { color: #0f172a !important; }
        h1, h2, h3 { color: #1e3a8a !important; }
      </style>
    `;
    if (html.includes('</head>')) {
      html = html.replace('</head>', `${customStyle}</head>`);
    } else {
      html = customStyle + html;
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    res.status(500).send(`<h3>Chyba pri načítavaní LV: ${e.message}</h3>`);
  }
});

// ── Accent-insensitive helpers ────────────────────────────────────────────────
/** Build a SQL expression that strips Slovak diacritics from a column natively using DuckDB strip_accents */
function normSql(col) {
  return `strip_accents(LOWER(CAST(${col} AS VARCHAR)))`;
}

/** Strip diacritics + lowercase a JS string for LIKE comparison */
function normStr(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/'/g, "''");  // escape SQL quotes
}

/** Build tokenized LIKE conditions so words match in any order (first name / last name) */
function tokenLikeSql(col, str) {
  const toks = normStr(str).split(/\s+/).filter(Boolean);
  if (!toks.length) return '';
  return toks.map(t => `${col} LIKE '%${t}%'`).join(' AND ');
}

/** GET /api/geo-stats — Aggregated counts per cadastral unit / town for map */
app.get('/api/geo-stats', async (req, res) => {
  try {
    const topKu = await queryObjects(`
      SELECT 
        katastralne_uzemie,
        poradove_cislo as cislo_ku,
        COUNT(*) as record_count,
        COUNT(DISTINCT lv) as lv_count
      FROM unknown_owners
      WHERE katastralne_uzemie IS NOT NULL AND katastralne_uzemie != ''
      GROUP BY katastralne_uzemie, poradove_cislo
      ORDER BY record_count DESC
      LIMIT 200
    `);

    res.json(jsonSafe({ topKu }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



/** GET /api/geo-boundaries — Returns official Slovakia municipality & district GeoJSON with DuckDB counts */
let cachedGeoJson = null;
app.get('/api/geo-boundaries', async (req, res) => {
  try {
    if (!cachedGeoJson && fs.existsSync('sk_boundaries.json')) {
      cachedGeoJson = JSON.parse(fs.readFileSync('sk_boundaries.json', 'utf8'));
    }
    if (!cachedGeoJson) {
      return res.status(404).json({ error: 'sk_boundaries.json not found' });
    }

    const rows = await queryObjects(`
      SELECT strip_accents(LOWER(katastralne_uzemie)) as ku_norm, COUNT(*) as cnt
      FROM unknown_owners
      WHERE katastralne_uzemie IS NOT NULL AND katastralne_uzemie != ''
      GROUP BY strip_accents(LOWER(katastralne_uzemie))
    `);

    const countMap = {};
    rows.forEach(r => {
      countMap[r.ku_norm] = Number(r.cnt);
      const simpleName = r.ku_norm.replace(/^(velky|maly|stary|novy|vyssia|nizsia|horny|dolny|vysne|nizne)\s+/i, '');
      if (simpleName !== r.ku_norm) {
        countMap[simpleName] = (countMap[simpleName] || 0) + Number(r.cnt);
      }
    });

    const features = cachedGeoJson.features.map(f => {
      const nameNorm = (f.properties.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const cnt = countMap[nameNorm] || 0;
      return {
        type: f.type,
        geometry: f.geometry,
        properties: {
          ...f.properties,
          record_count: cnt
        }
      };
    });

    res.json({
      type: 'FeatureCollection',
      features
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/stats', async (req, res) => {
  try {
    const rows = await queryObjects(`
      SELECT
        (SELECT COUNT(*)                          FROM unknown_owners)     AS total_unknown_owners,
        (SELECT COUNT(DISTINCT katastralne_uzemie) FROM unknown_owners)    AS unique_katastralne,
        (SELECT COUNT(DISTINCT lv)                FROM unknown_owners)     AS unique_lv_uo,
        (SELECT COUNT(DISTINCT meno_vlastnika)     FROM unknown_owners)    AS unique_names,
        (SELECT COUNT(*)                          FROM transferred_rights) AS total_transferred,
        (SELECT COUNT(DISTINCT lv)                FROM transferred_rights) AS unique_lv_tr,
        (SELECT COUNT(DISTINCT nazov_ku)          FROM transferred_rights) AS unique_ku_tr,
        (SELECT COUNT(*)                          FROM v_overlap)          AS overlap_count
    `);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/top-katastralne?limit=20 — top cadastral areas by owner count */
app.get('/api/top-katastralne', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const rows = await queryObjects(`
      SELECT katastralne_uzemie, poradove_cislo, owner_count, unique_lv_count
      FROM v_top_katastralne
      LIMIT ${limit}
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/transferred-by-year — year-over-year transfer stats */
app.get('/api/transferred-by-year', async (req, res) => {
  try {
    const rows = await queryObjects(`SELECT * FROM v_transferred_by_year`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/transferred-top-ku?limit=20 — top cadastral areas in transferred rights */
app.get('/api/transferred-top-ku', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const rows = await queryObjects(`
      SELECT * FROM v_transferred_top_ku LIMIT ${limit}
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/overlap?limit=50 — LV overlap between datasets */
app.get('/api/overlap', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const rows = await queryObjects(`
      SELECT * FROM v_overlap LIMIT ${limit}
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/alpha-distribution — letter distribution of cadastral areas */
app.get('/api/alpha-distribution', async (req, res) => {
  try {
    const rows = await queryObjects(`SELECT * FROM v_alpha_distribution`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/owners — search with instant pre-normalized columns & sorting */
app.get('/api/owners', async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = (page - 1) * limit;

    const q      = normStr(req.query.q || '');
    const fKu    = normStr(req.query.f_ku || '');
    const fName  = normStr(req.query.f_name || '');
    const fCislo = (req.query.f_cislo || '').trim().replace(/'/g, "''");
    const fLv    = (req.query.f_lv || '').trim().replace(/'/g, "''");

    const ALLOWED = {
      katastralne_uzemie: 'katastralne_uzemie',
      poradove_cislo:     'poradove_cislo',
      lv:                 'lv',
      meno_vlastnika:     'meno_vlastnika',
    };
    const sortCol = ALLOWED[req.query.sort_col] || 'katastralne_uzemie';
    const sortDir = req.query.sort_dir === 'DESC' ? 'DESC' : 'ASC';

    const conds = [];
    const qPred = tokenLikeSql('meno_norm', req.query.q);
    const fKuPred = tokenLikeSql('ku_norm', req.query.f_ku);
    const fNamePred = tokenLikeSql('meno_norm', req.query.f_name);
    if (qPred)     conds.push(qPred);
    if (fKuPred)   conds.push(fKuPred);
    if (fCislo)    conds.push(`CAST(poradove_cislo AS VARCHAR) LIKE '%${fCislo}%'`);
    if (fLv)       conds.push(`CAST(lv AS VARCHAR) LIKE '%${fLv}%'`);
    if (fNamePred) conds.push(fNamePred);

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const [cntRow, rows] = await Promise.all([
      queryObjects(`SELECT COUNT(*) as cnt FROM unknown_owners ${where}`),
      queryObjects(`
        SELECT id, katastralne_uzemie, poradove_cislo, lv, meno_vlastnika
        FROM unknown_owners ${where}
        ORDER BY ${sortCol} ${sortDir}
        LIMIT ${limit} OFFSET ${offset}
      `),
    ]);

    res.json({ total: cntRow[0].cnt, page, limit, rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/transferred — search with instant pre-normalized columns & sorting */
app.get('/api/transferred', async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = (page - 1) * limit;

    const fLv     = (req.query.f_lv || '').trim().replace(/'/g, "''");
    const fCislo  = (req.query.f_cislo || '').trim().replace(/'/g, "''");
    const fDatum  = (req.query.f_datum || '').trim().replace(/'/g, "''");
    const fYear   = parseInt(req.query.f_year) || null;

    const ALLOWED = {
      year:            'year',
      lv:              'lv',
      vlastnik_lv:     'vlastnik_lv',
      cislo_ku:        'cislo_ku',
      nazov_ku:        'nazov_ku',
      datum_ucinnosti: 'datum_ucinnosti',
    };
    const sortCol = ALLOWED[req.query.sort_col] || 'year';
    const sortDir = req.query.sort_dir === 'ASC' ? 'ASC' : 'DESC';

    const conds = [];
    const qPred = tokenLikeSql('vlastnik_norm', req.query.q);
    const fVlastPred = tokenLikeSql('vlastnik_norm', req.query.f_vlast || req.query.f_vast);
    const fKuPred = tokenLikeSql('ku_norm', req.query.f_ku);
    if (qPred)      conds.push(qPred);
    if (fVlastPred) conds.push(fVlastPred);
    if (fKuPred)    conds.push(fKuPred);
    if (fLv)        conds.push(`CAST(lv AS VARCHAR) LIKE '%${fLv}%'`);
    if (fCislo)     conds.push(`CAST(cislo_ku AS VARCHAR) LIKE '%${fCislo}%'`);
    if (fDatum)     conds.push(`datum_ucinnosti LIKE '%${fDatum}%'`);
    if (fYear)      conds.push(`year = ${fYear}`);

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const [cntRow, rows] = await Promise.all([
      queryObjects(`SELECT COUNT(*) as cnt FROM transferred_rights ${where}`),
      queryObjects(`
        SELECT id, lv, vlastnik_lv, cislo_ku, nazov_ku, crz, datum_ucinnosti, year
        FROM transferred_rights ${where}
        ORDER BY ${sortCol} ${sortDir}
        LIMIT ${limit} OFFSET ${offset}
      `),
    ]);

    res.json({ total: cntRow[0].cnt, page, limit, rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
/** GET /api/all-unique-transferred-lvs — Return ALL unique (lv, cislo_ku) pairs for given filters (no pagination) */
app.get('/api/all-unique-transferred-lvs', async (req, res) => {
  try {
    const fLv     = (req.query.f_lv || '').trim().replace(/'/g, "''");
    const fCislo  = (req.query.f_cislo || '').trim().replace(/'/g, "''");
    const fDatum  = (req.query.f_datum || '').trim().replace(/'/g, "''");
    const fYear   = parseInt(req.query.f_year) || null;

    const conds = [];
    const qPred = tokenLikeSql('vlastnik_norm', req.query.q);
    const fVlastPred = tokenLikeSql('vlastnik_norm', req.query.f_vlast || req.query.f_vast);
    const fKuPred = tokenLikeSql('ku_norm', req.query.f_ku);
    if (qPred)      conds.push(qPred);
    if (fVlastPred) conds.push(fVlastPred);
    if (fKuPred)    conds.push(fKuPred);
    if (fLv)        conds.push(`CAST(lv AS VARCHAR) LIKE '%${fLv}%'`);
    if (fCislo)     conds.push(`CAST(cislo_ku AS VARCHAR) LIKE '%${fCislo}%'`);
    if (fDatum)     conds.push(`datum_ucinnosti LIKE '%${fDatum}%'`);
    if (fYear)      conds.push(`year = ${fYear}`);

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const rows = await queryObjects(`
      SELECT DISTINCT lv, cislo_ku, nazov_ku
      FROM transferred_rights ${where}
      ORDER BY nazov_ku, lv
    `);

    const lvs = rows.map(r => ({ lv: r.lv, ku: r.cislo_ku, kuName: r.nazov_ku }));
    res.json({ count: lvs.length, lvs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


app.get('/api/correlations', async (req, res) => {
  try {
    // Find cadastral areas appearing in both datasets with counts
    const bothDatasets = await queryObjects(`
      WITH uo_agg AS (
        SELECT poradove_cislo, katastralne_uzemie, COUNT(*) AS unknown_count
        FROM unknown_owners
        GROUP BY poradove_cislo, katastralne_uzemie
      ),
      tr_agg AS (
        SELECT cislo_ku, COUNT(*) AS transferred_count
        FROM transferred_rights
        GROUP BY cislo_ku
      )
      SELECT
        u.katastralne_uzemie,
        u.poradove_cislo,
        u.unknown_count,
        t.transferred_count,
        ROUND(t.transferred_count::DOUBLE / u.unknown_count::DOUBLE * 100, 2) AS transfer_rate_pct
      FROM uo_agg u
      JOIN tr_agg t ON u.poradove_cislo = t.cislo_ku
      WHERE u.unknown_count >= 5
      ORDER BY transfer_rate_pct DESC
      LIMIT 30
    `);

    // Year trend by k.u.
    const yearByKu = await queryObjects(`
      SELECT
        year,
        nazov_ku,
        COUNT(*) AS count
      FROM transferred_rights
      GROUP BY year, nazov_ku
      ORDER BY year, count DESC
    `);

    // LV number range distribution for unknown owners
    const lvBuckets = await queryObjects(`
      SELECT
        (lv / 500) * 500        AS lv_bucket_start,
        (lv / 500) * 500 + 499  AS lv_bucket_end,
        COUNT(*)                AS count
      FROM unknown_owners
      WHERE lv IS NOT NULL AND lv > 0
      GROUP BY lv / 500
      ORDER BY lv_bucket_start
      LIMIT 50
    `);

    // SPF vs non-SPF in transferred rights
    const spfAnalysis = await queryObjects(`
      SELECT
        year,
        SUM(CASE WHEN vlastnik_lv ILIKE '%(SPF)%' THEN 1 ELSE 0 END) AS spf_count,
        SUM(CASE WHEN vlastnik_lv NOT ILIKE '%(SPF)%' THEN 1 ELSE 0 END) AS non_spf_count,
        COUNT(*) AS total
      FROM transferred_rights
      GROUP BY year
      ORDER BY year
    `);

    res.json({ bothDatasets, yearByKu, lvBuckets, spfAnalysis });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



/** GET /api/custom-query — run a custom SQL query (SELECT only) */
app.post('/api/custom-query', async (req, res) => {
  try {
    const { sql } = req.body;
    if (!sql) return res.status(400).json({ error: 'No SQL provided' });
    // Safety: only allow SELECT
    const trimmed = sql.trim().toUpperCase();
    if (!trimmed.startsWith('SELECT') && !trimmed.startsWith('WITH')) {
      return res.status(403).json({ error: 'Only SELECT queries are allowed' });
    }
    const rows = await queryObjects(sql);
    res.json(jsonSafe({ rows, count: rows.length }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/save-lv-data — Receive browser-fetched LV text, parse, and store into DuckDB */
app.post('/api/save-lv-data', async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'Array of {lv, ku, text} required' });
    }

    let savedDocs = 0;
    let savedParcels = 0;
    let savedOwners = 0;

    for (const item of items) {
      const lv = parseInt(item.lv, 10);
      const ku = parseInt(item.ku, 10);
      const text = item.text || '';
      if (!lv || !ku || !text || text.length < 200) continue;

      const parsed = parseVypisInput(text, lv, ku);
      const doc = parsed.doc;

      // Save document summary
      await queryObjects(`
        INSERT OR REPLACE INTO lv_details (lv, cislo_ku, nazov_ku, okres, obec, pocet_parciel_c, pocet_parciel_e, celkova_vymera_m2, pocet_vlastnikov, fetched_at)
        VALUES (${doc.lv}, ${doc.cislo_ku}, '${(doc.nazov_ku || item.kuName || '').replace(/'/g,"''")}', '${(doc.okres || '').replace(/'/g,"''")}', '${(doc.obec || '').replace(/'/g,"''")}', ${doc.pocet_parciel_c}, ${doc.pocet_parciel_e}, ${doc.celkova_vymera_m2}, ${doc.pocet_vlastnikov}, CURRENT_TIMESTAMP)
      `);
      savedDocs++;

      // Save parcels
      for (const p of parsed.parcels) {
        const pId = `${doc.cislo_ku}_${doc.lv}_${p.register_type}_${p.parcel_no}`.replace(/[\/\s]/g, '_');
        await queryObjects(`
          INSERT OR REPLACE INTO lv_parcels (id, lv, cislo_ku, register_type, parcel_no, vymera_m2, druh_pozemku)
          VALUES ('${pId.replace(/'/g,"''")}', ${doc.lv}, ${doc.cislo_ku}, '${p.register_type}', '${p.parcel_no.replace(/'/g,"''")}', ${p.vymera_m2}, '${(p.druh_pozemku || '').replace(/'/g,"''")}')
        `);
        savedParcels++;
      }

      // Save owners
      for (const o of parsed.owners) {
        const oId = `${doc.cislo_ku}_${doc.lv}_${o.poradove_cislo}`;
        await queryObjects(`
          INSERT OR REPLACE INTO lv_owners (id, lv, cislo_ku, poradove_cislo, meno_vlastnika, datum_narodenia, podiel_str, podiel_num, podiel_den, podiel_decimal, titul_nadobudnutia)
          VALUES ('${oId}', ${doc.lv}, ${doc.cislo_ku}, ${o.poradove_cislo}, '${o.meno_vlastnika.replace(/'/g,"''")}', '${o.datum_narodenia.replace(/'/g,"''")}', '${o.podiel_str}', ${o.podiel_num}, ${o.podiel_den}, ${o.podiel_decimal}, '${(o.titul_nadobudnutia || '').replace(/'/g,"''")}')
        `);
        savedOwners++;
      }
    }

    res.json({ success: true, savedDocs, savedParcels, savedOwners });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



function buildTokenWhere(col, searchName) {
  const tokens = normStr(searchName).split(/\s+/).filter(Boolean);
  if (!tokens.length) return '1=1';
  return tokens.map(t => `${normSql(col)} LIKE '%${t}%'`).join(' AND ');
}

/** GET /api/all-unique-lvs — Return ALL unique (lv, poradove_cislo) pairs for given filters (no pagination) */
app.get('/api/all-unique-lvs', async (req, res) => {
  try {
    const fCislo = (req.query.f_cislo || '').trim().replace(/'/g, "''");
    const fLv    = (req.query.f_lv || '').trim().replace(/'/g, "''");

    const conds = [];
    const qPred = tokenLikeSql('meno_norm', req.query.q);
    const fKuPred = tokenLikeSql('ku_norm', req.query.f_ku);
    const fNamePred = tokenLikeSql('meno_norm', req.query.f_name);
    if (qPred)     conds.push(qPred);
    if (fKuPred)   conds.push(fKuPred);
    if (fCislo)    conds.push(`CAST(poradove_cislo AS VARCHAR) LIKE '%${fCislo}%'`);
    if (fLv)       conds.push(`CAST(lv AS VARCHAR) LIKE '%${fLv}%'`);
    if (fNamePred) conds.push(fNamePred);

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const rows = await queryObjects(`
      SELECT DISTINCT lv, poradove_cislo, katastralne_uzemie
      FROM unknown_owners ${where}
      ORDER BY katastralne_uzemie, lv
    `);

    const lvs = rows.map(r => ({ lv: r.lv, ku: r.poradove_cislo, kuName: r.katastralne_uzemie }));
    res.json({ count: lvs.length, lvs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/lv-analysis — Run correlation & m2 ownership analysis across stored LVs */
app.get('/api/lv-analysis', async (req, res) => {
  try {
    const searchName = (req.query.name || '').trim();

    // Total stored LVs matching search name (multi-token accent insensitive)
    const lvBreakdown = await queryObjects(`
      SELECT 
        o.lv, 
        o.cislo_ku, 
        d.nazov_ku, 
        d.celkova_vymera_m2, 
        d.pocet_parciel_c + d.pocet_parciel_e AS total_parcels,
        d.pocet_vlastnikov,
        o.poradove_cislo,
        o.meno_vlastnika,
        o.podiel_str,
        o.podiel_decimal,
        ROUND(d.celkova_vymera_m2 * o.podiel_decimal, 2) AS owned_m2,
        o.titul_nadobudnutia
      FROM lv_owners o
      JOIN lv_details d ON o.lv = d.lv AND o.cislo_ku = d.cislo_ku
      WHERE ${buildTokenWhere('o.meno_vlastnika', searchName)}
      ORDER BY owned_m2 DESC
    `);

    // Total m2 owned across all stored LVs
    const totalOwnedM2 = lvBreakdown.reduce((sum, r) => sum + (r.owned_m2 || 0), 0);

    // Land type breakdown
    const landTypeBreakdown = await queryObjects(`
      SELECT 
        p.druh_pozemku,
        COUNT(DISTINCT p.id) AS parcel_count,
        ROUND(SUM(p.vymera_m2), 0) AS total_type_m2
      FROM lv_owners o
      JOIN lv_parcels p ON o.lv = p.lv AND o.cislo_ku = p.cislo_ku
      WHERE ${buildTokenWhere('o.meno_vlastnika', searchName)}
      GROUP BY p.druh_pozemku
      ORDER BY total_type_m2 DESC
    `);

    // Co-owners / Relatives sharing LVs
    const coOwners = await queryObjects(`
      SELECT 
        o2.meno_vlastnika,
        COUNT(DISTINCT o2.lv) AS shared_lvs_count,
        MAX(o2.datum_narodenia) AS datum_narodenia
      FROM lv_owners o1
      JOIN lv_owners o2 ON o1.lv = o2.lv AND o1.cislo_ku = o2.cislo_ku
      WHERE ${buildTokenWhere('o1.meno_vlastnika', searchName)}
        AND NOT (${buildTokenWhere('o2.meno_vlastnika', searchName)})
      GROUP BY o2.meno_vlastnika
      ORDER BY shared_lvs_count DESC, o2.meno_vlastnika
      LIMIT 25
    `);

    res.json(jsonSafe({
      searchName,
      storedLvCount: lvBreakdown.length,
      totalOwnedM2,
      totalOwnedHa: (totalOwnedM2 / 10000).toFixed(4),
      lvBreakdown,
      landTypeBreakdown,
      coOwners
    }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/swap-analysis — Land swap & consolidation engine across stored LVs */
app.get('/api/swap-analysis', async (req, res) => {
  try {
    const kuQuery = (req.query.ku || '').trim();
    const nameQuery = (req.query.name || '').trim();

    let kuWhere = '1=1';
    if (kuQuery) {
      if (/^\d+$/.test(kuQuery)) {
        kuWhere = `d.cislo_ku = ${parseInt(kuQuery, 10)}`;
      } else {
        kuWhere = `(d.nazov_ku ILIKE '%${kuQuery.replace(/'/g, "''")}%' OR d.obec ILIKE '%${kuQuery.replace(/'/g, "''")}%')`;
      }
    }

    const allOwners = await queryObjects(`
      SELECT
        o.cislo_ku,
        d.nazov_ku,
        d.obec,
        d.okres,
        d.celkova_vymera_m2,
        o.lv,
        o.poradove_cislo,
        o.meno_vlastnika,
        o.datum_narodenia,
        o.podiel_str,
        o.podiel_decimal,
        ROUND(d.celkova_vymera_m2 * o.podiel_decimal, 2) AS owned_m2,
        o.titul_nadobudnutia
      FROM lv_owners o
      JOIN lv_details d ON o.lv = d.lv AND o.cislo_ku = d.cislo_ku
      WHERE ${kuWhere}
      ORDER BY d.nazov_ku, o.meno_vlastnika, o.lv
    `);

    const allParcels = await queryObjects(`
      SELECT p.cislo_ku, p.lv, p.register_type, p.parcel_no, p.vymera_m2, p.druh_pozemku
      FROM lv_parcels p
      JOIN lv_details d ON p.lv = d.lv AND p.cislo_ku = d.cislo_ku
      WHERE ${kuWhere}
      ORDER BY p.cislo_ku, p.lv, p.vymera_m2 DESC
    `);

    const allLvs = await queryObjects(`
      SELECT d.lv, d.cislo_ku, d.nazov_ku, d.obec, d.okres, d.celkova_vymera_m2,
             d.pocet_parciel_c, d.pocet_parciel_e, d.pocet_vlastnikov
      FROM lv_details d
      WHERE ${kuWhere}
      ORDER BY d.nazov_ku, d.lv
    `);

    const lvMap = new Map();
    allLvs.forEach((l) => {
      lvMap.set(`${l.cislo_ku}:${l.lv}`, { ...l, owners: [], parcels: [] });
    });

    allParcels.forEach((p) => {
      const key = `${p.cislo_ku}:${p.lv}`;
      if (lvMap.has(key)) lvMap.get(key).parcels.push(p);
    });

    const ownerMap = new Map();
    allOwners.forEach((o) => {
      const lvKey = `${o.cislo_ku}:${o.lv}`;
      if (lvMap.has(lvKey)) lvMap.get(lvKey).owners.push(o);

      const normKey = String(o.meno_vlastnika || '').toLowerCase().trim();
      if (!ownerMap.has(normKey)) {
        ownerMap.set(normKey, {
          name: o.meno_vlastnika,
          dob: o.datum_narodenia,
          total_owned_m2: 0,
          holdings: [],
        });
      }
      const rec = ownerMap.get(normKey);
      rec.total_owned_m2 += o.owned_m2 || 0;
      rec.holdings.push({
        lv: o.lv,
        cislo_ku: o.cislo_ku,
        nazov_ku: o.nazov_ku,
        podiel_str: o.podiel_str,
        podiel_decimal: o.podiel_decimal,
        owned_m2: o.owned_m2,
        total_m2: o.celkova_vymera_m2,
      });
    });

    const ownersList = Array.from(ownerMap.values()).map((o) => ({
      ...o,
      total_owned_m2: Math.round(o.total_owned_m2 * 100) / 100,
      total_owned_ha: Math.round((o.total_owned_m2 / 10000) * 10000) / 10000,
    })).sort((a, b) => b.total_owned_m2 - a.total_owned_m2);

    // 1. Bilateral Swaps
    const swapOpportunities = [];
    const ownerKeys = Array.from(ownerMap.keys());

    for (let i = 0; i < ownerKeys.length; i++) {
      for (let j = i + 1; j < ownerKeys.length; j++) {
        const oA = ownerMap.get(ownerKeys[i]);
        const oB = ownerMap.get(ownerKeys[j]);

        for (const hA of oA.holdings) {
          for (const hB of oB.holdings) {
            if (hA.cislo_ku !== hB.cislo_ku || hA.lv === hB.lv) continue;

            const m2A = hA.owned_m2;
            const m2B = hB.owned_m2;
            if (m2A <= 0 || m2B <= 0) continue;

            const diffM2 = Math.round(Math.abs(m2A - m2B) * 100) / 100;
            const maxM2 = Math.max(m2A, m2B);
            const diffPct = maxM2 > 0 ? (diffM2 / maxM2) : 1;

            if (diffPct <= 0.40) {
              const score = Math.round((1 - diffPct) * 100);
              swapOpportunities.push({
                ownerA: oA.name,
                ownerB: oB.name,
                ku: hA.nazov_ku,
                cislo_ku: hA.cislo_ku,
                tradeAtoB: { lv: hA.lv, share: hA.podiel_str, m2: m2A },
                tradeBtoA: { lv: hB.lv, share: hB.podiel_str, m2: m2B },
                diffM2,
                cashEqualizationEur: Math.round(diffM2 * 1.0),
                paysCash: m2A > m2B ? oB.name : (m2B > m2A ? oA.name : null),
                score,
              });
            }
          }
        }
      }
    }
    swapOpportunities.sort((a, b) => b.score - a.score || a.diffM2 - b.diffM2);

    // 2. Buyout targets
    const buyoutTargets = [];
    lvMap.forEach((lvDoc) => {
      if (!lvDoc.owners.length) return;
      const sortedOwners = [...lvDoc.owners].sort((a, b) => b.podiel_decimal - a.podiel_decimal);
      const topOwner = sortedOwners[0];
      const topSharePct = Math.round(topOwner.podiel_decimal * 1000) / 10;

      if (topSharePct >= 20 && sortedOwners.length > 1) {
        const minorities = sortedOwners.slice(1).map((m) => ({
          name: m.meno_vlastnika,
          poradove_cislo: m.poradove_cislo,
          share: m.podiel_str,
          m2: m.owned_m2,
          estEur: Math.round(m.owned_m2 * 1.0),
        }));
        const remainingM2 = Math.round(minorities.reduce((s, m) => s + m.m2, 0) * 100) / 100;
        buyoutTargets.push({
          lv: lvDoc.lv,
          cislo_ku: lvDoc.cislo_ku,
          nazov_ku: lvDoc.nazov_ku,
          total_m2: lvDoc.celkova_vymera_m2,
          topOwner: topOwner.meno_vlastnika,
          topShareStr: topOwner.podiel_str,
          topSharePct,
          topOwnedM2: topOwner.owned_m2,
          remainingM2,
          totalBuyoutEstEur: Math.round(remainingM2 * 1.0),
          minorities,
        });
      }
    });
    buyoutTargets.sort((a, b) => b.topSharePct - a.topSharePct);

    // 3. Subdivision candidates
    const subdivisionCandidates = [];
    allParcels.forEach((p) => {
      if (p.vymera_m2 < 2000) return;
      const lvDoc = lvMap.get(`${p.cislo_ku}:${p.lv}`);
      if (!lvDoc) return;
      lvDoc.owners.forEach((o) => {
        const shareM2 = Math.round(p.vymera_m2 * o.podiel_decimal * 100) / 100;
        if (shareM2 >= 2000) {
          subdivisionCandidates.push({
            lv: p.lv,
            cislo_ku: p.cislo_ku,
            nazov_ku: lvDoc.nazov_ku,
            parcel_no: p.parcel_no,
            register_type: p.register_type,
            druh_pozemku: p.druh_pozemku,
            total_parcel_m2: p.vymera_m2,
            owner: o.meno_vlastnika,
            share: o.podiel_str,
            shareM2,
            minParcelLimitM2: 2000,
            feasible: true,
          });
        }
      });
    });
    subdivisionCandidates.sort((a, b) => b.shareM2 - a.shareM2);

    res.json(jsonSafe({
      kuQuery,
      nameQuery,
      storedLvCount: allLvs.length,
      storedOwnersCount: ownersList.length,
      lvs: allLvs,
      owners: ownersList,
      swapOpportunities: swapOpportunities.slice(0, 50),
      buyoutTargets: buyoutTargets.slice(0, 50),
      subdivisionCandidates: subdivisionCandidates.slice(0, 50),
    }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start Server ──────────────────────────────────────────────────────────────
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🚀 PZF Data Explorer running at http://localhost:${PORT}\n`);
  });
}).catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
