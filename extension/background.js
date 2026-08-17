const PZF_TAB_URLS = [
  'https://solexecution.github.io/pozemkovyfond/*',
  'https://solexecution.github.io/pozemkovyfond',
  'http://localhost/*',
  'http://localhost:*/*',
  'http://127.0.0.1/*',
  'http://127.0.0.1:*/*',
];

function isPzfUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'solexecution.github.io') {
      return u.pathname.includes('pozemkovyfond');
    }
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;
  } catch (_) {}
  return false;
}

function relayVypis(msg) {
  const payload = {
    type: 'pzf-vypis',
    html: msg.html,
    lv: msg.lv || '',
    ku: msg.ku || '',
  };
  chrome.tabs.query({ url: PZF_TAB_URLS }, (tabs) => {
    const list = tabs || [];
    const send = (tab) => {
      if (!tab?.id || !isPzfUrl(tab.url || '')) return;
      try {
        const p = chrome.tabs.sendMessage(tab.id, payload);
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (_) {}
    };
    if (list.length) {
      list.forEach(send);
      return;
    }
    chrome.tabs.query({}, (all) => {
      (all || []).forEach(send);
    });
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'pzf-vypis' || typeof msg.html !== 'string') return;
  relayVypis(msg);
  sendResponse({ ok: true });
  return true;
});

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  const url = sender?.url || '';
  if (!isPzfUrl(url) && sender?.origin !== 'https://solexecution.github.io') {
    if (!/^https?:\/\/(localhost|127\.0\.0\.1)(?::\d+)?$/i.test(sender?.origin || '')) {
      return;
    }
  }
  if (msg?.type === 'pzf-hello') {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return;
  }
  if (msg?.type === 'pzf-vypis' && typeof msg.html === 'string') {
    relayVypis(msg);
    sendResponse({ ok: true });
    return true;
  }
});
