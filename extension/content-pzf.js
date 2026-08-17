function isPzfPage() {
  const host = location.hostname;
  if (host === 'solexecution.github.io') return location.pathname.includes('pozemkovyfond');
  if (host !== 'localhost' && host !== '127.0.0.1') return false;
  const root = document.documentElement;
  if (root?.getAttribute('data-pzf') === '1') return true;
  if (root?.dataset?.pzf === '1') return true;
  return false;
}

function announce() {
  if (!isPzfPage()) return;
  document.documentElement.dataset.pzfExt = '1';
  document.documentElement.dataset.pzfExtId = chrome.runtime.id;
  try {
    window.postMessage({
      type: 'pzf-ext-ready',
      id: chrome.runtime.id,
      version: chrome.runtime.getManifest().version,
    }, location.origin);
  } catch (_) {}
}

if (document.documentElement) announce();
document.addEventListener('DOMContentLoaded', announce);
window.addEventListener('load', announce);

chrome.runtime.onMessage.addListener((msg) => {
  if (!isPzfPage()) return;
  if (!msg || msg.type !== 'pzf-vypis' || typeof msg.html !== 'string') return;
  try {
    window.postMessage({
      type: 'pzf-vypis',
      html: msg.html,
      lv: msg.lv || '',
      ku: msg.ku || '',
    }, location.origin);
  } catch (_) {}
});
