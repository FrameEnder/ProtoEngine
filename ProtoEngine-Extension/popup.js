// Cross-browser API namespace (Firefox uses `browser`, Chrome uses `chrome`).
const ext = typeof browser !== 'undefined' ? browser : chrome;

const $ = (id) => document.getElementById(id);

// ---------- settings storage ----------
function getSettings() {
  return new Promise((resolve) => {
    ext.storage.local.get(['baseUrl', 'apiKey'], (r) => resolve(r || {}));
  });
}
function saveSettings(s) {
  return new Promise((resolve) => ext.storage.local.set(s, resolve));
}

// ---------- active tab ----------
function getActiveTab() {
  return new Promise((resolve) => {
    ext.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0]));
  });
}

// Try to fetch the favicon as a Blob. Returns null on any failure (the
// listing is still created without an icon in that case).
async function fetchFavicon(tab) {
  const candidates = [];
  if (tab.favIconUrl) candidates.push(tab.favIconUrl);
  // Fallback: site root /favicon.ico
  try {
    const u = new URL(tab.url);
    candidates.push(`${u.origin}/favicon.ico`);
  } catch { /* ignore */ }

  for (const url of candidates) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const blob = await res.blob();
      if (blob.size > 0 && blob.size <= 512 * 1024 && blob.type.startsWith('image/')) {
        return blob;
      }
    } catch { /* try next */ }
  }
  return null;
}

let currentTab = null;
let faviconBlob = null;

// ---------- views ----------
function showSettings(show) {
  $('settingsView').hidden = !show;
  $('submitView').hidden = show;
}

function setMsg(el, text, kind) {
  el.textContent = text || '';
  el.className = 'msg' + (kind ? ' msg--' + kind : '');
}

// ---------- init ----------
async function init() {
  const settings = await getSettings();

  // If not configured yet, open settings first.
  if (!settings.baseUrl || !settings.apiKey) {
    $('baseUrl').value = settings.baseUrl || '';
    $('apiKey').value = settings.apiKey || '';
    showSettings(true);
    setMsg($('settingsMsg'), 'Set your ProtoEngine URL and API key to begin.', null);
  } else {
    showSettings(false);
  }

  // Populate the page preview from the active tab.
  currentTab = await getActiveTab();
  if (currentTab) {
    $('nameInput').value = (currentTab.title || '').slice(0, 120);
    $('urlText').textContent = currentTab.url || '';
    // Show favicon preview and grab the blob for upload.
    const favWrap = $('favWrap');
    if (currentTab.favIconUrl) {
      const img = document.createElement('img');
      img.src = currentTab.favIconUrl;
      img.alt = '';
      img.onerror = () => { favWrap.textContent = (currentTab.title || '?').charAt(0).toUpperCase(); };
      favWrap.appendChild(img);
    } else {
      favWrap.textContent = (currentTab.title || '?').charAt(0).toUpperCase();
    }
    faviconBlob = await fetchFavicon(currentTab);
  }
}

// ---------- submit ----------
async function submit() {
  const settings = await getSettings();
  if (!settings.baseUrl || !settings.apiKey) {
    showSettings(true);
    setMsg($('settingsMsg'), 'Configure your ProtoEngine URL and API key first.', 'error');
    return;
  }

  const name = $('nameInput').value.trim();
  const url = currentTab?.url || '';
  const description = $('descInput').value.trim();
  const tags = $('tagsInput').value.trim();

  if (!name) { setMsg($('msg'), 'A name is required.', 'error'); return; }
  if (!description) { setMsg($('msg'), 'A description is required.', 'error'); return; }

  const btn = $('submitBtn');
  btn.disabled = true; btn.textContent = 'Adding…';
  setMsg($('msg'), '', null);

  try {
    const fd = new FormData();
    fd.set('name', name);
    fd.set('url', url);
    fd.set('description', description);
    fd.set('tags', tags);
    if (faviconBlob) {
      const ext2 = (faviconBlob.type.split('/')[1] || 'png').replace('x-icon', 'ico').replace('vnd.microsoft.icon', 'ico');
      fd.set('icon', faviconBlob, `favicon.${ext2}`);
    }

    const base = settings.baseUrl.replace(/\/+$/, '');
    const res = await fetch(`${base}/api/sites`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${settings.apiKey}` },
      body: fd,
    });

    let data = {};
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);

    setMsg($('msg'), 'Added to ProtoEngine ✓', 'ok');
    btn.textContent = 'Added';
    setTimeout(() => window.close(), 900);
  } catch (e) {
    let m = e.message;
    if (/Failed to fetch|NetworkError/i.test(m)) {
      m = 'Could not reach ProtoEngine. Check the URL and that the server is running.';
    }
    setMsg($('msg'), m, 'error');
    btn.disabled = false; btn.textContent = 'Add to ProtoEngine';
  }
}

// ---------- settings actions ----------
async function saveSettingsAction() {
  const baseUrl = $('baseUrl').value.trim().replace(/\/+$/, '');
  const apiKey = $('apiKey').value.trim();
  if (!baseUrl) { setMsg($('settingsMsg'), 'Enter your ProtoEngine URL.', 'error'); return; }
  if (!apiKey) { setMsg($('settingsMsg'), 'Enter your API key.', 'error'); return; }
  await saveSettings({ baseUrl, apiKey });
  setMsg($('settingsMsg'), 'Saved ✓', 'ok');
  setTimeout(() => showSettings(false), 600);
}

async function testSettingsAction() {
  const baseUrl = $('baseUrl').value.trim().replace(/\/+$/, '');
  const apiKey = $('apiKey').value.trim();
  if (!baseUrl || !apiKey) { setMsg($('settingsMsg'), 'Enter both fields to test.', 'error'); return; }
  setMsg($('settingsMsg'), 'Testing…', null);
  try {
    // /api/config is public; a reachable response means the URL is good.
    const res = await fetch(`${baseUrl}/api/config`);
    if (!res.ok) throw new Error(`Server responded ${res.status}.`);
    const cfg = await res.json();
    setMsg($('settingsMsg'), `Connected to "${cfg.appName || 'ProtoEngine'}" ✓`, 'ok');
  } catch (e) {
    let m = e.message;
    if (/Failed to fetch|NetworkError/i.test(m)) m = 'Could not reach that URL.';
    setMsg($('settingsMsg'), m, 'error');
  }
}

// ---------- wire up ----------
document.addEventListener('DOMContentLoaded', () => {
  init();
  $('submitBtn').addEventListener('click', submit);
  $('settingsBtn').addEventListener('click', () => showSettings($('settingsView').hidden));
  $('saveBtn').addEventListener('click', saveSettingsAction);
  $('testBtn').addEventListener('click', testSettingsAction);
  // Enter in tags field submits.
  $('tagsInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
});
