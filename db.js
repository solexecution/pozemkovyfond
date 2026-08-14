/**
 * DuckDB WASM client — replaces the Express API for static GitHub Pages.
 */
import * as duckdb from 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.32.0/+esm';
import { parseLvText } from './lv_parser.js';

const DATA_CACHE = 'pzf-data-v5';

let db = null;
let conn = null;
let ready = false;
let geoJsonCache = null;
let cachedStats = null;

function dataUrl(name) {
  return new URL(`data/${name}`, window.location.href).href;
}

function assetUrl(name) {
  return new URL(name, window.location.href).href;
}

function setStatus(text, kind = 'loading') {
  const dot = document.getElementById('db-dot');
  const el = document.getElementById('db-status-text');
  if (el) el.textContent = text;
  if (dot) {
    dot.className = kind === 'ok' ? 'db-dot online' : 'db-dot loading';
    if (kind === 'error') {
      dot.className = 'db-dot';
      dot.style.background = '#ef4444';
    }
  }
  const bootMsg = document.getElementById('boot-msg');
  if (bootMsg) bootMsg.textContent = text;
}

function setProgress(pct) {
  const fill = document.getElementById('boot-bar-fill');
  const label = document.getElementById('boot-pct');
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  if (fill) fill.style.width = `${clamped}%`;
  if (label) label.textContent = `${clamped} %`;
}

function hideBoot() {
  const overlay = document.getElementById('boot-overlay');
  if (overlay) {
    overlay.classList.add('hidden');
    setTimeout(() => overlay.remove(), 400);
  }
}

async function fetchBuffer(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Nepodarilo sa stiahnuť ${url} (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress?.(1);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total) onProgress?.(received / total);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  onProgress?.(1);
  return out;
}

async function openDataCache() {
  try {
    if (typeof caches !== 'undefined') return await caches.open(DATA_CACHE);
  } catch (_) { /* private mode / insecure */ }
  return null;
}

async function fetchCachedBuffer(url, onProgress, label) {
  const cache = await openDataCache();
  if (cache) {
    const hit = await cache.match(url);
    if (hit) {
      setStatus(`Z cache: ${label}`);
      const buf = new Uint8Array(await hit.arrayBuffer());
      onProgress?.(1);
      return buf;
    }
  }
  const buf = await fetchBuffer(url, onProgress);
  if (cache) {
    try {
      await cache.put(url, new Response(buf, {
        headers: { 'Content-Type': 'application/octet-stream' },
      }));
    } catch (e) {
      console.warn('Cache write failed', e);
    }
  }
  return buf;
}

function toObjects(table) {
  const rows = table.toArray().map((row) => (typeof row.toJSON === 'function' ? row.toJSON() : { ...row }));
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      const val = row[key];
      if (typeof val === 'bigint') row[key] = Number(val);
    }
  }
  return rows;
}

export async function queryObjects(sql) {
  if (!conn) throw new Error('DuckDB ešte nie je pripravená');
  const table = await conn.query(sql);
  return toObjects(table);
}

async function queryRun(sql) {
  if (!conn) throw new Error('DuckDB ešte nie je pripravená');
  await conn.query(sql);
}

function normStr(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/'/g, "''");
}

function escSql(s) {
  return String(s ?? '').replace(/'/g, "''");
}

function normSql(col) {
  return `strip_accents(LOWER(CAST(${col} AS VARCHAR)))`;
}

function buildTokenWhere(col, searchName) {
  const tokens = normStr(searchName).split(/\s+/).filter(Boolean);
  if (!tokens.length) return '1=1';
  return tokens.map((t) => `${normSql(col)} LIKE '%${t}%'`).join(' AND ');
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    throw err;
  }
}

async function registerParquet(filename, label, weightStart, weightEnd) {
  setStatus(`Načítavam ${label}...`);
  const buf = await fetchCachedBuffer(dataUrl(filename), (p) => {
    setProgress(weightStart + (weightEnd - weightStart) * p);
  }, label);
  const bytes = buf.byteLength;
  await db.registerFileBuffer(filename, buf);
  return bytes;
}

function nextPrefix(s) {
  if (!s) return s;
  const last = s.charCodeAt(s.length - 1);
  return s.slice(0, -1) + String.fromCharCode(last + 1);
}

function prefixPred(col, token) {
  return `(${col} >= '${token}' AND ${col} < '${nextPrefix(token)}')`;
}

export async function initDb() {
  if (ready) return;

  setStatus('Inicializujem DuckDB WASM...');
  setProgress(2);

  const bundles = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(bundles);
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' })
  );
  const worker = new Worker(workerUrl);
  db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  conn = await db.connect();
  setProgress(8);

  try {
    const statsRes = await fetch(dataUrl('stats.json'));
    if (statsRes.ok) cachedStats = await statsRes.json();
  } catch (_) {}

  await registerParquet('places_agg.parquet', 'obce', 8, 12);
  await registerParquet('surnames.parquet', 'index mien', 12, 16);
  await registerParquet('lv_co.parquet', 'hustota LV', 16, 20);
  await registerParquet('unknown_owners.parquet', 'register (cache po 1. načítaní)', 20, 78);
  await registerParquet('transferred_rights.parquet', 'prevedené práva', 78, 84);
  await registerParquet('lv_details.parquet', 'uložené LV', 84, 86);
  await registerParquet('lv_owners.parquet', 'vlastníkov LV', 86, 88);
  await registerParquet('lv_parcels.parquet', 'parcely LV', 88, 90);

  setStatus('Pripravujem tabuľky...');
  await queryRun(`CREATE OR REPLACE VIEW unknown_owners AS SELECT * FROM read_parquet('unknown_owners.parquet')`);
  await queryRun(`CREATE OR REPLACE VIEW transferred_rights AS SELECT * FROM read_parquet('transferred_rights.parquet')`);
  await queryRun(`CREATE OR REPLACE TABLE places_agg AS SELECT * FROM read_parquet('places_agg.parquet')`);
  await queryRun(`CREATE OR REPLACE TABLE surnames AS SELECT * FROM read_parquet('surnames.parquet')`);
  await queryRun(`CREATE OR REPLACE TABLE lv_co AS SELECT * FROM read_parquet('lv_co.parquet')`);
  try {
    await queryRun(`CREATE INDEX idx_surnames_token ON surnames(token)`);
    await queryRun(`CREATE INDEX idx_places_ku ON places_agg(ku_norm)`);
    await queryRun(`CREATE INDEX idx_lv_co ON lv_co(poradove_cislo, lv)`);
  } catch (_) { /* older wasm may skip */ }

  await queryRun(`
    CREATE TABLE lv_details (
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
  await queryRun(`INSERT OR REPLACE INTO lv_details SELECT * FROM read_parquet('lv_details.parquet')`);

  await queryRun(`
    CREATE TABLE lv_parcels (
      id VARCHAR PRIMARY KEY,
      lv INTEGER,
      cislo_ku INTEGER,
      register_type VARCHAR,
      parcel_no VARCHAR,
      vymera_m2 DOUBLE,
      druh_pozemku VARCHAR
    )
  `);
  await queryRun(`INSERT OR REPLACE INTO lv_parcels SELECT * FROM read_parquet('lv_parcels.parquet')`);

  await queryRun(`
    CREATE TABLE lv_owners (
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
  await queryRun(`INSERT OR REPLACE INTO lv_owners SELECT * FROM read_parquet('lv_owners.parquet')`);

  await queryRun(`
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
  await queryRun(`
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
  await queryRun(`
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
  await queryRun(`
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
  await queryRun(`
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

  ready = true;
  setProgress(100);
  setStatus('DuckDB WASM · pripravené', 'ok');
  hideBoot();
}

async function stats() {
  if (cachedStats) return cachedStats;
  try {
    const res = await fetch(dataUrl('stats.json'));
    if (res.ok) {
      cachedStats = await res.json();
      return cachedStats;
    }
  } catch (_) {}
  const rows = await queryObjects(`
    SELECT
      (SELECT COUNT(*) FROM unknown_owners) AS total_unknown_owners,
      (SELECT COUNT(DISTINCT katastralne_uzemie) FROM unknown_owners) AS unique_katastralne,
      (SELECT COUNT(DISTINCT lv) FROM unknown_owners) AS unique_lv_uo,
      (SELECT COUNT(DISTINCT meno_vlastnika) FROM unknown_owners) AS unique_names,
      (SELECT COUNT(*) FROM transferred_rights) AS total_transferred,
      (SELECT COUNT(DISTINCT lv) FROM transferred_rights) AS unique_lv_tr,
      (SELECT COUNT(DISTINCT nazov_ku) FROM transferred_rights) AS unique_ku_tr,
      1533 AS overlap_count
  `);
  cachedStats = rows[0];
  return cachedStats;
}

function bothWhere(q) {
  const tokens = normStr(q).split(/\s+/).filter((t) => t.length >= 2);
  if (!tokens.length) return '';
  const first = tokens[0];
  const rest = tokens.slice(1);
  const nameFast = [prefixPred('meno_norm', first), ...rest.map((t) => `contains(meno_norm, '${t}')`)].join(' AND ');
  const placePred = tokens.map((t) => `contains(ku_norm, '${t}')`).join(' AND ');
  return `((${nameFast}) OR (${placePred}))`;
}

async function overviewSearch(q) {
  const raw = (q.q || '').trim();
  if (raw.length < 2) {
    return { total: 0, unique_names: 0, unique_places: 0, unique_lv: 0, names: [], places: [], rows: [], lvs: [], page: 1, limit: 50 };
  }
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const limit = Math.min(parseInt(q.limit, 10) || 50, 200);
  const offset = (page - 1) * limit;
  const fName = (q.f_name || '').trim();
  const fKu = normStr(q.f_ku || '');
  const tokens = normStr(raw).split(/\s+/).filter((t) => t.length >= 2);
  const first = tokens[0] || normStr(raw);

  const places = await queryObjects(`
    SELECT katastralne_uzemie, poradove_cislo, recs, names, lvs
    FROM places_agg
    WHERE ${prefixPred('ku_norm', first)}
       ${tokens.slice(1).map((t) => `AND contains(ku_norm, '${t}')`).join(' ')}
    ORDER BY recs DESC
    LIMIT 40
  `);

  const surname = (await queryObjects(`
    SELECT
      COALESCE(SUM(recs), 0) AS total,
      COALESCE(SUM(names), 0) AS unique_names,
      COALESCE(SUM(places), 0) AS unique_places,
      COALESCE(SUM(lvs), 0) AS unique_lv
    FROM surnames
    WHERE ${prefixPred('token', first)}
  `))[0] || { total: 0, unique_names: 0, unique_places: 0, unique_lv: 0 };

  const nameConds = [prefixPred('meno_norm', first)];
  tokens.slice(1).forEach((t) => nameConds.push(`contains(meno_norm, '${t}')`));
  if (fName) nameConds.push(`meno_vlastnika = '${escSql(fName)}'`);
  if (fKu) nameConds.push(`contains(ku_norm, '${fKu}')`);
  const where = `WHERE ${nameConds.join(' AND ')}`;

  const names = await queryObjects(`
    WITH mine AS (
      SELECT u.meno_vlastnika, u.katastralne_uzemie, u.poradove_cislo, u.lv,
             COALESCE(c.names_on_lv, 1) AS names_on_lv
      FROM unknown_owners u
      LEFT JOIN lv_co c
        ON u.poradove_cislo = c.poradove_cislo AND u.lv = c.lv
      ${where}
    ),
    by_ku AS (
      SELECT
        meno_vlastnika,
        katastralne_uzemie,
        ANY_VALUE(poradove_cislo) AS poradove_cislo,
        COUNT(*) AS recs,
        COUNT(DISTINCT lv) AS lvs,
        SUM(CASE WHEN names_on_lv <= 1 THEN 1 ELSE 0 END) AS solo_lvs,
        AVG(names_on_lv) AS avg_co,
        SUM(1.0 / GREATEST(names_on_lv, 1)) AS portion
      FROM mine
      GROUP BY meno_vlastnika, katastralne_uzemie
    ),
    tot AS (
      SELECT meno_vlastnika,
             SUM(recs) AS recs, SUM(lvs) AS lvs, COUNT(*) AS districts,
             SUM(solo_lvs) AS solo_lvs, SUM(portion) AS portion, AVG(avg_co) AS avg_co
      FROM by_ku
      GROUP BY meno_vlastnika
    ),
    topku AS (
      SELECT meno_vlastnika, katastralne_uzemie, poradove_cislo, recs, lvs, solo_lvs, portion
      FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY meno_vlastnika ORDER BY recs DESC, lvs DESC) AS rn
        FROM by_ku
      )
      WHERE rn = 1
    )
    SELECT
      t.meno_vlastnika,
      t.recs, t.lvs, t.districts, t.solo_lvs,
      ROUND(t.portion, 2) AS portion,
      ROUND(t.avg_co, 1) AS avg_co,
      k.katastralne_uzemie AS top_ku,
      k.poradove_cislo AS top_ku_code,
      k.recs AS top_ku_recs,
      k.lvs AS top_ku_lvs,
      k.solo_lvs AS top_ku_solo,
      ROUND(k.portion, 2) AS top_ku_portion,
      ROUND(100.0 * k.recs / NULLIF(t.recs, 0), 0) AS top_ku_pct
    FROM tot t
    JOIN topku k ON t.meno_vlastnika = k.meno_vlastnika
    ORDER BY t.portion DESC, t.recs DESC
    LIMIT 40
  `);

  const rows = await queryObjects(`
    SELECT id, katastralne_uzemie, poradove_cislo, lv, meno_vlastnika
    FROM unknown_owners ${where}
    ORDER BY meno_norm
    LIMIT ${limit} OFFSET ${offset}
  `);

  const lvs = rows
    .filter((r) => r.lv && r.poradove_cislo)
    .map((r) => ({ lv: r.lv, ku: r.poradove_cislo, kuName: r.katastralne_uzemie }));

  const placeRecs = places.reduce((s, p) => s + Number(p.recs || 0), 0);
  return {
    total: Math.max(Number(surname.total || 0), placeRecs, rows.length),
    unique_names: Number(surname.unique_names || names.length),
    unique_places: Math.max(Number(surname.unique_places || 0), places.length),
    unique_lv: Number(surname.unique_lv || 0),
    names,
    places,
    rows,
    lvs,
    page,
    limit,
  };
}

function parseNameList(q) {
  if (q.names) {
    try {
      const parsed = JSON.parse(q.names);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch (_) { /* ignore */ }
  }
  if (q.name) return [String(q.name)];
  return [];
}

function sqlNameIn(list) {
  return list.map((n) => `'${escSql(n)}'`).join(', ');
}

async function nameDistricts(q) {
  const list = parseNameList(q);
  if (!list.length) return { name: '', rows: [] };
  const rows = await queryObjects(`
    WITH mine AS (
      SELECT u.katastralne_uzemie, u.poradove_cislo, u.lv,
             COALESCE(c.names_on_lv, 1) AS names_on_lv
      FROM unknown_owners u
      LEFT JOIN lv_co c
        ON u.poradove_cislo = c.poradove_cislo AND u.lv = c.lv
      WHERE u.meno_vlastnika IN (${sqlNameIn(list)})
    )
    SELECT
      katastralne_uzemie,
      ANY_VALUE(poradove_cislo) AS poradove_cislo,
      COUNT(*) AS recs,
      COUNT(DISTINCT lv) AS lvs,
      SUM(CASE WHEN names_on_lv <= 1 THEN 1 ELSE 0 END) AS solo_lvs,
      ROUND(AVG(names_on_lv), 1) AS avg_co,
      ROUND(SUM(1.0 / GREATEST(names_on_lv, 1)), 2) AS portion
    FROM mine
    GROUP BY katastralne_uzemie
    ORDER BY portion DESC, recs DESC
  `);
  return { name: list[0], rows };
}

async function nameKuDetail(q) {
  const list = parseNameList(q);
  const name = list[0] || (q.name || '').trim();
  const ku = (q.ku || '').trim();
  if (!list.length || !ku) return { error: 'name and ku required' };

  const lvs = await queryObjects(`
    WITH mine AS (
      SELECT u.lv, u.poradove_cislo, u.katastralne_uzemie,
             COALESCE(c.names_on_lv, 1) AS names_on_lv
      FROM unknown_owners u
      LEFT JOIN lv_co c
        ON u.poradove_cislo = c.poradove_cislo AND u.lv = c.lv
      WHERE u.meno_vlastnika IN (${sqlNameIn(list)})
        AND u.katastralne_uzemie = '${escSql(ku)}'
    )
    SELECT
      lv,
      ANY_VALUE(poradove_cislo) AS cislo_ku,
      ANY_VALUE(katastralne_uzemie) AS ku_name,
      ANY_VALUE(names_on_lv) AS names_on_lv,
      CASE WHEN ANY_VALUE(names_on_lv) <= 1 THEN 1 ELSE 0 END AS solo
    FROM mine
    GROUP BY lv
    ORDER BY solo DESC, names_on_lv ASC, lv
  `);

  const summary = {
    name,
    ku,
    recs: 0,
    lvs: lvs.length,
    solo_lvs: lvs.filter((r) => r.solo).length,
    portion: 0,
    avg_co: 0,
    cislo_ku: lvs[0]?.cislo_ku || null,
  };
  if (lvs.length) {
    const portions = lvs.map((r) => 1 / Math.max(Number(r.names_on_lv) || 1, 1));
    summary.portion = Math.round(portions.reduce((a, b) => a + b, 0) * 100) / 100;
    summary.avg_co = Math.round((lvs.reduce((a, r) => a + Number(r.names_on_lv || 1), 0) / lvs.length) * 10) / 10;
    summary.recs = lvs.length;
  }

  let transferred = [];
  if (summary.cislo_ku && lvs.length) {
    const lvList = lvs.map((r) => Number(r.lv)).filter(Boolean).slice(0, 400).join(',');
    if (lvList) {
      transferred = await queryObjects(`
        SELECT year, lv, vlastnik_lv, cislo_ku, nazov_ku, datum_ucinnosti, crz
        FROM transferred_rights
        WHERE cislo_ku = ${Number(summary.cislo_ku)}
          AND lv IN (${lvList})
        ORDER BY year DESC, lv
        LIMIT 50
      `);
    }
  }

  let coowners = [];
  if (summary.cislo_ku && lvs.length) {
    const lvList = lvs.map((r) => Number(r.lv)).filter(Boolean).slice(0, 400).join(',');
    if (lvList) {
      coowners = await queryObjects(`
        SELECT meno_vlastnika,
               COUNT(DISTINCT lv) AS shared_lvs
        FROM unknown_owners
        WHERE poradove_cislo = ${Number(summary.cislo_ku)}
          AND lv IN (${lvList})
          AND meno_vlastnika NOT IN (${sqlNameIn(list)})
        GROUP BY meno_vlastnika
        ORDER BY shared_lvs DESC, meno_vlastnika
        LIMIT 25
      `);
    }
  }

  return { summary, lvs, transferred, coowners };
}

async function owners(q) {
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const limit = Math.min(parseInt(q.limit, 10) || 50, 200);
  const offset = (page - 1) * limit;
  const search = normStr(q.q || '');
  const fKu = normStr(q.f_ku || '');
  const fName = normStr(q.f_name || '');
  const fCislo = (q.f_cislo || '').trim().replace(/'/g, "''");
  const fLv = (q.f_lv || '').trim().replace(/'/g, "''");

  const ALLOWED = {
    katastralne_uzemie: 'katastralne_uzemie',
    poradove_cislo: 'poradove_cislo',
    lv: 'lv',
    meno_vlastnika: 'meno_vlastnika',
  };
  const sortCol = ALLOWED[q.sort_col] || 'katastralne_uzemie';
  const sortDir = q.sort_dir === 'DESC' ? 'DESC' : 'ASC';

  const conds = [];
  if (search) conds.push(prefixPred('meno_norm', search));
  if (fKu) conds.push(`contains(ku_norm, '${fKu}')`);
  if (fCislo) conds.push(`CAST(poradove_cislo AS VARCHAR) LIKE '%${fCislo}%'`);
  if (fLv) conds.push(`CAST(lv AS VARCHAR) LIKE '%${fLv}%'`);
  if (fName) conds.push(prefixPred('meno_norm', fName));
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const countToken = fName || search;
  let total;
  if (countToken && !fKu && !fCislo && !fLv) {
    const est = await queryObjects(`SELECT COALESCE(SUM(recs), 0) AS cnt FROM surnames WHERE ${prefixPred('token', countToken)}`);
    total = est[0].cnt;
  } else if (!where) {
    total = cachedStats?.total_unknown_owners ?? 0;
  } else {
    const cntRow = await queryObjects(`SELECT COUNT(*) as cnt FROM unknown_owners ${where}`);
    total = cntRow[0].cnt;
  }

  const order = (search || fName) && sortCol === 'meno_vlastnika'
    ? 'meno_norm'
    : `${sortCol} ${sortDir}`;
  const rows = await queryObjects(`
    SELECT id, katastralne_uzemie, poradove_cislo, lv, meno_vlastnika
    FROM unknown_owners ${where}
    ORDER BY ${order}
    LIMIT ${limit} OFFSET ${offset}
  `);
  return { total, page, limit, rows };
}

async function transferred(q) {
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const limit = Math.min(parseInt(q.limit, 10) || 50, 200);
  const offset = (page - 1) * limit;
  const search = normStr(q.q || '');
  const fVlast = normStr(q.f_vlast || q.f_vast || '');
  const fKu = normStr(q.f_ku || '');
  const fLv = (q.f_lv || '').trim().replace(/'/g, "''");
  const fCislo = (q.f_cislo || '').trim().replace(/'/g, "''");
  const fDatum = (q.f_datum || '').trim().replace(/'/g, "''");
  const fYear = parseInt(q.f_year, 10) || null;

  const ALLOWED = {
    year: 'year',
    lv: 'lv',
    vlastnik_lv: 'vlastnik_lv',
    cislo_ku: 'cislo_ku',
    nazov_ku: 'nazov_ku',
    datum_ucinnosti: 'datum_ucinnosti',
  };
  const sortCol = ALLOWED[q.sort_col] || 'year';
  const sortDir = q.sort_dir === 'ASC' ? 'ASC' : 'DESC';

  const conds = [];
  if (search) conds.push(`vlastnik_norm LIKE '%${search}%'`);
  if (fVlast) conds.push(`vlastnik_norm LIKE '%${fVlast}%'`);
  if (fKu) conds.push(`ku_norm LIKE '%${fKu}%'`);
  if (fLv) conds.push(`CAST(lv AS VARCHAR) LIKE '%${fLv}%'`);
  if (fCislo) conds.push(`CAST(cislo_ku AS VARCHAR) LIKE '%${fCislo}%'`);
  if (fDatum) conds.push(`datum_ucinnosti LIKE '%${fDatum}%'`);
  if (fYear) conds.push(`year = ${fYear}`);
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
  return { total: cntRow[0].cnt, page, limit, rows };
}

async function allUniqueLvs(q) {
  const search = normStr(q.q || '');
  const fKu = normStr(q.f_ku || '');
  const fName = normStr(q.f_name || '');
  const fCislo = (q.f_cislo || '').trim().replace(/'/g, "''");
  const fLv = (q.f_lv || '').trim().replace(/'/g, "''");
  const conds = [];
  if (search) conds.push(`meno_norm LIKE '%${search}%'`);
  if (fKu) conds.push(`ku_norm LIKE '%${fKu}%'`);
  if (fCislo) conds.push(`CAST(poradove_cislo AS VARCHAR) LIKE '%${fCislo}%'`);
  if (fLv) conds.push(`CAST(lv AS VARCHAR) LIKE '%${fLv}%'`);
  if (fName) conds.push(`meno_norm LIKE '%${fName}%'`);
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const rows = await queryObjects(`
    SELECT DISTINCT lv, poradove_cislo, katastralne_uzemie
    FROM unknown_owners ${where}
    ORDER BY katastralne_uzemie, lv
  `);
  const lvs = rows.map((r) => ({ lv: r.lv, ku: r.poradove_cislo, kuName: r.katastralne_uzemie }));
  return { count: lvs.length, lvs };
}

async function allUniqueTransferredLvs(q) {
  const search = normStr(q.q || '');
  const fVlast = normStr(q.f_vlast || q.f_vast || '');
  const fKu = normStr(q.f_ku || '');
  const fLv = (q.f_lv || '').trim().replace(/'/g, "''");
  const fCislo = (q.f_cislo || '').trim().replace(/'/g, "''");
  const fDatum = (q.f_datum || '').trim().replace(/'/g, "''");
  const fYear = parseInt(q.f_year, 10) || null;
  const conds = [];
  if (search) conds.push(`vlastnik_norm LIKE '%${search}%'`);
  if (fVlast) conds.push(`vlastnik_norm LIKE '%${fVlast}%'`);
  if (fKu) conds.push(`ku_norm LIKE '%${fKu}%'`);
  if (fLv) conds.push(`CAST(lv AS VARCHAR) LIKE '%${fLv}%'`);
  if (fCislo) conds.push(`CAST(cislo_ku AS VARCHAR) LIKE '%${fCislo}%'`);
  if (fDatum) conds.push(`datum_ucinnosti LIKE '%${fDatum}%'`);
  if (fYear) conds.push(`year = ${fYear}`);
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const rows = await queryObjects(`
    SELECT DISTINCT lv, cislo_ku, nazov_ku
    FROM transferred_rights ${where}
    ORDER BY nazov_ku, lv
  `);
  const lvs = rows.map((r) => ({ lv: r.lv, ku: r.cislo_ku, kuName: r.nazov_ku }));
  return { count: lvs.length, lvs };
}

async function correlations() {
  const [bothDatasets, yearByKu, lvBuckets, spfAnalysis] = await Promise.all([
    queryObjects(`
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
    `),
    queryObjects(`
      SELECT year, nazov_ku, COUNT(*) AS count
      FROM transferred_rights
      GROUP BY year, nazov_ku
      ORDER BY year, count DESC
    `),
    queryObjects(`
      SELECT
        (lv / 500) * 500        AS lv_bucket_start,
        (lv / 500) * 500 + 499  AS lv_bucket_end,
        COUNT(*)                AS count
      FROM unknown_owners
      WHERE lv IS NOT NULL AND lv > 0
      GROUP BY lv / 500
      ORDER BY lv_bucket_start
      LIMIT 50
    `),
    queryObjects(`
      SELECT
        year,
        SUM(CASE WHEN vlastnik_lv ILIKE '%(SPF)%' THEN 1 ELSE 0 END) AS spf_count,
        SUM(CASE WHEN vlastnik_lv NOT ILIKE '%(SPF)%' THEN 1 ELSE 0 END) AS non_spf_count,
        COUNT(*) AS total
      FROM transferred_rights
      GROUP BY year
      ORDER BY year
    `),
  ]);
  return { bothDatasets, yearByKu, lvBuckets, spfAnalysis };
}

async function lvAnalysis(q) {
  const searchName = (q.name || 'kuzmiak').trim();
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
  const totalOwnedM2 = lvBreakdown.reduce((sum, r) => sum + (r.owned_m2 || 0), 0);
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
  return {
    searchName,
    storedLvCount: lvBreakdown.length,
    totalOwnedM2,
    totalOwnedHa: (totalOwnedM2 / 10000).toFixed(4),
    lvBreakdown,
    landTypeBreakdown,
    coOwners,
  };
}

async function saveLvData(body) {
  const items = body?.items;
  if (!Array.isArray(items) || !items.length) {
    return { error: 'Array of {lv, ku, text} required' };
  }
  let savedDocs = 0;
  let savedParcels = 0;
  let savedOwners = 0;

  for (const item of items) {
    const lv = parseInt(item.lv, 10);
    const ku = parseInt(item.ku, 10);
    const text = item.text || '';
    if (!lv || !ku || !text || text.length < 200) continue;
    const parsed = parseLvText(text, lv, ku);
    const doc = parsed.doc;

    await queryRun(`
      INSERT OR REPLACE INTO lv_details
        (lv, cislo_ku, nazov_ku, okres, obec, pocet_parciel_c, pocet_parciel_e, celkova_vymera_m2, pocet_vlastnikov, fetched_at)
      VALUES (
        ${doc.lv}, ${doc.cislo_ku},
        '${escSql(doc.nazov_ku || item.kuName || '')}',
        '${escSql(doc.okres || '')}',
        '${escSql(doc.obec || '')}',
        ${doc.pocet_parciel_c}, ${doc.pocet_parciel_e},
        ${doc.celkova_vymera_m2}, ${doc.pocet_vlastnikov},
        CURRENT_TIMESTAMP
      )
    `);
    savedDocs++;

    for (const p of parsed.parcels) {
      const pId = `${doc.cislo_ku}_${doc.lv}_${p.register_type}_${p.parcel_no}`.replace(/[/\s]/g, '_');
      await queryRun(`
        INSERT OR REPLACE INTO lv_parcels
          (id, lv, cislo_ku, register_type, parcel_no, vymera_m2, druh_pozemku)
        VALUES (
          '${escSql(pId)}', ${doc.lv}, ${doc.cislo_ku},
          '${escSql(p.register_type)}', '${escSql(p.parcel_no)}',
          ${p.vymera_m2}, '${escSql(p.druh_pozemku || '')}'
        )
      `);
      savedParcels++;
    }

    for (const o of parsed.owners) {
      const oId = `${doc.cislo_ku}_${doc.lv}_${o.poradove_cislo}`;
      await queryRun(`
        INSERT OR REPLACE INTO lv_owners
          (id, lv, cislo_ku, poradove_cislo, meno_vlastnika, datum_narodenia, podiel_str, podiel_num, podiel_den, podiel_decimal, titul_nadobudnutia)
        VALUES (
          '${escSql(oId)}', ${doc.lv}, ${doc.cislo_ku}, ${o.poradove_cislo},
          '${escSql(o.meno_vlastnika)}', '${escSql(o.datum_narodenia)}',
          '${escSql(o.podiel_str)}', ${o.podiel_num}, ${o.podiel_den}, ${o.podiel_decimal},
          '${escSql(o.titul_nadobudnutia || '')}'
        )
      `);
      savedOwners++;
    }
  }
  return { success: true, savedDocs, savedParcels, savedOwners };
}

async function lvPreview(q) {
  const lv = (q.lv || '').trim();
  const ku = (q.ku || '').trim();
  if (!lv || !ku) return '<h3>Chýbajúce parametre LV alebo k.ú.</h3>';
  const targetUrl = `https://kataster.skgeodesy.sk/Portal45/api/Bo/GeneratePrfPublic?prfNumber=${encodeURIComponent(lv)}&cadastralUnitCode=${encodeURIComponent(ku)}&outputType=html`;
  try {
    const response = await fetch(targetUrl);
    const html = await response.text();
    if (html && html.length > 500 && html.includes('LIST U VLASTNÍCTVA')) return html;
  } catch (_) {
    /* CORS on GitHub Pages — fall through */
  }
  return `<h3>Náhľad LV nie je dostupný z prehliadača (CORS).</h3>
    <p><a href="${targetUrl}" target="_blank" rel="noopener">Otvoriť výpis v novom okne</a></p>`;
}

async function geoStats() {
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
  return { topKu };
}

async function geoBoundaries() {
  if (!geoJsonCache) {
    const res = await fetch(assetUrl('sk_boundaries.json'));
    if (!res.ok) throw new Error('sk_boundaries.json not found');
    geoJsonCache = await res.json();
  }
  const rows = await queryObjects(`
    SELECT ku_norm, COUNT(*) as cnt
    FROM unknown_owners
    WHERE ku_norm IS NOT NULL AND ku_norm != ''
    GROUP BY ku_norm
  `);
  const countMap = {};
  rows.forEach((r) => {
    countMap[r.ku_norm] = Number(r.cnt);
    const simpleName = r.ku_norm.replace(/^(velky|maly|stary|novy|vyssia|nizsia|horny|dolny|vysne|nizne)\s+/i, '');
    if (simpleName !== r.ku_norm) {
      countMap[simpleName] = (countMap[simpleName] || 0) + Number(r.cnt);
    }
  });
  const features = geoJsonCache.features.map((f) => {
    const nameNorm = (f.properties.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return {
      type: f.type,
      geometry: f.geometry,
      properties: { ...f.properties, record_count: countMap[nameNorm] || 0 },
    };
  });
  return { type: 'FeatureCollection', features };
}

async function customQuery(body) {
  const sql = (body?.sql || '').trim();
  if (!sql) return { error: 'No SQL provided' };
  const trimmed = sql.toUpperCase();
  if (!trimmed.startsWith('SELECT') && !trimmed.startsWith('WITH')) {
    return { error: 'Only SELECT queries are allowed' };
  }
  let safeSql = sql.replace(/;+\s*$/, '');
  if (!/\bLIMIT\s+\d+/i.test(safeSql)) safeSql += ' LIMIT 2000';
  const rows = await queryObjects(safeSql);
  return { rows, count: rows.length };
}

export async function apiRequest(path, options = {}) {
  throwIfAborted(options.signal);
  const url = new URL(path, 'https://pzf.local/');
  const route = url.pathname.replace(/^\/api\//, '').replace(/^\//, '');
  const q = Object.fromEntries(url.searchParams.entries());
  let body = null;
  if (options.body) {
    body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
  }

  let result;
  switch (route) {
    case 'stats':
      result = await stats();
      break;
    case 'top-katastralne':
      result = await queryObjects(`SELECT katastralne_uzemie, poradove_cislo, owner_count, unique_lv_count FROM v_top_katastralne LIMIT ${Math.min(parseInt(q.limit, 10) || 20, 100)}`);
      break;
    case 'transferred-by-year':
      result = await queryObjects(`SELECT * FROM v_transferred_by_year`);
      break;
    case 'transferred-top-ku':
      result = await queryObjects(`SELECT * FROM v_transferred_top_ku LIMIT ${Math.min(parseInt(q.limit, 10) || 20, 100)}`);
      break;
    case 'overlap':
      result = await queryObjects(`SELECT * FROM v_overlap LIMIT ${Math.min(parseInt(q.limit, 10) || 50, 500)}`);
      break;
    case 'alpha-distribution':
      result = await queryObjects(`SELECT * FROM v_alpha_distribution`);
      break;
    case 'overview-search':
      result = await overviewSearch(q);
      break;
    case 'name-districts':
      result = await nameDistricts(q);
      break;
    case 'name-ku-detail':
      result = await nameKuDetail(q);
      break;
    case 'owners':
      result = await owners(q);
      break;
    case 'transferred':
      result = await transferred(q);
      break;
    case 'all-unique-lvs':
      result = await allUniqueLvs(q);
      break;
    case 'all-unique-transferred-lvs':
      result = await allUniqueTransferredLvs(q);
      break;
    case 'correlations':
      result = await correlations();
      break;
    case 'lv-analysis':
      result = await lvAnalysis(q);
      break;
    case 'save-lv-data':
      result = await saveLvData(body);
      break;
    case 'lv-preview':
      result = await lvPreview(q);
      break;
    case 'geo-stats':
      result = await geoStats();
      break;
    case 'geo-boundaries':
      result = await geoBoundaries();
      break;
    case 'custom-query':
      result = await customQuery(body);
      break;
    default:
      throw new Error(`Neznámy endpoint: ${route}`);
  }
  throwIfAborted(options.signal);
  return result;
}
