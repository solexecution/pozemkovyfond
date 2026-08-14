/**
 * Fetch Kataster výpis (parcels + výmera) for solo LVs via Playwright.
 *
 * Official GeneratePrfPublic is recaptcha-gated. Run headed once, solve the
 * captcha, then the persistent profile reuses the cookie for later LVs.
 *
 *   node fetch-solo-lvs.mjs --ku sulin --limit 10 --headed
 *   node fetch-solo-lvs.mjs --lv 1208 --cislo 859559 --headed
 */
import { chromium } from 'playwright';
import { DuckDBInstance } from '@duckdb/node-api';
import { mkdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseLvHtml, parseLvText } from './lv_parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = path.join(__dirname, '.browser-data');
const DB_PATH = path.join(__dirname, 'pzf.duckdb');
const OUT = path.join(__dirname, 'data').replace(/\\/g, '/');

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : '1';
}
const has = (name) => process.argv.includes(`--${name}`);

function fold(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function lvUrl(lv, ku, type = 'html') {
  return `https://kataster.skgeodesy.sk/Portal45/api/Bo/GeneratePrfPublic?prfNumber=${lv}&cadastralUnitCode=${ku}&outputType=${type}`;
}

function isCaptcha(html, text) {
  const blob = `${html}\n${text}`;
  return /g-recaptcha|recaptcha|captchaIsReady/i.test(blob) && !/MAJETKOVÁ PODSTATA|VÝPIS Z LISTU VLASTNÍCTVA/i.test(text);
}

function isLvText(text) {
  return /MAJETKOVÁ PODSTATA|VÝPIS Z LISTU VLASTNÍCTVA|Parcely registra/i.test(text || '');
}

async function queryAll(conn, sql) {
  return (await conn.runAndReadAll(sql)).getRowObjectsJS();
}

async function ensureTables(conn) {
  await conn.run(`
    CREATE TABLE IF NOT EXISTS lv_details (
      lv INTEGER, cislo_ku INTEGER, nazov_ku VARCHAR, okres VARCHAR, obec VARCHAR,
      pocet_parciel_c INTEGER, pocet_parciel_e INTEGER, celkova_vymera_m2 DOUBLE,
      pocet_vlastnikov INTEGER, fetched_at TIMESTAMP,
      PRIMARY KEY (lv, cislo_ku)
    )
  `);
  await conn.run(`
    CREATE TABLE IF NOT EXISTS lv_parcels (
      id VARCHAR PRIMARY KEY, lv INTEGER, cislo_ku INTEGER, register_type VARCHAR,
      parcel_no VARCHAR, vymera_m2 DOUBLE, druh_pozemku VARCHAR
    )
  `);
  await conn.run(`
    CREATE TABLE IF NOT EXISTS lv_owners (
      id VARCHAR PRIMARY KEY, lv INTEGER, cislo_ku INTEGER, poradove_cislo INTEGER,
      meno_vlastnika VARCHAR, datum_narodenia VARCHAR, podiel_str VARCHAR,
      podiel_num BIGINT, podiel_den BIGINT, podiel_decimal DOUBLE, titul_nadobudnutia VARCHAR
    )
  `);
}

function esc(s) {
  return String(s ?? '').replace(/'/g, "''");
}

async function saveParsed(conn, parsed, item) {
  const doc = parsed.doc;
  await conn.run(`
    INSERT OR REPLACE INTO lv_details
      (lv, cislo_ku, nazov_ku, okres, obec, pocet_parciel_c, pocet_parciel_e, celkova_vymera_m2, pocet_vlastnikov, fetched_at)
    VALUES (
      ${doc.lv || item.lv}, ${doc.cislo_ku || item.cislo_ku},
      '${esc(doc.nazov_ku || item.katastralne_uzemie)}',
      '${esc(doc.okres)}', '${esc(doc.obec)}',
      ${doc.pocet_parciel_c || 0}, ${doc.pocet_parciel_e || 0},
      ${doc.celkova_vymera_m2 || 0}, ${doc.pocet_vlastnikov || 0},
      CURRENT_TIMESTAMP
    )
  `);
  for (const p of parsed.parcels) {
    const id = `${doc.cislo_ku || item.cislo_ku}_${doc.lv || item.lv}_${p.register_type}_${p.parcel_no}`.replace(/[/\s]/g, '_');
    await conn.run(`
      INSERT OR REPLACE INTO lv_parcels
        (id, lv, cislo_ku, register_type, parcel_no, vymera_m2, druh_pozemku)
      VALUES (
        '${esc(id)}', ${doc.lv || item.lv}, ${doc.cislo_ku || item.cislo_ku},
        '${esc(p.register_type)}', '${esc(p.parcel_no)}', ${p.vymera_m2}, '${esc(p.druh_pozemku)}'
      )
    `);
  }
  for (const o of parsed.owners) {
    const id = `${doc.cislo_ku || item.cislo_ku}_${doc.lv || item.lv}_${o.poradove_cislo}`;
    await conn.run(`
      INSERT OR REPLACE INTO lv_owners
        (id, lv, cislo_ku, poradove_cislo, meno_vlastnika, datum_narodenia, podiel_str, podiel_num, podiel_den, podiel_decimal, titul_nadobudnutia)
      VALUES (
        '${esc(id)}', ${doc.lv || item.lv}, ${doc.cislo_ku || item.cislo_ku}, ${o.poradove_cislo},
        '${esc(o.meno_vlastnika)}', '${esc(o.datum_narodenia)}',
        '${esc(o.podiel_str)}', ${o.podiel_num}, ${o.podiel_den}, ${o.podiel_decimal},
        '${esc(o.titul_nadobudnutia)}'
      )
    `);
  }
}

async function exportParquet(conn) {
  mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  for (const t of ['lv_details', 'lv_parcels', 'lv_owners']) {
    await conn.run(`COPY ${t} TO '${OUT}/${t}.parquet' (FORMAT PARQUET, COMPRESSION ZSTD, COMPRESSION_LEVEL 9)`);
  }
  console.log('Wrote data/lv_details.parquet, lv_parcels.parquet, lv_owners.parquet');
}

async function fetchOne(page, item, headed) {
  const url = lvUrl(item.lv, item.cislo_ku, 'html');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1200);
  let html = await page.content();
  let text = await page.evaluate(() => document.body?.innerText || '');

  if (isCaptcha(html, text)) {
    if (!headed) {
      return { ok: false, reason: 'captcha', item };
    }
    console.log(`  Captcha on LV ${item.lv} / ${item.cislo_ku} — vyrieš ju v okne, čakám max 3 min…`);
    try {
      await page.waitForFunction(
        () => /MAJETKOVÁ PODSTATA|VÝPIS Z LISTU VLASTNÍCTVA|Parcely registra/i.test(document.body?.innerText || ''),
        null,
        { timeout: 180000 },
      );
    } catch {
      return { ok: false, reason: 'captcha-timeout', item };
    }
    html = await page.content();
    text = await page.evaluate(() => document.body?.innerText || '');
  }

  if (!isLvText(text) && !isLvText(html)) {
    return { ok: false, reason: 'not-lv', item };
  }

  const parsed = parseLvHtml(html, item.lv, item.cislo_ku);
  if (!parsed.parcels.length) {
    const again = parseLvText(text, item.lv, item.cislo_ku);
    if (again.parcels.length) return { ok: true, parsed: again, item };
  }
  if (!parsed.doc.celkova_vymera_m2 && !parsed.parcels.length) {
    return { ok: false, reason: 'no-parcels', item, parsed };
  }
  return { ok: true, parsed, item };
}

async function main() {
  const ku = arg('ku');
  const name = arg('name');
  const limit = Math.max(1, parseInt(arg('limit', '10'), 10) || 10);
  const oneLv = arg('lv');
  const oneKu = arg('cislo');
  const headed = has('headed') || !has('headless');
  const skipDone = !has('refetch');

  const db = await DuckDBInstance.create(existsSync(DB_PATH) ? DB_PATH : ':memory:');
  const conn = await db.connect();
  await ensureTables(conn);

  let targets = [];
  if (oneLv && oneKu) {
    targets = [{ lv: Number(oneLv), cislo_ku: Number(oneKu), katastralne_uzemie: '', meno_vlastnika: '' }];
  } else {
    const conds = [];
    if (ku) conds.push(`contains(ku_norm, '${fold(ku).replace(/'/g, "''")}')`);
    if (name) conds.push(`contains(meno_norm, '${fold(name).replace(/'/g, "''")}')`);
    if (!conds.length) {
      console.error('Zadaj --ku <k.ú.> alebo --lv <n> --cislo <kód k.ú.>. Bez filtra by sme ťahali 491k listov.');
      process.exit(1);
    }
    const where = `WHERE ${conds.join(' AND ')}`;
    targets = await queryAll(conn, `
      SELECT DISTINCT lv, cislo_ku, katastralne_uzemie, meno_vlastnika
      FROM read_parquet('${OUT}/solo_lvs.parquet')
      ${where}
      ORDER BY katastralne_uzemie, lv
      LIMIT ${limit}
    `);
    if (!targets.length) {
      // duckdb file might have solo_lvs table
      try {
        targets = await queryAll(conn, `
          SELECT DISTINCT lv, cislo_ku, katastralne_uzemie, meno_vlastnika
          FROM solo_lvs ${where}
          ORDER BY katastralne_uzemie, lv
          LIMIT ${limit}
        `);
      } catch { /* ignore */ }
    }
  }

  if (skipDone && targets.length) {
    const have = new Set(
      (await queryAll(conn, `SELECT lv, cislo_ku FROM lv_details WHERE celkova_vymera_m2 > 0`))
        .map((r) => `${r.lv}|${r.cislo_ku}`),
    );
    targets = targets.filter((t) => !have.has(`${t.lv}|${t.cislo_ku}`));
  }

  if (!targets.length) {
    console.log('Nič na stiahnutie (už máme výmeru, alebo filter je prázdny).');
    await exportParquet(conn);
    return;
  }

  console.log(`Sťahujem ${targets.length} solo LV z Katastra (${headed ? 'headed' : 'headless'})…`);
  mkdirSync(PROFILE, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: !headed,
    locale: 'sk-SK',
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();

  let ok = 0;
  let fail = 0;
  for (let i = 0; i < targets.length; i++) {
    const item = targets[i];
    process.stdout.write(`[${i + 1}/${targets.length}] LV ${item.lv} ${item.katastralne_uzemie || item.cislo_ku}… `);
    try {
      const res = await fetchOne(page, item, headed);
      if (res.ok) {
        await saveParsed(conn, res.parsed, item);
        ok++;
        console.log(`ok  ${res.parsed.doc.celkova_vymera_m2} m²  ${res.parsed.parcels.length} parciel`);
      } else {
        fail++;
        console.log(`fail (${res.reason})`);
        if (res.reason === 'captcha' && !headed) {
          console.log('Spusti znova s --headed a vyrieš captcha v prvom okne.');
          break;
        }
      }
    } catch (e) {
      fail++;
      console.log('error', e.message);
    }
    await page.waitForTimeout(1500);
  }

  await ctx.close();
  await exportParquet(conn);
  console.log(`Hotovo: ${ok} uložených, ${fail} zlyhaní.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
