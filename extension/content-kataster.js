const VYPIS_RE = /VÝPIS Z LISTU VLASTNÍCTVA|ČASŤ A|MAJETKOVÁ PODSTATA|Parcely registra/i;
const CAPTCHA_RE = /g-recaptcha|captchaIsReady/i;

function looksLikeVypis(html) {
  if (!html || html.length < 400) return false;
  if (!VYPIS_RE.test(html)) return false;
  if (CAPTCHA_RE.test(html) && !/MAJETKOVÁ PODSTATA/i.test(html)) return false;
  return true;
}

function urlLvKu() {
  try {
    const q = new URL(location.href).searchParams;
    return {
      lv: q.get('prfNumber') || '',
      ku: q.get('cadastralUnitCode') || '',
    };
  } catch (_) {
    return { lv: '', ku: '' };
  }
}

let sentSig = '';
let timer = 0;

function showSentNote() {
  if (document.getElementById('pzf-grab-note')) return;
  const n = document.createElement('div');
  n.id = 'pzf-grab-note';
  n.textContent = 'PZF: výpis odoslaný. Môžete sa vrátiť do PZF Explorer.';
  n.setAttribute('role', 'status');
  n.style.cssText = [
    'position:fixed',
    'z-index:2147483647',
    'left:12px',
    'right:12px',
    'bottom:12px',
    'padding:10px 14px',
    'background:#0f172a',
    'color:#e2e8f0',
    'font:14px/1.4 system-ui,sans-serif',
    'border-radius:8px',
    'box-shadow:0 8px 24px rgba(0,0,0,.25)',
  ].join(';');
  (document.body || document.documentElement).appendChild(n);
}

function tryGrab() {
  const html = document.documentElement?.outerHTML || '';
  if (!looksLikeVypis(html)) return;
  const { lv, ku } = urlLvKu();
  const sig = `${html.length}:${lv}:${ku}:${html.slice(80, 160)}`;
  if (sig === sentSig) return;
  sentSig = sig;
  chrome.runtime.sendMessage({ type: 'pzf-vypis', html, lv, ku }, () => {
    void chrome.runtime.lastError;
    showSentNote();
  });
}

function scheduleGrab() {
  clearTimeout(timer);
  timer = setTimeout(tryGrab, 250);
}

function start() {
  tryGrab();
  const obs = new MutationObserver(scheduleGrab);
  obs.observe(document.documentElement, { childList: true, subtree: true });
  let n = 0;
  const poll = setInterval(() => {
    tryGrab();
    n += 1;
    if (sentSig || n > 180) clearInterval(poll);
  }, 1000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
