/**
 * app.js — PZF Data Explorer Frontend Logic
 * Vanilla JS + Chart.js + DuckDB WASM
 * Instant character-by-character filtering with diacritics neutralization, event delegation & focus protection.
 */

import { initDb, apiRequest } from './db.js';

async function apiFetch(path, options = {}) {
  const data = await apiRequest(path, options);
  const isHtml = typeof data === 'string';
  return {
    ok: true,
    json: async () => (isHtml ? { html: data } : data),
    text: async () => (isHtml ? data : JSON.stringify(data)),
  };
}

// ── Chart.js Defaults ──────────────────────────────────────────────────────
Chart.defaults.color       = '#8b95a8';
Chart.defaults.borderColor = '#252a38';
Chart.defaults.font.family = "Inter, system-ui, sans-serif";
Chart.defaults.font.size   = 11;
Chart.defaults.plugins.legend.labels.boxWidth = 12;
Chart.defaults.plugins.legend.labels.usePointStyle = true;

const THEME_KEY = 'pzf-theme';

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function applyChartTheme(theme) {
  if (typeof Chart === 'undefined') return;
  Chart.defaults.color = theme === 'light' ? '#475569' : '#8b95a8';
  Chart.defaults.borderColor = theme === 'light' ? '#e2e8f0' : '#252a38';
  document.querySelectorAll('canvas').forEach((canvas) => {
    const chart = Chart.getChart?.(canvas);
    if (!chart) return;
    chart.options.color = Chart.defaults.color;
    chart.update('none');
  });
}

function applyTheme(theme, persist = true) {
  const next = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  if (persist) {
    try { localStorage.setItem(THEME_KEY, next); } catch (_) { /* private mode */ }
  }
  applyChartTheme(next);
  applyMapTheme(next);
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    const toLight = next === 'dark';
    btn.setAttribute('aria-label', toLight ? 'Zapnúť svetlý motív' : 'Zapnúť tmavý motív');
    btn.title = toLight ? 'Svetlý motív' : 'Tmavý motív';
  }
}

function toggleTheme() {
  applyTheme(currentTheme() === 'light' ? 'dark' : 'light');
}
window.toggleTheme = toggleTheme;

applyChartTheme(currentTheme());
try {
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
    try { if (localStorage.getItem(THEME_KEY)) return; } catch (_) { /* ignore */ }
    applyTheme(e.matches ? 'light' : 'dark', false);
  });
} catch (_) { /* ignore */ }

const PALETTE = [
  '#3b82f6','#6366f1','#8b5cf6','#ec4899',
  '#06b6d4','#10b981','#f59e0b','#ef4444',
  '#14b8a6','#a855f7','#f97316','#84cc16',
  '#0ea5e9','#d946ef','#22c55e','#eab308',
  '#64748b','#78716c','#71717a','#6b7280',
];

// ── Utilities ──────────────────────────────────────────────────────────────
function fmt(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('sk-SK');
}
function fmtDate(s) { return s || '—'; }

const SK_FOLD = {
  á: 'a', ä: 'a', č: 'c', ď: 'd', é: 'e', í: 'i', ĺ: 'l', ľ: 'l',
  ň: 'n', ó: 'o', ô: 'o', ŕ: 'r', š: 's', ť: 't', ú: 'u', ý: 'y', ž: 'z',
  ě: 'e', ů: 'u', ł: 'l', ą: 'a', ę: 'e',
};

function fold(s) {
  return String(s || '')
    .replace(/[áäčďéěíĺľłňóôŕšťúůýžąę]/gi, (ch) => SK_FOLD[ch.toLowerCase()] || ch)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function tokensOf(s) {
  return fold(s).split(/[^a-z0-9]+/).filter((t) => t.length >= 1);
}

function matchesFolded(text, query) {
  const toks = tokensOf(query);
  if (!toks.length) return true;
  const hay = fold(text);
  return toks.every((t) => hay.includes(t));
}

function esc(s) {
  if (s === null || s === undefined) return '—';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cellSortKey(td) {
  const raw = (td?.innerText || td?.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  if (!raw || raw === '—' || raw === '-') return { empty: true, n: 0, s: '' };
  const lv = raw.match(/LV\s+([\d ]+)/i);
  if (lv) return { n: Number(lv[1].replace(/\s/g, '')), s: '' };
  const stripped = raw.replace(/[^\d,.\s-]/g, '').replace(/\s/g, '').replace(',', '.');
  const leftover = raw.replace(/[\d\s.,%\-–]/g, '').replace(/m²|ha|LV|↗|📄|📜/gi, '').trim();
  if (stripped && /^-?\d+(\.\d+)?$/.test(stripped) && leftover.length <= 3) {
    return { n: Number(stripped), s: '' };
  }
  return {
    n: 0,
    s: raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(),
  };
}

function sortTableByColumn(table, colIdx, th) {
  const tbody = table.querySelector('tbody');
  if (!tbody) return;
  const dir = th.dataset.sortDir === 'ASC' ? 'DESC' : 'ASC';
  th.parentElement.querySelectorAll('th').forEach((h) => {
    h.classList.remove('sort-active');
    const ic = h.querySelector('.sort-ic');
    if (ic) ic.textContent = '↕';
    delete h.dataset.sortDir;
  });
  th.classList.add('sort-active');
  th.dataset.sortDir = dir;
  const ic = th.querySelector('.sort-ic');
  if (ic) ic.textContent = dir === 'ASC' ? '↑' : '↓';
  const mul = dir === 'ASC' ? 1 : -1;
  const rows = [...tbody.querySelectorAll(':scope > tr')];
  rows.sort((a, b) => {
    const ka = cellSortKey(a.cells[colIdx]);
    const kb = cellSortKey(b.cells[colIdx]);
    if (ka.empty && !kb.empty) return 1;
    if (kb.empty && !ka.empty) return -1;
    if (ka.s || kb.s) return ka.s.localeCompare(kb.s, 'sk', { sensitivity: 'base' }) * mul;
    if (ka.n !== kb.n) return (ka.n - kb.n) * mul;
    return 0;
  });
  const frag = document.createDocumentFragment();
  rows.forEach((r) => frag.appendChild(r));
  tbody.appendChild(frag);
}

function decorateTableHeaders(table) {
  if (!table || table.tagName !== 'TABLE') return;
  const headerRow = table.querySelector('thead tr:first-child');
  if (!headerRow) return;
  headerRow.querySelectorAll('th').forEach((th) => {
    if (th.classList.contains('filter-cell') || th.querySelector('input, button, select')) return;
    if (th.hasAttribute('onclick')) return;
    const label = (th.textContent || '').replace(/[↕↑↓]/g, '').trim();
    if (!label || label === '#') return;
    th.classList.add('sortable');
    th.dataset.domSort = '1';
    if (!th.querySelector('.sort-ic')) {
      th.insertAdjacentHTML('beforeend', '<span class="sort-ic">↕</span>');
    }
  });
}

function installTableSortObserver() {
  if (window._tableSortReady) return;
  window._tableSortReady = true;
  document.addEventListener('click', (e) => {
    const th = e.target.closest('th.sortable[data-dom-sort]');
    if (!th) return;
    if (e.target.closest('input, button, a, select')) return;
    const table = th.closest('table');
    if (!table) return;
    const idx = [...th.parentElement.children].indexOf(th);
    sortTableByColumn(table, idx, th);
  });
  const scan = (root) => {
    if (!root || root.nodeType !== 1) return;
    if (root.matches?.('table')) decorateTableHeaders(root);
    root.querySelectorAll?.('table').forEach(decorateTableHeaders);
  };
  scan(document);
  new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) scan(n);
    }
  }).observe(document.body, { childList: true, subtree: true });
}
installTableSortObserver();

const _trackQueue = [];
let _trackTimer = null;
let _searchTrackTimer = null;

function trackVal(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return String(v).replace(/\s+/g, ' ').trim().slice(0, 120);
}

function umamiOptedOut() {
  try {
    if (localStorage.getItem('umami.disabled')) return true;
    if (/(?:^|;\s*)umami\.disabled=1/.test(document.cookie)) return true;
  } catch (_) {}
  const host = location.hostname;
  return host === 'localhost' || host === '127.0.0.1';
}

function track(event, data) {
  if (umamiOptedOut()) return;
  const payload = {};
  if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data)) {
      const n = trackVal(v);
      if (n === null || n === '') continue;
      payload[k] = n;
    }
  }
  const send = () => {
    if (typeof umami === 'object' && typeof umami.track === 'function') {
      try { umami.track(event, payload); } catch (_) {}
      return true;
    }
    return false;
  };
  if (send()) return;
  _trackQueue.push([event, payload]);
  if (_trackTimer) return;
  const started = Date.now();
  _trackTimer = setInterval(() => {
    if (typeof umami === 'object' && typeof umami.track === 'function') {
      while (_trackQueue.length) {
        const [name, d] = _trackQueue.shift();
        try { umami.track(name, d); } catch (_) {}
      }
      clearInterval(_trackTimer);
      _trackTimer = null;
      return;
    }
    if (Date.now() - started > 10000) {
      _trackQueue.length = 0;
      clearInterval(_trackTimer);
      _trackTimer = null;
    }
  }, 300);
}

function trackSearchSettled(data) {
  clearTimeout(_searchTrackTimer);
  _searchTrackTimer = setTimeout(() => track('search', data), 800);
}

function showToast(msg, type = 'info') {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.style.borderLeft = `3px solid ${type === 'error' ? '#ef4444' : type === 'success' ? '#10b981' : '#3b82f6'}`;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

function openKatasterLV(kuName, kuCislo, lv) {
  if (!lv) return;
  const kuText = kuName ? kuName.trim() : '';
  const info = `${kuText}${kuCislo ? ` (k.ú. ${kuCislo})` : ''}, LV ${lv}`;

  try {
    navigator.clipboard.writeText(info);
  } catch (_) {}

  const cleanCislo = kuCislo ? String(kuCislo).trim() : '';
  track('kataster', {
    name: ovSearch?.pickName || '',
    ku: kuText,
    ku_code: cleanCislo,
    lv,
  });
  if (cleanCislo) {
    showToast(`📜 Otváram priamy Výpis z LV č. ${lv} (${kuText})...`, 'success');
    window.open(`https://kataster.skgeodesy.sk/Portal45/api/Bo/GeneratePrfPublic?prfNumber=${lv}&cadastralUnitCode=${cleanCislo}&outputType=html`, '_blank');
  } else {
    showToast(`Otváram Kataster Portal pre ${info}...`, 'info');
    window.open('https://kataster.skgeodesy.sk/eskn-portal/search/lv', '_blank');
  }
}
window.openKatasterLV = openKatasterLV;

// ── Universal Focus Preservation ───────────────────────────────────────────
function captureFocus() {
  const el = document.activeElement;
  if (!el || !el.id) return null;
  return {
    id: el.id,
    start: typeof el.selectionStart === 'number' ? el.selectionStart : null,
    end: typeof el.selectionEnd === 'number' ? el.selectionEnd : null,
  };
}

function restoreFocus(info) {
  if (!info || !info.id) return;
  const el = document.getElementById(info.id);
  if (el) {
    el.focus();
    if (info.start !== null && info.end !== null) {
      try { el.setSelectionRange(info.start, info.end); } catch (_) {}
    }
  }
}

function isAdm() {
  if (window.PZF_ADM) return true;
  const path = (location.pathname || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return /(^|\/)adm$/i.test(path) || /(^|\/)adm\/index\.html$/i.test(path);
}
if (isAdm()) {
  window.PZF_ADM = true;
  document.body.classList.add('adm');
}

// ── Tab Navigation ─────────────────────────────────────────────────────────
const tabLoaded = {};
function closeRegMenu() {
  const dd = document.getElementById('reg-dropdown');
  const btn = document.getElementById('reg-toggle');
  const wrap = document.getElementById('reg-wrap');
  if (dd) dd.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
  if (wrap) wrap.classList.remove('open');
}
function toggleRegMenu() {
  const dd = document.getElementById('reg-dropdown');
  if (!dd) return;
  const open = dd.hidden;
  if (open) {
    dd.hidden = false;
    document.getElementById('reg-toggle')?.setAttribute('aria-expanded', 'true');
    document.getElementById('reg-wrap')?.classList.add('open');
  } else {
    closeRegMenu();
  }
}
function goHome() {
  closeRegMenu();
  clearOverviewSearch();
}
function showTab(name) {
  closeRegMenu();
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const tab = document.getElementById('tab-' + name);
  if (tab) tab.classList.add('active');
  const nav = document.getElementById('nav-' + name);
  if (nav) nav.classList.add('active');
  document.body.classList.toggle('register-view', name !== 'overview');
  if (name !== 'overview') document.body.classList.remove('landing-mode');
  if (name !== 'overview') track('tab', { tab: name });
  if (!tabLoaded[name]) {
    tabLoaded[name] = true;
    switch (name) {
      case 'solo':         loadSoloLvs();      break;
      case 'owners':       loadOwners();       break;
      case 'transferred':  loadTransferred();  break;
      case 'overlap':      loadOverlap();      break;
      case 'correlations': loadCorrelations(); break;
      case 'map':          initSlovakiaMap();  break;
    }
  }
  if (name === 'map') {
    initSlovakiaMap();
    setTimeout(() => {
      if (skMap) skMap.invalidateSize();
      applyMapSearchFilter({ fit: true, force: true });
    }, 150);
  }
}
window.showTab = showTab;
window.toggleRegMenu = toggleRegMenu;
window.goHome = goHome;
document.addEventListener('click', (e) => {
  if (!e.target.closest('#reg-wrap')) closeRegMenu();
  if (!e.target.closest('#overview-place, #results-place, #overview-search, #header-search, .whisper')) hideWhisper();
});

// ── DB Status ──────────────────────────────────────────────────────────────
async function checkDbStatus() {
  const dot  = document.getElementById('db-dot');
  const text = document.getElementById('db-status-text');
  try {
    const r = await apiFetch(`/stats`);
    if (!r.ok) throw new Error('not ok');
    if (dot) dot.className = 'db-dot online';
    if (text) text.textContent = 'Pripojené';
    return await r.json();
  } catch {
    if (dot) { dot.className = 'db-dot'; dot.style.background = '#ef4444'; }
    if (text) text.textContent = 'Chyba pripojenia';
    showToast('Nepodarilo sa pripojiť na server.', 'error');
    return null;
  }
}

// ── Overview Tab ───────────────────────────────────────────────────────────
async function loadOverview() {
  const stats = await checkDbStatus();
  if (!stats) return;

  const setTxt = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  setTxt('s-total-uo', fmt(stats.total_unknown_owners));
  setTxt('s-unique-ku', fmt(stats.unique_katastralne));
  setTxt('s-unique-lv', fmt(stats.unique_lv_uo));
  setTxt('s-unique-names', fmt(stats.unique_names));
  setTxt('s-transferred', fmt(stats.total_transferred));
  setTxt('s-overlap', fmt(stats.overlap_count));

  const scale = document.getElementById('landing-scale');
  if (scale) {
    scale.textContent = `${fmt(stats.total_unknown_owners)} záznamov · ${fmt(stats.unique_names)} mien · ${fmt(stats.unique_katastralne)} katastrálnych území`;
  }
}

let chartTopKu = null;
async function loadTopKuChart() {
  const data = await apiFetch(`/top-katastralne?limit=20`).then(r => r.json());
  if (chartTopKu) chartTopKu.destroy();
  chartTopKu = new Chart(document.getElementById('chart-top-ku'), {
    type: 'bar',
    data: {
      labels: data.map(d => d.katastralne_uzemie),
      datasets: [{ label: 'Počet vlastníkov', data: data.map(d => d.owner_count),
        backgroundColor: PALETTE[0] + 'cc', borderColor: PALETTE[0], borderWidth: 1, borderRadius: 4 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: '#1f2435' }, ticks: { callback: v => fmt(v) } },
        y: { grid: { display: false }, ticks: { font: { size: 10 } } },
      }
    }
  });
}

let chartTopKuTr = null;
async function loadTopKuTrChart() {
  const data = await apiFetch(`/transferred-top-ku?limit=20`).then(r => r.json());
  if (chartTopKuTr) chartTopKuTr.destroy();
  chartTopKuTr = new Chart(document.getElementById('chart-top-ku-tr'), {
    type: 'bar',
    data: {
      labels: data.map(d => d.nazov_ku || `k.ú.${d.cislo_ku}`),
      datasets: [{ label: 'Počet prevedených práv', data: data.map(d => d.transfer_count),
        backgroundColor: PALETTE[1] + 'cc', borderColor: PALETTE[1], borderWidth: 1, borderRadius: 4 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: '#1f2435' }, ticks: { callback: v => fmt(v) } },
        y: { grid: { display: false }, ticks: { font: { size: 10 } } },
      }
    }
  });
}

let chartByYear = null;
async function loadByYearChart() {
  const data = await apiFetch(`/transferred-by-year`).then(r => r.json());
  if (chartByYear) chartByYear.destroy();
  chartByYear = new Chart(document.getElementById('chart-by-year'), {
    type: 'bar',
    data: {
      labels: data.map(d => String(d.year)),
      datasets: [
        { label: 'Prevedených záznamov', data: data.map(d => d.transfer_count),
          backgroundColor: PALETTE[4] + 'bb', borderColor: PALETTE[4], borderRadius: 6, yAxisID: 'y' },
        { label: 'Unikátnych LV', data: data.map(d => d.unique_lv), type: 'line',
          borderColor: PALETTE[5], backgroundColor: PALETTE[5] + '22',
          pointBackgroundColor: PALETTE[5], fill: true, tension: 0.3, yAxisID: 'y1' },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'top' } },
      scales: {
        y:  { grid: { color: '#1f2435' }, ticks: { callback: v => fmt(v) } },
        y1: { display: false },
      }
    }
  });
}

let chartAlpha = null;
async function loadAlphaChart() {
  const data = await apiFetch(`/alpha-distribution`).then(r => r.json());
  if (chartAlpha) chartAlpha.destroy();
  chartAlpha = new Chart(document.getElementById('chart-alpha'), {
    type: 'bar',
    data: {
      labels: data.map(d => d.first_letter),
      datasets: [{ label: 'Počet neznámych vlastníkov', data: data.map(d => d.owner_count),
        backgroundColor: data.map((_, i) => PALETTE[i % PALETTE.length] + 'bb'), borderRadius: 4 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false } },
        y: { grid: { color: '#1f2435' }, ticks: { callback: v => fmt(v) } },
      }
    }
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  OVERVIEW SEARCH
// ════════════════════════════════════════════════════════════════════════════

const ovSearch = {
  q: '',
  page: 1,
  fName: '',
  fKu: '',
  placeQ: '',
  pickName: '',
  pickKu: '',
  names: [],
  places: [],
  districts: [],
  variantMap: {},
  sortCol: 'portion',
  sortDir: 'DESC',
  step: 'names',
  holdNames: false,
  holdPlaces: false,
};

function cleanPersonName(raw) {
  let t = String(raw || '').replace(/\u00a0/g, ' ');
  t = t.replace(/\(SPF\)/gi, ' ');
  t = t.replace(/\[SPF\]/gi, ' ');
  t = t.replace(/\bSPF\b/gi, ' ');
  t = t.replace(/\bUSA\b/g, ' ');
  t = t.replace(/,?\s*\bSR\b/g, ' ');
  t = t.replace(/pôv\.?\s*zápis/gi, ' ');
  t = t.replace(/D:\([^)]*\)/gi, ' ');
  t = t.replace(/D:[^\s,;|]*/gi, ' ');
  t = t.replace(/\(ž[^)]*\)/gi, ' ');
  t = t.replace(/\(m[.,][^)]*\)/gi, ' ');
  const maiden = t.match(/\((r\.\s*[^),]+)\)/i);
  const before = t.split('(')[0];
  if (before.replace(/[^A-Za-zÁáÄäČčĎďÉéÍíĽľĹĺŇňÓóÔôŔŕŠšŤťÚúÝýŽž]/g, '').length >= 5) {
    t = before;
    if (maiden && !/r\./i.test(t)) t += ` ${maiden[1]}`;
  }
  t = t.replace(/(?:^|[\s,;])ž\s+\S+(?:\s+r\.\s+\S+)?/gi, ' ');
  t = t.replace(/[,;|/]+/g, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/^[,\-\s]+|[,\-\s]+$/g, '');
  return t || String(raw || '').trim();
}

function nameKey(s) {
  return fold(cleanPersonName(s));
}

function groupCleanNames(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const clean = cleanPersonName(r.meno_vlastnika);
    const key = nameKey(clean);
    if (!map.has(key)) {
      map.set(key, {
        ...r,
        meno_vlastnika: clean,
        variants: [r.meno_vlastnika],
      });
    } else {
      const g = map.get(key);
      if (!g.variants.includes(r.meno_vlastnika)) g.variants.push(r.meno_vlastnika);
      g.recs = Number(g.recs || 0) + Number(r.recs || 0);
      g.lvs = Number(g.lvs || 0) + Number(r.lvs || 0);
      g.solo_lvs = Number(g.solo_lvs || 0) + Number(r.solo_lvs || 0);
      g.portion = Math.round((Number(g.portion || 0) + Number(r.portion || 0)) * 100) / 100;
      g.districts = Math.max(Number(g.districts || 0), Number(r.districts || 0));
      if (Number(r.recs || 0) > Number(g.top_ku_recs || 0)) {
        g.top_ku = r.top_ku;
        g.top_ku_code = r.top_ku_code;
        g.top_ku_recs = r.top_ku_recs;
        g.top_ku_lvs = r.top_ku_lvs;
        g.top_ku_solo = r.top_ku_solo;
        g.top_ku_portion = r.top_ku_portion;
      }
      const tot = Number(g.recs || 0);
      g.top_ku_pct = tot ? Math.round(100 * Number(g.top_ku_recs || 0) / tot) : 0;
    }
  }
  const grouped = [...map.values()].sort((a, b) => Number(b.portion || 0) - Number(a.portion || 0) || Number(b.recs || 0) - Number(a.recs || 0));
  ovSearch.variantMap = {};
  for (const g of grouped) ovSearch.variantMap[g.meno_vlastnika] = g.variants;
  return grouped;
}

function variantsFor(name) {
  return ovSearch.variantMap[name] || [name];
}

function namesParam(name) {
  return encodeURIComponent(JSON.stringify(variantsFor(name)));
}
function jsAttr(s) {
  return esc(s).replace(/'/g, "\\'");
}
function syncSearchInputs(val, source) {
  const ov = document.getElementById('overview-search');
  const hd = document.getElementById('header-search');
  if (ov && source !== 'overview' && ov.value !== val) ov.value = val;
  if (hd && source !== 'header' && hd.value !== val) hd.value = val;
}
function syncPlaceInputs(val, source) {
  const ov = document.getElementById('overview-place');
  const rs = document.getElementById('results-place');
  if (ov && source !== 'overview' && ov.value !== val) ov.value = val;
  if (rs && source !== 'results' && rs.value !== val) rs.value = val;
}
function currentPlaceQuery() {
  return (document.getElementById('overview-place')?.value
    || document.getElementById('results-place')?.value
    || ovSearch.placeQ
    || ovSearch.fKu
    || '').trim();
}
function hasSearchQuery() {
  const q = (document.getElementById('overview-search')?.value || ovSearch.q || '').trim();
  return q.length >= 2 || currentPlaceQuery().length >= 2;
}
function setWizardStep(step) {
  ovSearch.step = step;
  const names = document.getElementById('step-names');
  const places = document.getElementById('step-places');
  const strip = document.getElementById('step-places-strip');
  const dossier = document.getElementById('overview-dossier');
  if (names) names.hidden = step !== 'names';
  if (places) places.hidden = step !== 'places';
  if (dossier) {
    dossier.hidden = step !== 'dossier';
    if (step !== 'dossier') dossier.innerHTML = '';
  }
  if (strip) strip.hidden = step !== 'names' || !(ovSearch.places || []).length;
  renderCrumb();
}
function renderCrumb() {
  const el = document.getElementById('wizard-crumb');
  if (!el) return;
  const q = ovSearch.q || '';
  const bits = [
    `<li><button type="button" class="crumb-btn" onclick="wizardBackToNames()">${q ? `„${esc(q)}”` : (ovSearch.fKu ? esc(ovSearch.fKu) : 'Hľadanie')}</button></li>`,
  ];
  if (ovSearch.pickName) {
    bits.push(`<li><button type="button" class="crumb-btn" onclick="wizardBackToPlaces()">${esc(ovSearch.pickName)}</button></li>`);
  }
  if (ovSearch.pickKu && ovSearch.step === 'dossier') {
    bits.push(`<li><span class="crumb-current">${esc(ovSearch.pickKu)}</span></li>`);
  }
  el.innerHTML = bits.join('');
}
function wizardBackToNames() {
  ovSearch.pickName = '';
  ovSearch.pickKu = '';
  ovSearch.holdNames = true;
  ovSearch.holdPlaces = false;
  writeSearchUrl(ovSearch.q, '', '');
  setWizardStep('names');
  applyMapSearchFilter();
}
function wizardBackToPlaces() {
  if (!ovSearch.pickName) {
    wizardBackToNames();
    return;
  }
  ovSearch.pickKu = '';
  ovSearch.holdPlaces = true;
  writeSearchUrl(ovSearch.q, ovSearch.pickName, '');
  if (ovSearch.districts?.length) {
    setWizardStep('places');
    renderPlaceCards(ovSearch.districts);
    applyMapSearchFilter();
  } else {
    loadKuOptions(ovSearch.pickName);
  }
}
let _ovTimer = null;
let ovSearchController = null;
const SEARCH_DEBOUNCE_MS = 700;

const BANNER_KEY = 'pzf-src-banner-v1';

function showSourceBannerIfNeeded() {
  try {
    if (localStorage.getItem(BANNER_KEY)) return;
  } catch (_) { /* private mode */ }
  const el = document.getElementById('source-banner');
  if (el) el.hidden = false;
}

function dismissSourceBanner() {
  try { localStorage.setItem(BANNER_KEY, '1'); } catch (_) {}
  const el = document.getElementById('source-banner');
  if (el) el.hidden = true;
}

function searchQueryFromUrl() {
  const p = new URLSearchParams(location.search);
  return (p.get('q') || p.get('search') || '').trim();
}

function writeSearchUrl(q, name, ku) {
  const url = new URL(location.href);
  if (q && q.length >= 2) url.searchParams.set('q', q);
  else url.searchParams.delete('q');
  const place = ovSearch.fKu || ovSearch.placeQ || '';
  if (place && place.length >= 2) url.searchParams.set('place', place);
  else url.searchParams.delete('place');
  const n = name !== undefined ? name : ovSearch.pickName;
  const k = ku !== undefined ? ku : ovSearch.pickKu;
  if (n) url.searchParams.set('name', n);
  else url.searchParams.delete('name');
  if (k) url.searchParams.set('ku', k);
  else url.searchParams.delete('ku');
  history.replaceState(null, '', url);
  const bits = [n, k, place, q].filter(Boolean);
  document.title = bits.length
    ? `${bits.join(' · ')} — PZF Explorer`
    : 'PZF Explorer — Neznámi vlastníci';
}

function shareSearchLink() {
  const q = (document.getElementById('overview-search')?.value || ovSearch.q || '').trim();
  const place = currentPlaceQuery();
  if (q.length < 2 && place.length < 2) {
    showToast('Najprv zadajte meno alebo obec (min. 2 znaky).', 'info');
    return;
  }
  writeSearchUrl(q);
  track('share', { q, place, name: ovSearch.pickName, ku: ovSearch.pickKu });
  const link = location.href;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(link).then(
      () => showToast('Odkaz skopírovaný — môžete ho poslať.', 'success'),
      () => showToast(link, 'info')
    );
  } else {
    showToast(link, 'info');
  }
}

function setOverviewSearching(on, msg) {
  const form = document.getElementById('overview-search-form');
  const status = document.getElementById('overview-search-status');
  const btn = document.getElementById('overview-search-go');
  if (form) form.classList.toggle('searching', !!on);
  if (btn) btn.disabled = !!on;
  if (status) {
    if (on) {
      status.hidden = false;
      status.textContent = msg || 'Hľadám v registri…';
    } else if (msg) {
      status.hidden = false;
      status.textContent = msg;
    } else {
      status.hidden = true;
      status.textContent = '';
    }
  }
}

function beginSearch(q, source) {
  ovSearch.q = q;
  ovSearch.page = 1;
  ovSearch.fName = '';
  ovSearch.pickName = '';
  ovSearch.pickKu = '';
  ovSearch.holdNames = false;
  ovSearch.holdPlaces = false;
  ovSearch.districts = [];
  syncSearchInputs(q, source);
}

function submitOverviewSearch(e) {
  if (e) e.preventDefault();
  const q = (
    document.getElementById('header-search')?.value
    || document.getElementById('overview-search')?.value
    || ovSearch.q
    || ''
  ).trim();
  const place = currentPlaceQuery();
  beginSearch(q);
  ovSearch.placeQ = place;
  ovSearch.fKu = place;
  hideWhisper();
  clearTimeout(_ovTimer);
  if (q.length < 2 && place.length < 2) {
    setOverviewSearching(false, 'Zadajte meno alebo obec (aspoň 2 znaky).');
    return;
  }
  document.getElementById('overview-search')?.blur();
  document.getElementById('header-search')?.blur();
  document.getElementById('overview-place')?.blur();
  document.getElementById('results-place')?.blur();
  showTab('overview');
  setOverviewSearching(true, 'Hľadám v registri…');
  loadOverviewSearch(1);
}

function scheduleOverviewSearch(source) {
  clearTimeout(_ovTimer);
  if (!hasSearchQuery()) {
    setOverviewSearching(false);
    const card = document.getElementById('overview-search-card');
    if (card) card.hidden = true;
    if (source !== 'header' || !document.body.classList.contains('register-view')) {
      document.body.classList.add('landing-mode');
      document.body.classList.remove('search-mode');
    }
    applyMapSearchFilter({ fit: true, force: true });
    return;
  }
  _ovTimer = setTimeout(() => {
    const q = (document.getElementById('overview-search')?.value || ovSearch.q || '').trim();
    const place = currentPlaceQuery();
    beginSearch(q, source);
    ovSearch.placeQ = place;
    ovSearch.fKu = place;
    if (source === 'header') {
      const onMap = document.getElementById('tab-map')?.classList.contains('active');
      if (!onMap) showTab('overview');
    }
    setOverviewSearching(true, 'Hľadám…');
    loadOverviewSearch(1);
  }, SEARCH_DEBOUNCE_MS);
}

function onOverviewSearchInput(val) {
  syncSearchInputs(val, 'overview');
  ovSearch.q = val;
  scheduleNameWhisper(val, 'overview');
}

function onHeaderSearchInput(val) {
  syncSearchInputs(val, 'header');
  ovSearch.q = val;
  scheduleNameWhisper(val, 'header');
}

function onOverviewSearchKeydown(e) {
  const source = e.target?.id === 'header-search' ? 'header' : 'overview';
  if (handleWhisperKey(e, 'name', source)) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    submitOverviewSearch(e);
  }
  if (e.key === 'Escape') clearOverviewSearch();
}

const whisper = {
  name: { idx: -1, rows: [], controller: null },
  place: { idx: -1, rows: [], controller: null },
};
let _nameWhisperTimer = null;

function whisperDd(kind, source) {
  if (kind === 'place') {
    return document.getElementById(source === 'overview' ? 'overview-place-dd' : 'results-place-dd');
  }
  return document.getElementById(source === 'header' ? 'header-name-dd' : 'overview-name-dd');
}

function hideWhisper(kind) {
  const ids = kind === 'place'
    ? ['overview-place-dd', 'results-place-dd']
    : kind === 'name'
      ? ['overview-name-dd', 'header-name-dd']
      : ['overview-place-dd', 'results-place-dd', 'overview-name-dd', 'header-name-dd'];
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (el) { el.hidden = true; el.innerHTML = ''; }
  });
  const kinds = kind ? [kind] : ['name', 'place'];
  for (const k of kinds) {
    whisper[k].idx = -1;
    whisper[k].rows = [];
  }
}

function hidePlaceSuggest() {
  hideWhisper('place');
}

function whisperPrefixLen(display, foldedPrefix) {
  let i = 0;
  let fi = 0;
  while (i < display.length && fi < foldedPrefix.length) {
    const f = fold(display[i]);
    if (!f) { i += 1; continue; }
    if (!foldedPrefix.startsWith(f, fi)) break;
    fi += f.length;
    i += 1;
  }
  return fi >= foldedPrefix.length ? i : 0;
}

function nameMatchesWhisper(name, query) {
  const ntoks = tokensOf(name);
  const qtoks = tokensOf(query);
  if (!qtoks.length) return false;
  const used = new Set();
  for (const qt of qtoks) {
    const idx = ntoks.findIndex((nt, i) => !used.has(i) && nt.startsWith(qt));
    if (idx < 0) return false;
    used.add(idx);
  }
  return true;
}

function whisperNameScore(name, query) {
  const ntoks = tokensOf(name);
  const qtoks = tokensOf(query);
  if (!qtoks.length) return 0;
  let score = 0;
  const used = new Set();
  for (const qt of qtoks) {
    const idx = ntoks.findIndex((nt, i) => !used.has(i) && nt.startsWith(qt));
    if (idx < 0) return -1;
    used.add(idx);
    score += ntoks[idx] === qt ? 120 : 50;
    score -= idx * 4;
  }
  score -= Math.max(0, ntoks.length - qtoks.length) * 12;
  if (ntoks[0] === qtoks[0]) score += 40;
  return score;
}

function markWhisper(text, query) {
  const qtoks = tokensOf(query);
  if (!qtoks.length) return esc(text);
  const used = new Set();
  return String(text).replace(
    /[A-Za-z0-9ÁáÄäČčĎďÉéÍíĽľĹĺŇňÓóÔôŔŕŠšŤťÚúÝýŽž]+|[^A-Za-z0-9ÁáÄäČčĎďÉéÍíĽľĹĺŇňÓóÔôŔŕŠšŤťÚúÝýŽž]+/g,
    (chunk) => {
      const folded = fold(chunk).replace(/[^a-z0-9]/g, '');
      if (!folded) return esc(chunk);
      let qi = -1;
      for (let i = 0; i < qtoks.length; i++) {
        if (used.has(i)) continue;
        if (folded.startsWith(qtoks[i])) { qi = i; break; }
      }
      if (qi < 0) return `<span class="whisper-tail">${esc(chunk)}</span>`;
      used.add(qi);
      const n = whisperPrefixLen(chunk, qtoks[qi]);
      const head = chunk.slice(0, n);
      const tail = chunk.slice(n);
      let html = `<span class="whisper-match">${esc(head)}</span>`;
      if (tail) html += `<span class="whisper-tail">${esc(tail)}</span>`;
      return html;
    }
  );
}

function uniqueWhisperNames(rows, query) {
  const seen = new Set();
  const scored = [];
  for (const r of rows || []) {
    const clean = cleanPersonName(r.meno_vlastnika);
    const k = nameKey(clean);
    if (!k || seen.has(k)) continue;
    if (!nameMatchesWhisper(clean, query)) continue;
    seen.add(k);
    scored.push({ name: clean, score: whisperNameScore(clean, query) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 8).map((x) => x.name);
}

function renderWhisper(kind, rows, source, query, pickFn, labelOf) {
  const dd = whisperDd(kind, source);
  if (!dd) return;
  const st = whisper[kind];
  st.rows = rows || [];
  st.idx = st.rows.length ? 0 : -1;
  if (!st.rows.length) {
    dd.hidden = true;
    dd.innerHTML = '';
    return;
  }
  dd.hidden = false;
  dd.innerHTML = st.rows.map((r, i) => {
    const label = labelOf(r);
    return `<button type="button" class="${i === 0 ? 'active' : ''}" data-idx="${i}"
            onmousedown="${pickFn}('${jsAttr(label)}')">
      ${markWhisper(label, query)}
    </button>`;
  }).join('');
}

function renderPlaceSuggest(rows, source) {
  const typed = (source === 'overview'
    ? document.getElementById('overview-place')?.value
    : document.getElementById('results-place')?.value) || ovSearch.placeQ || '';
  renderWhisper('place', rows, source, typed, 'pickPlaceSuggest', (r) => r.katastralne_uzemie);
}

function renderNameSuggest(names, source) {
  const typed = (source === 'header'
    ? document.getElementById('header-search')?.value
    : document.getElementById('overview-search')?.value) || ovSearch.q || '';
  renderWhisper('name', names, source, typed, 'pickNameSuggest', (n) => n);
}

function scheduleNameWhisper(val, source) {
  clearTimeout(_nameWhisperTimer);
  const q = (val || '').trim();
  if (q.length < 3) {
    hideWhisper('name');
    return;
  }
  _nameWhisperTimer = setTimeout(() => fetchNameWhisper(q, source), 180);
}

async function fetchNameWhisper(q, source) {
  const st = whisper.name;
  if (st.controller) st.controller.abort();
  st.controller = new AbortController();
  const signal = st.controller.signal;
  try {
    const data = await apiFetch(`/name-search?q=${encodeURIComponent(q)}`, { signal }).then((r) => r.json());
    if (signal.aborted) return;
    renderNameSuggest(uniqueWhisperNames(data.rows, q), source);
  } catch (e) {
    if (e.name === 'AbortError') return;
    hideWhisper('name');
  }
}

function whisperLabel(kind, row) {
  if (kind === 'place') return typeof row === 'string' ? row : row.katastralne_uzemie;
  return typeof row === 'string' ? row : row.meno_vlastnika;
}

function handleWhisperKey(e, kind, source) {
  const st = whisper[kind];
  const dd = whisperDd(kind, source);
  if (e.key === 'Escape' && st.rows.length && dd && !dd.hidden) {
    hideWhisper(kind);
    e.preventDefault();
    return true;
  }
  if (e.key === 'Enter' && st.rows.length && dd && !dd.hidden) {
    e.preventDefault();
    const row = st.rows[Math.max(0, st.idx)] || st.rows[0];
    if (!row) return true;
    const label = whisperLabel(kind, row);
    if (kind === 'place') pickPlaceSuggest(label);
    else pickNameSuggest(label);
    return true;
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return false;
  if (!st.rows.length || dd?.hidden) return false;
  e.preventDefault();
  const delta = e.key === 'ArrowDown' ? 1 : -1;
  st.idx = (st.idx + delta + st.rows.length) % st.rows.length;
  dd.querySelectorAll('button').forEach((btn, i) => btn.classList.toggle('active', i === st.idx));
  return true;
}

async function onPlaceSearchInput(val, source) {
  syncPlaceInputs(val, source);
  ovSearch.placeQ = val;
  ovSearch.fKu = val.trim();
  const q = val.trim();
  if (q.length < 2) {
    hideWhisper('place');
    return;
  }
  const st = whisper.place;
  if (st.controller) st.controller.abort();
  st.controller = new AbortController();
  const signal = st.controller.signal;
  try {
    const data = await apiFetch(`/place-search?q=${encodeURIComponent(q)}`, { signal }).then((r) => r.json());
    if (signal.aborted) return;
    renderPlaceSuggest(data.rows || [], source);
  } catch (e) {
    if (e.name === 'AbortError') return;
    hideWhisper('place');
  }
}

function onPlaceSearchKeydown(e, source) {
  if (handleWhisperKey(e, 'place', source)) return;
}

function pickNameSuggest(name) {
  ovSearch.q = name;
  syncSearchInputs(name);
  hideWhisper();
  track('name_whisper', { q: name });
  const place = currentPlaceQuery();
  beginSearch(name);
  ovSearch.placeQ = place;
  ovSearch.fKu = place;
  showTab('overview');
  setOverviewSearching(true, `Hľadám ${name}…`);
  loadOverviewSearch(1);
}

function pickPlaceSuggest(ku) {
  ovSearch.fKu = ku;
  ovSearch.placeQ = ku;
  syncPlaceInputs(ku);
  hideWhisper();
  track('place_chip', { q: ovSearch.q, ku });
  const q = (document.getElementById('overview-search')?.value || ovSearch.q || '').trim();
  beginSearch(q);
  ovSearch.fKu = ku;
  ovSearch.placeQ = ku;
  showTab('overview');
  setOverviewSearching(true, `Filtrujem ${ku}…`);
  loadOverviewSearch(1);
}

function clearOverviewSearch() {
  ovSearch.q = '';
  ovSearch.page = 1;
  ovSearch.fName = '';
  ovSearch.fKu = '';
  ovSearch.placeQ = '';
  ovSearch.pickName = '';
  ovSearch.pickKu = '';
  ovSearch.names = [];
  ovSearch.places = [];
  ovSearch.districts = [];
  ovSearch.holdNames = false;
  ovSearch.holdPlaces = false;
  syncSearchInputs('');
  syncPlaceInputs('');
  hideWhisper();
  writeSearchUrl('');
  setOverviewSearching(false);
  document.body.classList.remove('search-mode');
  document.body.classList.add('landing-mode');
  const card = document.getElementById('overview-search-card');
  if (card) card.hidden = true;
  hideDossier();
  showTab('overview');
  applyMapSearchFilter({ fit: true, force: true });
  document.getElementById('overview-search')?.focus();
}

function filterOverviewName(name) {
  ovSearch.fName = name;
  ovSearch.fKu = '';
  loadOverviewSearch(1);
}

function nameChance(r) {
  const solo = Number(r.solo_lvs || 0);
  const pct = Number(r.top_ku_pct || 0);
  const avg = Number(r.avg_co || 99);
  const portion = Number(r.portion || 0);
  if (solo >= 5 || (portion >= 3 && pct >= 70 && avg <= 2)) {
    return { label: 'Vysoká', cls: 'badge-green' };
  }
  if (solo >= 1 || (pct >= 55 && avg <= 6) || portion >= 1.5) {
    return { label: 'Stredná', cls: 'badge-amber' };
  }
  return { label: 'Nízka', cls: 'badge-blue' };
}

async function showNameDistricts(name) {
  const box = document.getElementById('overview-name-districts');
  if (!box) return;
  ovSearch.fName = name;
  box.hidden = false;
  box.innerHTML = `<div class="loading-state"><div class="loading-spinner"></div>Počítam nárok v k.ú. pre ${esc(name)}…</div>`;
  try {
    const data = await apiFetch(`/name-districts?names=${namesParam(name)}`).then((r) => r.json());
    const rows = data.rows || [];
    if (!rows.length) {
      box.innerHTML = `<div class="empty-state">Žiadny rozpis pre ${esc(name)}</div>`;
      return;
    }
    box.innerHTML = `
      <div class="card-title" style="margin-bottom:.5rem">
        Koľko pôdy v ktorom k.ú. — ${esc(name)}
        <button class="btn btn-ghost" type="button" onclick="filterOverviewName('${esc(name).replace(/'/g, "\\'")}')">Filtrovať záznamy</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Katast. územie</th>
              <th>Kód</th>
              <th>Záznamy</th>
              <th>LV</th>
              <th>Solo LV</th>
              <th>Ø spoluvlastníkov</th>
              <th>Odhad podielu</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((r) => `
              <tr class="ov-click-row" onclick="filterOverviewPlace('${esc(r.katastralne_uzemie).replace(/'/g, "\\'")}')">
                <td><strong>${esc(r.katastralne_uzemie)}</strong></td>
                <td>${fmt(r.poradove_cislo)}</td>
                <td>${fmt(r.recs)}</td>
                <td><span class="badge badge-amber">${fmt(r.lvs)}</span></td>
                <td><span class="badge badge-green">${fmt(r.solo_lvs)}</span></td>
                <td>${r.avg_co ?? '—'}</td>
                <td><strong>${r.portion ?? '—'}</strong></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  } catch (e) {
    box.innerHTML = `<div class="empty-state" style="color:#ef4444">${esc(e.message)}</div>`;
  }
}

function filterOverviewPlace(ku) {
  ovSearch.fKu = ku;
  ovSearch.fName = '';
  loadOverviewSearch(1);
}

function openOverviewInOwners(name, ku) {
  const n = name || ovSearch.fName || ovSearch.q || '';
  const k = ku || ovSearch.fKu || '';
  const nameEl = document.getElementById('owner-search');
  const kuEl = document.getElementById('owner-ku-filter');
  if (nameEl) nameEl.value = n;
  if (kuEl) kuEl.value = k;
  ownerState.colFilters.name = n;
  ownerState.colFilters.ku = k;
  showTab('owners');
  loadOwners(1);
}

function overviewNameSortVal(r, col) {
  switch (col) {
    case 'meno_vlastnika': return nameKey(r.meno_vlastnika);
    case 'recs': return Number(r.recs || 0);
    case 'lvs': return Number(r.lvs || 0);
    case 'top_ku': return String(r.top_ku || '').toLowerCase();
    case 'top_ku_pct': return Number(r.top_ku_pct || 0);
    case 'portion': return Number(r.portion || 0);
    case 'solo_lvs': return Number(r.solo_lvs || 0);
    case 'chance': {
      const ch = nameChance(r);
      return ch.label === 'Vysoká' ? 2 : ch.label === 'Stredná' ? 1 : 0;
    }
    default: return Number(r.portion || 0);
  }
}

function sortedOverviewNames() {
  const col = ovSearch.sortCol || 'portion';
  const dir = ovSearch.sortDir === 'ASC' ? 1 : -1;
  return [...(ovSearch.names || [])].sort((a, b) => {
    const va = overviewNameSortVal(a, col);
    const vb = overviewNameSortVal(b, col);
    if (typeof va === 'string' || typeof vb === 'string') {
      const c = String(va).localeCompare(String(vb), 'sk', { sensitivity: 'base' });
      if (c) return c * dir;
    } else if (va !== vb) {
      return (va - vb) * dir;
    }
    return Number(b.portion || 0) - Number(a.portion || 0) || Number(b.recs || 0) - Number(a.recs || 0);
  });
}

function sortOverviewNames(col) {
  if (ovSearch.sortCol === col) {
    ovSearch.sortDir = ovSearch.sortDir === 'ASC' ? 'DESC' : 'ASC';
  } else {
    ovSearch.sortCol = col;
    ovSearch.sortDir = (col === 'meno_vlastnika' || col === 'top_ku') ? 'ASC' : 'DESC';
  }
  renderOverviewNames();
}

function renderOverviewNames() {
  const namesWrap = document.getElementById('overview-names-wrap');
  if (!namesWrap) return;
  const names = sortedOverviewNames();
  if (!names.length) {
    namesWrap.innerHTML = ovSearch.fKu
      ? `<div class="empty-state">Žiadne mená v ${esc(ovSearch.fKu)} pre tento výraz. Skúste iné meno, alebo zrušte filter obce.</div>`
      : '<div class="empty-state">Žiadne mená pre tento výraz. Skúste priezvisko, alebo zadajte obec.</div>';
    return;
  }
  const title = document.getElementById('step-names-title');
  if (title) {
    if (ovSearch.fKu) {
      title.textContent = names.length === 1
        ? `Je to toto meno v ${ovSearch.fKu}?`
        : `Ktoré meno v ${ovSearch.fKu}? (${names.length})`;
    } else {
      title.textContent = names.length === 1 ? 'Je to toto meno?' : `Ktoré meno? (${names.length})`;
    }
  }
  namesWrap.innerHTML = names.map((r) => {
    const ch = nameChance(r);
    const variants = (r.variants || []).filter((v) => nameKey(v) !== nameKey(r.meno_vlastnika) || v !== r.meno_vlastnika);
    const shown = variants.slice(0, 4);
    const more = variants.length - shown.length;
    const pct = Number(r.top_ku_pct || 0);
    return `
      <button type="button" class="pick-card" onclick="onPickName('${jsAttr(r.meno_vlastnika)}')">
        <div class="pick-card-head">
          <strong>${esc(r.meno_vlastnika)}</strong>
          <span class="badge ${ch.cls}">${ch.label}</span>
        </div>
        ${shown.length
          ? `<div class="variant-chips">${shown.map((v) => `<span class="variant-chip">${esc(v)}</span>`).join('')}${more > 0 ? `<span class="variant-chip muted">+${more}</span>` : ''}</div>`
          : `<p class="variant-none">Jeden zápis v registri</p>`}
        <div class="pick-card-meta">
          <span>${esc(r.top_ku || '—')}${pct ? ` · ${pct}%` : ''}</span>
          <span>${fmt(r.lvs)} LV</span>
          <span>${fmt(r.solo_lvs)} solo</span>
          <span>podiel ${r.portion ?? '—'}</span>
        </div>
      </button>`;
  }).join('');
}

function renderPlacesStrip(places) {
  ovSearch.places = places || [];
  const wrap = document.getElementById('overview-places-wrap');
  const strip = document.getElementById('step-places-strip');
  if (!wrap) return;
  if (!ovSearch.places.length) {
    if (strip) strip.hidden = true;
    wrap.innerHTML = '';
    return;
  }
  if (strip) strip.hidden = ovSearch.step !== 'names';
  wrap.innerHTML = ovSearch.places.slice(0, 16).map((r) => `
    <button type="button" class="place-chip${ovSearch.fKu === r.katastralne_uzemie ? ' active' : ''}"
            onclick="onPickPlaceChip('${jsAttr(r.katastralne_uzemie)}')">
      ${esc(r.katastralne_uzemie)}
    </button>`).join('');
}

function onPickPlaceChip(ku) {
  ovSearch.fKu = ovSearch.fKu === ku ? '' : ku;
  ovSearch.placeQ = ovSearch.fKu;
  syncPlaceInputs(ovSearch.fKu);
  ovSearch.pickName = '';
  ovSearch.pickKu = '';
  ovSearch.holdNames = false;
  track('place_chip', { q: ovSearch.q, ku: ovSearch.fKu || ku });
  loadOverviewSearch(1);
}

function renderPlaceCards(rows) {
  const wrap = document.getElementById('overview-ku-wrap');
  if (!wrap) return;
  const title = document.getElementById('step-places-title');
  if (title) {
    title.textContent = rows.length === 1
      ? `Katastrálne územie pre ${ovSearch.pickName}`
      : `Ktoré katastrálne územie? (${rows.length})`;
  }
  if (!rows.length) {
    wrap.innerHTML = '<div class="empty-state">Pre toto meno sa nenašlo katastrálne územie.</div>';
    return;
  }
  wrap.innerHTML = rows.map((r) => `
    <button type="button" class="pick-card" onclick="onPickKu('${jsAttr(r.katastralne_uzemie)}')">
      <div class="pick-card-head">
        <strong>${esc(r.katastralne_uzemie)}</strong>
        <span class="badge badge-amber">${fmt(r.lvs)} LV</span>
      </div>
      <div class="pick-card-meta">
        <span>kód ${fmt(r.poradove_cislo)}</span>
        <span>${fmt(r.solo_lvs)} solo</span>
        <span>Ø spoluvl. ${r.avg_co ?? '—'}</span>
        <span>podiel ${r.portion ?? '—'}</span>
      </div>
    </button>`).join('');
}

function resolvePickedName(wanted) {
  if (!wanted) return '';
  const names = ovSearch.names || [];
  if (names.some((n) => n.meno_vlastnika === wanted)) return wanted;
  const key = nameKey(wanted);
  const hit = names.find((n) => nameKey(n.meno_vlastnika) === key);
  return hit ? hit.meno_vlastnika : wanted;
}

async function loadOverviewSearch(page = 1) {
  const q = (
    document.getElementById('overview-search')?.value
    || ovSearch.q
    || searchQueryFromUrl()
    || ''
  ).trim();
  const place = (
    currentPlaceQuery()
    || new URLSearchParams(location.search).get('place')
    || ''
  ).trim();
  ovSearch.q = q;
  ovSearch.placeQ = place;
  if (place) ovSearch.fKu = place;
  ovSearch.page = page;
  const card = document.getElementById('overview-search-card');
  if (!card) return;

  if (q.length < 2 && place.length < 2) {
    card.hidden = true;
    writeSearchUrl('');
    setOverviewSearching(false);
    applyMapSearchFilter({ fit: true, force: true });
    return;
  }

  card.hidden = false;
  document.body.classList.add('search-mode');
  document.body.classList.remove('landing-mode');
  writeSearchUrl(q);
  setOverviewSearching(true, 'Hľadám v registri…');
  const namesWrap = document.getElementById('overview-names-wrap');
  if (namesWrap) namesWrap.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div>Hľadám v registri...</div>';
  setWizardStep('names');

  if (ovSearchController) ovSearchController.abort();
  ovSearchController = new AbortController();
  const signal = ovSearchController.signal;

  const params = new URLSearchParams({
    q,
    page,
    limit: 50,
    f_name: ovSearch.fName,
    f_ku: ovSearch.fKu,
  });

  try {
    const data = await apiFetch(`/overview-search?${params}`, { signal }).then((r) => r.json());
    if (data.error) throw new Error(data.error);

    ovSearch.names = groupCleanNames(data.names || []).filter((r) => {
      if (q.length >= 2) return matchesFolded(r.meno_vlastnika, q);
      return true;
    });
    renderPlacesStrip(data.places || []);
    renderOverviewNames();
    renderCrumb();

    const label = document.getElementById('overview-search-label');
    if (label) {
      const placeHint = ovSearch.fKu ? ` · obec ${ovSearch.fKu}` : '';
      label.textContent = `${ovSearch.names.length} mien · ${(data.places || []).length} obcí${placeHint}`;
    }

    if (ovSearch.pickName) {
      ovSearch.pickName = resolvePickedName(ovSearch.pickName);
      await loadKuOptions(ovSearch.pickName, ovSearch.pickKu);
    } else if (ovSearch.names.length === 1 && !ovSearch.holdNames) {
      await onPickName(ovSearch.names[0].meno_vlastnika);
    } else {
      setWizardStep('names');
    }

    setOverviewSearching(false, label?.textContent || '');
    applyMapSearchFilter();
    const topNames = ovSearch.names.slice(0, 8).map((r) => r.meno_vlastnika).join(' | ');
    const topPlaces = (data.places || []).slice(0, 8).map((r) => r.katastralne_uzemie).join(' | ');
    trackSearchSettled({
      q,
      place: ovSearch.fKu,
      names: topNames,
      places: topPlaces,
      name_count: ovSearch.names.length,
      place_count: (data.places || []).length,
    });
  } catch (e) {
    if (e.name === 'AbortError') return;
    setOverviewSearching(false);
    showToast('Chyba hľadania: ' + e.message, 'error');
    const nw = document.getElementById('overview-names-wrap');
    if (nw) nw.innerHTML = `<div class="empty-state" style="color:#ef4444">${esc(e.message)}</div>`;
  }
}

function hideDossier() {
  const d = document.getElementById('overview-dossier');
  if (d) { d.hidden = true; d.innerHTML = ''; }
}

async function onPickName(name) {
  ovSearch.pickName = name || '';
  ovSearch.pickKu = '';
  ovSearch.holdPlaces = false;
  writeSearchUrl(ovSearch.q, name || '', '');
  if (!name) {
    setWizardStep('names');
    return;
  }
  const row = (ovSearch.names || []).find((r) => r.meno_vlastnika === name);
  track('pick_name', {
    q: ovSearch.q,
    name,
    variants: (row?.variants || []).slice(0, 6).join(' | '),
    ku: row?.top_ku,
    lvs: row?.lvs,
    solo: row?.solo_lvs,
    portion: row?.portion,
  });
  await loadKuOptions(name);
}

async function loadKuOptions(name, preferKu) {
  setWizardStep('places');
  const wrap = document.getElementById('overview-ku-wrap');
  if (wrap) wrap.innerHTML = `<div class="loading-state"><div class="loading-spinner"></div>Hľadám obce pre ${esc(name)}…</div>`;
  try {
    const data = await apiFetch(`/name-districts?names=${namesParam(name)}`).then((r) => r.json());
    let rows = data.rows || [];
    const loc = ovSearch.fKu || ovSearch.placeQ;
    if (loc && loc.trim().length >= 2) {
      const filtered = rows.filter((r) => matchesFolded(r.katastralne_uzemie, loc));
      if (filtered.length) rows = filtered;
    }
    ovSearch.districts = rows;
    renderPlaceCards(rows);
    applyMapSearchFilter();
    const exact = loc
      ? rows.find((r) => fold(r.katastralne_uzemie) === fold(loc))
      : null;
    const pick = preferKu && rows.some((r) => r.katastralne_uzemie === preferKu)
      ? preferKu
      : exact
        ? exact.katastralne_uzemie
        : '';
    if (pick) {
      await onPickKu(pick);
    } else if (rows.length === 1 && !ovSearch.holdPlaces) {
      await onPickKu(rows[0].katastralne_uzemie);
    } else {
      setWizardStep('places');
    }
  } catch (e) {
    if (wrap) wrap.innerHTML = `<div class="empty-state" style="color:#ef4444">${esc(e.message)}</div>`;
  }
}

async function onPickKuFromList(ku) {
  if (!ovSearch.pickName) {
    onPickPlaceChip(ku);
    return;
  }
  await onPickKu(ku);
}

async function onPickKu(ku) {
  ovSearch.pickKu = ku || '';
  writeSearchUrl(ovSearch.q, ovSearch.pickName, ku || '');
  applyMapSearchFilter();
  if (!ku || !ovSearch.pickName) {
    setWizardStep(ovSearch.pickName ? 'places' : 'names');
    return;
  }
  const row = (ovSearch.districts || []).find((r) => r.katastralne_uzemie === ku);
  track('pick_place', {
    q: ovSearch.q,
    name: ovSearch.pickName,
    ku,
    lvs: row?.lvs,
    solo: row?.solo_lvs,
    portion: row?.portion,
  });
  await loadDossier(ovSearch.pickName, ku);
}

function clearPicks() {
  wizardBackToNames();
}

async function onPickCoowner(name) {
  const keepKu = ovSearch.pickKu;
  ovSearch.holdPlaces = false;
  ovSearch.pickName = name;
  ovSearch.pickKu = '';
  track('pick_coowner', { q: ovSearch.q, name, ku: keepKu });
  await loadKuOptions(name, keepKu);
}

async function loadDossier(name, ku) {
  const box = document.getElementById('overview-dossier');
  if (!box) return;
  setWizardStep('dossier');
  writeSearchUrl(ovSearch.q, name, ku);
  box.innerHTML = `<div class="loading-state"><div class="loading-spinner"></div>Načítavam ${esc(name)} v ${esc(ku)}…</div>`;
  try {
    const data = await apiFetch(`/name-ku-detail?names=${namesParam(name)}&ku=${encodeURIComponent(ku)}`).then((r) => r.json());
    if (data.error) throw new Error(data.error);
    renderDossier(data);
    renderCrumb();
  } catch (e) {
    box.innerHTML = `<div class="empty-state" style="color:#ef4444">${esc(e.message)}</div>`;
  }
}

function renderDossier(data) {
  const box = document.getElementById('overview-dossier');
  if (!box) return;
  const s = { ...(data.summary || {}), name: ovSearch.pickName || data.summary?.name || '' };
  const lvs = data.lvs || [];
  const tr = data.transferred || [];
  const co = data.coowners || [];
  const chance = nameChance({
    solo_lvs: s.solo_lvs,
    top_ku_pct: 100,
    avg_co: s.avg_co,
    portion: s.portion,
  });
  const solo = lvs.filter((r) => Number(r.solo));
  const shared = lvs.filter((r) => !Number(r.solo));
  const trByLv = {};
  tr.forEach((row) => {
    const key = String(row.lv);
    if (!trByLv[key]) trByLv[key] = [];
    trByLv[key].push(row);
  });
  window._overviewLvs = lvs.map((r) => ({ lv: r.lv, ku: r.cislo_ku, kuName: r.ku_name }));
  window._soloLvs = solo.map((r) => ({ lv: r.lv, ku: r.cislo_ku, kuName: r.ku_name }));
  track('view_dossier', {
    q: ovSearch.q,
    name: s.name,
    ku: s.ku,
    lvs: s.lvs,
    solo: s.solo_lvs,
    portion: s.portion,
    transfers: tr.length,
    coowners: co.slice(0, 8).map((r) => r.meno_vlastnika).join(' | '),
  });

  function lvRowsHtml(list) {
    if (!list.length) return '<div class="empty-state">Žiadne LV v tejto skupine</div>';
    return `
      <table>
        <thead>
          <tr>
            <th>LV</th>
            <th>k.ú.</th>
            <th>Kód</th>
            <th>Neznámych</th>
            <th>Odhad podielu</th>
            <th>Zápis v registri</th>
            <th>Prevod</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${list.map((r) => {
            const xfers = trByLv[String(r.lv)] || [];
            const xferTxt = xfers.length
              ? xfers.map((x) => `${x.year || ''} → ${x.vlastnik_lv || ''}${x.datum_ucinnosti ? ` (${x.datum_ucinnosti})` : ''}`).join('; ')
              : '—';
            const safeKu = jsAttr(r.ku_name);
            return `
              <tr>
                <td><span class="badge badge-amber badge-clickable" onclick="window.openKatasterLV('${safeKu}', '${r.cislo_ku}', '${r.lv}')">LV ${fmt(r.lv)}</span></td>
                <td>${esc(r.ku_name)}</td>
                <td>${fmt(r.cislo_ku)}</td>
                <td>${fmt(r.names_on_lv)}</td>
                <td><strong>${r.portion ?? '—'}</strong></td>
                <td class="cell-muted">${esc(r.variants || '—')}</td>
                <td class="cell-muted">${esc(xferTxt)}</td>
                <td><a class="btn-lv-link" target="_blank" rel="noopener"
                      href="https://kataster.skgeodesy.sk/Portal45/api/Bo/GeneratePrfPublic?prfNumber=${r.lv}&cadastralUnitCode=${r.cislo_ku}&outputType=html">Výpis</a></td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  }

  box.innerHTML = `
    <div class="dossier">
      <header class="dossier-head">
        <div>
          <h2 class="dossier-name">${esc(s.name)}</h2>
          <p class="dossier-place">${esc(s.ku)}${s.cislo_ku ? ` · kód ${fmt(s.cislo_ku)}` : ''}</p>
        </div>
        <span class="badge ${chance.cls}">Šanca ${chance.label}</span>
      </header>
      <p class="insight-note">
        Odhad podielu je súčet 1/N na každom liste, kde N je počet neznámych z tohto registra — nie výmera z katastra.
        Solo LV = na liste nie je iný neznámy; to je najlepší kandidát na väčší kus pôdy.
      </p>
      <div class="stat-grid ov-search-stats">
        <div class="stat-card"><div class="stat-label">LV v tomto k.ú.</div><div class="stat-value">${fmt(s.lvs)}</div></div>
        <div class="stat-card"><div class="stat-label">Solo LV</div><div class="stat-value">${fmt(s.solo_lvs)}</div><div class="stat-sub">jediný neznámy na liste</div></div>
        <div class="stat-card"><div class="stat-label">Odhad podielu</div><div class="stat-value">${s.portion ?? '—'}</div><div class="stat-sub">súčet 1/N na LV</div></div>
        <div class="stat-card"><div class="stat-label">Ø spoluvlastníkov</div><div class="stat-value">${s.avg_co ?? '—'}</div><div class="stat-sub">neznámych na LV</div></div>
      </div>
      <div class="bulk-lv-bar">
        <div>Otvoriť výpisy z katastra pre toto meno v tomto k.ú.</div>
        <div class="dossier-actions">
          <button class="bulk-lv-btn" type="button" onclick="window.shareSearchLink()">Zdieľať</button>
          ${solo.length ? `<button class="bulk-lv-btn bulk-lv-btn-solo" type="button" onclick="window.openAllLvs(window._soloLvs)">Otvoriť ${solo.length} solo výpisov</button>` : ''}
          ${lvs.length ? `<button class="bulk-lv-btn" type="button" onclick="window.openAllLvs(window._overviewLvs)">Otvoriť všetkých ${lvs.length}</button>` : ''}
        </div>
      </div>
      <h3 class="dossier-section">Solo LV — jediný neznámy vlastník</h3>
      <p class="insight-note">Na liste nie je iný neznámy z registra. Podiel 1.0 = celý neznámy nárok na tom LV.</p>
      <div class="table-wrap solo-lv-table">${lvRowsHtml(solo)}</div>
      <h3 class="dossier-section">Ostatné LV — zdieľané s ďalšími neznámymi</h3>
      <div class="table-wrap">${lvRowsHtml(shared)}</div>
      <h3 class="dossier-section">Ďalší neznámi na tých istých LV</h3>
      <p class="insight-note">Môžu to byť príbuzní alebo iní spoluvlastníci. Kliknutím prejdete na ich zápis v tom istom k.ú., ak tam sú.</p>
      <div class="table-wrap">
        ${!co.length ? '<div class="empty-state">Žiadni ďalší v registri</div>' : `
        <table>
          <thead><tr><th>Meno</th><th>Spoločné LV</th><th></th></tr></thead>
          <tbody>
            ${co.map((r) => `
              <tr class="ov-click-row" onclick="onPickCoowner('${jsAttr(r.meno_vlastnika)}')">
                <td>${esc(r.meno_vlastnika)}</td>
                <td><span class="badge badge-blue">${fmt(r.shared_lvs)}</span></td>
                <td>zvoliť</td>
              </tr>`).join('')}
          </tbody>
        </table>`}
      </div>
      <h3 class="dossier-section">Prevedené práva na týchto LV</h3>
      <p class="insight-note">Ak tu je prevod z 2022–2025, časť práva už mohla prejsť na iného vlastníka (často SPF).</p>
      <div class="table-wrap">
        ${!tr.length ? '<div class="empty-state">Žiadny prevod v 2022–2025</div>' : `
        <table>
          <thead><tr><th>Rok</th><th>LV</th><th>Na koho</th><th>Účinnosť</th><th>CRZ</th></tr></thead>
          <tbody>
            ${tr.map((r) => `
              <tr>
                <td>${fmt(r.year)}</td>
                <td>${fmt(r.lv)}</td>
                <td>${esc(r.vlastnik_lv)}</td>
                <td>${esc(r.datum_ucinnosti)}</td>
                <td>${esc(r.crz)}</td>
              </tr>`).join('')}
          </tbody>
        </table>`}
      </div>
    </div>`;
}

window.dismissSourceBanner = dismissSourceBanner;
window.shareSearchLink = shareSearchLink;
window.submitOverviewSearch = submitOverviewSearch;
window.onOverviewSearchInput = onOverviewSearchInput;
window.onHeaderSearchInput = onHeaderSearchInput;
window.onOverviewSearchKeydown = onOverviewSearchKeydown;
window.onPlaceSearchInput = onPlaceSearchInput;
window.onPlaceSearchKeydown = onPlaceSearchKeydown;
window.pickPlaceSuggest = pickPlaceSuggest;
window.pickNameSuggest = pickNameSuggest;
window.clearOverviewSearch = clearOverviewSearch;
window.filterOverviewName = filterOverviewName;
window.showNameDistricts = showNameDistricts;
window.onPickName = onPickName;
window.onPickKu = onPickKu;
window.onPickKuFromList = onPickKuFromList;
window.onPickPlaceChip = onPickPlaceChip;
window.onPickCoowner = onPickCoowner;
window.clearPicks = clearPicks;
window.wizardBackToNames = wizardBackToNames;
window.wizardBackToPlaces = wizardBackToPlaces;
window.filterOverviewPlace = filterOverviewPlace;
window.openOverviewInOwners = openOverviewInOwners;
window.loadOverviewSearch = loadOverviewSearch;
window.sortOverviewNames = sortOverviewNames;

const soloState = { page: 1, ku: '', name: '', sortCol: 'katastralne_uzemie', sortDir: 'ASC' };

function sortSoloLvs(col) {
  if (soloState.sortCol === col) {
    soloState.sortDir = soloState.sortDir === 'ASC' ? 'DESC' : 'ASC';
  } else {
    soloState.sortCol = col;
    soloState.sortDir = (col === 'meno_vlastnika' || col === 'katastralne_uzemie') ? 'ASC' : 'DESC';
  }
  loadSoloLvs(1);
}
let _soloTimer = null;

function onSoloKuInput(val) {
  soloState.ku = val || '';
  soloState.page = 1;
  clearTimeout(_soloTimer);
  _soloTimer = setTimeout(() => loadSoloLvs(1), 300);
}

function onSoloNameInput(val) {
  soloState.name = val || '';
  soloState.page = 1;
  clearTimeout(_soloTimer);
  _soloTimer = setTimeout(() => loadSoloLvs(1), 300);
}

function clearSoloFilter() {
  const kuEl = document.getElementById('solo-ku-filter');
  const nameEl = document.getElementById('solo-name-filter');
  if (kuEl) kuEl.value = '';
  if (nameEl) nameEl.value = '';
  soloState.ku = '';
  soloState.name = '';
  loadSoloLvs(1);
}

async function loadSoloLvs(page = 1) {
  soloState.page = page;
  const wrap = document.getElementById('solo-table-wrap');
  if (!wrap) return;
  wrap.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div>Načítavam solo LV…</div>';
  const params = new URLSearchParams({
    page,
    limit: 50,
    ku: soloState.ku || document.getElementById('solo-ku-filter')?.value || '',
    name: soloState.name || document.getElementById('solo-name-filter')?.value || '',
    sort_col: soloState.sortCol,
    sort_dir: soloState.sortDir,
  });
  try {
    const data = await apiFetch(`/solo-lvs?${params}`).then((r) => r.json());
    if (data.error) throw new Error(data.error);
    const label = document.getElementById('solo-total-label');
    if (label) label.textContent = `${fmt(data.total)} listov`;
    window._soloAllPage = (data.rows || []).map((r) => ({
      lv: r.lv, ku: r.cislo_ku, kuName: r.katastralne_uzemie,
    }));
    const bulk = document.getElementById('solo-bulk-bar');
    const withArea = (data.rows || []).filter((r) => Number(r.celkova_vymera_m2) > 0).length;
    const kuArg = (soloState.ku || '').trim();
    const nameArg = (soloState.name || '').trim();
    const fetchCmd = `node fetch-solo-lvs.mjs${kuArg ? ` --ku "${kuArg}"` : ''}${nameArg ? ` --name "${nameArg}"` : ''} --limit 20 --headed`;
    if (bulk) {
      bulk.innerHTML = data.rows.length ? `
        <div class="bulk-lv-bar">
          <div>Stránka: <strong>${data.rows.length}</strong> solo LV · výmera z Katastra: <strong>${withArea}</strong></div>
          <div style="display:flex;gap:.5rem;flex-wrap:wrap">
            <button class="bulk-lv-btn" style="background:linear-gradient(135deg,#10b981,#059669)"
                    onclick="window.openAllLvs(window._soloAllPage)">🌲 Otvoriť tieto výpisy ↗</button>
            <button class="bulk-lv-btn" type="button" onclick="copySoloFetchCmd()">⬇ Stiahnuť výmeru (Playwright)</button>
          </div>
        </div>
        <p class="insight-note" style="margin-top:.6rem">
          PZF CSV nemá m². Výmeru berieme z Katastra cez Playwright (jednorazová captcha v okne).
          Filter k.ú. je povinný — bez neho je 491 500 listov. Príkaz:
          <code id="solo-fetch-cmd">${esc(fetchCmd)}</code>
        </p>` : '';
    }
    if (!data.rows.length) {
      wrap.innerHTML = `<div class="empty-state">Žiadne solo LV${soloState.ku ? ` pre k.ú. „${esc(soloState.ku)}“` : ''}.</div>`;
      renderPagination('solo-pagination', page, data.total, 50, loadSoloLvs);
      return;
    }
    const sTh = (label, col) => {
      const active = soloState.sortCol === col;
      const icon = active ? (soloState.sortDir === 'ASC' ? '↑' : '↓') : '↕';
      return `<th class="sortable${active ? ' sort-active' : ''}" onclick="event.stopPropagation(); sortSoloLvs('${col}')">${label}<span class="sort-ic">${icon}</span></th>`;
    };
    wrap.innerHTML = `
      <table>
        <thead>
          <tr>
            ${sTh('Meno', 'meno_vlastnika')}
            ${sTh('k.ú.', 'katastralne_uzemie')}
            ${sTh('Kód', 'cislo_ku')}
            ${sTh('LV', 'lv')}
            ${sTh('Výmera m²', 'vymera')}
            ${sTh('Parcely', 'parcely')}
            ${sTh('Odhad podielu', 'portion')}
            ${sTh('Kataster', 'kataster')}
          </tr>
        </thead>
        <tbody>
          ${data.rows.map((r) => {
            const clean = cleanPersonName(r.meno_vlastnika);
            const safeKu = esc(r.katastralne_uzemie).replace(/'/g, "\\'");
            const m2 = Number(r.celkova_vymera_m2);
            const pc = Number(r.pocet_parciel_c || 0) + Number(r.pocet_parciel_e || 0);
            const plist = (data.parcels || []).filter((p) => Number(p.lv) === Number(r.lv) && Number(p.cislo_ku) === Number(r.cislo_ku));
            const tip = plist.map((p) => `${p.register_type} ${p.parcel_no}: ${fmt(Math.round(p.vymera_m2))} m² ${p.druh_pozemku || ''}`).join('\n');
            return `
              <tr>
                <td><strong>${esc(clean)}</strong></td>
                <td>${esc(r.katastralne_uzemie)}</td>
                <td>${fmt(r.cislo_ku)}</td>
                <td><span class="badge badge-amber badge-clickable"
                      onclick="window.openKatasterLV('${safeKu}', '${r.cislo_ku}', '${r.lv}')">📄 LV ${fmt(r.lv)} ↗</span></td>
                <td>${m2 > 0 ? `<strong title="${esc(tip)}">${fmt(Math.round(m2))} m²</strong>` : '<span style="opacity:.45">—</span>'}</td>
                <td>${pc ? `<span class="badge badge-blue" title="${esc(tip)}">${fmt(pc)}</span>` : '—'}</td>
                <td><strong>1.0</strong></td>
                <td><a class="btn-lv-link" target="_blank" rel="noopener"
                      href="https://kataster.skgeodesy.sk/Portal45/api/Bo/GeneratePrfPublic?prfNumber=${r.lv}&cadastralUnitCode=${r.cislo_ku}&outputType=html">📜 Výpis ↗</a></td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>`;
    renderPagination('solo-pagination', page, data.total, 50, loadSoloLvs);
  } catch (e) {
    wrap.innerHTML = `<div class="empty-state" style="color:#ef4444">${esc(e.message)}</div>`;
  }
}

function copySoloFetchCmd() {
  const el = document.getElementById('solo-fetch-cmd');
  const cmd = el?.textContent || 'node fetch-solo-lvs.mjs --ku "sulin" --limit 20 --headed';
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(cmd).then(
      () => showToast('Príkaz skopírovaný. Spusti ho v priečinku projektu (headed = captcha raz).', 'success'),
      () => showToast(cmd, 'info'),
    );
  } else {
    showToast(cmd, 'info');
  }
}

window.onSoloKuInput = onSoloKuInput;
window.onSoloNameInput = onSoloNameInput;
window.clearSoloFilter = clearSoloFilter;
window.loadSoloLvs = loadSoloLvs;
window.sortSoloLvs = sortSoloLvs;
window.copySoloFetchCmd = copySoloFetchCmd;

// ════════════════════════════════════════════════════════════════════════════
//  OWNERS TAB
// ════════════════════════════════════════════════════════════════════════════

const ownerState = {
  page: 1,
  sortCol: 'katastralne_uzemie',
  sortDir: 'ASC',
  colFilters: { ku: '', cislo: '', lv: '', name: '' },
};

let ownerFetchController = null;
let _ownerTimer = null;

function syncOwnerStateFromDOM() {
  const active = document.activeElement ? document.activeElement.id : '';

  const topName  = document.getElementById('owner-search')?.value || '';
  const topKu    = document.getElementById('owner-ku-filter')?.value || '';
  const colKu    = document.getElementById('oc-ku')?.value || '';
  const colCislo = document.getElementById('oc-cislo')?.value || '';
  const colLv    = document.getElementById('oc-lv')?.value || '';
  const colName  = document.getElementById('oc-name')?.value || '';

  if (active === 'owner-search') {
    ownerState.colFilters.name = topName;
  } else if (active === 'oc-name') {
    ownerState.colFilters.name = colName;
  } else {
    ownerState.colFilters.name = topName || colName || ownerState.colFilters.name || '';
  }

  if (active === 'owner-ku-filter') {
    ownerState.colFilters.ku = topKu;
  } else if (active === 'oc-ku') {
    ownerState.colFilters.ku = colKu;
  } else {
    ownerState.colFilters.ku = topKu || colKu || ownerState.colFilters.ku || '';
  }

  if (colCislo) ownerState.colFilters.cislo = colCislo;
  if (colLv) ownerState.colFilters.lv = colLv;
}

function debouncedLoadOwners(delay = 50) {
  clearTimeout(_ownerTimer);
  _ownerTimer = setTimeout(() => loadOwners(1), delay);
}

function onOwnerTopInput(key, val) {
  ownerState.colFilters[key] = val;
  const colEl = document.getElementById(key === 'ku' ? 'oc-ku' : key === 'name' ? 'oc-name' : '');
  if (colEl && colEl !== document.activeElement) colEl.value = val;
  debouncedLoadOwners();
}

function setOwnerColFilter(key, val) {
  ownerState.colFilters[key] = val;
  if (key === 'ku') {
    const topEl = document.getElementById('owner-ku-filter');
    if (topEl && topEl !== document.activeElement) topEl.value = val;
  } else if (key === 'name') {
    const topEl = document.getElementById('owner-search');
    if (topEl && topEl !== document.activeElement) topEl.value = val;
  }
  debouncedLoadOwners();
}

async function loadOwners(page = 1) {
  ownerState.page = page;
  syncOwnerStateFromDOM();

  if (ownerFetchController) ownerFetchController.abort();
  ownerFetchController = new AbortController();
  const signal = ownerFetchController.signal;

  const focusInfo = captureFocus();
  const wrap = document.getElementById('owners-table-wrap');

  if (wrap.querySelector('table')) {
    wrap.style.opacity = '0.7';
  } else {
    wrap.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div>Načítavam...</div>';
  }

  const params = new URLSearchParams({
    page, limit: 50,
    sort_col: ownerState.sortCol,
    sort_dir: ownerState.sortDir,
    f_ku:    ownerState.colFilters.ku,
    f_cislo: ownerState.colFilters.cislo,
    f_lv:    ownerState.colFilters.lv,
    f_name:  ownerState.colFilters.name,
  });

  try {
    const data = await apiFetch(`/owners?${params}`, { signal }).then(r => r.json());
    if (data.error) throw new Error(data.error);

    document.getElementById('owners-total-label').textContent = fmt(data.total) + ' záznamov';
    renderOwnerTable(data.rows, focusInfo);
    renderPagination('owners-pagination', page, data.total, 50, loadOwners);
  } catch (e) {
    if (e.name === 'AbortError') return;
    showToast('Chyba: ' + e.message, 'error');
    wrap.innerHTML = `<div class="empty-state" style="color:#ef4444">❌ ${esc(e.message)}</div>`;
  } finally {
    if (!signal.aborted) wrap.style.opacity = '1';
  }
}

function sortOwners(col) {
  if (ownerState.sortCol === col) {
    ownerState.sortDir = ownerState.sortDir === 'ASC' ? 'DESC' : 'ASC';
  } else {
    ownerState.sortCol = col;
    ownerState.sortDir = 'ASC';
  }
  loadOwners(1);
}

function openAllLvs(lvs) {
  if (!lvs || !lvs.length) return;
  track('open_lvs', {
    name: ovSearch.pickName,
    ku: ovSearch.pickKu,
    count: lvs.length,
  });
  showToast(`🚀 Otváram ${lvs.length} unikátnych výpisov z Katastra...`, 'success');
  lvs.forEach((item, i) => {
    setTimeout(() => {
      window.open(`https://kataster.skgeodesy.sk/Portal45/api/Bo/GeneratePrfPublic?prfNumber=${item.lv}&cadastralUnitCode=${item.ku}&outputType=html`, '_blank');
    }, i * 150);
  });
}
window.openAllLvs = openAllLvs;

async function enrichAndAnalyzeLvs(lvs) {
  const searchBox = (document.getElementById('owner-search')?.value || '').trim();
  const colNameFilter = (ownerState.colFilters.name || '').trim();
  const currentSearchName = searchBox || colNameFilter || 'horvath';
  
  // 1. Immediately switch to Analýza LV tab so the user sees action right away!
  showTab('lv-analysis');
  const searchInput = document.getElementById('lv-analysis-search');
  if (searchInput) searchInput.value = currentSearchName;

  // Render loading state in Analýza LV tab
  const portfolioWrap = document.getElementById('lv-portfolio-wrap');
  if (portfolioWrap) {
    portfolioWrap.innerHTML = `
      <div class="loading-state">
        <div class="loading-spinner"></div>
        ⏳ Spracovávam a analyzujem ${lvs ? lvs.length : 0} Listov Vlastníctva z Katastra do DuckDB...
      </div>`;
  }

  // First load existing stored analysis from DuckDB so the screen is never empty!
  await loadLvAnalysis(currentSearchName);

  if (!lvs || !lvs.length) return;

  showToast(`⏳ Sťahujem ${lvs.length} LV z Katastra...`, 'info');

  const items = [];
  for (let i = 0; i < lvs.length; i++) {
    const item = lvs[i];
    try {
      // Try local proxy endpoint first
      let resp = await apiFetch(`/lv-preview?lv=${item.lv}&ku=${item.ku}`);
      let html = await resp.text();
      
      let doc = new DOMParser().parseFromString(html, 'text/html');
      let text = doc.body.innerText || doc.body.textContent || '';

      // If local proxy returned reCAPTCHA script, try direct Kataster API URL
      if (!text.includes('LIST U VLASTNÍCTVA') && !text.includes('MAJETKOVÁ PODSTATA')) {
        try {
          const directUrl = `https://kataster.skgeodesy.sk/Portal45/api/Bo/GeneratePrfPublic?prfNumber=${item.lv}&cadastralUnitCode=${item.ku}&outputType=html`;
          resp = await fetch(directUrl);
          html = await resp.text();
          doc = new DOMParser().parseFromString(html, 'text/html');
          text = doc.body.innerText || doc.body.textContent || '';
        } catch (_) {}
      }

      if (text && text.length > 200 && (text.includes('MAJETKOVÁ PODSTATA') || text.includes('VLASTNÍCI') || text.includes('LIST U VLASTNÍCTVA') || text.includes('Parcely'))) {
        items.push({ lv: item.lv, ku: item.ku, kuName: item.kuName, text });
      }
    } catch (e) {
      console.warn(`Failed to fetch LV ${item.lv}:`, e);
    }
  }

  if (items.length > 0) {
    try {
      const saveResp = await apiFetch('/save-lv-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items })
      }).then(r => r.json());

      if (saveResp.error) throw new Error(saveResp.error);

      showToast(`✅ Úspešne uložených ${saveResp.savedDocs} LV, ${saveResp.savedParcels} parciel a ${saveResp.savedOwners} spoluvlastníkov v DuckDB!`, 'success');
    } catch (e) {
      console.error('Save error:', e);
    }
  } else {
    showToast('Zobrazujem uložené dáta v databáze DuckDB.', 'info');
  }

  // Refresh analysis dashboard with all updated DuckDB records
  await loadLvAnalysis(currentSearchName);
}
window.enrichAndAnalyzeLvs = enrichAndAnalyzeLvs;

/** Fetch ALL unique LVs for a name from the register and process them — called from the Analyzá LV amber banner */
window._refetchAllLvs = async function(name) {
  try {
    showToast(`⏳ Načítavam všetky LV pre: ${name}...`, 'info');
    const data = await apiFetch(`/all-unique-lvs?f_name=${encodeURIComponent(name)}`).then(r => r.json());
    if (!data.lvs || !data.lvs.length) {
      showToast('Nenajdené žiadne LV v registri.', 'error');
      return;
    }
    showToast(`⚡ Spracúvam ${data.lvs.length} LV...`, 'info');
    await enrichAndAnalyzeLvs(data.lvs);
  } catch (e) {
    showToast('Chyba: ' + e.message, 'error');
  }
};

async function loadLvAnalysis(searchName) {
  const q = searchName || (document.getElementById('lv-analysis-search')?.value || 'horvath jan');
  showToast(`🔍 Analýza vlastnených pozemkov pre: ${q}...`, 'info');

  try {
    const data = await apiFetch(`/lv-analysis?name=${encodeURIComponent(q)}`).then(r => r.json());
    if (data.error) throw new Error(data.error);

    document.getElementById('lv-stat-count').textContent = fmt(data.storedLvCount) + ' LV';
    document.getElementById('lv-stat-ha').textContent = data.totalOwnedHa + ' ha';
    document.getElementById('lv-stat-m2').textContent = fmt(Math.round(data.totalOwnedM2)) + ' m² čistej výmery';
    document.getElementById('lv-stat-coowners').textContent = fmt(data.coOwners.length);

    // Also show total LVs available in the register (async, non-blocking)
    const statEl = document.getElementById('lv-stat-count');
    statEl.textContent = fmt(data.storedLvCount) + ' LV';
    apiFetch(`/all-unique-lvs?f_name=${encodeURIComponent(q)}`)
      .then(r => r.json())
      .then(all => {
        const total = all.count || 0;
        if (total > data.storedLvCount) {
          statEl.textContent = `${fmt(data.storedLvCount)} / ${fmt(total)} LV`;
          statEl.title = `${data.storedLvCount} stiahnutých z ${total} celkových LV v registri. Kliknite na ⋆ Spracovať v záložke Neznámi vlastníci.`;
          statEl.style.cursor = 'help';

          // Offer a re-fetch button below the stat cards if not fully processed
          const hintEl = document.getElementById('lv-reprocess-hint');
          if (hintEl) {
            hintEl.innerHTML = `
              <div style="margin-bottom:1rem;padding:.75rem 1rem;background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.35);border-radius:.75rem;display:flex;align-items:center;gap:1rem;flex-wrap:wrap">
                ⚠️ <strong>${data.storedLvCount} z ${total}</strong> LV spracovaných. ${total - data.storedLvCount} LV ešte nie je stiahnutých z Katastra.
                <button class="bulk-lv-btn" style="background:linear-gradient(135deg,#10b981,#059669);margin:0" onclick="window._refetchAllLvs('${esc(q)}')">  ⚡ Stažuj zvyšných ${total - data.storedLvCount} LV</button>
              </div>`;
          }
        } else {
          statEl.textContent = fmt(data.storedLvCount) + ' LV';
        }
      })
      .catch(() => {
        statEl.textContent = fmt(data.storedLvCount) + ' LV';
      });


    // 1. Render Portfolio Table
    const portfolioWrap = document.getElementById('lv-portfolio-wrap');
    if (!data.lvBreakdown || !data.lvBreakdown.length) {
      portfolioWrap.innerHTML = `<div class="empty-state">Žiadne spracované LV v databáze pre "${esc(q)}". Kliknite na "⚡ Spracovať a Uložiť Všetky LV" v záložke Neznámi vlastníci.</div>`;
    } else {
      portfolioWrap.innerHTML = `
        <table>
          <thead>
            <tr>
              <th>Katastrálne územie</th>
              <th>LV #</th>
              <th>Meno na LV</th>
              <th>Por. č.</th>
              <th>Podiel (Zlomok)</th>
              <th>Podiel (%)</th>
              <th>Celková výmera LV</th>
              <th>Vypočítaný podiel (m²)</th>
              <th>Titul nadobudnutia</th>
              <th>Kataster Link</th>
            </tr>
          </thead>
          <tbody>
            ${data.lvBreakdown.map(r => `
              <tr>
                <td><strong>${esc(r.nazov_ku)}</strong> (${fmt(r.cislo_ku)})</td>
                <td><span class="badge badge-amber">LV ${fmt(r.lv)}</span></td>
                <td><strong>${esc(r.meno_vlastnika)}</strong></td>
                <td>${fmt(r.poradove_cislo)}</td>
                <td><span class="badge badge-blue">${esc(r.podiel_str)}</span></td>
                <td>${(r.podiel_decimal * 100).toFixed(4)} %</td>
                <td>${fmt(r.celkova_vymera_m2)} m²</td>
                <td><strong style="color:#6ee7b7">${fmt(r.owned_m2)} m²</strong></td>
                <td style="font-size:0.75rem;color:var(--text-secondary)">${esc(r.titul_nadobudnutia || '-')}</td>
                <td>
                  <a href="https://kataster.skgeodesy.sk/Portal45/api/Bo/GeneratePrfPublic?prfNumber=${r.lv}&cadastralUnitCode=${r.cislo_ku}&outputType=html"
                     target="_blank" class="btn-lv-link">📜 Výpis LV ${r.lv} ↗</a>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>`;
    }

    // 2. Render Land Type Breakdown Table
    const landWrap = document.getElementById('lv-landtype-wrap');
    if (!data.landTypeBreakdown || !data.landTypeBreakdown.length) {
      landWrap.innerHTML = '<div class="empty-state">Žiadne dáta o parcelách</div>';
    } else {
      landWrap.innerHTML = `
        <table>
          <thead>
            <tr>
              <th>Druh pozemku</th>
              <th>Počet parciel</th>
              <th>Celková výmera</th>
            </tr>
          </thead>
          <tbody>
            ${data.landTypeBreakdown.map(r => `
              <tr>
                <td><strong>${esc(r.druh_pozemku)}</strong></td>
                <td><span class="badge badge-blue">${fmt(r.parcel_count)}</span></td>
                <td><strong style="color:#93c5fd">${fmt(r.total_type_m2)} m²</strong> (${(r.total_type_m2/10000).toFixed(2)} ha)</td>
              </tr>
            `).join('')}
          </tbody>
        </table>`;
    }

    // 3. Render Co-Owners Table
    const coWrap = document.getElementById('lv-coowners-wrap');
    if (!data.coOwners || !data.coOwners.length) {
      coWrap.innerHTML = '<div class="empty-state">Žiadni spoluvlastníci</div>';
    } else {
      coWrap.innerHTML = `
        <table>
          <thead>
            <tr>
              <th>Spoluvlastník</th>
              <th>Dátum narodenia</th>
              <th>Spoločné LV</th>
            </tr>
          </thead>
          <tbody>
            ${data.coOwners.map(r => `
              <tr>
                <td><strong>${esc(r.meno_vlastnika)}</strong></td>
                <td style="font-size:0.78rem;color:var(--text-secondary)">${esc(r.datum_narodenia || '-')}</td>
                <td><span class="badge badge-amber">${fmt(r.shared_lvs_count)} LV</span></td>
              </tr>
            `).join('')}
          </tbody>
        </table>`;
    }

  } catch (e) {
    showToast('Chyba pri načítaní analýzy: ' + e.message, 'error');
  }
}
window.loadLvAnalysis = loadLvAnalysis;
window.runLvAnalysisUI = () => {
  const q = document.getElementById('lv-analysis-search')?.value;
  loadLvAnalysis(q);
};

function renderOwnerTable(rows, focusInfo) {
  const wrap = document.getElementById('owners-table-wrap');
  const s = ownerState;

  if (!rows || !rows.length) {
    wrap.innerHTML = '<div class="empty-state">Žiadne výsledky pre zadaný filter</div>';
    const bulkBar = document.getElementById('owners-bulk-bar');
    if (bulkBar) bulkBar.innerHTML = '';
    restoreFocus(focusInfo);
    return;
  }

  // Collect unique LVs for bulk action bar
  const uniqueLvsMap = new Map();
  rows.forEach(r => {
    if (r.lv && r.poradove_cislo) {
      const key = `${r.poradove_cislo}_${r.lv}`;
      if (!uniqueLvsMap.has(key)) {
        uniqueLvsMap.set(key, { lv: r.lv, ku: r.poradove_cislo, kuName: r.katastralne_uzemie });
      }
    }
  });
  const uniqueLvsOnPage = Array.from(uniqueLvsMap.values());

  const bulkBar = document.getElementById('owners-bulk-bar');
  if (bulkBar) {
    if (uniqueLvsOnPage.length > 0) {
      // Store page LVs as fallback immediately
      window._currentOwnerLvs = uniqueLvsOnPage;

      // Fetch ALL unique LVs across every page from the server
      const s = ownerState;
      const params = new URLSearchParams();
      if (s.q)                    params.set('q',      s.q);
      if (s.colFilters.ku)        params.set('f_ku',   s.colFilters.ku);
      if (s.colFilters.name)      params.set('f_name', s.colFilters.name);
      if (s.colFilters.cislo)     params.set('f_cislo',s.colFilters.cislo);
      if (s.colFilters.lv)        params.set('f_lv',   s.colFilters.lv);

      // Show count immediately with page data, then update when server responds
      const renderBulkBar = (allLvs, loading) => {
        window._currentOwnerLvs = allLvs;
        bulkBar.innerHTML = `
          <div class="bulk-lv-bar">
            <div>⚡ Zobrazených <strong>${rows.length}</strong> záznamov — <strong>${allLvs.length}</strong> unikátnych LV${loading ? ' <span style="opacity:.6">(načítavam všetky...)</span>' : ' celkovo'}</div>
            <div style="display:flex;gap:0.5rem">
              <button class="bulk-lv-btn" style="background:linear-gradient(135deg, #10b981, #059669)" onclick="window.enrichAndAnalyzeLvs(window._currentOwnerLvs)">
                ⚡ Spracovať, Uložiť & Analyzovať v DuckDB 🌲 (${allLvs.length} LV)
              </button>
              <button class="bulk-lv-btn" onclick="window.openAllLvs(window._currentOwnerLvs)">
                🚀 Otvoriť výpisy ↗
              </button>
            </div>
          </div>`;
      };

      renderBulkBar(uniqueLvsOnPage, true);

      // Async fetch all unique LVs across all pages
      apiFetch(`/all-unique-lvs?${params}`)
        .then(r => r.json())
        .then(data => {
          if (data.lvs && data.lvs.length > 0) {
            renderBulkBar(data.lvs, false);
          }
        })
        .catch(() => renderBulkBar(uniqueLvsOnPage, false));
    } else {
      bulkBar.innerHTML = '';
    }
  }

  function sTh(label, col) {
    const active = s.sortCol === col;
    const icon   = active ? (s.sortDir === 'ASC' ? '↑' : '↓') : '↕';
    const keyMap = { katastralne_uzemie: 'ku', poradove_cislo: 'cislo', lv: 'lv', meno_vlastnika: 'name' };
    const hasFil = !!s.colFilters[keyMap[col]];
    return `<th class="sortable${active ? ' sort-active' : ''}${hasFil ? ' has-filter' : ''}" onclick="window.sortOwners('${col}')">
      ${label}<span class="sort-ic">${icon}</span>
    </th>`;
  }

  function fTh(key, placeholder) {
    const val = (s.colFilters[key] || '').replace(/"/g, '&quot;');
    return `<th class="filter-cell">
      <input class="col-filter" id="oc-${key}"
             placeholder="${placeholder}"
             value="${val}">
    </th>`;
  }

  wrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th style="width:70px">#</th>
          ${sTh('Katast. územie', 'katastralne_uzemie')}
          ${sTh('Por. číslo', 'poradove_cislo')}
          ${sTh('LV', 'lv')}
          ${sTh('Meno vlastníka', 'meno_vlastnika')}
          ${sTh('Kataster Výpis', 'lv')}
        </tr>
        <tr class="filter-row">
          <th></th>
          ${fTh('ku',    'Filter k.ú...')}
          ${fTh('cislo', 'Filter čísla...')}
          ${fTh('lv',    'Filter LV...')}
          ${fTh('name',  'Filter mena...')}
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td><span class="badge badge-blue" style="font-size:0.68rem">${fmt(r.id)}</span></td>
            <td>${esc(r.katastralne_uzemie)}</td>
            <td>${fmt(r.poradove_cislo)}</td>
            <td>
              <span class="badge badge-amber badge-clickable"
                    title="Otvoriť Kataster Portal (${esc(r.katastralne_uzemie)}, LV ${fmt(r.lv)})"
                    onclick="window.openKatasterLV('${esc(r.katastralne_uzemie).replace(/'/g, "\\'")}', '${r.poradove_cislo}', '${r.lv}')">
                📄 LV ${fmt(r.lv)} ↗
              </span>
            </td>
            <td>${esc(r.meno_vlastnika)}</td>
            <td>
              <a href="https://kataster.skgeodesy.sk/Portal45/api/Bo/GeneratePrfPublic?prfNumber=${r.lv}&cadastralUnitCode=${r.poradove_cislo}&outputType=html"
                 target="_blank"
                 class="btn-lv-link"
                 title="Otvoriť priamy výpis z Katastra pre LV ${fmt(r.lv)} (${esc(r.katastralne_uzemie)})">
                📜 Výpis LV ${fmt(r.lv)} ↗
              </a>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;

  restoreFocus(focusInfo);
}

function clearOwnerSearch() {
  const s = document.getElementById('owner-search');
  const k = document.getElementById('owner-ku-filter');
  if (s) s.value = '';
  if (k) k.value = '';
  ownerState.colFilters = { ku: '', cislo: '', lv: '', name: '' };
  ownerState.sortCol = 'katastralne_uzemie';
  ownerState.sortDir = 'ASC';
  loadOwners(1);
}

// ════════════════════════════════════════════════════════════════════════════
//  TRANSFERRED TAB
// ════════════════════════════════════════════════════════════════════════════

const trState = {
  page: 1,
  sortCol: 'year',
  sortDir: 'DESC',
  colFilters: { year: '', lv: '', vlastnik: '', cislo: '', ku: '', datum: '' },
};

let trFetchController = null;
let _trTimer = null;

function syncTrStateFromDOM() {
  const active = document.activeElement ? document.activeElement.id : '';

  const topVlast  = document.getElementById('tr-search')?.value || '';
  const topKu     = document.getElementById('tr-ku-filter')?.value || '';
  const topYear   = document.getElementById('tr-year-filter')?.value || '';
  const colYear   = document.getElementById('tc-year')?.value || '';
  const colLv     = document.getElementById('tc-lv')?.value || '';
  const colVlast  = document.getElementById('tc-vlastnik')?.value || '';
  const colCislo  = document.getElementById('tc-cislo')?.value || '';
  const colKu     = document.getElementById('tc-ku')?.value || '';
  const colDatum  = document.getElementById('tc-datum')?.value || '';

  if (active === 'tr-search') trState.colFilters.vlastnik = topVlast;
  else if (active === 'tc-vlastnik') trState.colFilters.vlastnik = colVlast;
  else trState.colFilters.vlastnik = topVlast || colVlast || trState.colFilters.vlastnik || '';

  if (active === 'tr-ku-filter') trState.colFilters.ku = topKu;
  else if (active === 'tc-ku') trState.colFilters.ku = colKu;
  else trState.colFilters.ku = topKu || colKu || trState.colFilters.ku || '';

  if (active === 'tr-year-filter') trState.colFilters.year = topYear;
  else if (active === 'tc-year') trState.colFilters.year = colYear;
  else trState.colFilters.year = topYear || colYear || trState.colFilters.year || '';

  if (colLv) trState.colFilters.lv = colLv;
  if (colCislo) trState.colFilters.cislo = colCislo;
  if (colDatum) trState.colFilters.datum = colDatum;
}

function debouncedLoadTransferred(delay = 50) {
  clearTimeout(_trTimer);
  _trTimer = setTimeout(() => loadTransferred(1), delay);
}

function onTrTopInput(key, val) {
  trState.colFilters[key] = val;
  const colEl = document.getElementById(
    key === 'ku' ? 'tc-ku' : key === 'vlastnik' ? 'tc-vlastnik' : key === 'year' ? 'tc-year' : ''
  );
  if (colEl && colEl !== document.activeElement) colEl.value = val;
  debouncedLoadTransferred();
}

function setTrColFilter(key, val) {
  trState.colFilters[key] = val;
  if (key === 'ku') {
    const topEl = document.getElementById('tr-ku-filter');
    if (topEl && topEl !== document.activeElement) topEl.value = val;
  } else if (key === 'vlastnik') {
    const topEl = document.getElementById('tr-search');
    if (topEl && topEl !== document.activeElement) topEl.value = val;
  } else if (key === 'year') {
    const topEl = document.getElementById('tr-year-filter');
    if (topEl && topEl !== document.activeElement) topEl.value = val;
  }
  debouncedLoadTransferred();
}

async function loadTransferred(page = 1) {
  trState.page = page;
  syncTrStateFromDOM();

  if (trFetchController) trFetchController.abort();
  trFetchController = new AbortController();
  const signal = trFetchController.signal;

  const focusInfo = captureFocus();
  const wrap = document.getElementById('tr-table-wrap');

  if (wrap.querySelector('table')) {
    wrap.style.opacity = '0.7';
  } else {
    wrap.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div>Načítavam...</div>';
  }

  const params = new URLSearchParams({
    page, limit: 50,
    sort_col: trState.sortCol,
    sort_dir: trState.sortDir,
    f_year:  trState.colFilters.year,
    f_lv:    trState.colFilters.lv,
    f_vlast: trState.colFilters.vlastnik,
    f_cislo: trState.colFilters.cislo,
    f_ku:    trState.colFilters.ku,
    f_datum: trState.colFilters.datum,
  });

  try {
    const data = await apiFetch(`/transferred?${params}`, { signal }).then(r => r.json());
    if (data.error) throw new Error(data.error);

    document.getElementById('tr-total-label').textContent = fmt(data.total) + ' záznamov';
    renderTrTable(data.rows, focusInfo);
    renderPagination('tr-pagination', page, data.total, 50, loadTransferred);
  } catch (e) {
    if (e.name === 'AbortError') return;
    showToast('Chyba: ' + e.message, 'error');
    wrap.innerHTML = `<div class="empty-state" style="color:#ef4444">❌ ${esc(e.message)}</div>`;
  } finally {
    if (!signal.aborted) wrap.style.opacity = '1';
  }
}

function sortTr(col) {
  if (trState.sortCol === col) {
    trState.sortDir = trState.sortDir === 'ASC' ? 'DESC' : 'ASC';
  } else {
    trState.sortCol = col;
    trState.sortDir = col === 'year' ? 'DESC' : 'ASC';
  }
  loadTransferred(1);
}

function renderTrTable(rows, focusInfo) {
  const wrap = document.getElementById('tr-table-wrap');
  const s = trState;

  if (!rows || !rows.length) {
    wrap.innerHTML = '<div class="empty-state">Žiadne výsledky pre zadaný filter</div>';
    const bulkBar = document.getElementById('tr-bulk-bar');
    if (bulkBar) bulkBar.innerHTML = '';
    restoreFocus(focusInfo);
    return;
  }

  // Collect unique LVs for bulk action bar
  const uniqueLvsMap = new Map();
  rows.forEach(r => {
    if (r.lv && r.cislo_ku) {
      const key = `${r.cislo_ku}_${r.lv}`;
      if (!uniqueLvsMap.has(key)) {
        uniqueLvsMap.set(key, { lv: r.lv, ku: r.cislo_ku, kuName: r.nazov_ku });
      }
    }
  });
  const uniqueLvsOnPageTr = Array.from(uniqueLvsMap.values());

  const bulkBar = document.getElementById('tr-bulk-bar');
  if (bulkBar) {
    if (uniqueLvsOnPageTr.length > 0) {
      window._currentTrLvs = uniqueLvsOnPageTr;

      const trParams = new URLSearchParams();
      if (s.q)                    trParams.set('q',       s.q);
      if (s.colFilters.ku)        trParams.set('f_ku',    s.colFilters.ku);
      if (s.colFilters.vlastnik)  trParams.set('f_vlast', s.colFilters.vlastnik);
      if (s.colFilters.cislo)     trParams.set('f_cislo', s.colFilters.cislo);
      if (s.colFilters.lv)        trParams.set('f_lv',    s.colFilters.lv);
      if (s.colFilters.datum)     trParams.set('f_datum', s.colFilters.datum);
      if (s.colFilters.year)      trParams.set('f_year',  s.colFilters.year);

      const renderTrBulkBar = (allLvs, loading) => {
        window._currentTrLvs = allLvs;
        bulkBar.innerHTML = `
          <div class="bulk-lv-bar">
            <div>⚡ Zobrazených <strong>${rows.length}</strong> záznamov — <strong>${allLvs.length}</strong> unikátnych LV${loading ? ' <span style="opacity:.6">(načítavam všetky...)</span>' : ' celkovo'}</div>
            <button class="bulk-lv-btn" onclick="window.openAllLvs(window._currentTrLvs)">
              🚀 Otvoriť všetkých ${allLvs.length} unikátnych LV v Katastri ↗
            </button>
          </div>`;
      };

      renderTrBulkBar(uniqueLvsOnPageTr, true);

      apiFetch(`/all-unique-transferred-lvs?${trParams}`)
        .then(r => r.json())
        .then(data => {
          if (data.lvs && data.lvs.length > 0) renderTrBulkBar(data.lvs, false);
        })
        .catch(() => renderTrBulkBar(uniqueLvsOnPageTr, false));
    } else {
      bulkBar.innerHTML = '';
    }
  }

  const yearColors = { 2022: 'badge-blue', 2023: 'badge-green', 2024: 'badge-amber', 2025: 'badge-red' };

  function sTh(label, col) {
    const active = s.sortCol === col;
    const icon   = active ? (s.sortDir === 'ASC' ? '↑' : '↓') : '↕';
    const colKey = { year: 'year', lv: 'lv', vlastnik_lv: 'vlastnik', cislo_ku: 'cislo', nazov_ku: 'ku', datum_ucinnosti: 'datum' }[col];
    const hasFil = colKey && !!s.colFilters[colKey];
    return `<th class="sortable${active ? ' sort-active' : ''}${hasFil ? ' has-filter' : ''}" onclick="window.sortTr('${col}')">
      ${label}<span class="sort-ic">${icon}</span>
    </th>`;
  }

  function fTh(key, placeholder) {
    const val = (s.colFilters[key] || '').replace(/"/g, '&quot;');
    return `<th class="filter-cell">
      <input class="col-filter" id="tc-${key}"
             placeholder="${placeholder}"
             value="${val}">
    </th>`;
  }

  wrap.innerHTML = `
    <table>
      <thead>
        <tr>
          ${sTh('Rok', 'year')}
          ${sTh('LV', 'lv')}
          ${sTh('Vlastník podľa LV', 'vlastnik_lv')}
          ${sTh('Číslo k.ú.', 'cislo_ku')}
          ${sTh('Názov k.ú.', 'nazov_ku')}
          ${sTh('CRZ', 'crz')}
          ${sTh('Dátum účinnosti', 'datum_ucinnosti')}
          ${sTh('Kataster Výpis', 'lv')}
        </tr>
        <tr class="filter-row">
          ${fTh('year',    'Rok...')}
          ${fTh('lv',      'LV...')}
          ${fTh('vlastnik','Meno...')}
          ${fTh('cislo',   'Číslo...')}
          ${fTh('ku',      'K.ú. názov...')}
          <th></th>
          ${fTh('datum',   'Dátum...')}
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td><span class="badge ${yearColors[r.year] || 'badge-blue'}">${r.year}</span></td>
            <td>
              <span class="badge badge-amber badge-clickable"
                    title="Otvoriť Kataster Portal (${esc(r.nazov_ku)}, LV ${fmt(r.lv)})"
                    onclick="window.openKatasterLV('${esc(r.nazov_ku).replace(/'/g, "\\'")}', '${r.cislo_ku}', '${r.lv}')">
                📄 LV ${fmt(r.lv)} ↗
              </span>
            </td>
            <td>${esc(r.vlastnik_lv)}</td>
            <td>${fmt(r.cislo_ku)}</td>
            <td>${esc(r.nazov_ku)}</td>
            <td style="font-size:0.72rem;color:var(--text-secondary)">${esc(r.crz)}</td>
            <td>${fmtDate(r.datum_ucinnosti)}</td>
            <td>
              <a href="https://kataster.skgeodesy.sk/Portal45/api/Bo/GeneratePrfPublic?prfNumber=${r.lv}&cadastralUnitCode=${r.cislo_ku}&outputType=html"
                 target="_blank"
                 class="btn-lv-link"
                 title="Otvoriť priamy výpis z Katastra pre LV ${fmt(r.lv)} (${esc(r.nazov_ku)})">
                📜 Výpis LV ${fmt(r.lv)} ↗
              </a>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;

  restoreFocus(focusInfo);
}

function clearTrSearch() {
  const s = document.getElementById('tr-search');
  const k = document.getElementById('tr-ku-filter');
  const y = document.getElementById('tr-year-filter');
  if (s) s.value = '';
  if (k) k.value = '';
  if (y) y.value = '';
  trState.colFilters = { year: '', lv: '', vlastnik: '', cislo: '', ku: '', datum: '' };
  trState.sortCol = 'year';
  trState.sortDir = 'DESC';
  loadTransferred(1);
}

// ════════════════════════════════════════════════════════════════════════════
//  GLOBAL EVENT DELEGATION FOR ALL INPUTS
// ════════════════════════════════════════════════════════════════════════════
document.addEventListener('input', (e) => {
  const id = e.target.id;
  if (!id) return;

  if (id === 'owner-search') {
    ownerState.colFilters.name = e.target.value;
    const oc = document.getElementById('oc-name');
    if (oc && oc !== e.target) oc.value = e.target.value;
    debouncedLoadOwners();
  } else if (id === 'owner-ku-filter') {
    ownerState.colFilters.ku = e.target.value;
    const oc = document.getElementById('oc-ku');
    if (oc && oc !== e.target) oc.value = e.target.value;
    debouncedLoadOwners();
  } else if (id === 'oc-name') {
    ownerState.colFilters.name = e.target.value;
    const top = document.getElementById('owner-search');
    if (top && top !== e.target) top.value = e.target.value;
    debouncedLoadOwners();
  } else if (id === 'oc-ku') {
    ownerState.colFilters.ku = e.target.value;
    const top = document.getElementById('owner-ku-filter');
    if (top && top !== e.target) top.value = e.target.value;
    debouncedLoadOwners();
  } else if (id === 'oc-cislo') {
    ownerState.colFilters.cislo = e.target.value;
    debouncedLoadOwners();
  } else if (id === 'oc-lv') {
    ownerState.colFilters.lv = e.target.value;
    debouncedLoadOwners();
  } else if (id === 'tr-search') {
    trState.colFilters.vlastnik = e.target.value;
    const tc = document.getElementById('tc-vlastnik');
    if (tc && tc !== e.target) tc.value = e.target.value;
    debouncedLoadTransferred();
  } else if (id === 'tr-ku-filter') {
    trState.colFilters.ku = e.target.value;
    const tc = document.getElementById('tc-ku');
    if (tc && tc !== e.target) tc.value = e.target.value;
    debouncedLoadTransferred();
  } else if (id === 'tc-vlastnik') {
    trState.colFilters.vlastnik = e.target.value;
    const top = document.getElementById('tr-search');
    if (top && top !== e.target) top.value = e.target.value;
    debouncedLoadTransferred();
  } else if (id === 'tc-ku') {
    trState.colFilters.ku = e.target.value;
    const top = document.getElementById('tr-ku-filter');
    if (top && top !== e.target) top.value = e.target.value;
    debouncedLoadTransferred();
  } else if (id === 'tc-year') {
    trState.colFilters.year = e.target.value;
    const top = document.getElementById('tr-year-filter');
    if (top && top !== e.target) top.value = e.target.value;
    debouncedLoadTransferred();
  } else if (id === 'tc-lv' || id === 'tc-cislo' || id === 'tc-datum') {
    const keyMap = { 'tc-lv': 'lv', 'tc-cislo': 'cislo', 'tc-datum': 'datum' };
    trState.colFilters[keyMap[id]] = e.target.value;
    debouncedLoadTransferred();
  }
});

document.addEventListener('change', (e) => {
  const id = e.target.id;
  if (id === 'tr-year-filter') {
    trState.colFilters.year = e.target.value;
    const tc = document.getElementById('tc-year');
    if (tc && tc !== e.target) tc.value = e.target.value;
    debouncedLoadTransferred();
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  OVERLAP TAB
// ════════════════════════════════════════════════════════════════════════════

let chartOverlapKu = null;
let chartOverlapLv = null;

async function loadOverlap() {
  document.getElementById('overlap-table-wrap').innerHTML =
    '<div class="loading-state"><div class="loading-spinner"></div>Načítavam prienik...</div>';
  try {
    const data = await apiFetch(`/overlap?limit=200`).then(r => r.json());
    document.getElementById('overlap-count-label').textContent = `${fmt(data.length)} zhodných LV`;
    renderOverlapTable(data);
    renderOverlapCharts(data);
  } catch (e) {
    showToast('Chyba: ' + e.message, 'error');
  }
}

function renderOverlapTable(rows) {
  if (!rows.length) {
    document.getElementById('overlap-table-wrap').innerHTML = '<div class="empty-state">Žiadny prienik nenájdený</div>';
    return;
  }
  document.getElementById('overlap-table-wrap').innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Katast. územie</th>
          <th>Číslo k.ú.</th>
          <th>LV</th>
          <th>Neznámi vlastníci</th>
          <th>Prevedené práva</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td><strong>${esc(r.katastralne_uzemie || r.nazov_ku)}</strong></td>
            <td>${fmt(r.poradove_cislo)}</td>
            <td>
              <span class="badge badge-amber badge-clickable"
                    title="Otvoriť Kataster Portal (${esc(r.katastralne_uzemie || r.nazov_ku)}, LV ${fmt(r.lv)})"
                    onclick="window.openKatasterLV('${esc(r.katastralne_uzemie || r.nazov_ku).replace(/'/g, "\\'")}', '${r.poradove_cislo}', '${r.lv}')">
                📄 LV ${fmt(r.lv)} ↗
              </span>
            </td>
            <td><span class="badge badge-blue">${fmt(r.unknown_owner_count)}</span></td>
            <td><span class="badge badge-red">${fmt(r.transferred_count)}</span></td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

function renderOverlapCharts(data) {
  const top20 = data.slice(0, 20);
  if (chartOverlapKu) chartOverlapKu.destroy();
  chartOverlapKu = new Chart(document.getElementById('chart-overlap-ku'), {
    type: 'bar',
    data: {
      labels: top20.map(d => d.katastralne_uzemie || d.nazov_ku || `LV${d.lv}`),
      datasets: [
        { label: 'Neznámi vlastníci', data: top20.map(d => d.unknown_owner_count),
          backgroundColor: PALETTE[0] + 'bb', borderRadius: 4 },
        { label: 'Prevedené práva', data: top20.map(d => d.transferred_count),
          backgroundColor: PALETTE[3] + 'bb', borderRadius: 4 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false, indexAxis: 'y',
      plugins: { legend: { position: 'top' } },
      scales: {
        x: { grid: { color: '#1f2435' } },
        y: { grid: { display: false }, ticks: { font: { size: 9 } } },
      }
    }
  });

  const buckets = {};
  data.forEach(d => { const b = Math.floor(d.lv / 1000) * 1000; buckets[b] = (buckets[b] || 0) + 1; });
  const bKeys = Object.keys(buckets).sort((a, b) => a - b);

  if (chartOverlapLv) chartOverlapLv.destroy();
  chartOverlapLv = new Chart(document.getElementById('chart-overlap-lv'), {
    type: 'bar',
    data: {
      labels: bKeys.map(k => `${fmt(k)}–${fmt(Number(k) + 999)}`),
      datasets: [{ label: 'Počet LV', data: bKeys.map(k => buckets[k]),
        backgroundColor: PALETTE[2] + 'bb', borderRadius: 4 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 45, font: { size: 9 } } },
        y: { grid: { color: '#1f2435' } },
      }
    }
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  CORRELATIONS TAB
// ════════════════════════════════════════════════════════════════════════════

let chartSpf = null, chartLvBuckets = null, chartYearKu = null;

async function loadCorrelations() {
  try {
    const data = await apiFetch(`/correlations`).then(r => r.json());
    renderSpfChart(data.spfAnalysis);
    renderKuBars(data.bothDatasets);
    renderLvBuckets(data.lvBuckets);
    renderYearKuChart(data.yearByKu);
  } catch (e) {
    showToast('Chyba: ' + e.message, 'error');
  }
}

function renderSpfChart(data) {
  if (chartSpf) chartSpf.destroy();
  chartSpf = new Chart(document.getElementById('chart-spf'), {
    type: 'bar',
    data: {
      labels: data.map(d => String(d.year)),
      datasets: [
        { label: 'SPF vlastníci', data: data.map(d => d.spf_count),
          backgroundColor: PALETTE[0] + 'cc', borderRadius: 5 },
        { label: 'Ostatní vlastníci', data: data.map(d => d.non_spf_count),
          backgroundColor: PALETTE[5] + 'cc', borderRadius: 5 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'top' } },
      scales: {
        x: { grid: { display: false } },
        y: { grid: { color: '#1f2435' }, ticks: { callback: v => fmt(v) } },
      }
    }
  });
}

function renderKuBars(data) {
  if (!data?.length) {
    document.getElementById('corr-ku-bars').innerHTML = '<div class="empty-state">Žiadne dáta</div>';
    return;
  }
  const max = Math.max(...data.map(d => d.transfer_rate_pct));
  document.getElementById('corr-ku-bars').innerHTML = data.slice(0, 25).map(d => {
    const pct   = (d.transfer_rate_pct / max * 100).toFixed(1);
    const color = d.transfer_rate_pct > 50 ? '#ef4444' : d.transfer_rate_pct > 20 ? '#f59e0b' : '#3b82f6';
    return `<div class="corr-row">
      <div class="corr-label">
        <span class="corr-name" title="${esc(d.katastralne_uzemie)}">${esc(d.katastralne_uzemie)}</span>
        <span class="corr-val">${d.transfer_rate_pct}%</span>
      </div>
      <div class="corr-track"><div class="corr-fill" style="width:${pct}%;background:${color}"></div></div>
    </div>`;
  }).join('');
}

function renderLvBuckets(data) {
  if (chartLvBuckets) chartLvBuckets.destroy();
  chartLvBuckets = new Chart(document.getElementById('chart-lv-buckets'), {
    type: 'line',
    data: {
      labels: data.map(d => fmt(d.lv_bucket_start)),
      datasets: [{ label: 'Počet vlastníkov', data: data.map(d => d.count),
        borderColor: PALETTE[2], backgroundColor: PALETTE[2] + '22',
        fill: true, tension: 0.4, pointRadius: 2 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: '#1f2435' }, ticks: { maxTicksLimit: 10, font: { size: 9 } } },
        y: { grid: { color: '#1f2435' }, ticks: { callback: v => fmt(v) } },
      }
    }
  });
}

function renderYearKuChart(data) {
  const totals = {};
  data.forEach(d => { totals[d.nazov_ku] = (totals[d.nazov_ku] || 0) + d.count; });
  const topKu = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k);
  const years  = [...new Set(data.map(d => d.year))].sort();

  if (chartYearKu) chartYearKu.destroy();
  chartYearKu = new Chart(document.getElementById('chart-year-ku'), {
    type: 'line',
    data: {
      labels: years.map(String),
      datasets: topKu.map((ku, i) => ({
        label: ku,
        data: years.map(y => { const r = data.find(d => d.nazov_ku === ku && d.year === y); return r ? r.count : 0; }),
        borderColor: PALETTE[i], backgroundColor: PALETTE[i] + '22',
        fill: false, tension: 0.3, pointRadius: 4,
      }))
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'top' } },
      scales: {
        x: { grid: { color: '#1f2435' } },
        y: { grid: { color: '#1f2435' }, ticks: { callback: v => fmt(v) } },
      }
    }
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  PAGINATION
// ════════════════════════════════════════════════════════════════════════════

function renderPagination(containerId, page, total, limit, callback) {
  const pages     = Math.ceil(total / limit);
  const container = document.getElementById(containerId);
  if (!container) return;

  const start = (page - 1) * limit + 1;
  const end   = Math.min(page * limit, total);

  const delta = 2;
  const raw   = [];
  for (let i = 1; i <= pages; i++) {
    if (i === 1 || i === pages || (i >= page - delta && i <= page + delta)) raw.push(i);
  }
  const btns = [];
  let last   = 0;
  for (const p of raw) {
    if (last && p - last > 1) btns.push('…');
    btns.push(p);
    last = p;
  }

  container.innerHTML = `
    <div class="pagination-info">Zobrazujem ${fmt(start)}–${fmt(end)} z ${fmt(total)}</div>
    <div class="pagination-btns">
      <button class="page-btn" ${page <= 1 ? 'disabled' : ''} onclick="window.${callback.name}(${page - 1})">‹</button>
      ${btns.map(b => b === '…'
        ? `<button class="page-btn" disabled>…</button>`
        : `<button class="page-btn ${b === page ? 'active' : ''}" onclick="window.${callback.name}(${b})">${b}</button>`
      ).join('')}
      <button class="page-btn" ${page >= pages ? 'disabled' : ''} onclick="window.${callback.name}(${page + 1})">›</button>
    </div>`;
}

// ════════════════════════════════════════════════════════════════════════════
//  SQL TAB
// ════════════════════════════════════════════════════════════════════════════

async function runCustomQuery() {
  const sql  = document.getElementById('sql-editor').value.trim();
  if (!sql) return;
  const card = document.getElementById('sql-result-card');
  const wrap = document.getElementById('sql-table-wrap');
  card.style.display = 'block';
  wrap.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div>Vykonávam dotaz...</div>';
  document.getElementById('sql-result-count').textContent = '';

  try {
    const resp = await apiFetch(`/custom-query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql }),
    });
    const data = await resp.json();
    if (data.error) {
      wrap.innerHTML = `<div class="empty-state" style="color:#ef4444">❌ ${esc(data.error)}</div>`;
      return;
    }
    document.getElementById('sql-result-count').textContent = `${fmt(data.count)} záznamov`;
    if (!data.rows.length) { wrap.innerHTML = '<div class="empty-state">Žiadne výsledky</div>'; return; }

    const cols = Object.keys(data.rows[0]);
    wrap.innerHTML = `
      <table>
        <thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
        <tbody>
          ${data.rows.slice(0, 500).map(row =>
            `<tr>${cols.map(c => `<td>${row[c] !== null ? esc(String(row[c])) : '—'}</td>`).join('')}</tr>`
          ).join('')}
        </tbody>
      </table>`;
    showToast(`Dotaz úspešný — ${fmt(data.count)} záznamov`, 'success');
  } catch (e) {
    wrap.innerHTML = `<div class="empty-state" style="color:#ef4444">❌ ${esc(e.message)}</div>`;
    showToast('Chyba dotazu: ' + e.message, 'error');
  }
}

const SAMPLE_QUERIES = {
  overlap: `SELECT
  uo.katastralne_uzemie,
  uo.lv,
  uo.meno_vlastnika AS neznamy_vlastnik,
  tr.vlastnik_lv    AS prevedene_na,
  tr.datum_ucinnosti,
  tr.year            AS rok_prevodu
FROM unknown_owners uo
JOIN transferred_rights tr
  ON uo.lv = tr.lv AND uo.poradove_cislo = tr.cislo_ku
ORDER BY tr.year DESC, uo.katastralne_uzemie
LIMIT 100`,

  spf: `SELECT
  vlastnik_lv,
  COUNT(*)                  AS pocet,
  MIN(year)                 AS prvy_rok,
  MAX(year)                 AS posledny_rok,
  COUNT(DISTINCT cislo_ku)  AS pocet_ku
FROM transferred_rights
WHERE vlastnik_lv ILIKE '%(SPF)%'
GROUP BY vlastnik_lv
ORDER BY pocet DESC
LIMIT 50`,

  stats: `SELECT
  (SELECT COUNT(*) FROM unknown_owners)                     AS celkovo_neznami,
  (SELECT COUNT(DISTINCT katastralne_uzemie) FROM unknown_owners) AS unikatne_ku,
  (SELECT COUNT(*) FROM transferred_rights WHERE year = 2022) AS prevody_2022,
  (SELECT COUNT(*) FROM transferred_rights WHERE year = 2023) AS prevody_2023,
  (SELECT COUNT(*) FROM transferred_rights WHERE year = 2024) AS prevody_2024,
  (SELECT COUNT(*) FROM transferred_rights WHERE year = 2025) AS prevody_2025,
  (SELECT COUNT(*) FROM v_overlap)                           AS prienik_lv`,
};

function setSampleQuery(name) {
  document.getElementById('sql-editor').value = SAMPLE_QUERIES[name] || '';
}

// ── GEOGRAPHIC MAP OF SLOVAKIA ENGINE ───────────────────────────────────────
let skMap = null;
let mapTileLayer = null;
let mapMarkersGroup = null;
let geoStatsData = null;

const SLOVAK_COORDINATES = {
  // Key Slovak Towns & Cadastral Units (Official GPS Coordinates)
  'Veľký Sulín': [49.3650, 20.7600],
  'Sulín': [49.3620, 20.7510],
  'Stráňany': [49.3490, 20.5730],
  'Mníšek nad Popradom': [49.4140, 20.6550],
  'Veľký Lipník': [49.3730, 20.5050],
  'Haligovce': [49.3780, 20.4440],
  'Kremná': [49.3680, 20.5790],
  'Stará Ľubovňa': [49.3015, 20.6885],
  'Stará Bystrica': [49.3460, 18.9480],
  'Východná': [49.0600, 19.8900],
  'Bardejov': [49.2920, 21.2760],
  'Poprad': [49.0550, 20.2980],
  'Kežmarok': [49.1360, 20.4330],
  'Prešov': [48.9980, 21.2400],
  'Košice': [48.7160, 21.2580],
  'Žilina': [49.2230, 18.7390],
  'Bratislava': [48.1480, 17.1070],
  'Banská Bystrica': [48.7360, 19.1460],
  'Nitra': [48.3060, 18.0860],
  'Trnava': [48.3770, 17.5860],
  'Trenčín': [48.8940, 18.0400],
  'Martin': [49.0660, 18.9220],
  'Liptovský Mikuláš': [49.0830, 19.6130],
  'Svidník': [49.3050, 21.5670],
  'Stropkov': [49.2020, 21.6520],
  'Medzilaborce': [49.2710, 21.9050],
  'Humenné': [48.9370, 21.9080],
  'Snina': [48.9870, 22.1500],
  'Michalovce': [48.7560, 21.9190],
  'Tichý Potok': [49.1450, 20.7850],
  'Dacov': [48.3180, 19.1550],
  'Dačov Lom': [48.3180, 19.1550],
  'Levice': [48.2150, 18.6080],
  'Veľké Zálužie': [48.3030, 17.9550],
  'Detva': [48.5600, 19.4180],
  'Zakarovce': [48.8750, 20.8650],
  'Sološnica': [48.4610, 17.2280],
  'Šološnica': [48.4610, 17.2280],
  'Jasov': [48.6810, 20.9730],
  'Papradno': [49.2300, 18.4000],
  'Kolárovo': [47.9150, 17.9950],
  'Moravské Lieskové': [48.8150, 17.8000],
  'Čadca': [49.4380, 18.7880],
  'Liptovská Lúžna': [48.9400, 19.2600],
  'Skalité': [49.4950, 18.8950],
  'Oščadnica': [49.4350, 18.8850],
  'Klokočov': [49.4500, 18.5700],
  'Ružomberok': [49.0750, 19.3000],
  'Krásno nad Kysucou': [49.3950, 18.8350],
  'Svrčinovec': [49.4800, 18.7950],
  'Nesluša': [49.3000, 18.7400],
  'Nová Bystrica': [49.3400, 19.0100],
  'Dolná Poruba': [48.9100, 18.3100],
  'Močenok': [48.2300, 17.9300],
  'Brodské': [48.6900, 17.0100],
  'Riečnica': [49.3300, 19.0500],
  'Čachtice': [48.7150, 17.7850],
  'Vrbovce': [48.8000, 17.4700],
  'Terchová': [49.2580, 19.0300],
  'Zázrivá': [49.2800, 19.1500],
  'Rajecká Lesná': [49.0400, 18.6300],
  'Vysoká nad Kysucou': [49.3800, 18.5500],
  'Mojtín': [49.0150, 18.4100],
  'Radôstka': [49.3000, 18.9300],
  'Dlhé Pole': [49.3100, 18.6300],
  'Horná Tižina': [49.2300, 19.0200],
  'Turzovka': [49.4050, 18.6250],
  'Dohnany': [49.1450, 18.2800],
  'Dohňany': [49.1450, 18.2800],
  'Púchov': [49.1200, 18.3200],
  'Považská Bystrica': [49.1170, 18.4480],
  'Bytča': [49.2230, 18.5580],
  'Kysucké Nové Mesto': [49.3000, 18.7800],
  'Čirč': [49.2800, 20.9200],
  'Orlov': [49.2800, 20.8600],
  'Jarabina': [49.3300, 20.6500],
  'Chmeľnica': [49.2900, 20.7300],
  'Podolínec': [49.2570, 20.5370],
  'Plavnica': [49.2700, 20.7800]
};

async function initSlovakiaMap() {
  const mapContainer = document.getElementById('sk-map');
  if (!mapContainer) return;

  if (!skMap) {
    // 1. Initialize Leaflet Map centered on Central/East Slovakia
    skMap = L.map('sk-map', {
      center: [49.0, 20.2],
      zoom: 8.5,
      zoomControl: true
    });

    applyMapTheme(currentTheme());

    mapMarkersGroup = L.layerGroup().addTo(skMap);

    // Re-render markers on zoom change for optimal badge density
    skMap.on('zoomend', () => {
      if (geoJsonLayer && window._geoBoundariesData) {
        renderGeoPills();
      } else if (geoStatsData && geoStatsData.topKu) {
        renderMapMarkers(geoStatsData.topKu);
      }
    });
  }

  window.skMap = skMap;
  window.mapMarkersGroup = mapMarkersGroup;

  setTimeout(() => {
    if (skMap) skMap.invalidateSize();
  }, 150);

  // 2. Fetch Geo Stats & GeoJSON boundaries
  if (!geoStatsData) {
    try {
      geoStatsData = await apiFetch('/geo-stats').then(r => r.json());
      populateMapOkresSelect();
      renderMapChips(geoStatsData.topKu);
    } catch (e) {
      console.error('Failed to load map geo stats:', e);
    }
  }

  // Load official GeoJSON boundaries
  loadGeoJsonBoundaries();
}
window.initSlovakiaMap = initSlovakiaMap;

let geoJsonLayer = null;
let _mapFilterKey = '';

function mapFilterKus() {
  if (ovSearch.pickKu) return [ovSearch.pickKu];
  if (ovSearch.fKu) return [ovSearch.fKu];
  if (ovSearch.pickName && ovSearch.districts?.length) {
    return ovSearch.districts.map((r) => r.katastralne_uzemie).filter(Boolean);
  }
  const out = [];
  const fromPlaces = (ovSearch.places || []).map((r) => r.katastralne_uzemie).filter(Boolean);
  const placeHit = fromPlaces.some((p) => matchesFolded(p, ovSearch.q));
  if (placeHit) return [...new Set(fromPlaces)];
  fromPlaces.forEach((p) => out.push(p));
  (ovSearch.names || []).forEach((r) => {
    if (r.top_ku) out.push(r.top_ku);
  });
  return [...new Set(out)];
}

function mapFilterActive() {
  return (ovSearch.q || '').trim().length >= 2 && mapFilterKus().length > 0;
}

function kuLayerStyle(feature, { match = false, active = false } = {}) {
  const light = currentTheme() === 'light';
  const cnt = feature?.properties?.record_count || 0;
  if (!active) {
    return {
      color: cnt > 0 ? (light ? '#2563eb' : '#60a5fa') : (light ? '#cbd5e1' : '#334155'),
      weight: cnt > 0 ? 1.5 : 0.6,
      opacity: cnt > 0 ? 0.9 : 0.3,
      fillColor: cnt > 0 ? (light ? '#3b82f6' : '#1d4ed8') : (light ? '#e2e8f0' : '#0f172a'),
      fillOpacity: cnt > 0 ? Math.min(0.45, 0.08 + (cnt / 50000) * 0.35) : (light ? 0.22 : 0.04),
    };
  }
  if (match) {
    return {
      color: light ? '#059669' : '#34d399',
      weight: 2.2,
      opacity: 0.95,
      fillColor: light ? '#10b981' : '#059669',
      fillOpacity: cnt > 0 ? Math.min(0.5, 0.2 + (cnt / 50000) * 0.3) : 0.18,
    };
  }
  return {
    color: light ? '#cbd5e1' : '#334155',
    weight: 0.5,
    opacity: 0.2,
    fillColor: light ? '#f1f5f9' : '#0f172a',
    fillOpacity: light ? 0.12 : 0.03,
  };
}

function applyMapTheme(theme) {
  if (!skMap || typeof L === 'undefined') return;
  const light = theme === 'light';
  const url = light
    ? 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
    : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
  if (mapTileLayer) skMap.removeLayer(mapTileLayer);
  mapTileLayer = L.tileLayer(url, {
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(skMap);
  mapTileLayer.bringToBack();
  if (geoJsonLayer) applyMapSearchFilter({ fit: false });
}

function mapChipItems(kus) {
  const byName = new Map();
  (geoStatsData?.topKu || []).forEach((r) => byName.set(fold(r.katastralne_uzemie), r));
  (ovSearch.districts || []).forEach((r) => {
    const k = fold(r.katastralne_uzemie);
    if (!byName.has(k)) {
      byName.set(k, { katastralne_uzemie: r.katastralne_uzemie, record_count: r.lvs || r.recs || 0 });
    }
  });
  (ovSearch.places || []).forEach((r) => {
    const k = fold(r.katastralne_uzemie);
    if (!byName.has(k)) {
      byName.set(k, { katastralne_uzemie: r.katastralne_uzemie, record_count: r.recs || r.lvs || 0 });
    }
  });
  (window._geoBoundariesData?.features || []).forEach((f) => {
    const k = fold(f.properties.name);
    if (!byName.has(k)) {
      byName.set(k, { katastralne_uzemie: f.properties.name, record_count: f.properties.record_count || 0 });
    }
  });
  return kus.map((name) => {
    const hit = byName.get(fold(name));
    return hit ? { ...hit, katastralne_uzemie: name } : { katastralne_uzemie: name, record_count: 0 };
  });
}

function updateMapFilterBanner() {
  const sub = document.getElementById('map-subtitle');
  const title = document.getElementById('map-chips-title');
  const active = mapFilterActive();
  const kus = mapFilterKus();
  if (sub) {
    if (active) {
      const who = ovSearch.pickKu || ovSearch.fKu || ovSearch.pickName || ovSearch.q;
      sub.textContent = `Filtrované podľa hľadania: ${who} · ${kus.length} k.ú.`;
    } else {
      sub.textContent = 'Kliknite na okres alebo katastrálne územie na mape pre okamžité filtrovanie celej databázy neznámych vlastníkov';
    }
  }
  if (title) {
    title.textContent = active
      ? `📍 Katastrálne územia podľa hľadania (${kus.length})`
      : '📍 Najvýznamnejšie Katastrálne Územia & Hot-spoty PZF';
  }
  document.getElementById('tab-map')?.classList.toggle('map-filtered', active);
}

function applyMapSearchFilter(opts = {}) {
  const { fit = true, force = false } = opts;
  updateMapFilterBanner();
  if (!skMap || !geoJsonLayer) return;

  const kus = mapFilterKus();
  const active = (ovSearch.q || '').trim().length >= 2 && kus.length > 0;
  const folded = new Set(kus.map(fold));
  const key = active ? [...folded].sort().join('|') : '';
  const changed = force || key !== _mapFilterKey;
  _mapFilterKey = key;

  geoJsonLayer.eachLayer((layer) => {
    const name = layer.feature?.properties?.name || '';
    const match = active && folded.has(fold(name));
    layer.setStyle(kuLayerStyle(layer.feature, { match, active }));
  });

  if (active) renderMapChips(mapChipItems(kus));
  else if (geoStatsData?.topKu) renderMapChips(geoStatsData.topKu);

  renderGeoPills();

  if (!fit || !changed) return;

  if (active) {
    const bounds = [];
    geoJsonLayer.eachLayer((layer) => {
      const name = layer.feature?.properties?.name || '';
      if (!folded.has(fold(name)) || !layer.getBounds) return;
      try { bounds.push(layer.getBounds()); } catch (_) { /* ignore */ }
    });
    if (bounds.length) {
      const group = bounds.reduce((acc, b) => acc.extend(b), L.latLngBounds(bounds[0]));
      if (group.isValid()) {
        const maxZoom = kus.length <= 1 ? 13 : kus.length <= 8 ? 11 : 9;
        skMap.fitBounds(group, { padding: [40, 40], maxZoom });
      }
    }
  } else if (geoJsonLayer.getBounds().isValid()) {
    skMap.fitBounds(geoJsonLayer.getBounds(), { padding: [15, 15] });
  }
}

function onMapKuClick(kuName) {
  if ((ovSearch.q || '').trim().length >= 2) {
    if (ovSearch.pickName) onPickKu(kuName);
    else {
      ovSearch.fKu = kuName;
      ovSearch.pickName = '';
      ovSearch.pickKu = '';
      ovSearch.holdNames = false;
      track('place_chip', { q: ovSearch.q, ku: kuName });
      loadOverviewSearch(1);
    }
    showTab('overview');
    return;
  }
  if (isAdm()) {
    filterByMapLocation(kuName, 'owners');
    return;
  }
  const inp = document.getElementById('overview-search');
  if (inp) inp.value = kuName;
  beginSearch(kuName);
  showTab('overview');
  loadOverviewSearch(1);
}

async function loadGeoJsonBoundaries() {
  if (!skMap) return;
  try {
    const geoData = await apiFetch('/geo-boundaries').then(r => r.json());
    if (geoJsonLayer && skMap) skMap.removeLayer(geoJsonLayer);
    
    if (!mapMarkersGroup) {
      mapMarkersGroup = L.layerGroup().addTo(skMap);
      window.mapMarkersGroup = mapMarkersGroup;
    }
    mapMarkersGroup.clearLayers();

    geoJsonLayer = L.geoJSON(geoData, {
      filter: (feature) => {
        return feature.geometry && (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon');
      },
      style: (feature) => kuLayerStyle(feature, { active: false }),
      onEachFeature: (feature, layer) => {
        const name = feature.properties.name;
        const district = feature.properties.district;
        const cnt = feature.properties.record_count || 0;
        const safeName = jsAttr(name);

        const popupContent = `
          <div style="font-family:Inter,sans-serif;padding:4px">
            <div style="font-size:1rem;font-weight:700;color:#0f172a">📍 ${esc(name)}</div>
            <div style="font-size:0.8rem;color:#475569;margin-bottom:6px">Okres: <strong>${esc(district || 'N/A')}</strong></div>
            ${cnt > 0 ? `<div style="background:#eff6ff;color:#1e40af;padding:3px 8px;border-radius:6px;font-weight:600;font-size:0.8rem;margin-bottom:8px">👥 ${fmt(cnt)} neznámych vlastníkov</div>` : '<div style="color:#94a3b8;font-size:0.75rem;margin-bottom:6px">Žiadne záznamy PZF</div>'}
            <button class="btn" style="padding:4px 8px;font-size:0.75rem;width:100%" onclick="window.onMapKuClick('${safeName}')">📍 Otvoriť k.ú.</button>
          </div>`;

        layer.bindPopup(popupContent);
      }
    }).addTo(skMap);


    window.geoJsonLayer = geoJsonLayer;
    window._geoBoundariesData = geoData;

    applyMapSearchFilter({ fit: true, force: true });
  } catch (e) {
    console.error('Failed to load GeoJSON boundaries:', e);
  }
}
window.loadGeoJsonBoundaries = loadGeoJsonBoundaries;
window.applyMapSearchFilter = applyMapSearchFilter;
window.onMapKuClick = onMapKuClick;

function renderGeoPills() {
  if (!mapMarkersGroup || !window._geoBoundariesData) return;
  mapMarkersGroup.clearLayers();

  const kus = mapFilterKus();
  const folded = mapFilterActive() ? new Set(kus.map(fold)) : null;
  const zoom = skMap ? skMap.getZoom() : 8;
  const threshold = folded ? 0 : zoom >= 11 ? 100 : zoom >= 10 ? 500 : zoom >= 9 ? 1500 : 3000;
  const maxMarkers = folded ? 400 : zoom >= 12 ? 400 : zoom >= 11 ? 300 : zoom >= 10 ? 200 : 150;

  const viewport = skMap.getBounds();

  const visible = window._geoBoundariesData.features
    .filter(f => {
      const name = f.properties.name || '';
      if (folded && !folded.has(fold(name))) return false;
      const cnt = f.properties.record_count || 0;
      if (cnt < threshold) return false;
      const fBounds = L.geoJSON(f).getBounds();
      return viewport.intersects(fBounds);
    })
    .sort((a, b) => (b.properties.record_count || 0) - (a.properties.record_count || 0))
    .slice(0, maxMarkers);

  visible.forEach(feature => {
    try {
      const bounds = L.geoJSON(feature).getBounds();
      const center = bounds.getCenter();
      const name = feature.properties.name;
      const cnt = feature.properties.record_count;
      const safeName = jsAttr(name);
      const marker = L.marker(center, {
        icon: L.divIcon({
          className: 'custom-map-marker',
          html: `<div class="map-num-pill" onclick="window.onMapKuClick('${safeName}')" title="${esc(name)}: ${fmt(cnt)} neznámych">${fmt(cnt)}</div>`,
          iconSize: [null, null],
          iconAnchor: [18, 10]
        })
      });
      mapMarkersGroup.addLayer(marker);
    } catch (e) { /* ignore malformed geometry */ }
  });
}
window.renderGeoPills = renderGeoPills;




function renderMapMarkers(kuList) {
  if (!mapMarkersGroup || !kuList) return;
  mapMarkersGroup.clearLayers();

  const currentZoom = skMap ? skMap.getZoom() : 8;
  const limit = currentZoom <= 8 ? 35 : currentZoom <= 10 ? 80 : 200;

  kuList.slice(0, limit).forEach(item => {
    const name = item.katastralne_uzemie;
    if (!name) return;
    const coords = SLOVAK_COORDINATES[name] || getDeterministicCoords(name);

    if (coords) {
      const safeName = jsAttr(name);
      
      // Clean numeric count pill marker (NO names, ONLY count!)
      const badgeIcon = L.divIcon({
        className: 'custom-map-marker',
        html: `
          <div class="map-num-pill" onclick="window.onMapKuClick('${safeName}')" title="${esc(name)}: ${fmt(item.record_count)} neznámych">
            ${fmt(item.record_count)}
          </div>`,
        iconSize: [null, null],
        iconAnchor: [20, 10]
      });

      const marker = L.marker(coords, { icon: badgeIcon });

      const popupHtml = `
        <div style="font-family:Inter,sans-serif;padding:4px">
          <div style="font-size:1rem;font-weight:700;color:#0f172a;margin-bottom:4px">📍 ${esc(name)}</div>
          <div style="font-size:0.8rem;color:#475569;margin-bottom:8px">Kód k.ú.: <strong>${item.cislo_ku}</strong></div>
          <div style="display:flex;gap:8px;margin-bottom:10px">
            <span style="background:#eff6ff;color:#1e40af;padding:2px 8px;border-radius:6px;font-size:0.75rem;font-weight:600">👥 ${fmt(item.record_count)} neznámych</span>
            <span style="background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:6px;font-size:0.75rem;font-weight:600">📜 ${fmt(item.lv_count)} LV</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:4px">
            <button class="btn" style="padding:4px 8px;font-size:0.75rem" onclick="window.onMapKuClick('${safeName}')">📍 Otvoriť k.ú.</button>
            <button class="btn btn-ghost" style="padding:4px 8px;font-size:0.75rem" onclick="window.filterByMapLocation('${safeName}', 'transferred')">📋 Zobraziť Prevedené Práva</button>
            <button class="btn btn-ghost" style="padding:4px 8px;font-size:0.75rem" onclick="window.filterByMapLocation('${safeName}', 'lv-analysis')">🌲 Hĺbková Analýza LV</button>
          </div>
        </div>`;

      marker.bindPopup(popupHtml);
      mapMarkersGroup.addLayer(marker);
    }
  });
}
window.renderMapMarkers = renderMapMarkers;

function filterByMapLocation(kuName, targetTab) {
  if (targetTab === 'owners') {
    showTab('owners');
    const kuInput = document.getElementById('owner-ku-filter');
    if (kuInput) {
      kuInput.value = kuName;
      kuInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } else if (targetTab === 'transferred') {
    showTab('transferred');
    const kuInput = document.getElementById('tr-ku-filter');
    if (kuInput) {
      kuInput.value = kuName;
      kuInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } else if (targetTab === 'lv-analysis') {
    showTab('lv-analysis');
    const searchInput = document.getElementById('lv-analysis-search');
    if (searchInput) searchInput.value = kuName;
    loadLvAnalysis(kuName);
  }
}
window.filterByMapLocation = filterByMapLocation;

function getDeterministicCoords(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  // Strictly bounded inside Slovakia geography (48.1°N - 49.3°N, 18.3°E - 22.0°E)
  const lat = 48.1 + (Math.abs(hash % 110) / 100);
  const lng = 18.3 + (Math.abs((hash >> 3) % 350) / 100);
  return [lat, lng];
}

function populateMapOkresSelect() {
  const select = document.getElementById('map-okres-select');
  if (!select || !geoStatsData) return;

  const okresy = ['Stará Ľubovňa', 'Bardejov', 'Poprad', 'Kežmarok', 'Prešov', 'Košice', 'Žilina', 'Liptovský Mikuláš', 'Svidník', 'Bratislava', 'Nitra', 'Trnava', 'Banská Bystrica', 'Trenčín', 'Martin', 'Detva', 'Levice'];
  select.innerHTML = '<option value="">-- Všetky Okresy --</option>' + 
    okresy.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
}

function filterMapByOkres(okresName) {
  if (!okresName) {
    resetMapView();
    return;
  }
  const coords = SLOVAK_COORDINATES[okresName];
  if (coords && skMap) {
    skMap.setView(coords, 11);
  }
}
window.filterMapByOkres = filterMapByOkres;

function normStr(s) {
  return fold(s).trim();
}

let _mapSearchIdx = -1; // keyboard nav index

function onMapSearchInput(query) {
  const dd = document.getElementById('map-search-dropdown');
  if (!dd) return;

  const q = normStr(query);
  if (!q || !window._geoBoundariesData) {
    dd.style.display = 'none';
    _mapSearchIdx = -1;
    return;
  }

  // Search across GeoJSON features — match name and district
  const filterSet = mapFilterActive() ? new Set(mapFilterKus().map(fold)) : null;
  const results = window._geoBoundariesData.features
    .filter(f => {
      if (filterSet && !filterSet.has(fold(f.properties.name))) return false;
      const name = normStr(f.properties.name);
      const district = normStr(f.properties.district || '');
      return name.includes(q) || district.includes(q);
    })
    .sort((a, b) => {
      // Exact prefix match first, then by count desc
      const an = normStr(a.properties.name);
      const bn = normStr(b.properties.name);
      const aExact = an.startsWith(q) ? 0 : 1;
      const bExact = bn.startsWith(q) ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      return (b.properties.record_count || 0) - (a.properties.record_count || 0);
    })
    .slice(0, 12);

  if (!results.length) {
    dd.style.display = 'none';
    _mapSearchIdx = -1;
    return;
  }

  _mapSearchIdx = -1;
  dd.innerHTML = results.map((f, i) => {
    const name = f.properties.name || '';
    const district = f.properties.district || '';
    const cnt = f.properties.record_count || 0;
    return `<div class="map-search-result" data-idx="${i}"
      onmousedown="onMapSearchSelect(event, '${esc(name).replace(/'/g, "\\'")}')"
      onmouseenter="_mapSearchIdx=${i};_highlightMapResult()"
      style="display:flex;justify-content:space-between;align-items:center;padding:8px 14px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.06);transition:background 0.1s">
      <div>
        <div style="font-size:0.88rem;font-weight:600;color:#e2e8f0">${esc(name)}</div>
        <div style="font-size:0.75rem;color:#64748b">${esc(district)}</div>
      </div>
      ${cnt > 0 ? `<div style="background:rgba(59,130,246,0.2);color:#60a5fa;padding:2px 8px;border-radius:20px;font-size:0.75rem;font-weight:600">${fmt(cnt)}</div>` : ''}
    </div>`;
  }).join('');

  dd.style.display = 'block';
  // Close dropdown on outside click
  document.addEventListener('mousedown', _closeMapDropdown, { once: true });
}
window.onMapSearchInput = onMapSearchInput;

function _closeMapDropdown(e) {
  const dd = document.getElementById('map-search-dropdown');
  const inp = document.getElementById('map-search-input');
  if (dd && !dd.contains(e.target) && e.target !== inp) {
    dd.style.display = 'none';
  }
}

function _highlightMapResult() {
  const dd = document.getElementById('map-search-dropdown');
  if (!dd) return;
  dd.querySelectorAll('.map-search-result').forEach((el, i) => {
    el.style.background = i === _mapSearchIdx ? 'rgba(59,130,246,0.18)' : '';
  });
}

function onMapSearchKeydown(e) {
  const dd = document.getElementById('map-search-dropdown');
  if (!dd || dd.style.display === 'none') return;
  const items = dd.querySelectorAll('.map-search-result');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _mapSearchIdx = Math.min(_mapSearchIdx + 1, items.length - 1);
    _highlightMapResult();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _mapSearchIdx = Math.max(_mapSearchIdx - 1, 0);
    _highlightMapResult();
  } else if (e.key === 'Enter' && _mapSearchIdx >= 0) {
    e.preventDefault();
    const active = items[_mapSearchIdx];
    if (active) active.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  } else if (e.key === 'Escape') {
    dd.style.display = 'none';
  }
}
window.onMapSearchKeydown = onMapSearchKeydown;

function onMapSearchSelect(e, name) {
  e.preventDefault();
  const dd = document.getElementById('map-search-dropdown');
  if (dd) dd.style.display = 'none';
  const inp = document.getElementById('map-search-input');
  if (inp) inp.value = name;

  // Find the feature, fly to it
  if (!window._geoBoundariesData || !skMap) return;
  const feature = window._geoBoundariesData.features.find(f => f.properties.name === name);
  if (!feature) return;

  try {
    const bounds = L.geoJSON(feature).getBounds();
    if (bounds.isValid()) {
      skMap.flyToBounds(bounds, { padding: [40, 40], maxZoom: 14, duration: 0.8 });
    }
  } catch (err) {}
}
window.onMapSearchSelect = onMapSearchSelect;

function searchMapLocation(query) {
  // Legacy shim — delegates to instant search
  onMapSearchInput(query);
}

function resetMapView() {
  const select = document.getElementById('map-okres-select');
  if (select) select.value = '';
  const search = document.getElementById('map-search-input');
  if (search) search.value = '';
  if (mapFilterActive()) {
    applyMapSearchFilter({ fit: true, force: true });
    return;
  }
  if (skMap && geoJsonLayer && geoJsonLayer.getBounds().isValid()) {
    skMap.fitBounds(geoJsonLayer.getBounds(), { padding: [15, 15] });
  } else if (skMap) {
    skMap.setView([48.7, 19.6], 8);
  }
}
window.resetMapView = resetMapView;

function renderMapChips(kuList) {
  const wrap = document.getElementById('map-chips-wrap');
  if (!wrap || !kuList) return;
  const limit = mapFilterActive() ? 30 : 15;

  wrap.innerHTML = kuList.slice(0, limit).map(item => `
    <button class="btn btn-ghost" style="font-size:0.78rem;padding:4px 10px" onclick="onMapKuClick('${jsAttr(item.katastralne_uzemie)}')">
      📍 <strong>${esc(item.katastralne_uzemie)}</strong> (${fmt(item.record_count)})
    </button>
  `).join('');
}

// ── Export all handlers to window object ───────────────────────────────────
window.dismissSourceBanner = dismissSourceBanner;
window.shareSearchLink = shareSearchLink;
window.submitOverviewSearch = submitOverviewSearch;
window.onOverviewSearchInput = onOverviewSearchInput;
window.onHeaderSearchInput = onHeaderSearchInput;
window.onOverviewSearchKeydown = onOverviewSearchKeydown;
window.onPlaceSearchInput = onPlaceSearchInput;
window.onPlaceSearchKeydown = onPlaceSearchKeydown;
window.pickPlaceSuggest = pickPlaceSuggest;
window.pickNameSuggest = pickNameSuggest;
window.clearOverviewSearch = clearOverviewSearch;
window.filterOverviewName = filterOverviewName;
window.showNameDistricts = showNameDistricts;
window.onPickName = onPickName;
window.onPickKu = onPickKu;
window.onPickKuFromList = onPickKuFromList;
window.onPickPlaceChip = onPickPlaceChip;
window.onPickCoowner = onPickCoowner;
window.clearPicks = clearPicks;
window.wizardBackToNames = wizardBackToNames;
window.wizardBackToPlaces = wizardBackToPlaces;
window.filterOverviewPlace = filterOverviewPlace;
window.openOverviewInOwners = openOverviewInOwners;
window.loadOverviewSearch = loadOverviewSearch;
window.sortOverviewNames = sortOverviewNames;
window.loadSoloLvs = loadSoloLvs;
window.sortSoloLvs = sortSoloLvs;
window.copySoloFetchCmd = copySoloFetchCmd;
window.onSoloKuInput = onSoloKuInput;
window.onSoloNameInput = onSoloNameInput;
window.clearSoloFilter = clearSoloFilter;
window.onOwnerTopInput = onOwnerTopInput;
window.setOwnerColFilter = setOwnerColFilter;
window.onTrTopInput = onTrTopInput;
window.setTrColFilter = setTrColFilter;
window.clearOwnerSearch = clearOwnerSearch;
window.clearTrSearch = clearTrSearch;
window.sortOwners = sortOwners;
window.sortTr = sortTr;
window.loadOwners = loadOwners;
window.loadTransferred = loadTransferred;
window.showTab = showTab;
window.runCustomQuery = runCustomQuery;
window.setSampleQuery = setSampleQuery;
window.initSlovakiaMap = initSlovakiaMap;
window.onMapKuClick = onMapKuClick;
window.applyMapSearchFilter = applyMapSearchFilter;
window.toggleTheme = toggleTheme;

// ── Init ───────────────────────────────────────────────────────────────────
async function boot() {
  try {
    await initDb();
    showSourceBannerIfNeeded();
    const sharedQ = searchQueryFromUrl();
    const params = new URLSearchParams(location.search);
    ovSearch.pickName = (params.get('name') || '').trim();
    ovSearch.pickKu = (params.get('ku') || '').trim();
    ovSearch.fKu = (params.get('place') || '').trim();
    ovSearch.placeQ = ovSearch.fKu;
    if (ovSearch.fKu) syncPlaceInputs(ovSearch.fKu);
    tabLoaded['overview'] = true;
    showTab('overview');
    if (sharedQ.length >= 2 || ovSearch.pickName || ovSearch.fKu.length >= 2) {
      const q = sharedQ || ovSearch.pickName;
      syncSearchInputs(q);
      ovSearch.q = q;
      document.body.classList.add('search-mode');
      document.body.classList.remove('landing-mode');
      setOverviewSearching(true, `Hľadám…`);
      await loadOverviewSearch(1);
      loadOverview();
    } else {
      document.body.classList.add('landing-mode');
      document.body.classList.remove('search-mode');
      loadOverview();
    }
  } catch (e) {
    console.error(e);
    const overlay = document.getElementById('boot-overlay');
    const msg = document.getElementById('boot-msg');
    if (msg) msg.textContent = 'Chyba inicializácie: ' + e.message;
    if (overlay) overlay.classList.add('boot-error');
    showToast('DuckDB WASM sa nepodarilo spustiť: ' + e.message, 'error');
  }
}

window.addEventListener('popstate', () => {
  const params = new URLSearchParams(location.search);
  const q = searchQueryFromUrl();
  const place = (params.get('place') || '').trim();
  syncSearchInputs(q);
  syncPlaceInputs(place);
  ovSearch.q = q;
  ovSearch.fName = '';
  ovSearch.fKu = place;
  ovSearch.placeQ = place;
  ovSearch.pickName = (params.get('name') || '').trim();
  ovSearch.pickKu = (params.get('ku') || '').trim();
  if (q.length >= 2 || place.length >= 2 || ovSearch.pickName) {
    showTab('overview');
    loadOverviewSearch(1);
  } else {
    const card = document.getElementById('overview-search-card');
    if (card) card.hidden = true;
    document.body.classList.add('landing-mode');
    document.body.classList.remove('search-mode');
    document.title = 'PZF Explorer — Neznámi vlastníci';
  }
});

applyTheme(currentTheme(), false);

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
