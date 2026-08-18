/**
 * DuckDB WASM client — replaces the Express API for static GitHub Pages.
 */
import * as duckdb from 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.32.0/+esm';
import { parseVypisInput } from './lv_parser.js';
import { isLvVypisHtml } from './lv-html.js';

const DATA_CACHE = 'pzf-data-v6';
const DATA_FP_KEY = 'pzf-data-fp';

let db = null;
let conn = null;
let ready = false;
let geoJsonCache = null;
let cachedStats = null;

function dataUrl(name) {
  return new URL(`data/${name}`, document.baseURI).href;
}

function assetUrl(name) {
  return new URL(name, document.baseURI).href;
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

function showBootProgress() {
  const consent = document.getElementById('boot-consent');
  const progress = document.getElementById('boot-progress');
  if (consent) consent.hidden = true;
  if (progress) progress.hidden = false;
}

function isCellularConnection() {
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!c) return null;
  if (c.saveData) return true;
  if (c.type === 'cellular') return true;
  if (c.type === 'wifi' || c.type === 'ethernet') return false;
  const slow = c.effectiveType === 'slow-2g' || c.effectiveType === '2g' || c.effectiveType === '3g';
  return slow ? true : null;
}

async function isRegisterCached() {
  try {
    const cache = await openDataCache();
    if (!cache) return false;
    const hit = await cache.match(dataUrl('unknown_owners.parquet'));
    return Boolean(hit);
  } catch (_) {
    return false;
  }
}

async function waitForFirstDownloadConsent() {
  if (await isRegisterCached()) {
    showBootProgress();
    setStatus('Načítavam z cache…');
    return;
  }

  const consent = document.getElementById('boot-consent');
  const btn = document.getElementById('boot-consent-btn');
  const warn = document.getElementById('boot-cell-warn');
  if (!consent || !btn) {
    showBootProgress();
    return;
  }

  consent.hidden = false;
  const cell = isCellularConnection();
  if (warn && cell === true) {
    warn.classList.add('boot-cell-hot');
    warn.innerHTML = 'Zdá sa, že ste na <strong>mobilných dátach</strong>. Sťahovanie <strong>~60&nbsp;MB</strong> môže byť spoplatnené. Odporúčame Wi‑Fi.';
    btn.textContent = 'Aj tak stiahnuť (~60 MB)';
  }
  setStatus('Čakám na potvrdenie sťahovania…');
  btn.disabled = false;

  await new Promise((resolve) => {
    btn.addEventListener('click', () => {
      btn.disabled = true;
      showBootProgress();
      resolve();
    }, { once: true });
  });
}

function isReloadNavigation() {
  try {
    const nav = performance.getEntriesByType?.('navigation')?.[0];
    if (nav) return nav.type === 'reload';
    return performance.navigation?.type === 1;
  } catch (_) {
    return false;
  }
}

function statsFingerprint(s) {
  if (!s || typeof s !== 'object') return '';
  return [
    s.total_unknown_owners,
    s.unique_katastralne,
    s.unique_lv_uo,
    s.unique_names,
    s.total_transferred,
    s.unique_lv_tr,
    s.overlap_count,
  ].join('|');
}

function rememberedDataFingerprint() {
  try {
    return localStorage.getItem(DATA_FP_KEY) || '';
  } catch (_) {
    return '';
  }
}

function rememberDataFingerprint(s) {
  const fp = statsFingerprint(s);
  if (!fp) return;
  try {
    localStorage.setItem(DATA_FP_KEY, fp);
  } catch (_) { /* private mode */ }
}

function dataStatsUnchanged() {
  const now = statsFingerprint(cachedStats);
  const prev = rememberedDataFingerprint();
  return Boolean(now && prev && now === prev);
}

async function isCachedResponseStale(url, hit) {
  if (!hit) return true;
  if (!isReloadNavigation()) return false;
  // UI-only deploys change GitHub Pages ETag/Last-Modified on every file.
  // Re-download parquet only when register stats (or byte size) actually changed.
  if (dataStatsUnchanged()) return false;
  const prevFp = rememberedDataFingerprint();
  const nowFp = statsFingerprint(cachedStats);
  if (prevFp && nowFp && prevFp !== nowFp) return true;
  try {
    const head = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    if (!head.ok) return false;
    const remoteLen = head.headers.get('content-length');
    if (!remoteLen) return false;
    const cachedLen = hit.headers.get('X-Pzf-Size') || hit.headers.get('Content-Length');
    const size = cachedLen || String((await hit.clone().blob()).size);
    return remoteLen !== String(size);
  } catch (_) {
    return false;
  }
}

async function fetchBuffer(url, onProgress, fetchOpts = {}) {
  const res = await fetch(url, fetchOpts);
  if (!res.ok) throw new Error(`Nepodarilo sa stiahnuť ${url} (${res.status})`);
  const etag = res.headers.get('etag') || '';
  const lastModified = res.headers.get('last-modified') || '';
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress?.(1);
    return { buf, etag, lastModified, size: buf.byteLength };
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
  return { buf: out, etag, lastModified, size: out.byteLength };
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
    if (hit && !(await isCachedResponseStale(url, hit))) {
      setStatus(`Z cache: ${label}`);
      const buf = new Uint8Array(await hit.arrayBuffer());
      onProgress?.(1);
      return buf;
    }
    if (hit) setStatus(`Obnovujem ${label}…`);
  }
  const { buf, etag, lastModified, size } = await fetchBuffer(
    url,
    onProgress,
    isReloadNavigation() ? { cache: 'no-store' } : {}
  );
  if (cache) {
    try {
      const headers = {
        'Content-Type': 'application/octet-stream',
        'X-Pzf-Size': String(size),
      };
      if (etag) headers.ETag = etag;
      if (lastModified) headers['Last-Modified'] = lastModified;
      await cache.put(url, new Response(buf, { headers }));
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

const SK_FOLD = {
  á: 'a', ä: 'a', č: 'c', ď: 'd', é: 'e', í: 'i', ĺ: 'l', ľ: 'l',
  ň: 'n', ó: 'o', ô: 'o', ŕ: 'r', š: 's', ť: 't', ú: 'u', ý: 'y', ž: 'z',
  ě: 'e', ů: 'u', ł: 'l', ą: 'a', ę: 'e', ó: 'o',
};

function fold(s) {
  return String(s || '')
    .replace(/[áäčďéěíĺľłňóôŕšťúůýžąę]/gi, (ch) => SK_FOLD[ch.toLowerCase()] || ch)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function normStr(s) {
  return fold(s).replace(/'/g, "''");
}

function tokensOf(s) {
  return fold(s).split(/[^a-z0-9]+/).filter((t) => t.length >= 1);
}

function tokenPred(col, q, opts = {}) {
  const toks = tokensOf(q);
  if (!toks.length) return '';
  const isMeno = col === 'meno_norm' || col === 's.meno_norm' || col === 'u.meno_norm';
  const prefixConds = (opts.prefixFirst !== false || isMeno)
    ? toks.filter((t) => t.length >= 2).map((t) => prefixPred(col, t.replace(/'/g, "''")))
    : [];
  const containsConds = toks.map((t) => `contains(${col}, '${t.replace(/'/g, "''")}')`);

  if (prefixConds.length > 0) {
    const prefixClause = prefixConds.length === 1 ? prefixConds[0] : `(${prefixConds.join(' OR ')})`;
    return `(${prefixClause} AND ${containsConds.join(' AND ')})`;
  }
  return containsConds.join(' AND ');
}

function foldedNamePred(rawList) {
  const raw = (rawList || []).map(String).filter(Boolean);
  const folded = [...new Set(raw.map((n) => fold(n).replace(/'/g, "''")).filter(Boolean))];
  const parts = [];
  if (raw.length) parts.push(`meno_vlastnika IN (${raw.map((n) => `'${escSql(n)}'`).join(', ')})`);
  if (folded.length) {
    const norms = folded.map((f) => `'${f}'`).join(', ');
    parts.push(`meno_norm IN (${norms})`);
    parts.push(folded.map((f) => `(meno_norm LIKE '${f} %' OR meno_norm LIKE '${f},%')`).join(' OR '));
    for (const item of raw) {
      const toks = tokensOf(item);
      if (toks.length >= 2) {
        const pConds = toks.filter((t) => t.length >= 2).map((t) => prefixPred('meno_norm', t.replace(/'/g, "''")));
        const pClause = pConds.length === 1 ? pConds[0] : `(${pConds.join(' OR ')})`;
        const cClause = toks.map((t) => `contains(meno_norm, '${t.replace(/'/g, "''")}')`).join(' AND ');
        parts.push(`(${pClause} AND ${cClause})`);
      }
    }
  }
  return parts.length ? `(${parts.join(' OR ')})` : '1=0';
}

function escSql(s) {
  return String(s ?? '').replace(/'/g, "''");
}

function normSql(col) {
  return `strip_accents(LOWER(CAST(${col} AS VARCHAR)))`;
}

function buildTokenWhere(col, searchName) {
  const toks = tokensOf(searchName);
  if (!toks.length) return '1=1';
  return toks.map((t) => `${normSql(col)} LIKE '%${t.replace(/'/g, "''")}%'`).join(' AND ');
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    throw err;
  }
}

let searchTail = Promise.resolve();
let searchSeq = 0;

function coalesceSearch(signal, fn) {
  const seq = ++searchSeq;
  const run = searchTail.then(async () => {
    throwIfAborted(signal);
    if (seq !== searchSeq) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }
    return fn();
  });
  searchTail = run.then(() => undefined, () => undefined);
  return run;
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

  const isLocal = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

  if (!isLocal) {
    await waitForFirstDownloadConsent();
  } else {
    const consent = document.getElementById('boot-consent');
    if (consent) consent.style.display = 'none';
    const prog = document.getElementById('boot-progress');
    if (prog) prog.hidden = false;
  }

  setStatus('Inicializujem DuckDB...');
  setProgress(5);

  const bundles = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(bundles);
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' })
  );
  const worker = new Worker(workerUrl);
  db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  conn = await db.connect();
  if (navigator.hardwareConcurrency && window.crossOriginIsolated) {
    try {
      const threads = Math.min(navigator.hardwareConcurrency || 4, 8);
      await conn.query(`SET threads TO ${threads}`);
      console.log(`🚀 DuckDB WASM running in MULTI-THREADED mode (${threads} Web Workers / PThreads)`);
    } catch (_) {}
  }
  setProgress(8);

  try {
    const statsRes = await fetch(dataUrl('stats.json'), { cache: 'no-store' });
    if (statsRes.ok) cachedStats = await statsRes.json();
  } catch (_) {}

  await registerParquet('places_agg.parquet', 'obce', 8, 12);
  await registerParquet('surnames.parquet', 'index mien', 12, 16);
  await registerParquet('lv_co.parquet', 'hustota LV', 16, 18);
  await registerParquet('solo_lvs.parquet', 'solo LV', 18, 24);
  await registerParquet('unknown_owners.parquet', 'register (cache po 1. načítaní)', 24, 78);
  await registerParquet('transferred_rights.parquet', 'prevedené práva', 78, 84);
  try {
    await registerParquet('lv_details.parquet', 'uložené LV', 84, 86);
    await registerParquet('lv_owners.parquet', 'vlastníkov LV', 86, 88);
    await registerParquet('lv_parcels.parquet', 'parcely LV', 88, 90);
  } catch (_) { /* local-only / missing on some deploys */ }

  setStatus('Pripravujem tabuľky...');
  await queryRun(`CREATE OR REPLACE VIEW unknown_owners AS SELECT * FROM read_parquet('unknown_owners.parquet')`);
  await queryRun(`CREATE OR REPLACE VIEW transferred_rights AS SELECT * FROM read_parquet('transferred_rights.parquet')`);
  await queryRun(`CREATE OR REPLACE TABLE places_agg AS SELECT * FROM read_parquet('places_agg.parquet')`);
  await queryRun(`CREATE OR REPLACE TABLE surnames AS SELECT * FROM read_parquet('surnames.parquet')`);
  await queryRun(`CREATE OR REPLACE TABLE lv_co AS SELECT * FROM read_parquet('lv_co.parquet')`);
  await queryRun(`CREATE OR REPLACE TABLE solo_lvs AS SELECT * FROM read_parquet('solo_lvs.parquet')`);
  try {
    await queryRun(`CREATE INDEX idx_surnames_token ON surnames(token)`);
    await queryRun(`CREATE INDEX idx_places_ku ON places_agg(ku_norm)`);
    await queryRun(`CREATE INDEX idx_lv_co ON lv_co(poradove_cislo, lv)`);
    await queryRun(`CREATE INDEX idx_solo_ku ON solo_lvs(ku_norm)`);
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
  try {
    await queryRun(`INSERT OR REPLACE INTO lv_details SELECT * FROM read_parquet('lv_details.parquet')`);
  } catch (_) { /* optional */ }

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
  try {
    await queryRun(`INSERT OR REPLACE INTO lv_parcels SELECT * FROM read_parquet('lv_parcels.parquet')`);
  } catch (_) { /* optional */ }

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
  try {
    await queryRun(`INSERT OR REPLACE INTO lv_owners SELECT * FROM read_parquet('lv_owners.parquet')`);
  } catch (_) { /* optional */ }

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
  rememberDataFingerprint(cachedStats);
  setProgress(100);
  setStatus('DuckDB WASM · pripravené', 'ok');
  hideBoot();
}

async function stats() {
  if (cachedStats) return cachedStats;
  try {
    const res = await fetch(dataUrl('stats.json'), isReloadNavigation() ? { cache: 'no-store' } : {});
    if (res.ok) {
      cachedStats = await res.json();
      rememberDataFingerprint(cachedStats);
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
  const nameFast = tokenPred('meno_norm', q);
  const placePred = tokenPred('ku_norm', q, { prefixFirst: false });
  if (!nameFast && !placePred) return '';
  if (!placePred) return `(${nameFast})`;
  if (!nameFast) return `(${placePred})`;
  return `((${nameFast}) OR (${placePred}))`;
}

async function overviewSearch(q) {
  const raw = (q.q || '').trim();
  const fKu = (q.f_ku || '').trim();
  const qOk = fold(raw).replace(/[^a-z0-9]/g, '').length >= 2;
  const kuOk = fold(fKu).replace(/[^a-z0-9]/g, '').length >= 2;
  if (!qOk && !kuOk) {
    return { total: 0, unique_names: 0, unique_places: 0, unique_lv: 0, names: [], places: [], rows: [], lvs: [], page: 1, limit: 50 };
  }
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const limit = Math.min(parseInt(q.limit, 10) || 50, 200);
  const fName = (q.f_name || '').trim();
  const tokens = tokensOf(raw);
  const first = tokens[0] || fold(raw);

  const placeQuery = fKu || raw;
  const placeWhere = tokenPred('ku_norm', placeQuery, { prefixFirst: false });
  const places = placeWhere ? await queryObjects(`
    SELECT katastralne_uzemie,
           SUM(recs) AS recs, SUM(names) AS names, SUM(lvs) AS lvs
    FROM places_agg
    WHERE ${placeWhere}
    GROUP BY katastralne_uzemie
    ORDER BY recs DESC
    LIMIT 40
  `) : [];

  const surnameWhere = tokens.length
    ? tokens.filter((t) => t.length >= 2).map((t) => prefixPred('token', t.replace(/'/g, "''"))).join(' OR ')
    : '';
  const surname = surnameWhere ? ((await queryObjects(`
    SELECT
      COALESCE(SUM(recs), 0) AS total,
      COALESCE(SUM(names), 0) AS unique_names,
      COALESCE(SUM(places), 0) AS unique_places,
      COALESCE(SUM(lvs), 0) AS unique_lv
    FROM surnames
    WHERE ${surnameWhere}
  `))[0] || { total: 0, unique_names: 0, unique_places: 0, unique_lv: 0 })
    : { total: 0, unique_names: 0, unique_places: 0, unique_lv: 0 };

  const nameConds = [];
  const namePred = qOk ? tokenPred('meno_norm', raw) : '';
  if (namePred) nameConds.push(namePred);
  if (fName) nameConds.push(foldedNamePred([fName]));
  const kuPred = tokenPred('ku_norm', fKu, { prefixFirst: false });
  if (kuPred) nameConds.push(kuPred);
  const where = nameConds.length ? `WHERE ${nameConds.join(' AND ')}` : 'WHERE 1=0';

  const names = await queryObjects(`
    WITH hits AS (
      SELECT meno_vlastnika, katastralne_uzemie, poradove_cislo, lv
      FROM unknown_owners
      ${where}
    ),
    mine AS (
      SELECT h.meno_vlastnika, h.katastralne_uzemie, h.poradove_cislo, h.lv,
             COALESCE(c.names_on_lv, 1) AS names_on_lv
      FROM hits h
      LEFT JOIN lv_co c
        ON h.poradove_cislo = c.poradove_cislo AND h.lv = c.lv
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

  const placeRecs = places.reduce((s, p) => s + Number(p.recs || 0), 0);
  return {
    total: Math.max(Number(surname.total || 0), placeRecs, names.length),
    unique_names: Number(surname.unique_names || names.length),
    unique_places: Math.max(Number(surname.unique_places || 0), places.length),
    unique_lv: Number(surname.unique_lv || 0),
    names,
    places,
    rows: [],
    lvs: [],
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

async function placeSearch(q) {
  const raw = (q.q || '').trim();
  const placeWhere = tokenPred('ku_norm', raw, { prefixFirst: false });
  if (!placeWhere) return { rows: [] };
  const rows = await queryObjects(`
    SELECT katastralne_uzemie,
           SUM(recs) AS recs, SUM(names) AS names, SUM(lvs) AS lvs
    FROM places_agg
    WHERE ${placeWhere}
    GROUP BY katastralne_uzemie
    ORDER BY recs DESC
    LIMIT 12
  `);
  return { rows };
}

function nameWhisperPred(q) {
  return tokenPred('meno_norm', q);
}

async function nameSearch(q) {
  const pred = nameWhisperPred((q.q || '').trim());
  if (!pred) return { rows: [] };
  const rows = await queryObjects(`
    SELECT meno_vlastnika
    FROM unknown_owners
    WHERE ${pred}
    GROUP BY meno_vlastnika
    ORDER BY COUNT(*) DESC
    LIMIT 48
  `);
  return { rows };
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
      WHERE ${foldedNamePred(list)}
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

  const kuClause = `(u.katastralne_uzemie = '${escSql(ku)}' OR u.ku_norm = '${normStr(ku)}')`;

  const lvs = await queryObjects(`
    WITH mine AS (
      SELECT u.lv, u.poradove_cislo, u.katastralne_uzemie, u.meno_vlastnika,
             COALESCE(c.names_on_lv, 1) AS names_on_lv
      FROM unknown_owners u
      LEFT JOIN lv_co c
        ON u.poradove_cislo = c.poradove_cislo AND u.lv = c.lv
      WHERE ${foldedNamePred(list)}
        AND ${kuClause}
    )
    SELECT
      lv,
      ANY_VALUE(poradove_cislo) AS cislo_ku,
      ANY_VALUE(katastralne_uzemie) AS ku_name,
      ANY_VALUE(names_on_lv) AS names_on_lv,
      CASE WHEN ANY_VALUE(names_on_lv) <= 1 THEN 1 ELSE 0 END AS solo,
      COUNT(*) AS recs,
      ROUND(1.0 / GREATEST(ANY_VALUE(names_on_lv), 1), 4) AS portion,
      STRING_AGG(DISTINCT meno_vlastnika, ' · ') AS variants
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
          AND NOT ${foldedNamePred(list)}
        GROUP BY meno_vlastnika
        ORDER BY shared_lvs DESC, meno_vlastnika
        LIMIT 25
      `);
    }
  }

  let extracts = {};
  if (lvs.length) {
    extracts = await lvExtractsByKeys(lvs.map((r) => ({ lv: r.lv, ku: r.cislo_ku })));
  }

  return { summary, lvs, transferred, coowners, extracts };
}

async function soloLvs(q) {
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const limit = Math.min(parseInt(q.limit, 10) || 50, 200);
  const offset = (page - 1) * limit;
  const kuPred = tokenPred('s.ku_norm', q.ku || q.f_ku || '', { prefixFirst: false });
  const namePred = tokenPred('s.meno_norm', q.q || q.name || q.f_name || '');
  const conds = [kuPred, namePred].filter(Boolean);
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const SOLO_SORT = {
    meno_vlastnika: 's.meno_norm',
    katastralne_uzemie: 's.katastralne_uzemie',
    cislo_ku: 's.cislo_ku',
    lv: 's.lv',
    portion: 's.lv',
    kataster: 's.lv',
    vymera: 'd.celkova_vymera_m2',
    parcely: 'd.pocet_parciel_c',
  };
  const sortCol = SOLO_SORT[q.sort_col] || 's.katastralne_uzemie';
  const sortDir = q.sort_dir === 'DESC' ? 'DESC' : 'ASC';
  const order = `${sortCol} ${sortDir} NULLS LAST, s.lv ${sortDir}`;

  const cntRow = await queryObjects(`SELECT COUNT(*) AS cnt FROM solo_lvs s ${where}`);
  const rows = await queryObjects(`
    SELECT
      s.meno_vlastnika, s.katastralne_uzemie, s.cislo_ku, s.lv,
      d.celkova_vymera_m2, d.pocet_parciel_c, d.pocet_parciel_e, d.pocet_vlastnikov
    FROM solo_lvs s
    LEFT JOIN lv_details d ON s.lv = d.lv AND s.cislo_ku = d.cislo_ku
    ${where}
    ORDER BY ${order}
    LIMIT ${limit} OFFSET ${offset}
  `);

  const keys = (rows || []).filter((r) => r.celkova_vymera_m2 > 0).map((r) => `(${Number(r.lv)},${Number(r.cislo_ku)})`);
  let parcels = [];
  if (keys.length) {
    parcels = await queryObjects(`
      SELECT lv, cislo_ku, register_type, parcel_no, vymera_m2, druh_pozemku
      FROM lv_parcels
      WHERE (lv, cislo_ku) IN (${keys.join(',')})
      ORDER BY register_type, parcel_no
    `);
  }
  return { total: cntRow[0].cnt, page, limit, rows, parcels };
}

async function lvParcels(q) {
  const lv = parseInt(q.lv, 10);
  const ku = parseInt(q.ku, 10);
  if (!Number.isFinite(lv) || !Number.isFinite(ku) || lv <= 0 || ku <= 0) {
    return { parcels: [] };
  }
  try {
    const parcels = await queryObjects(`
      SELECT lv, cislo_ku, register_type, parcel_no, vymera_m2, druh_pozemku
      FROM lv_parcels
      WHERE lv = ${lv} AND cislo_ku = ${ku}
      ORDER BY CASE WHEN register_type = 'C' THEN 0 ELSE 1 END, vymera_m2 DESC NULLS LAST, parcel_no
    `);
    return { parcels };
  } catch (_) {
    return { parcels: [] };
  }
}

async function lvExtractOne(lv, ku) {
  const nLv = Number(lv);
  const nKu = Number(ku);
  if (!Number.isFinite(nLv) || !Number.isFinite(nKu) || nLv <= 0 || nKu <= 0) {
    return { details: null, parcels: [], owners: [] };
  }
  let details = [];
  let parcels = [];
  let owners = [];
  try {
    details = await queryObjects(`
      SELECT lv, cislo_ku, nazov_ku, okres, obec, pocet_parciel_c, pocet_parciel_e,
             celkova_vymera_m2, pocet_vlastnikov
      FROM lv_details
      WHERE lv = ${nLv} AND cislo_ku = ${nKu}
      LIMIT 1
    `);
  } catch (_) {}
  try {
    parcels = await queryObjects(`
      SELECT lv, cislo_ku, register_type, parcel_no, vymera_m2, druh_pozemku
      FROM lv_parcels
      WHERE lv = ${nLv} AND cislo_ku = ${nKu}
      ORDER BY CASE WHEN register_type = 'C' THEN 0 ELSE 1 END, vymera_m2 DESC NULLS LAST, parcel_no
    `);
  } catch (_) {}
  try {
    owners = await queryObjects(`
      SELECT lv, cislo_ku, poradove_cislo, meno_vlastnika, datum_narodenia,
             podiel_str, podiel_num, podiel_den, podiel_decimal, titul_nadobudnutia
      FROM lv_owners
      WHERE lv = ${nLv} AND cislo_ku = ${nKu}
      ORDER BY poradove_cislo
    `);
  } catch (_) {}
  return {
    details: details[0] || null,
    parcels,
    owners,
  };
}

async function lvExtractsByKeys(pairs) {
  const out = {};
  const keys = (pairs || []).filter((p) => Number(p.lv) > 0 && Number(p.ku) > 0);
  if (!keys.length) return out;
  const lvList = [...new Set(keys.map((p) => Number(p.lv)))].join(',');
  const kuList = [...new Set(keys.map((p) => Number(p.ku)))].join(',');
  let details = [];
  let parcels = [];
  let owners = [];
  try {
    details = await queryObjects(`
      SELECT lv, cislo_ku, nazov_ku, okres, obec, pocet_parciel_c, pocet_parciel_e,
             celkova_vymera_m2, pocet_vlastnikov
      FROM lv_details
      WHERE lv IN (${lvList}) AND cislo_ku IN (${kuList})
    `);
  } catch (_) {}
  try {
    parcels = await queryObjects(`
      SELECT lv, cislo_ku, register_type, parcel_no, vymera_m2, druh_pozemku
      FROM lv_parcels
      WHERE lv IN (${lvList}) AND cislo_ku IN (${kuList})
      ORDER BY CASE WHEN register_type = 'C' THEN 0 ELSE 1 END, vymera_m2 DESC NULLS LAST, parcel_no
    `);
  } catch (_) {}
  try {
    owners = await queryObjects(`
      SELECT lv, cislo_ku, poradove_cislo, meno_vlastnika, datum_narodenia,
             podiel_str, podiel_num, podiel_den, podiel_decimal, titul_nadobudnutia
      FROM lv_owners
      WHERE lv IN (${lvList}) AND cislo_ku IN (${kuList})
      ORDER BY poradove_cislo
    `);
  } catch (_) {}
  const wanted = new Set(keys.map((p) => `${Number(p.ku)}:${Number(p.lv)}`));
  for (const key of wanted) {
    const [ku, lv] = key.split(':').map(Number);
    const d = details.find((r) => Number(r.lv) === lv && Number(r.cislo_ku) === ku) || null;
    const p = parcels.filter((r) => Number(r.lv) === lv && Number(r.cislo_ku) === ku);
    const o = owners.filter((r) => Number(r.lv) === lv && Number(r.cislo_ku) === ku);
    if (!d && !p.length && !o.length) continue;
    out[key] = {
      doc: d || {
        lv, cislo_ku: ku, nazov_ku: '',
        pocet_parciel_c: p.filter((x) => x.register_type === 'C').length,
        pocet_parciel_e: p.filter((x) => x.register_type === 'E').length,
        celkova_vymera_m2: p.reduce((s, x) => s + (Number(x.vymera_m2) || 0), 0),
        pocet_vlastnikov: o.length,
      },
      parcels: p,
      owners: o,
    };
  }
  return out;
}

async function lvExtract(q) {
  return lvExtractOne(q.lv, q.ku);
}

async function owners(q) {
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const limit = Math.min(parseInt(q.limit, 10) || 50, 200);
  const offset = (page - 1) * limit;
  const search = q.q || '';
  const fKu = q.f_ku || '';
  const fName = q.f_name || '';
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
  const searchPred = tokenPred('meno_norm', search);
  const namePred = tokenPred('meno_norm', fName);
  const kuPred = tokenPred('ku_norm', fKu, { prefixFirst: false });
  if (searchPred) conds.push(searchPred);
  if (kuPred) conds.push(kuPred);
  if (fCislo) conds.push(`CAST(poradove_cislo AS VARCHAR) LIKE '%${fCislo}%'`);
  if (fLv) conds.push(`CAST(lv AS VARCHAR) LIKE '%${fLv}%'`);
  if (namePred) conds.push(namePred);
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  let total;
  if (!where) {
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
  const search = q.q || '';
  const fVlast = q.f_vlast || q.f_vast || '';
  const fKu = q.f_ku || '';
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
    crz: 'crz',
  };
  const sortCol = ALLOWED[q.sort_col] || 'year';
  const sortDir = q.sort_dir === 'ASC' ? 'ASC' : 'DESC';

  const conds = [];
  const searchPred = tokenPred('vlastnik_norm', search, { prefixFirst: false });
  const vlastPred = tokenPred('vlastnik_norm', fVlast, { prefixFirst: false });
  const kuPred = tokenPred('ku_norm', fKu, { prefixFirst: false });
  if (searchPred) conds.push(searchPred);
  if (vlastPred) conds.push(vlastPred);
  if (kuPred) conds.push(kuPred);
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
  const search = q.q || '';
  const fKu = q.f_ku || '';
  const fName = q.f_name || '';
  const fCislo = (q.f_cislo || '').trim().replace(/'/g, "''");
  const fLv = (q.f_lv || '').trim().replace(/'/g, "''");
  const conds = [];
  const searchPred = tokenPred('meno_norm', search);
  const namePred = tokenPred('meno_norm', fName);
  const kuPred = tokenPred('ku_norm', fKu, { prefixFirst: false });
  if (searchPred) conds.push(searchPred);
  if (kuPred) conds.push(kuPred);
  if (fCislo) conds.push(`CAST(poradove_cislo AS VARCHAR) LIKE '%${fCislo}%'`);
  if (fLv) conds.push(`CAST(lv AS VARCHAR) LIKE '%${fLv}%'`);
  if (namePred) conds.push(namePred);
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
  const search = q.q || '';
  const fVlast = q.f_vlast || q.f_vast || '';
  const fKu = q.f_ku || '';
  const fLv = (q.f_lv || '').trim().replace(/'/g, "''");
  const fCislo = (q.f_cislo || '').trim().replace(/'/g, "''");
  const fDatum = (q.f_datum || '').trim().replace(/'/g, "''");
  const fYear = parseInt(q.f_year, 10) || null;
  const conds = [];
  const searchPred = tokenPred('vlastnik_norm', search, { prefixFirst: false });
  const vlastPred = tokenPred('vlastnik_norm', fVlast, { prefixFirst: false });
  const kuPred = tokenPred('ku_norm', fKu, { prefixFirst: false });
  if (searchPred) conds.push(searchPred);
  if (vlastPred) conds.push(vlastPred);
  if (kuPred) conds.push(kuPred);
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
  const searchName = (q.name || '').trim();
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
async function swapAnalysis(q) {
  const kuQuery = (q.ku || '').trim();
  const nameQuery = (q.name || '').trim();

  let kuWhere = '1=1';
  if (kuQuery) {
    if (/^\d+$/.test(kuQuery)) {
      kuWhere = `d.cislo_ku = ${parseInt(kuQuery, 10)}`;
    } else {
      kuWhere = `(d.nazov_ku ILIKE '%${escSql(kuQuery)}%' OR d.obec ILIKE '%${escSql(kuQuery)}%')`;
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

  // Build owner map and LV map
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

    const normKey = foldName(o.meno_vlastnika).trim();
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

  // 1. Bilateral Swap Opportunities
  const swapOpportunities = [];
  const ownerKeys = Array.from(ownerMap.keys());

  for (let i = 0; i < ownerKeys.length; i++) {
    for (let j = i + 1; j < ownerKeys.length; j++) {
      const oA = ownerMap.get(ownerKeys[i]);
      const oB = ownerMap.get(ownerKeys[j]);

      // Check all pairs of holdings
      for (const hA of oA.holdings) {
        for (const hB of oB.holdings) {
          if (hA.cislo_ku !== hB.cislo_ku || hA.lv === hB.lv) continue;

          // Swap candidate: A gives hA on LV1 to B; B gives hB on LV2 to A
          const m2A = hA.owned_m2;
          const m2B = hB.owned_m2;
          if (m2A <= 0 || m2B <= 0) continue;

          const diffM2 = Math.round(Math.abs(m2A - m2B) * 100) / 100;
          const maxM2 = Math.max(m2A, m2B);
          const diffPct = maxM2 > 0 ? (diffM2 / maxM2) : 1;

          if (diffPct <= 0.40) { // Max 40% difference for a realistic swap
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

  // 2. Buyout & Consolidation Targets (LVs where an owner has >= 25% or highest share)
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

  // 3. Physical Subdivision Candidates (parcels with owned share >= 2000 m2)
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

  return {
    kuQuery,
    nameQuery,
    storedLvCount: allLvs.length,
    storedOwnersCount: ownersList.length,
    lvs: allLvs,
    owners: ownersList,
    swapOpportunities: swapOpportunities.slice(0, 50),
    buyoutTargets: buyoutTargets.slice(0, 50),
    subdivisionCandidates: subdivisionCandidates.slice(0, 50),
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
    const raw = item.html || item.text || '';
    const hasParsed = Array.isArray(item.parsed?.parcels) || Array.isArray(item.parsed?.owners);
    if (!lv || !ku) continue;
    if (!hasParsed && (!raw || raw.length < 80)) continue;
    const parsed = hasParsed ? item.parsed : parseVypisInput(raw, lv, ku);
    const doc = {
      ...(parsed.doc || {}),
      lv: parsed.doc?.lv || lv,
      cislo_ku: parsed.doc?.cislo_ku || ku,
      nazov_ku: parsed.doc?.nazov_ku || item.kuName || '',
      okres: parsed.doc?.okres || '',
      obec: parsed.doc?.obec || '',
      pocet_parciel_c: parsed.doc?.pocet_parciel_c ?? (parsed.parcels || []).filter((p) => p.register_type === 'C').length,
      pocet_parciel_e: parsed.doc?.pocet_parciel_e ?? (parsed.parcels || []).filter((p) => p.register_type === 'E').length,
      celkova_vymera_m2: parsed.doc?.celkova_vymera_m2 ?? (parsed.parcels || []).reduce((s, p) => s + (Number(p.vymera_m2) || 0), 0),
      pocet_vlastnikov: parsed.doc?.pocet_vlastnikov ?? (parsed.owners || []).length,
    };
    if (!parsed.parcels?.length && !parsed.owners?.length) continue;

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

    for (const p of parsed.parcels || []) {
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

    for (const o of parsed.owners || []) {
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
    if (isLvVypisHtml(html)) return html;
  } catch (_) {
    /* CORS + reCAPTCHA on GitHub Pages — fall through */
  }
  return '';
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
      result = await coalesceSearch(options.signal, () => overviewSearch(q));
      break;
    case 'place-search':
      result = await placeSearch(q);
      break;
    case 'name-search':
      result = await coalesceSearch(options.signal, () => nameSearch(q));
      break;
    case 'name-districts':
      result = await nameDistricts(q);
      break;
    case 'name-ku-detail':
      result = await nameKuDetail(q);
      break;
    case 'solo-lvs':
      result = await soloLvs(q);
      break;
    case 'lv-parcels':
      result = await lvParcels(q);
      break;
    case 'lv-extract':
      result = await lvExtract(q);
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
    case 'swap-analysis':
      result = await swapAnalysis(q);
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
