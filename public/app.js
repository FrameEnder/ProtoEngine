// ---------- tiny helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return node;
};
const esc = (s) => String(s ?? '');

// ---------- state ----------
const state = {
  user: null,
  csrf: null,
  appName: 'Lumen',
  query: '',
  tags: [],          // active tag filters (all must match)
  sort: 'newest',    // newest | oldest | name | name_desc
  hasIcon: '',       // '' | 'true' | 'false'
  page: 1,
  pageCount: 1,
  matched: 0,
  sites: [],
  allTags: null,     // cached [{tag,count}] for pickers
};

// Is any filter active (used to decide the "searching" layout)?
function isSearching() {
  return !!(state.query || state.tags.length || state.hasIcon || state.sort !== 'newest');
}

// ---------- API client ----------
async function getCsrf() {
  if (state.csrf) return state.csrf;
  const r = await fetch('/api/csrf');
  const d = await r.json();
  state.csrf = d.token;
  return state.csrf;
}

async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method, headers: {} };
  if (method !== 'GET' && method !== 'HEAD') {
    opts.headers['x-csrf-token'] = await getCsrf();
  }
  if (form) {
    opts.body = form; // FormData; let browser set content-type
  } else if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch('/api' + path, opts);
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok) {
    // CSRF token may have rotated; refresh once.
    if (r.status === 403 && /token/i.test(data.error || '')) state.csrf = null;
    throw new Error(data.error || 'Request failed.');
  }
  return data;
}

// ---------- toast ----------
let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' toast--error' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

// ---------- favicon rendering ----------
function faviconNode(site) {
  const wrap = el('span', { class: 'result__favicon' });
  if (site.icon) {
    wrap.append(el('img', { src: site.icon, alt: '', loading: 'lazy' }));
  } else {
    wrap.textContent = (site.name || '?').charAt(0).toUpperCase();
  }
  return wrap;
}

function prettyUrl(url) {
  try {
    const u = new URL(url);
    return u.host + (u.pathname !== '/' ? u.pathname : '');
  } catch { return url; }
}

// ---------- permissions ----------
const RANK = { user: 1, moderator: 2, admin: 3 };
function canManage(site) {
  if (!state.user) return false;
  if (RANK[state.user.role] >= RANK.moderator) return true;
  return site.ownerId === state.user.id;
}

// ---------- rendering results ----------
// Move the logo + search bar row into the top bar while searching (so they
// sit on one line where the brand used to be, like Google's results header),
// and back into the stage on the home view (big centered logo above the box).
function placeSearchRow(searching) {
  const row = $('#searchRow');
  if (!row) return;
  const topbar = $('#topbar');
  const stage = $('#stage');
  const spacer = $('#topbarSpacer');
  if (searching) {
    if (row.parentElement !== topbar) {
      topbar.insertBefore(row, spacer); // left side, before the spacer/controls
    }
  } else {
    if (row.parentElement !== stage) {
      stage.insertBefore(row, stage.firstChild); // back to top of the stage
    }
  }
}

function renderResults() {
  const box = $('#results');
  box.innerHTML = '';
  const searching = isSearching();
  document.body.classList.toggle('searching', searching);
  placeSearchRow(searching);

  if (state.sites.length === 0) {
    box.append(
      el('div', { class: 'placeholder' },
        el('strong', {}, searching ? 'No matches' : 'Nothing here yet'),
        searching
          ? 'Try a different word, or adjust your filters.'
          : state.user
            ? 'Tap the + button up top to add the first website.'
            : 'Sign in to add the first website to this engine.'
      )
    );
    return;
  }

  // Google-style result count, shown only while searching.
  if (searching) {
    const n = state.matched;
    let label = `${n} result${n === 1 ? '' : 's'}`;
    if (state.pageCount > 1) label += ` · page ${state.page} of ${state.pageCount}`;
    box.append(el('div', { class: 'results__info' }, label));
  }

  for (const site of state.sites) {
    const result = el('div', { class: 'result' });

    const head = el('div', { class: 'result__head' },
      faviconNode(site),
      el('div', { class: 'result__crumbs' },
        el('div', { class: 'result__site' }, site.name),
        el('div', { class: 'result__url' }, prettyUrl(site.url)),
      )
    );

    const title = el('a', {
      class: 'result__title',
      href: site.url,
      target: '_blank',
      rel: 'noopener noreferrer nofollow',
    }, site.name);

    const desc = el('p', { class: 'result__desc' }, site.description);

    const meta = el('div', { class: 'result__meta' });
    if (site.ownerName) meta.append(el('span', { class: 'result__owner' }, 'added by ' + site.ownerName));

    result.append(head, title, desc, meta);

    if (site.tags && site.tags.length) {
      const tagWrap = el('div', { class: 'result__tags' });
      for (const tag of site.tags) {
        tagWrap.append(el('button', {
          class: 'chip' + (state.tags.includes(tag) ? ' chip--active' : ''),
          onclick: () => toggleTag(tag),
        }, '#' + tag));
      }
      result.append(tagWrap);
    }

    if (canManage(site)) {
      result.append(
        el('div', { class: 'result__actions' },
          el('button', { class: 'minibtn', onclick: () => openSiteModal(site) }, 'Edit'),
          el('button', { class: 'minibtn minibtn--danger', onclick: () => deleteSite(site) }, 'Delete'),
        )
      );
    }

    box.append(result);
  }

  // Pagination controls (Google-style: Prev, numbered pages, Next).
  if (state.pageCount > 1) {
    box.append(buildPagination());
  }
}

// Build the page navigation row.
function buildPagination() {
  const nav = el('nav', { class: 'pager', 'aria-label': 'Search result pages' });
  const cur = state.page;
  const last = state.pageCount;

  nav.append(el('button', {
    class: 'pager__btn pager__btn--nav',
    disabled: cur <= 1 ? 'disabled' : false,
    onclick: () => goToPage(cur - 1),
  }, '‹ Prev'));

  // Windowed page numbers: show up to 7, centered on current.
  const span = 7;
  let startP = Math.max(1, cur - Math.floor(span / 2));
  let endP = Math.min(last, startP + span - 1);
  startP = Math.max(1, endP - span + 1);

  if (startP > 1) {
    nav.append(pageNum(1));
    if (startP > 2) nav.append(el('span', { class: 'pager__gap' }, '…'));
  }
  for (let p = startP; p <= endP; p++) nav.append(pageNum(p));
  if (endP < last) {
    if (endP < last - 1) nav.append(el('span', { class: 'pager__gap' }, '…'));
    nav.append(pageNum(last));
  }

  nav.append(el('button', {
    class: 'pager__btn pager__btn--nav',
    disabled: cur >= last ? 'disabled' : false,
    onclick: () => goToPage(cur + 1),
  }, 'Next ›'));

  return nav;
}

function pageNum(p) {
  return el('button', {
    class: 'pager__btn' + (p === state.page ? ' pager__btn--current' : ''),
    'aria-current': p === state.page ? 'page' : false,
    onclick: () => goToPage(p),
  }, String(p));
}

// ---------- URL <-> state sync ----------
// The URL is the source of truth for query, tags, filters, and page:
//   /search?q=self+hosted&tag=docs,rust&sort=name&icon=true&p=2
//   /                                       (empty state / home)
function readStateFromUrl() {
  const url = new URL(window.location.href);
  const onSearch = url.pathname === '/search';
  if (!onSearch) {
    state.query = ''; state.tags = []; state.sort = 'newest'; state.hasIcon = ''; state.page = 1;
    return;
  }
  state.query = (url.searchParams.get('q') || '').trim();
  const tagStr = (url.searchParams.get('tag') || '').trim();
  state.tags = tagStr ? tagStr.split(',').map((t) => t.trim()).filter(Boolean) : [];
  const sort = url.searchParams.get('sort') || 'newest';
  state.sort = ['newest', 'oldest', 'name', 'name_desc'].includes(sort) ? sort : 'newest';
  const icon = url.searchParams.get('icon');
  state.hasIcon = (icon === 'true' || icon === 'false') ? icon : '';
  const p = parseInt(url.searchParams.get('p'), 10);
  state.page = Number.isInteger(p) && p > 0 ? p : 1;
}

// Build the URL from current state. push=true adds a history entry; push=false
// replaces it (for live typing).
function applyStateToUrl(push) {
  let path;
  if (isSearching()) {
    const params = new URLSearchParams();
    if (state.query) params.set('q', state.query);
    if (state.tags.length) params.set('tag', state.tags.join(','));
    if (state.sort !== 'newest') params.set('sort', state.sort);
    if (state.hasIcon) params.set('icon', state.hasIcon);
    if (state.page > 1) params.set('p', String(state.page));
    path = '/search?' + params.toString();
  } else {
    path = '/';
  }
  const cur = window.location.pathname + window.location.search;
  if (cur === path) return;
  if (push) history.pushState(null, '', path);
  else history.replaceState(null, '', path);
}

// ---------- search ----------
let searchTimer;
async function loadSites() {
  const params = new URLSearchParams();
  if (state.query) params.set('q', state.query);
  if (state.tags.length) params.set('tag', state.tags.join(','));
  if (state.sort !== 'newest') params.set('sort', state.sort);
  if (state.hasIcon) params.set('hasIcon', state.hasIcon);
  params.set('page', String(state.page));
  try {
    const d = await api('/sites?' + params.toString());
    state.sites = d.sites;
    state.page = d.page || 1;
    state.pageCount = d.pageCount || 1;
    state.matched = d.matched ?? d.sites.length;
    applyStateToUrl(false);
    renderResults();
    updateFilterButton();
    window.scrollTo({ top: 0, behavior: 'auto' });
  } catch (e) {
    toast(e.message, true);
  }
}

// Navigate to a specific page.
function goToPage(p) {
  if (p < 1 || p > state.pageCount || p === state.page) return;
  state.page = p;
  applyStateToUrl(true);
  loadSites();
}

// Toggle a tag in the active filter set (from clicking a result chip).
function toggleTag(tag) {
  const i = state.tags.indexOf(tag);
  if (i === -1) state.tags.push(tag);
  else state.tags.splice(i, 1);
  state.page = 1;
  updateActiveFilter();
  applyStateToUrl(true);
  loadSites();
}

// Show the active tag chips below the search bar.
function updateActiveFilter() {
  const wrap = $('#activeFilter');
  wrap.innerHTML = '';
  if (!state.tags.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  wrap.append(el('span', { class: 'activefilter__label' }, 'Tags:'));
  for (const t of state.tags) {
    wrap.append(el('button', {
      class: 'chip chip--active',
      onclick: () => toggleTag(t),
    }, '#' + t + '  ✕'));
  }
}

// Reflect whether any non-tag filter is active on the filter button.
function updateFilterButton() {
  const btn = $('#filterBtn');
  if (!btn) return;
  const active = state.sort !== 'newest' || !!state.hasIcon || state.tags.length > 0;
  btn.classList.toggle('iconbtn--active', active);
}

// Fetch (and cache) all existing tags with counts.
async function loadAllTags(force) {
  if (state.allTags && !force) return state.allTags;
  try {
    const d = await api('/sites/tags');
    state.allTags = d.tags || [];
  } catch {
    state.allTags = [];
  }
  return state.allTags;
}

// Filter settings popup: sort order, favicon presence, and tag selection,
// all applied to the current search.
async function openFilterModal() {
  // Working copy so Cancel discards changes.
  const draft = {
    sort: state.sort,
    hasIcon: state.hasIcon,
    tags: [...state.tags],
  };

  const tags = await loadAllTags();

  // Sort select.
  const sortSel = el('select', {},
    ...[
      ['newest', 'Newest first'],
      ['oldest', 'Oldest first'],
      ['name', 'Name (A–Z)'],
      ['name_desc', 'Name (Z–A)'],
    ].map(([v, label]) => el('option', { value: v, ...(draft.sort === v ? { selected: 'selected' } : {}) }, label))
  );
  sortSel.addEventListener('change', () => { draft.sort = sortSel.value; });

  // Favicon filter.
  const iconSel = el('select', {},
    ...[
      ['', 'Any'],
      ['true', 'Has a favicon'],
      ['false', 'No favicon'],
    ].map(([v, label]) => el('option', { value: v, ...(draft.hasIcon === v ? { selected: 'selected' } : {}) }, label))
  );
  iconSel.addEventListener('change', () => { draft.hasIcon = iconSel.value; });

  // Tag picker — clickable chips, highlighted when selected.
  const tagBox = el('div', { class: 'tagpick' });
  function paintTags() {
    tagBox.innerHTML = '';
    if (!tags.length) {
      tagBox.append(el('div', { class: 'field__hint' }, 'No tags exist yet.'));
      return;
    }
    for (const { tag, count } of tags) {
      const on = draft.tags.includes(tag);
      tagBox.append(el('button', {
        type: 'button',
        class: 'chip' + (on ? ' chip--active' : ''),
        onclick: () => {
          const i = draft.tags.indexOf(tag);
          if (i === -1) draft.tags.push(tag); else draft.tags.splice(i, 1);
          paintTags();
        },
      }, `#${tag} · ${count}`));
    }
  }
  paintTags();

  const apply = el('button', { class: 'btn btn--primary' }, 'Apply filters');
  apply.addEventListener('click', () => {
    state.sort = draft.sort;
    state.hasIcon = draft.hasIcon;
    state.tags = draft.tags;
    state.page = 1;
    closeModal();
    updateActiveFilter();
    applyStateToUrl(true);
    loadSites();
  });
  const reset = el('button', { class: 'btn btn--ghost' }, 'Reset');
  reset.addEventListener('click', () => {
    draft.sort = 'newest'; draft.hasIcon = ''; draft.tags = [];
    sortSel.value = 'newest'; iconSel.value = '';
    paintTags();
  });

  const body = el('div', {},
    el('div', { class: 'field' }, el('label', {}, 'Sort by'), sortSel),
    el('div', { class: 'field' }, el('label', {}, 'Favicon'), iconSel),
    el('div', { class: 'field' },
      el('label', {}, 'Filter by tags'),
      el('div', { class: 'field__hint', style: 'margin:0 0 8px' }, 'Click to include. All selected tags must match.'),
      tagBox),
    el('div', { class: 'row', style: 'display:flex;gap:8px' }, reset, apply),
  );

  openModal(modalShell('Filters', body));
}

// ---------- modal plumbing ----------
function openModal(node) {
  const root = $('#modalRoot');
  root.innerHTML = '';
  root.append(node);
  root.hidden = false;
  root.onclick = (e) => { if (e.target === root) closeModal(); };
  document.addEventListener('keydown', escClose);
  const firstInput = node.querySelector('input, select, textarea, button');
  if (firstInput) firstInput.focus();
}
function closeModal() {
  $('#modalRoot').hidden = true;
  $('#modalRoot').innerHTML = '';
  document.removeEventListener('keydown', escClose);
}
function escClose(e) { if (e.key === 'Escape') closeModal(); }

function modalShell(title, bodyNode, wide = false) {
  return el('div', { class: 'modal' + (wide ? ' modal--wide' : '') },
    el('div', { class: 'modal__head' },
      el('h2', { class: 'modal__title' }, title),
      el('button', { class: 'modal__close', 'aria-label': 'Close', onclick: closeModal }, '×'),
    ),
    el('div', { class: 'modal__body' }, bodyNode),
  );
}

// ---------- auth modals ----------
function openAuthModal(mode = 'login') {
  const msg = el('div', { class: 'formmsg' });
  const username = el('input', { type: 'text', id: 'au_user', autocomplete: 'username', placeholder: 'username' });
  const password = el('input', { type: 'password', id: 'au_pass', autocomplete: mode === 'login' ? 'current-password' : 'new-password', placeholder: 'password' });
  const submit = el('button', { class: 'btn btn--primary', type: 'submit' }, mode === 'login' ? 'Sign in' : 'Create account');

  const form = el('form', {},
    el('div', { class: 'field' }, el('label', { for: 'au_user' }, 'Username'), username),
    el('div', { class: 'field' }, el('label', { for: 'au_pass' }, 'Password'), password),
    msg,
    submit,
    el('div', { class: 'switcher' },
      mode === 'login' ? 'New here?' : 'Already have an account?',
      el('button', { type: 'button', onclick: () => openAuthModal(mode === 'login' ? 'register' : 'login') },
        mode === 'login' ? 'Create an account' : 'Sign in'),
    ),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.textContent = '';
    submit.disabled = true;
    try {
      const path = mode === 'login' ? '/auth/login' : '/auth/register';
      const d = await api(path, { method: 'POST', body: { username: username.value, password: password.value } });
      state.user = d.user;
      state.csrf = null; // session regenerated; refresh token
      // Pull full profile (avatar, API-key status) which login doesn't return.
      try { const me = await api('/auth/me'); if (me.user) state.user = me.user; } catch {}
      closeModal();
      syncChrome();
      toast(mode === 'login' ? 'Signed in.' : 'Account created. You are signed in.');
      loadSites();
    } catch (err) {
      msg.className = 'formmsg formmsg--error';
      msg.textContent = err.message;
      submit.disabled = false;
    }
  });

  openModal(modalShell(mode === 'login' ? 'Sign in to ' + state.appName : 'Create your account', form));
}

// ---------- add / edit site modal ----------
function openSiteModal(site = null) {
  const editing = !!site;
  const msg = el('div', { class: 'formmsg' });

  const name = el('input', { type: 'text', placeholder: 'My Project Wiki', value: editing ? site.name : '' });
  const url = el('input', { type: 'text', placeholder: 'https://example.com', value: editing ? site.url : '' });
  const description = el('textarea', { placeholder: 'A short summary of what this site is and why it is useful.' });
  description.value = editing ? site.description : '';
  const tags = el('input', { type: 'text', placeholder: 'docs, internal, rust', value: editing ? (site.tags || []).join(', ') : '' });

  // Picker of existing tags — click to add to the input. Helps reuse common
  // tags and see what already exists.
  const tagSuggest = el('div', { class: 'tagpick tagpick--suggest' });
  function currentTagSet() {
    return new Set(tags.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean));
  }
  function paintSuggest(list) {
    tagSuggest.innerHTML = '';
    if (!list.length) return;
    const have = currentTagSet();
    let shown = 0;
    for (const { tag, count } of list) {
      const on = have.has(tag);
      tagSuggest.append(el('button', {
        type: 'button',
        class: 'chip chip--mini' + (on ? ' chip--active' : ''),
        onclick: () => {
          const set = currentTagSet();
          if (set.has(tag)) {
            // remove it
            const kept = [...set].filter((t) => t !== tag);
            tags.value = kept.join(', ');
          } else {
            const existing = tags.value.trim();
            tags.value = existing ? existing.replace(/,\s*$/, '') + ', ' + tag : tag;
          }
          paintSuggest(list);
        },
      }, `#${tag}`));
      if (++shown >= 40) break; // cap to keep the picker tidy
    }
  }
  // Repaint highlight as the user types.
  tags.addEventListener('input', () => { if (state.allTags) paintSuggest(state.allTags); });
  loadAllTags().then((list) => paintSuggest(list));

  const iconInput = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/x-icon' });
  const preview = el('span', { class: 'iconpick__preview' });
  let removeExistingIcon = false;
  function paintPreview(src, fallback) {
    preview.innerHTML = '';
    if (src) preview.append(el('img', { src, alt: '' }));
    else preview.textContent = fallback || 'icon';
  }
  paintPreview(editing && site.icon ? site.icon : null, 'icon');
  iconInput.addEventListener('change', () => {
    const f = iconInput.files[0];
    if (f) { removeExistingIcon = false; paintPreview(URL.createObjectURL(f)); }
  });

  const iconRow = el('div', { class: 'iconpick' }, preview,
    el('div', {},
      iconInput,
      editing && site.icon
        ? el('button', { type: 'button', class: 'minibtn', style: 'margin-top:8px', onclick: () => {
            removeExistingIcon = true; iconInput.value = ''; paintPreview(null, 'removed');
          } }, 'Remove current icon')
        : null,
    )
  );

  const submit = el('button', { class: 'btn btn--primary', type: 'submit' }, editing ? 'Save changes' : 'Add website');

  const form = el('form', {},
    el('div', { class: 'field' }, el('label', {}, 'Name'), name),
    el('div', { class: 'field' }, el('label', {}, 'URL'), url,
      el('div', { class: 'field__hint' }, 'https:// is added automatically if you leave it off.')),
    el('div', { class: 'field' }, el('label', {}, 'Description'), description),
    el('div', { class: 'field' }, el('label', {}, 'Tags'), tags,
      el('div', { class: 'field__hint' }, 'Comma-separated. Each becomes a clickable filter.'),
      tagSuggest),
    el('div', { class: 'field' }, el('label', {}, 'Favicon (shown next to the listing)'), iconRow,
      el('div', { class: 'field__hint' }, 'PNG, JPG, GIF, WEBP, SVG, or ICO. Max 512 KB.')),
    msg,
    submit,
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.textContent = '';
    submit.disabled = true;
    const fd = new FormData();
    fd.set('name', name.value);
    fd.set('url', url.value);
    fd.set('description', description.value);
    fd.set('tags', tags.value);
    if (iconInput.files[0]) fd.set('icon', iconInput.files[0]);
    if (editing && removeExistingIcon) fd.set('removeIcon', 'true');
    try {
      if (editing) await api('/sites/' + site.id, { method: 'PATCH', form: fd });
      else await api('/sites', { method: 'POST', form: fd });
      state.allTags = null; // tags may have changed
      closeModal();
      toast(editing ? 'Listing updated.' : 'Website added.');
      loadSites();
    } catch (err) {
      msg.className = 'formmsg formmsg--error';
      msg.textContent = err.message;
      submit.disabled = false;
    }
  });

  openModal(modalShell(editing ? 'Edit website' : 'Add a website', form));
}

async function deleteSite(site) {
  if (!confirm(`Delete "${site.name}" from the search engine? This cannot be undone.`)) return;
  try {
    await api('/sites/' + site.id, { method: 'DELETE' });
    state.allTags = null;
    toast('Listing deleted.');
    loadSites();
  } catch (e) { toast(e.message, true); }
}

// ---------- account settings ----------
function openAccountModal() {
  const msg = el('div', { class: 'formmsg' });

  // --- Profile picture section ---
  const avatarPreview = el('span', { class: 'accountpfp__img' });
  function paintAvatar() {
    avatarPreview.innerHTML = '';
    if (state.user.avatar) avatarPreview.append(el('img', { src: state.user.avatar, alt: '' }));
    else avatarPreview.textContent = state.user.username.charAt(0).toUpperCase();
  }
  paintAvatar();
  const avatarFile = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp' });
  avatarFile.addEventListener('change', async () => {
    const f = avatarFile.files[0];
    if (!f) return;
    const fd = new FormData(); fd.set('avatar', f);
    try {
      const d = await api('/auth/avatar', { method: 'POST', form: fd });
      state.user.avatar = d.avatar;
      paintAvatar(); syncChrome(); toast('Profile picture updated.');
    } catch (e) { toast(e.message, true); }
    avatarFile.value = '';
  });
  const removeAvatarBtn = el('button', { type: 'button', class: 'minibtn' }, 'Remove');
  removeAvatarBtn.addEventListener('click', async () => {
    try {
      await api('/auth/avatar', { method: 'DELETE' });
      state.user.avatar = null;
      paintAvatar(); syncChrome(); toast('Profile picture removed.');
    } catch (e) { toast(e.message, true); }
  });
  const avatarSection = el('div', { class: 'accountpfp' },
    avatarPreview,
    el('div', {},
      el('div', { class: 'field__hint', style: 'margin-bottom:8px' }, 'PNG, JPG, GIF, or WEBP. Max 1 MB.'),
      avatarFile,
      el('div', { style: 'margin-top:8px' }, removeAvatarBtn),
    )
  );

  // --- Username / password section ---
  const username = el('input', { type: 'text', value: state.user.username, autocomplete: 'username' });
  const current = el('input', { type: 'password', autocomplete: 'current-password', placeholder: 'required only to change password' });
  const next = el('input', { type: 'password', autocomplete: 'new-password', placeholder: 'leave blank to keep current' });
  const submit = el('button', { class: 'btn btn--primary', type: 'submit' }, 'Save changes');

  const form = el('form', {},
    el('div', { class: 'field' }, el('label', {}, 'Username'), username),
    el('div', { class: 'field' }, el('label', {}, 'Current password'), current),
    el('div', { class: 'field' }, el('label', {}, 'New password'), next,
      el('div', { class: 'field__hint' }, 'At least 8 characters.')),
    msg,
    submit,
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.textContent = '';
    submit.disabled = true;
    const body = { username: username.value };
    if (next.value) { body.currentPassword = current.value; body.newPassword = next.value; }
    try {
      const d = await api('/auth/account', { method: 'PATCH', body });
      state.user.username = d.user.username;
      closeModal();
      syncChrome();
      toast('Account updated.');
      loadSites();
    } catch (err) {
      msg.className = 'formmsg formmsg--error';
      msg.textContent = err.message;
      submit.disabled = false;
    }
  });

  // --- API key section ---
  const apiSection = el('div', { class: 'apikey' });
  function renderApiSection() {
    apiSection.innerHTML = '';
    apiSection.append(el('div', { class: 'apikey__title' }, 'API key'));
    if (state.user.hasApiKey) {
      apiSection.append(
        el('p', { class: 'field__hint' }, 'An API key is active on this account. Generating a new one replaces it; revoking disables API access.'),
        el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' },
          el('button', { type: 'button', class: 'btn btn--ghost btn--small', onclick: genKey }, 'Regenerate'),
          el('button', { type: 'button', class: 'btn btn--ghost btn--small', onclick: revokeKey }, 'Revoke key'),
        )
      );
    } else {
      apiSection.append(
        el('p', { class: 'field__hint' }, 'Generate a key to access the API with this account\u2019s permissions. Send it as an Authorization: Bearer header.'),
        el('button', { type: 'button', class: 'btn btn--ghost btn--small', onclick: genKey }, 'Generate API key'),
      );
    }
  }
  async function genKey() {
    if (state.user.hasApiKey && !confirm('Replace the existing API key? The old key stops working immediately.')) return;
    try {
      const d = await api('/auth/apikey', { method: 'POST' });
      state.user.hasApiKey = true;
      renderApiSection();      // rebuild the section first (clears the box)...
      showKeyOnce(d.apiKey);   // ...then append the one-time key reveal
    } catch (e) { toast(e.message, true); }
  }
  async function revokeKey() {
    if (!confirm('Revoke this API key? Any client using it will stop working.')) return;
    try {
      await api('/auth/apikey', { method: 'DELETE' });
      state.user.hasApiKey = false;
      renderApiSection();
      toast('API key revoked.');
    } catch (e) { toast(e.message, true); }
  }
  function showKeyOnce(key) {
    // Shown once; not retrievable later.
    const box = el('div', { class: 'apikey__reveal' },
      el('div', { class: 'apikey__warn' }, 'Copy this key now — it will not be shown again.'),
      el('code', { class: 'apikey__code' }, key),
      el('button', { type: 'button', class: 'btn btn--ghost btn--small', onclick: () => {
        navigator.clipboard?.writeText(key).then(() => toast('Copied to clipboard.'), () => {});
      } }, 'Copy'),
    );
    apiSection.append(box);
  }
  renderApiSection();

  const wrap = el('div', {},
    el('div', { class: 'account__sectionlabel' }, 'Profile picture'),
    avatarSection,
    el('hr', { class: 'account__rule' }),
    form,
    el('hr', { class: 'account__rule' }),
    apiSection,
  );

  openModal(modalShell('Account settings', wrap));
}

// ---------- admin panel ----------
async function openAdminPanel() {
  const body = el('div', {});
  const tabs = el('div', { class: 'tabs' });
  const content = el('div', { class: 'modal__body', style: 'padding-top:16px' });

  const tabUsers = el('button', { class: 'tab tab--active' }, 'Users');
  const tabSites = el('button', { class: 'tab' }, 'Listings');
  const tabBackup = el('button', { class: 'tab' }, 'Backup');
  tabs.append(tabUsers, tabSites, tabBackup);

  tabUsers.onclick = () => { setActive(tabUsers); renderUsersTab(content); };
  tabSites.onclick = () => { setActive(tabSites); renderSitesTab(content); };
  tabBackup.onclick = () => { setActive(tabBackup); renderBackupTab(content); };
  function setActive(t) {
    [tabUsers, tabSites, tabBackup].forEach((x) => x.classList.toggle('tab--active', x === t));
  }

  body.append(tabs, content);
  const shell = el('div', { class: 'modal modal--wide' },
    el('div', { class: 'modal__head' },
      el('h2', { class: 'modal__title' }, 'Admin panel'),
      el('button', { class: 'modal__close', onclick: closeModal }, '×')),
    body,
  );
  openModal(shell);
  renderUsersTab(content);
}

async function renderUsersTab(content) {
  content.innerHTML = '';
  content.append(el('div', { class: 'placeholder' }, 'Loading users…'));
  try {
    const d = await api('/admin/users');
    content.innerHTML = '';
    for (const u of d.users) {
      const roleSel = el('select', {},
        ...['user', 'moderator', 'admin'].map((r) =>
          el('option', { value: r, ...(r === u.role ? { selected: 'selected' } : {}) }, r)));
      roleSel.addEventListener('change', async () => {
        try { await api('/admin/users/' + u.id, { method: 'PATCH', body: { role: roleSel.value } }); toast('Role updated.'); }
        catch (e) { toast(e.message, true); roleSel.value = u.role; }
      });

      const row = el('div', { class: 'adminrow' },
        el('div', { class: 'adminrow__main' },
          el('div', { class: 'adminrow__title' }, u.username,
            u.id === state.user.id ? el('span', { class: 'badge', style: 'margin-left:8px' }, 'you') : null,
            u.hasApiKey ? el('span', { class: 'badge', style: 'margin-left:8px' }, 'API key') : null),
          el('div', { class: 'adminrow__sub' }, 'joined ' + new Date(u.createdAt).toLocaleDateString())),
        roleSel,
        el('button', { class: 'minibtn', onclick: () => adminEditUser(u, content) }, 'Edit'),
        u.hasApiKey
          ? el('button', { class: 'minibtn', onclick: () => adminRevokeKey(u, content) }, 'Revoke key')
          : null,
        u.id === state.user.id ? null :
          el('button', { class: 'minibtn minibtn--danger', onclick: () => adminDeleteUser(u, content) }, 'Delete'),
      );
      content.append(row);
    }
    if (d.users.length === 0) content.append(el('div', { class: 'placeholder' }, 'No users.'));
  } catch (e) {
    content.innerHTML = '';
    content.append(el('div', { class: 'placeholder' }, e.message));
  }
}

function adminEditUser(u, content) {
  const msg = el('div', { class: 'formmsg' });
  const username = el('input', { type: 'text', value: u.username });
  const newPass = el('input', { type: 'password', placeholder: 'leave blank to keep current' });
  const submit = el('button', { class: 'btn btn--primary', type: 'submit' }, 'Save');
  const form = el('form', {},
    el('div', { class: 'field' }, el('label', {}, 'Username'), username),
    el('div', { class: 'field' }, el('label', {}, 'Reset password'), newPass),
    msg, submit,
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submit.disabled = true; msg.textContent = '';
    const body = { username: username.value };
    if (newPass.value) body.newPassword = newPass.value;
    try {
      await api('/admin/users/' + u.id, { method: 'PATCH', body });
      toast('User updated.');
      openAdminPanel();
    } catch (err) { msg.className = 'formmsg formmsg--error'; msg.textContent = err.message; submit.disabled = false; }
  });
  openModal(modalShell('Edit user', form));
}

async function adminRevokeKey(u, content) {
  if (!confirm(`Revoke ${u.username}'s API key? Any client using it stops working.`)) return;
  try {
    await api('/admin/users/' + u.id + '/apikey', { method: 'DELETE' });
    toast('API key revoked.');
    renderUsersTab(content);
  } catch (e) { toast(e.message, true); }
}

async function adminDeleteUser(u, content) {
  const purge = confirm(`Delete user "${u.username}".\n\nOK = also delete all their listings.\nCancel = keep listings (will pick "keep" if you cancel the next prompt too).`);
  if (!confirm(`Permanently delete "${u.username}"? This cannot be undone.`)) return;
  try {
    await api('/admin/users/' + u.id + (purge ? '?purge=true' : ''), { method: 'DELETE' });
    toast('User deleted.');
    renderUsersTab(content);
    loadSites();
  } catch (e) { toast(e.message, true); }
}

async function renderSitesTab(content) {
  content.innerHTML = '';
  content.append(el('div', { class: 'placeholder' }, 'Loading listings…'));
  try {
    const d = await api('/sites?all=true');
    content.innerHTML = '';
    for (const s of d.sites) {
      const row = el('div', { class: 'adminrow' },
        faviconNode(s),
        el('div', { class: 'adminrow__main' },
          el('div', { class: 'adminrow__title' }, s.name),
          el('div', { class: 'adminrow__sub' }, prettyUrl(s.url) + ' · by ' + (s.ownerName || 'unknown'))),
        el('button', { class: 'minibtn', onclick: () => { closeModal(); openSiteModal(s); } }, 'Edit'),
        el('button', { class: 'minibtn minibtn--danger', onclick: async () => {
          if (!confirm(`Delete "${s.name}"?`)) return;
          try { await api('/sites/' + s.id, { method: 'DELETE' }); toast('Listing deleted.'); renderSitesTab(content); loadSites(); }
          catch (e) { toast(e.message, true); }
        } }, 'Delete'),
      );
      content.append(row);
    }
    if (d.sites.length === 0) content.append(el('div', { class: 'placeholder' }, 'No listings.'));
  } catch (e) {
    content.innerHTML = '';
    content.append(el('div', { class: 'placeholder' }, e.message));
  }
}

// ---------- admin: backup (snapshot export / import) ----------
function renderBackupTab(content) {
  content.innerHTML = '';

  // --- Export ---
  const exportBtn = el('button', { class: 'btn btn--ghost' }, 'Download snapshot (.zip)');
  exportBtn.addEventListener('click', () => downloadSnapshot(exportBtn));

  const exportCard = el('div', { class: 'backup__card' },
    el('div', { class: 'backup__title' }, 'Export'),
    el('p', { class: 'backup__desc' },
      'Save a dated .zip snapshot of all website listings, taglines, and uploaded favicons. Account data is never included. Your current data is left untouched.'),
    exportBtn,
  );

  // --- Import ---
  const fileInput = el('input', { type: 'file', accept: '.zip,application/zip' });
  const importBtn = el('button', { class: 'btn btn--primary', disabled: 'disabled' }, 'Replace data from snapshot');
  fileInput.addEventListener('change', () => { importBtn.disabled = !fileInput.files[0]; });
  importBtn.addEventListener('click', () => importSnapshot(fileInput, importBtn));

  const importCard = el('div', { class: 'backup__card' },
    el('div', { class: 'backup__title' }, 'Import'),
    el('p', { class: 'backup__desc' },
      'Restore from a snapshot. This clears all current listings, taglines, and favicons and replaces them with the contents of the .zip. Accounts are not affected. This cannot be undone — export a snapshot first if unsure.'),
    el('div', { class: 'field', style: 'margin:10px 0 12px' }, fileInput),
    importBtn,
  );

  content.append(exportCard, importCard);
}

async function downloadSnapshot(btn) {
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = 'Preparing…';
  try {
    const r = await fetch('/api/admin/export');
    if (!r.ok) {
      let msg = 'Export failed.';
      try { msg = (await r.json()).error || msg; } catch {}
      throw new Error(msg);
    }
    // Pull the filename from Content-Disposition, fall back to a dated name.
    const cd = r.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename="([^"]+)"/);
    const name = m ? m[1] : `lumen-snapshot-${new Date().toISOString().slice(0, 10)}.zip`;
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast('Snapshot downloaded.');
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false; btn.textContent = original;
  }
}

async function importSnapshot(fileInput, btn) {
  const file = fileInput.files[0];
  if (!file) return;
  if (!confirm('Replace ALL current listings, taglines, and favicons with this snapshot? Accounts are kept. This cannot be undone.')) return;
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = 'Importing…';
  try {
    const fd = new FormData();
    fd.set('snapshot', file);
    const d = await api('/admin/import', { method: 'POST', form: fd });
    toast(`Imported ${d.siteCount} listing${d.siteCount === 1 ? '' : 's'}.`);
    closeModal();
    loadSites();
  } catch (e) {
    toast(e.message, true);
    btn.disabled = false; btn.textContent = original;
  }
}

// ---------- chrome (top bar) sync ----------
function syncChrome() {
  const signedIn = !!state.user;
  $('#addBtn').hidden = !signedIn;
  $('#userMenu').hidden = !signedIn;
  $('#signinBtn').hidden = signedIn;
  $('#adminBtn').hidden = !(signedIn && state.user.role === 'admin');
  if (signedIn) {
    const av = $('#avatar');
    av.innerHTML = '';
    if (state.user.avatar) {
      av.append(el('img', { src: state.user.avatar, alt: '' }));
    } else {
      av.textContent = state.user.username.charAt(0);
    }
    $('#menuName').textContent = state.user.username;
    $('#menuRole').textContent = state.user.role;
  }
}

// ---------- wire up ----------
function init() {
  const input = $('#searchInput');
  input.addEventListener('input', () => {
    state.query = input.value.trim();
    state.page = 1;
    $('#clearBtn').hidden = !input.value;
    clearTimeout(searchTimer);
    // While typing: live results + replace URL (no history spam).
    searchTimer = setTimeout(() => { applyStateToUrl(false); loadSites(); }, 180);
  });
  $('#searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    clearTimeout(searchTimer);
    state.query = input.value.trim();
    state.page = 1;
    applyStateToUrl(true); // committed search -> history entry
    loadSites();
    input.blur();
  });
  $('#clearBtn').addEventListener('click', () => {
    input.value = ''; state.query = ''; state.page = 1;
    $('#clearBtn').hidden = true; input.focus();
    applyStateToUrl(true);
    loadSites();
  });

  $('#addBtn').addEventListener('click', () => openSiteModal());
  $('#filterBtn').addEventListener('click', openFilterModal);
  $('#signinBtn').addEventListener('click', () => openAuthModal('login'));
  $('#adminBtn').addEventListener('click', openAdminPanel);

  // Brand/logo returns to the home view without a full page reload. Both the
  // top-bar brand and the colorful hero logo trigger it (the hero is the only
  // visible wordmark while searching).
  function goHome(e) {
    if (e) e.preventDefault();
    state.query = ''; state.tags = []; state.sort = 'newest'; state.hasIcon = ''; state.page = 1;
    $('#searchInput').value = '';
    $('#clearBtn').hidden = true;
    updateActiveFilter();
    updateFilterButton();
    applyStateToUrl(true);
    loadSites();
  }
  $('.topbar__brand').addEventListener('click', goHome);
  const heroWord = $('#heroWord');
  if (heroWord) {
    heroWord.style.cursor = 'pointer';
    heroWord.setAttribute('role', 'link');
    heroWord.setAttribute('tabindex', '0');
    heroWord.addEventListener('click', goHome);
    heroWord.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') goHome(e);
    });
  }

  // Back/forward buttons: re-read the URL and reload results.
  window.addEventListener('popstate', () => {
    syncInputToState();
    loadSites();
  });

  // user menu toggle
  const trigger = $('#userMenuTrigger');
  const dd = $('#userMenuDropdown');
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = dd.hidden;
    dd.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', () => { dd.hidden = true; trigger.setAttribute('aria-expanded', 'false'); });
  dd.addEventListener('click', (e) => e.stopPropagation());
  $('#accountBtn').addEventListener('click', () => { dd.hidden = true; openAccountModal(); });
  $('#logoutBtn').addEventListener('click', async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch {}
    state.user = null; state.csrf = null;
    syncChrome(); toast('Signed out.'); loadSites();
  });

  bootstrap();
}

// Build the animated hero word from the brand name, one span per character.
function buildHero() {
  const h = $('#heroWord');
  if (!h) return;
  h.setAttribute('aria-label', state.appName);
  h.innerHTML = '';
  [...state.appName].forEach((ch, i) => {
    const span = el('span', { style: `--i:${i}` });
    // Preserve spaces visually.
    span.textContent = ch === ' ' ? '\u00A0' : ch;
    h.append(span);
  });
}

// Reflect current state into the search box and tag-filter UI. Used after
// reading the URL (initial load, back/forward).
function syncInputToState() {
  readStateFromUrl();
  const input = $('#searchInput');
  if (input) {
    input.value = state.query;
    $('#clearBtn').hidden = !state.query;
  }
  updateActiveFilter();
  updateFilterButton();
}

async function bootstrap() {
  try {
    const cfg = await api('/config');
    if (cfg.appName) state.appName = cfg.appName;
    if (Array.isArray(cfg.taglines) && cfg.taglines.length) {
      const tag = cfg.taglines[Math.floor(Math.random() * cfg.taglines.length)];
      const tagEl = $('#heroTag');
      if (tagEl) tagEl.textContent = tag;
    }
  } catch {}
  buildHero();
  try {
    const d = await api('/auth/me');
    state.user = d.user;
  } catch {}
  syncChrome();
  syncInputToState();   // populate query/tag/page + input box from the URL
  loadSites();
}

init();
