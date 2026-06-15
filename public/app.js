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
  appName: 'ProtoEngine',
  query: '',
  tags: [],          // active tag filters (all must match)
  sort: 'newest',    // newest | oldest | name | name_desc
  hasIcon: '',       // '' | 'true' | 'false'
  page: 1,
  pageCount: 1,
  matched: 0,
  sites: [],
  allTags: null,     // cached [{tag,count}] for pickers
  rssRefreshMinutes: 5,
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

// ---------- favorites ----------
function isFavorite(id) {
  return !!(state.user && Array.isArray(state.user.favorites) && state.user.favorites.includes(id));
}

function starSvg(filled) {
  return filled
    ? '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 17l-5.3 2.8 1-5.8-4.2-4.1 5.9-.9z" fill="currentColor"/></svg>'
    : '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 17l-5.3 2.8 1-5.8-4.2-4.1 5.9-.9z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
}

async function toggleFavorite(siteId) {
  if (!state.user) return;
  try {
    const d = await api('/auth/favorites/toggle', { method: 'POST', body: { siteId } });
    state.user.favorites = d.favorites || [];
    renderResults();      // refresh star states
    renderFavorites();    // refresh the grid
  } catch (e) { toast(e.message, true); }
}

// Result 3-dot menu open/close.
function closeAllResultMenus() {
  document.querySelectorAll('.result__menudrop').forEach((d) => { d.hidden = true; });
}
function toggleResultMenu(menuWrap) {
  const drop = menuWrap.querySelector('.result__menudrop');
  const wasHidden = drop.hidden;
  closeAllResultMenus();
  drop.hidden = !wasHidden;
}

// Render the favorites grid (an app-grid of favicons, drag-to-reorder). Shown
// on the home view when signed in with at least one favorite.
// Pointer-based drag for favorite tiles — works with mouse AND touch, shows a
// floating preview that follows the pointer, and reorders live as you hover
// other tiles. Listeners live on window during a drag so moves are never lost.
function attachFavDrag(tile, site, grid) {
  let startX = 0, startY = 0, dragging = false, ghost = null;
  let isTouch = false, armed = false, holdTimer = null;

  function onDown(e) {
    if (e.button != null && e.button !== 0) return; // left button / touch only
    startX = e.clientX; startY = e.clientY;
    dragging = false;
    isTouch = e.pointerType === 'touch';
    armed = !isTouch; // mouse: armed immediately; touch: arm after long-press

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);

    if (isTouch) {
      // Long-press to pick up (like rearranging phone icons). If the finger
      // moves much before this fires, it's a scroll and we cancel.
      holdTimer = setTimeout(() => {
        armed = true;
        beginDrag();
        if (navigator.vibrate) { try { navigator.vibrate(15); } catch {} }
      }, 250);
    }
  }

  function beginDrag() {
    dragging = true;
    tile.classList.add('favtile--dragging');
    const r = tile.getBoundingClientRect();
    ghost = tile.cloneNode(true);
    ghost.classList.add('favtile--ghost');
    ghost.style.width = r.width + 'px';
    ghost.style.height = r.height + 'px';
    document.body.append(ghost);
    moveGhost(startX, startY);
  }

  function moveGhost(x, y) {
    if (ghost) { ghost.style.left = x + 'px'; ghost.style.top = y + 'px'; }
  }

  function onMove(e) {
    const dx = e.clientX - startX, dy = e.clientY - startY;

    // Touch, before the long-press fires: if the finger moves, treat it as a
    // scroll — cancel the pending drag and let the drawer scroll normally.
    if (isTouch && !armed) {
      if (Math.hypot(dx, dy) > 8) cleanup();
      return;
    }
    // Mouse: start dragging once past the movement threshold.
    if (!dragging) {
      if (Math.hypot(dx, dy) < 6) return;
      beginDrag();
    }
    e.preventDefault();
    moveGhost(e.clientX, e.clientY);

    // Hide the ghost for the hit-test so elementFromPoint sees the tile below.
    ghost.style.display = 'none';
    const under = document.elementFromPoint(e.clientX, e.clientY);
    ghost.style.display = '';
    const overTile = under && under.closest('.favtile');

    grid.querySelectorAll('.favtile--over').forEach((t) => t.classList.remove('favtile--over'));
    if (overTile && overTile !== tile && overTile.parentElement === grid) {
      overTile.classList.add('favtile--over');
      const tiles = [...grid.children];
      if (tiles.indexOf(overTile) < tiles.indexOf(tile)) grid.insertBefore(tile, overTile);
      else grid.insertBefore(tile, overTile.nextSibling);
    }
  }

  function cleanup() {
    clearTimeout(holdTimer); holdTimer = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  }

  function onUp() {
    clearTimeout(holdTimer); holdTimer = null;
    cleanup();
    if (ghost) { ghost.remove(); ghost = null; }
    grid.querySelectorAll('.favtile--over').forEach((t) => t.classList.remove('favtile--over'));
    if (dragging) {
      tile.classList.remove('favtile--dragging');
      const order = [...grid.children].map((t) => t.dataset.id);
      persistFavOrder(order);
      // Suppress the click that would otherwise open the link right after drag.
      tile.addEventListener('click', suppressOnce, true);
    }
    dragging = false;
  }

  function suppressOnce(e) {
    e.preventDefault(); e.stopPropagation();
    tile.removeEventListener('click', suppressOnce, true);
  }

  // Stop the browser's native image/link drag on the anchor (competes with us).
  tile.addEventListener('dragstart', (e) => e.preventDefault());
  tile.setAttribute('draggable', 'false');
  // Suppress the native long-press context menu / link callout, which on
  // touch fires during a long-press and cancels our pick-up.
  tile.addEventListener('contextmenu', (e) => e.preventDefault());
  tile.addEventListener('pointerdown', onDown);
}

// Favorites edit mode (pencil) + view orientation icons.
let favEditMode = false;
const FAV_PENCIL_ICON = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 20h4l10-10-4-4L4 16v4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M13.5 6.5l4 4" stroke="currentColor" stroke-width="1.8"/></svg>';
const FAV_DONE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M5 12l5 5 9-10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const FAV_LIST_ICON = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M8 6h12M8 12h12M8 18h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="4" cy="6" r="1.4" fill="currentColor"/><circle cx="4" cy="12" r="1.4" fill="currentColor"/><circle cx="4" cy="18" r="1.4" fill="currentColor"/></svg>';
const FAV_GRID_ICON = '<svg viewBox="0 0 24 24" width="16" height="16"><rect x="4" y="4" width="6" height="6" rx="1.5" fill="currentColor"/><rect x="14" y="4" width="6" height="6" rx="1.5" fill="currentColor"/><rect x="4" y="14" width="6" height="6" rx="1.5" fill="currentColor"/><rect x="14" y="14" width="6" height="6" rx="1.5" fill="currentColor"/></svg>';

async function toggleFavView() {
  const next = (state.user.favoritesView === 'list') ? 'grid' : 'list';
  state.user.favoritesView = next;
  renderFavorites();
  try {
    await api('/auth/favorites/view', { method: 'PATCH', body: { view: next } });
  } catch (e) { toast(e.message, true); }
}

async function renderFavorites() {
  const panel = $('#favPanel');
  if (!panel) return;
  const ids = (state.user && state.user.favorites) || [];
  if (!state.user || !ids.length || isSearching()) {
    panel.hidden = true; panel.innerHTML = '';
    document.body.classList.remove('has-fav');
    return;
  }

  let sites = [];
  try {
    const d = await api('/sites/by-ids?ids=' + encodeURIComponent(ids.join(',')));
    sites = d.sites || [];
  } catch { sites = []; }
  if (!sites.length) {
    panel.hidden = true; panel.innerHTML = '';
    document.body.classList.remove('has-fav');
    return;
  }

  panel.innerHTML = '';
  const view = (state.user.favoritesView === 'list') ? 'list' : 'grid';

  // Header: title + list/grid toggle + edit pencil.
  const viewBtn = el('button', {
    class: 'favpanel__btn',
    title: view === 'grid' ? 'List view' : 'Grid view',
    'aria-label': 'Toggle view',
    onclick: () => toggleFavView(),
  }, el('span', { html: view === 'grid' ? FAV_LIST_ICON : FAV_GRID_ICON }));
  const editBtn = el('button', {
    class: 'favpanel__btn' + (favEditMode ? ' favpanel__btn--active' : ''),
    title: favEditMode ? 'Done' : 'Edit favorites',
    'aria-label': 'Edit favorites',
    onclick: () => { favEditMode = !favEditMode; renderFavorites(); },
  }, el('span', { html: favEditMode ? FAV_DONE_ICON : FAV_PENCIL_ICON }));

  panel.append(
    el('div', { class: 'favpanel__head' },
      el('span', {}, 'Favorites'),
      el('div', { class: 'favpanel__actions' }, viewBtn, editBtn),
    )
  );

  const grid = el('div', { class: 'favgrid favgrid--' + view + (favEditMode ? ' favgrid--editing' : '') });

  for (const site of sites) {
    const tile = el('a', {
      class: 'favtile',
      href: site.url,
      target: '_blank',
      rel: 'noopener noreferrer',
      title: site.name,
    },
      el('span', { class: 'favtile__icon' }, faviconNode(site)),
      el('span', { class: 'favtile__name' }, el('span', {}, site.name)),
    );
    tile.dataset.id = site.id;

    if (favEditMode) {
      // Delete badge: a red X that confirms then removes the favorite.
      const del = el('button', {
        class: 'favtile__del',
        title: 'Remove favorite',
        'aria-label': 'Remove favorite',
        onclick: (e) => {
          e.preventDefault(); e.stopPropagation();
          if (confirm(`Remove "${site.name}" from favorites?`)) toggleFavorite(site.id);
        },
      }, '×');
      tile.append(del);
      // In edit mode the tile shouldn't navigate.
      tile.addEventListener('click', (e) => e.preventDefault());
    } else {
      attachFavDrag(tile, site, grid);
    }
    grid.append(tile);
  }
  panel.append(grid);
  panel.hidden = false;
  document.body.classList.add('has-fav');

  // After layout, mark names that overflow their tile so only those marquee,
  // and set the exact scroll distance. Add the class first (it unclamps the
  // span) so scrollWidth reflects the full text width, then measure.
  requestAnimationFrame(() => {
    grid.querySelectorAll('.favtile__name').forEach((nameEl) => {
      const inner = nameEl.firstChild;
      if (!inner) return;
      const visible = nameEl.clientWidth;
      nameEl.classList.add('favtile__name--marquee');
      const full = inner.scrollWidth;
      if (full > visible + 1) {
        nameEl.style.setProperty('--marquee-dist', '-' + (full - visible) + 'px');
      } else {
        nameEl.classList.remove('favtile__name--marquee');
      }
    });
  });
}

// Move dragged favorite to the position of the target, persist new order.
// Persist a new favorites order (called after a pointer-drag completes).
async function persistFavOrder(order) {
  state.user.favorites = order;
  try {
    const d = await api('/auth/favorites/order', { method: 'PATCH', body: { order } });
    state.user.favorites = d.favorites || order;
  } catch (e) { toast(e.message, true); }
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

    // Per-listing controls: favorite star + 3-dot menu (top-right).
    if (state.user) {
      const controls = el('div', { class: 'result__controls' });

      const isFav = isFavorite(site.id);
      const starBtn = el('button', {
        class: 'result__star' + (isFav ? ' result__star--on' : ''),
        title: isFav ? 'Remove from favorites' : 'Add to favorites',
        'aria-label': 'Toggle favorite',
        onclick: (e) => { e.stopPropagation(); toggleFavorite(site.id); },
      }, el('span', { html: starSvg(isFav) }));
      controls.append(starBtn);

      // The 3-dot menu only appears if the user can edit/delete this listing.
      if (canManage(site)) {
        const menuWrap = el('div', { class: 'result__menu' });
        const dotsBtn = el('button', {
          class: 'result__dots',
          title: 'More actions',
          'aria-label': 'More actions',
          'aria-haspopup': 'true',
          onclick: (e) => { e.stopPropagation(); toggleResultMenu(menuWrap); },
        }, el('span', { html: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="5" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="19" r="1.6" fill="currentColor"/></svg>' }));
        const dropdown = el('div', { class: 'result__menudrop', hidden: true },
          el('button', { class: 'result__menuitem', onclick: () => { closeAllResultMenus(); openSiteModal(site); } }, 'Edit'),
          el('button', { class: 'result__menuitem result__menuitem--danger', onclick: () => { closeAllResultMenus(); deleteSite(site); } }, 'Delete'),
        );
        menuWrap.append(dotsBtn, dropdown);
        controls.append(menuWrap);
      }

      result.append(controls);
    }

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
let suggestTimer;
const suggestState = { items: [], active: -1 };

// Fetch up to 5 autocomplete suggestions for the typed query and show them.
async function fetchSuggestions(q) {
  try {
    const d = await api('/sites/suggest?q=' + encodeURIComponent(q));
    showSuggest(d.suggestions || []);
  } catch {
    hideSuggest();
  }
}

function showSuggest(items) {
  const list = $('#suggestList');
  const input = $('#searchInput');
  suggestState.items = items;
  suggestState.active = -1;
  list.innerHTML = '';
  if (!items.length) { hideSuggest(); return; }
  items.forEach((s, i) => {
    const li = el('li', {
      class: 'suggest__item',
      role: 'option',
      onmousedown: (e) => { e.preventDefault(); chooseSuggestion(s); },
    },
      el('span', { class: 'suggest__icon' }, s.type === 'tag' ? '#' : '\u2315'),
      el('span', { class: 'suggest__text' }, s.value),
      el('span', { class: 'suggest__type' }, s.type === 'tag' ? 'tag' : 'site'),
    );
    li.dataset.i = String(i);
    list.append(li);
  });
  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}

function hideSuggest() {
  const list = $('#suggestList');
  if (list) { list.hidden = true; list.innerHTML = ''; }
  suggestState.items = [];
  suggestState.active = -1;
  const input = $('#searchInput');
  if (input) input.setAttribute('aria-expanded', 'false');
}

function paintSuggestActive() {
  const list = $('#suggestList');
  [...list.children].forEach((li, i) => {
    li.classList.toggle('suggest__item--active', i === suggestState.active);
  });
}

// Pick a suggestion: a tag filters by that tag; a site name searches for it.
function chooseSuggestion(s) {
  const input = $('#searchInput');
  hideSuggest();
  if (s.type === 'tag') {
    // Add the tag to the active filters and clear the text query.
    input.value = '';
    state.query = '';
    if (!state.tags.includes(s.value)) state.tags.push(s.value);
    updateActiveFilter();
  } else {
    input.value = s.value;
    state.query = s.value;
  }
  state.page = 1;
  applyStateToUrl(true);
  loadSites();
  input.blur();
}

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
    loadRssPanel();
    renderFavorites();
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
function openSettingsPage() {
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

  // --- Background image section ---
  const bgPreview = el('span', { class: 'accountbg__img' });
  function paintBg() {
    bgPreview.style.backgroundImage = state.user.background ? `url("${state.user.background}")` : '';
    bgPreview.classList.toggle('accountbg__img--empty', !state.user.background);
    bgPreview.textContent = state.user.background ? '' : 'none';
  }
  paintBg();
  const bgFile = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp' });
  bgFile.addEventListener('change', async () => {
    const f = bgFile.files[0];
    if (!f) return;
    const fd = new FormData(); fd.set('background', f);
    try {
      const d = await api('/auth/background', { method: 'POST', form: fd });
      state.user.background = d.background;
      paintBg(); applyBackground(); toast('Background updated.');
    } catch (e) { toast(e.message, true); }
    bgFile.value = '';
  });
  const removeBgBtn = el('button', { type: 'button', class: 'minibtn' }, 'Remove');
  removeBgBtn.addEventListener('click', async () => {
    try {
      await api('/auth/background', { method: 'DELETE' });
      state.user.background = null;
      paintBg(); applyBackground(); toast('Background removed.');
    } catch (e) { toast(e.message, true); }
  });
  const bgSection = el('div', { class: 'accountbg' },
    bgPreview,
    el('div', {},
      el('div', { class: 'field__hint', style: 'margin-bottom:8px' }, 'Shown behind the page, with results on a frosted-glass panel. PNG, JPG, GIF, or WEBP. Max 6 MB.'),
      bgFile,
      el('div', { style: 'margin-top:8px' }, removeBgBtn),
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
      syncChrome();
      msg.className = 'formmsg formmsg--ok';
      msg.textContent = 'Account updated.';
      submit.disabled = false;
      current.value = ''; next.value = '';
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

  // --- Build the five settings panels ---
  const panelAccount = el('div', {},
    el('div', { class: 'account__sectionlabel' }, 'Profile picture'),
    avatarSection,
    el('hr', { class: 'account__rule' }),
    el('div', { class: 'account__sectionlabel' }, 'Username & password'),
    form,
  );
  const panelCustomization = el('div', {},
    el('div', { class: 'account__sectionlabel' }, 'Background image'),
    bgSection,
  );
  const panelRss = el('div', {});
  const panelDeveloper = el('div', {},
    apiSection,
  );
  const panelAdmin = el('div', {});

  const tabDefs = [
    ['account', 'Account', panelAccount],
    ['customization', 'Customization', panelCustomization],
    ['rss', 'RSS', panelRss],
    ['developer', 'Developer', panelDeveloper],
  ];
  if (state.user.role === 'admin') tabDefs.push(['admin', 'Admin Panel', panelAdmin]);

  const rail = el('nav', { class: 'settings__rail' });
  const content = el('div', { class: 'settings__content' });
  const tabButtons = {};
  const loaded = {};
  function showTab(key) {
    Object.values(tabButtons).forEach((b) => b.classList.remove('settings__tab--active'));
    tabButtons[key].classList.add('settings__tab--active');
    content.innerHTML = '';
    const panel = tabDefs.find((t) => t[0] === key)[2];
    content.append(panel);
    if (key === 'rss' && !loaded.rss) { loaded.rss = true; renderRssTab(panel); }
    if (key === 'admin' && !loaded.admin) { loaded.admin = true; renderAdminInto(panel); }
    // Reflect the active tab in the URL hash for refresh/back support.
    history.replaceState(null, '', '/settings#' + key);
  }
  for (const [key, label] of tabDefs) {
    const b = el('button', { class: 'settings__tab', onclick: () => showTab(key) }, label);
    tabButtons[key] = b;
    rail.append(b);
  }

  const page = $('#settingsPage');
  page.innerHTML = '';
  page.append(
    el('header', { class: 'settings__top' },
      el('button', { class: 'settings__back', onclick: closeSettingsPage, 'aria-label': 'Back' },
        el('span', { html: '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' })),
      el('h1', { class: 'settings__title' }, 'Settings'),
    ),
    el('div', { class: 'settings__body' }, rail, content),
  );
  page.hidden = false;
  document.body.classList.add('settings-open');

  // Open the tab named in the hash, else the first tab.
  const wantedHash = (window.location.hash || '').replace('#', '');
  const initial = tabDefs.some((t) => t[0] === wantedHash) ? wantedHash : 'account';
  showTab(initial);
}

// Close the settings page and return to the app.
function closeSettingsPage() {
  const page = $('#settingsPage');
  if (page) { page.hidden = true; page.innerHTML = ''; }
  document.body.classList.remove('settings-open');
  if (window.location.pathname === '/settings') {
    history.replaceState(null, '', '/');
  }
}

// Render the admin panel (users / listings / backup) into a settings panel.
function renderAdminInto(panel) {
  panel.innerHTML = '';
  const tabs = el('div', { class: 'tabs' });
  const content = el('div', { style: 'padding-top:16px' });
  const tabBranding = el('button', { class: 'tab tab--active' }, 'Branding');
  const tabUsers = el('button', { class: 'tab' }, 'Users');
  const tabSites = el('button', { class: 'tab' }, 'Listings');
  const tabBackup = el('button', { class: 'tab' }, 'Backup');
  tabs.append(tabBranding, tabUsers, tabSites, tabBackup);
  const all = [tabBranding, tabUsers, tabSites, tabBackup];
  function setActive(t) { all.forEach((x) => x.classList.toggle('tab--active', x === t)); }
  tabBranding.onclick = () => { setActive(tabBranding); renderBrandingTab(content); };
  tabUsers.onclick = () => { setActive(tabUsers); renderUsersTab(content); };
  tabSites.onclick = () => { setActive(tabSites); renderSitesTab(content); };
  tabBackup.onclick = () => { setActive(tabBackup); renderBackupTab(content); };
  panel.append(tabs, content);
  renderBrandingTab(content);
}

// Branding sub-tab: brand name, browser tab title, taglines, hero animation.
async function renderBrandingTab(content) {
  content.innerHTML = '';
  content.append(el('div', { class: 'placeholder' }, 'Loading…'));
  let s, anims;
  try {
    const d = await api('/admin/settings');
    s = d.settings; anims = d.heroAnimations || [];
  } catch (e) {
    content.innerHTML = ''; content.append(el('div', { class: 'placeholder' }, e.message)); return;
  }
  content.innerHTML = '';

  const nameInput = el('input', { type: 'text', value: s.appName, maxlength: '40' });
  const titleInput = el('input', { type: 'text', value: s.tabTitle, maxlength: '40' });
  const taglinesArea = el('textarea', { rows: '5', style: 'width:100%;resize:vertical' }, s.taglines.join('\n'));

  // Hero animation selector: "Random" plus each named animation.
  const animSelect = el('select', { style: 'width:100%' },
    el('option', { value: 'random', ...(s.heroAnimation === 'random' ? { selected: 'selected' } : {}) }, 'Random (cycle through all)'),
    ...anims.map((a) => el('option', { value: a, ...(s.heroAnimation === a ? { selected: 'selected' } : {}) }, a)),
  );
  // Visible preview target: a mini hero that plays the selected animation.
  const previewHero = el('h2', { class: 'hero__word brand-preview__word' });
  function playPreview() {
    const name = (nameInput.value.trim() || state.appName || 'ProtoEngine');
    let anim = animSelect.value;
    const list = (state.heroAnimations && state.heroAnimations.length) ? state.heroAnimations : ['rise'];
    if (anim === 'random') anim = list[Math.floor(Math.random() * list.length)];
    previewHero.className = 'hero__word brand-preview__word hero--anim-' + anim;
    previewHero.innerHTML = '';
    [...name].forEach((ch, i) => {
      const span = el('span', { style: `--i:${i}` });
      span.textContent = ch === ' ' ? '\u00A0' : ch;
      previewHero.append(span);
    });
  }
  const previewBtn = el('button', { type: 'button', class: 'btn btn--ghost btn--small' }, 'Replay');
  previewBtn.addEventListener('click', playPreview);
  animSelect.addEventListener('change', playPreview);
  nameInput.addEventListener('input', () => { /* keep preview text current */ });
  const previewBox = el('div', { class: 'brand-preview' }, previewHero);

  const msg = el('div', { class: 'formmsg' });
  const saveBtn = el('button', { type: 'button', class: 'btn btn--primary' }, 'Save branding');
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true; msg.textContent = '';
    const taglines = taglinesArea.value.split('\n').map((t) => t.trim()).filter(Boolean);
    try {
      const d = await api('/admin/settings', { method: 'PATCH', body: {
        appName: nameInput.value, tabTitle: titleInput.value, taglines, heroAnimation: animSelect.value,
      } });
      const ns = d.settings;
      state.appName = ns.appName;
      state.heroAnimation = ns.heroAnimation;
      buildHero();
      document.title = ns.tabTitle;
      msg.className = 'formmsg formmsg--ok';
      msg.textContent = 'Branding saved.';
    } catch (e) {
      msg.className = 'formmsg formmsg--error'; msg.textContent = e.message;
    } finally { saveBtn.disabled = false; }
  });

  content.append(
    el('div', { class: 'field' }, el('label', {}, 'Brand name'),
      el('div', { class: 'field__hint', style: 'margin-bottom:6px' }, 'Shown in the header and hero. Max 40 characters.'),
      nameInput),
    el('div', { class: 'field' }, el('label', {}, 'Browser tab title'),
      el('div', { class: 'field__hint', style: 'margin-bottom:6px' }, 'The page title shown in the browser tab.'),
      titleInput),
    el('div', { class: 'field' }, el('label', {}, 'Taglines'),
      el('div', { class: 'field__hint', style: 'margin-bottom:6px' }, 'One per line. A random tagline shows under the hero each load.'),
      taglinesArea),
    el('div', { class: 'field' }, el('label', {}, 'Hero animation'),
      el('div', { class: 'field__hint', style: 'margin-bottom:6px' }, 'Entrance animation for the brand hero. Tap Replay to preview.'),
      el('div', { style: 'display:flex;gap:8px;align-items:center' }, animSelect, previewBtn),
      previewBox),
    msg,
    saveBtn,
  );
  playPreview();
}

// Render the RSS feeds management tab.
async function renderRssTab(panel) {
  panel.innerHTML = '';
  panel.append(el('div', { class: 'placeholder', style: 'padding:24px' }, 'Loading feeds…'));

  let feeds = [];
  let groups = [];
  let refreshMinutes = state.rssRefreshMinutes || 5;
  try {
    const d = await api('/rss/feeds');
    feeds = d.feeds || [];
    groups = d.groups || [];
    if (Number.isFinite(d.refreshMinutes)) refreshMinutes = d.refreshMinutes;
  } catch (e) {
    panel.innerHTML = '';
    panel.append(el('div', { class: 'placeholder' }, e.message));
    return;
  }

  panel.innerHTML = '';

  // Small helper to build a collapsible section.
  function collapsible(title, startOpen, build) {
    const bodyWrap = el('div', { class: 'collapse__body' });
    const caret = el('span', { class: 'collapse__caret', html: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' });
    const head = el('button', { type: 'button', class: 'collapse__head' }, caret, el('span', {}, title));
    const section = el('div', { class: 'collapse' + (startOpen ? ' collapse--open' : '') }, head, bodyWrap);
    head.addEventListener('click', () => section.classList.toggle('collapse--open'));
    build(bodyWrap);
    return section;
  }

  // ---------- Feeds section ----------
  function buildFeeds(box) {
    const urlInput = el('input', { type: 'text', placeholder: 'https://example.com/feed.xml' });
    const addBtn = el('button', { class: 'btn btn--primary btn--small', type: 'button' }, 'Add');
    const addMsg = el('div', { class: 'formmsg' });
    const list = el('div', { class: 'rsslist' });

    async function addFeed() {
      const url = urlInput.value.trim();
      if (!url) return;
      addBtn.disabled = true; addBtn.textContent = 'Checking…'; addMsg.textContent = '';
      try {
        const d = await api('/rss/feeds', { method: 'POST', body: { url } });
        feeds.push(d.feed);
        urlInput.value = '';
        renderFeedList();
        renderGroupList();   // group membership pickers need the new feed
        toast('Feed added.');
      } catch (e) {
        addMsg.className = 'formmsg formmsg--error'; addMsg.textContent = e.message;
      } finally { addBtn.disabled = false; addBtn.textContent = 'Add'; }
    }
    addBtn.addEventListener('click', addFeed);
    urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addFeed(); });

    function renderFeedList() {
      list.innerHTML = '';
      if (!feeds.length) {
        list.append(el('div', { class: 'field__hint', style: 'padding:8px 0' }, 'No feeds yet. Add a feed URL above.'));
        return;
      }
      for (const feed of feeds) {
        const enabled = el('input', { type: 'checkbox', ...(feed.enabled ? { checked: 'checked' } : {}) });
        enabled.addEventListener('change', async () => {
          try { await api('/rss/feeds/' + feed.id, { method: 'PATCH', body: { enabled: enabled.checked } }); feed.enabled = enabled.checked; }
          catch (e) { toast(e.message, true); enabled.checked = feed.enabled; }
        });
        const del = el('button', { class: 'minibtn minibtn--danger', type: 'button' }, 'Remove');
        del.addEventListener('click', async () => {
          if (!confirm('Remove this feed?')) return;
          try {
            await api('/rss/feeds/' + feed.id, { method: 'DELETE' });
            feeds = feeds.filter((f) => f.id !== feed.id);
            groups.forEach((g) => { g.feedIds = (g.feedIds || []).filter((id) => id !== feed.id); });
            renderFeedList(); renderGroupList();
          } catch (e) { toast(e.message, true); }
        });
        list.append(
          el('div', { class: 'rssitem' },
            el('div', { class: 'rssitem__head' },
              el('div', { class: 'rssitem__title' }, feed.title || feed.url),
              del),
            el('div', { class: 'rssitem__url' }, feed.url),
            el('div', { class: 'rssitem__toggles' },
              el('label', { class: 'rsstoggle' }, enabled, el('span', {}, 'Enabled'))),
          )
        );
      }
    }
    renderFeedList();
    box.append(
      el('div', { class: 'field__hint', style: 'margin-bottom:10px' },
        'Add feed URLs. Use groups below to organize which feeds show together.'),
      el('div', { class: 'rssadd' }, urlInput, addBtn),
      addMsg,
      list,
    );
    // Expose for cross-updates from the groups section.
    renderRssTab._renderFeedList = renderFeedList;
  }

  // ---------- Groups section ----------
  const groupListEl = el('div', { class: 'rsslist' });
  function renderGroupList() {
    groupListEl.innerHTML = '';
    if (!groups.length) {
      groupListEl.append(el('div', { class: 'field__hint', style: 'padding:8px 0' }, 'No groups yet. Create one above, then add feeds to it.'));
      return;
    }
    for (const group of groups) {
      const del = el('button', { class: 'minibtn minibtn--danger', type: 'button' }, 'Delete');
      del.addEventListener('click', async () => {
        if (!confirm(`Delete group "${group.name}"? (Feeds themselves are kept.)`)) return;
        try {
          await api('/rss/groups/' + group.id, { method: 'DELETE' });
          groups = groups.filter((g) => g.id !== group.id);
          renderGroupList();
        } catch (e) { toast(e.message, true); }
      });

      group.feedIds = group.feedIds || [];

      // Helper to flip membership and re-render this list.
      async function setMember(feedId, member) {
        try {
          await api('/rss/groups/' + group.id + '/feeds', { method: 'PATCH', body: { feedId, member } });
          if (member) { if (!group.feedIds.includes(feedId)) group.feedIds.push(feedId); }
          else group.feedIds = group.feedIds.filter((id) => id !== feedId);
          renderGroupList();
        } catch (e) { toast(e.message, true); }
      }

      // Member feeds shown as removable chips.
      const chips = el('div', { class: 'rssgroup__chips' });
      const memberFeeds = feeds.filter((f) => group.feedIds.includes(f.id));
      if (!memberFeeds.length) {
        chips.append(el('span', { class: 'field__hint', style: 'margin:0' }, 'No feeds in this group yet.'));
      } else {
        for (const feed of memberFeeds) {
          const x = el('button', { class: 'rsschip__x', type: 'button', title: 'Remove from group', 'aria-label': 'Remove from group' }, '×');
          x.addEventListener('click', () => setMember(feed.id, false));
          chips.append(el('span', { class: 'rsschip' }, el('span', { class: 'rsschip__label' }, feed.title || feed.url), x));
        }
      }

      // "Add feed" dropdown listing feeds not already in the group.
      const available = feeds.filter((f) => !group.feedIds.includes(f.id));
      let adder;
      if (!feeds.length) {
        adder = el('div', { class: 'field__hint', style: 'margin-top:8px' }, 'Add feeds in the RSS Feeds section first, then assign them here.');
      } else if (!available.length) {
        adder = el('div', { class: 'field__hint', style: 'margin-top:8px' }, 'All your feeds are already in this group.');
      } else {
        const sel = el('select', { class: 'rssgroup__add' },
          el('option', { value: '' }, '+ Add a feed to this group…'),
          ...available.map((f) => el('option', { value: f.id }, f.title || f.url)),
        );
        sel.addEventListener('change', () => { if (sel.value) setMember(sel.value, true); });
        adder = sel;
      }

      groupListEl.append(
        el('div', { class: 'rssitem' },
          el('div', { class: 'rssitem__head' },
            el('div', { class: 'rssitem__title' }, group.name),
            del),
          el('div', { class: 'field__hint', style: 'margin:6px 0 4px' }, 'Feeds in this group:'),
          chips,
          adder,
        )
      );
    }
  }

  function buildGroups(box) {
    const nameInput = el('input', { type: 'text', placeholder: 'Group name (e.g. News, Dev, FFXIV)' });
    const addBtn = el('button', { class: 'btn btn--primary btn--small', type: 'button' }, 'Create');
    const addMsg = el('div', { class: 'formmsg' });
    async function addGroup() {
      const name = nameInput.value.trim();
      if (!name) return;
      addBtn.disabled = true; addMsg.textContent = '';
      try {
        const d = await api('/rss/groups', { method: 'POST', body: { name } });
        groups.push(d.group);
        nameInput.value = '';
        renderGroupList();
        toast('Group created.');
      } catch (e) { addMsg.className = 'formmsg formmsg--error'; addMsg.textContent = e.message; }
      finally { addBtn.disabled = false; }
    }
    addBtn.addEventListener('click', addGroup);
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addGroup(); });
    renderGroupList();
    box.append(
      el('div', { class: 'field__hint', style: 'margin-bottom:10px' },
        'Create groups and assign feeds to them. A feed can be in any number of groups. Switch groups from the dropdown on the feed panel.'),
      el('div', { class: 'rssadd' }, nameInput, addBtn),
      addMsg,
      groupListEl,
    );
  }

  // ---------- Refresh interval ----------
  const refreshInput = el('input', { type: 'number', min: '1', max: '1440', value: String(refreshMinutes), style: 'width:90px;flex:none' });
  const refreshSave = el('button', { class: 'btn btn--ghost btn--small', type: 'button' }, 'Save');
  refreshSave.addEventListener('click', async () => {
    const m = parseInt(refreshInput.value, 10);
    if (!Number.isInteger(m) || m < 1) { toast('Refresh must be at least 1 minute.', true); return; }
    try {
      const d = await api('/rss/settings', { method: 'PATCH', body: { refreshMinutes: m } });
      state.rssRefreshMinutes = d.refreshMinutes;
      refreshInput.value = String(d.refreshMinutes);
      armRssRefresh();
      toast('Refresh interval saved.');
    } catch (e) { toast(e.message, true); }
  });

  panel.append(
    el('div', { class: 'account__sectionlabel' }, 'RSS'),
    collapsible('RSS Feeds', true, buildFeeds),
    collapsible('RSS Groups', false, buildGroups),
    el('hr', { class: 'account__rule' }),
    el('div', { class: 'account__sectionlabel' }, 'Refresh interval'),
    el('div', { class: 'field__hint', style: 'margin-bottom:8px' }, 'How often the feed panel updates, in minutes (default 5).'),
    el('div', { style: 'display:flex;gap:8px;align-items:center' },
      refreshInput, el('span', { class: 'field__hint', style: 'margin:0' }, 'minutes'), refreshSave),
  );
}

// ---------- admin panel ----------
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
      closeModal();
      renderUsersTab(content);
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
    const name = m ? m[1] : `protoengine-snapshot-${new Date().toISOString().slice(0, 10)}.zip`;
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
    const n = d.siteCount;
    toast(`Imported ${n} listing${n === 1 ? '' : 's'}.`);
    // In-place success feedback: clear the chosen file, reset the button to a
    // confirmation state, and refresh the data behind the settings page.
    fileInput.value = '';
    btn.textContent = `Imported ${n} listing${n === 1 ? '' : 's'} ✓`;
    btn.disabled = true; // nothing selected now, so keep it disabled
    setTimeout(() => { btn.textContent = original; }, 4000);
    loadSites();
    loadRssSettings();
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
  applyBackground();
}

// Apply the current user's background image (or clear it). Adds a body class
// so the glass effect on results only kicks in when a background is present.
function applyBackground() {
  const layer = $('#bgLayer');
  const bg = state.user && state.user.background;
  if (bg) {
    layer.style.backgroundImage = `url("${bg}")`;
    document.body.classList.add('has-bg');
  } else {
    layer.style.backgroundImage = '';
    document.body.classList.remove('has-bg');
  }
}

// (Re)start the periodic RSS refresh using the user's configured interval.
let rssRefreshTimer = null;
function armRssRefresh() {
  if (rssRefreshTimer) clearInterval(rssRefreshTimer);
  if (!state.user) return;
  const mins = Number.isFinite(state.rssRefreshMinutes) ? state.rssRefreshMinutes : 5;
  rssRefreshTimer = setInterval(() => { loadRssPanel(); }, Math.max(1, mins) * 60 * 1000);
}

// Fetch the user's RSS settings (refresh interval) once after login/load.
async function loadRssSettings() {
  if (!state.user) { armRssRefresh(); return; }
  try {
    const d = await api('/rss/feeds');
    if (Number.isFinite(d.refreshMinutes)) state.rssRefreshMinutes = d.refreshMinutes;
    state.rssGroups = d.groups || [];
    state.rssHasFeeds = (d.feeds || []).length > 0;
    state.rssActiveGroup = typeof d.activeGroup === 'string' ? d.activeGroup : '';
  } catch { /* keep default */ }
  armRssRefresh();
}

// Load and render the RSS side panel for the current view (main vs search).
// Only shown when signed in and the user has feeds flagged for this context.
// Live "refreshed N ago" label that ticks up: seconds, then minutes, hours.
let rssAgoTimer = null;
function formatAgo(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}
function armRssAgoTicker() {
  if (rssAgoTimer) clearInterval(rssAgoTimer);
  const tick = () => {
    const el2 = $('#rssAgo');
    if (!el2 || !state.rssLastRefresh) return;
    el2.textContent = formatAgo(Date.now() - state.rssLastRefresh);
  };
  tick();
  rssAgoTimer = setInterval(tick, 1000);
}

function activeGroupName() {
  const id = state.rssActiveGroup || '';
  if (!id) return 'All Feeds';
  const g = (state.rssGroups || []).find((x) => x.id === id);
  return g ? g.name : 'All Feeds';
}

// Build the clickable group-selector header. Clicking the name opens a menu of
// "All Feeds" + every group; choosing one switches the active group, persists
// it per account, and reloads entries.
function buildRssHeader() {
  const head = el('div', { class: 'rsspanel__head' });

  const caret = el('span', { class: 'rsspanel__caret', html: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' });
  const nameBtn = el('button', { class: 'rsspanel__group', type: 'button', title: 'Switch group' },
    el('span', { class: 'rsspanel__groupname' }, activeGroupName()), caret);

  const menu = el('div', { class: 'rsspanel__menu', hidden: true });
  function buildMenu() {
    menu.innerHTML = '';
    const opts = [{ id: '', name: 'All Feeds' }, ...(state.rssGroups || [])];
    for (const o of opts) {
      const active = (state.rssActiveGroup || '') === o.id;
      const item = el('button', { class: 'rsspanel__menuitem' + (active ? ' rsspanel__menuitem--active' : ''), type: 'button' }, o.name);
      item.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        menu.hidden = true;
        if ((state.rssActiveGroup || '') === o.id) return;
        state.rssActiveGroup = o.id;
        try { await api('/rss/settings', { method: 'PATCH', body: { activeGroup: o.id } }); }
        catch (e) { toast(e.message, true); }
        loadRssPanel();
      });
      menu.append(item);
    }
  }
  nameBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (menu.hidden) { buildMenu(); menu.hidden = false; }
    else menu.hidden = true;
  });
  // Close the menu on any outside click.
  document.addEventListener('click', () => { menu.hidden = true; });

  const left = el('div', { class: 'rsspanel__headleft' },
    el('div', { class: 'rsspanel__groupwrap' }, nameBtn, menu),
    el('span', { class: 'rsspanel__ago', id: 'rssAgo' }, 'just now'),
  );
  const refreshBtn = el('button', {
    class: 'rsspanel__refresh',
    'aria-label': 'Refresh feeds',
    title: 'Refresh feeds',
    html: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M4.5 12a7.5 7.5 0 0 1 12.8-5.3M19.5 12a7.5 7.5 0 0 1-12.8 5.3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M17 3v4h-4M7 21v-4h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  });
  refreshBtn.addEventListener('click', (ev) => { ev.stopPropagation(); loadRssPanel(); });
  head.append(left, refreshBtn);
  return head;
}

async function loadRssPanel() {
  const panel = $('#rssPanel');
  if (!panel) return;
  if (!state.user) { panel.hidden = true; panel.innerHTML = ''; document.body.classList.remove('has-rss'); return; }

  const groupId = state.rssActiveGroup || '';
  let entries = [];
  try {
    const d = await api('/rss/entries?group=' + encodeURIComponent(groupId));
    entries = d.entries || [];
  } catch {
    panel.hidden = true; panel.innerHTML = '';
    document.body.classList.remove('has-rss');
    return;
  }

  // Hide the panel entirely only when the user has no feeds at all. If they
  // have feeds but the active group is empty, keep the panel (and its group
  // dropdown) visible with an empty-state message so they can switch back.
  if (!entries.length && !state.rssHasFeeds) {
    panel.hidden = true; panel.innerHTML = '';
    document.body.classList.remove('has-rss');
    return;
  }

  panel.innerHTML = '';
  state.rssLastRefresh = Date.now();
  panel.append(buildRssHeader());
  armRssAgoTicker();

  if (!entries.length) {
    panel.append(el('div', { class: 'field__hint', style: 'padding:14px 4px' },
      'No entries in this group yet. Pick another group above, or add feeds to it in Settings → RSS.'));
  }

  for (const e of entries) {
    const fhead = el('div', { class: 'rsscard__feedrow' });
    if (e.favicon) {
      const fav = el('img', { class: 'rsscard__fav', src: e.favicon, alt: '', loading: 'lazy' });
      fav.addEventListener('error', () => fav.remove());
      fhead.append(fav);
    }
    fhead.append(el('span', { class: 'rsscard__feed' }, e.feedTitle || ''));

    const card = el('a', {
      class: 'rsscard',
      href: e.link || '#',
      target: '_blank',
      rel: 'noopener noreferrer',
    },
      fhead,
      el('div', { class: 'rsscard__title' }, e.title || '(no title)'),
      e.summary ? el('div', { class: 'rsscard__summary' }, e.summary) : null,
      e.date ? el('div', { class: 'rsscard__date' }, formatRssDate(e.date)) : null,
    );
    panel.append(card);
  }
  panel.hidden = false;
  document.body.classList.add('has-rss');
}

function formatRssDate(d) {
  const t = Date.parse(d);
  if (!t) return '';
  try {
    return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch { return ''; }
}

// ---------- wire up ----------
// Lock page scrolling while a mobile drawer (RSS or favorites) is open, so
// touch-scrolling stays inside the drawer instead of moving the page behind it.
function syncDrawerScrollLock() {
  const open = $('#rssPanel').classList.contains('rsspanel--open') ||
               $('#favPanel').classList.contains('favpanel--open');
  document.body.classList.toggle('drawer-open', open);
}

function init() {
  const input = $('#searchInput');

  // Run a committed search (Enter, search button, or chosen suggestion).
  function runSearch() {
    clearTimeout(suggestTimer);
    hideSuggest();
    state.query = input.value.trim();
    state.page = 1;
    applyStateToUrl(true); // committed search -> history entry
    loadSites();
    input.blur();
  }

  // As you type: fetch suggestions, don't search. Search waits for Enter,
  // the search button, or picking a suggestion.
  input.addEventListener('input', () => {
    $('#clearBtn').hidden = !input.value;
    clearTimeout(suggestTimer);
    const q = input.value.trim();
    if (!q) { hideSuggest(); return; }
    suggestTimer = setTimeout(() => fetchSuggestions(q), 140);
  });

  // Keyboard navigation within the suggestion list.
  input.addEventListener('keydown', (e) => {
    const items = suggestState.items;
    if (e.key === 'ArrowDown' && items.length) {
      e.preventDefault();
      suggestState.active = (suggestState.active + 1) % items.length;
      paintSuggestActive();
    } else if (e.key === 'ArrowUp' && items.length) {
      e.preventDefault();
      suggestState.active = (suggestState.active - 1 + items.length) % items.length;
      paintSuggestActive();
    } else if (e.key === 'Enter') {
      // If a suggestion is highlighted, choose it; otherwise search the text.
      if (suggestState.active >= 0 && items[suggestState.active]) {
        e.preventDefault();
        chooseSuggestion(items[suggestState.active]);
      }
      // else: let the form submit handler run the search.
    } else if (e.key === 'Escape') {
      hideSuggest();
    }
  });

  $('#searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    runSearch();
  });
  // Hide suggestions when focus leaves the search area.
  input.addEventListener('blur', () => { setTimeout(hideSuggest, 120); });

  $('#clearBtn').addEventListener('click', () => {
    input.value = ''; state.query = ''; state.page = 1;
    $('#clearBtn').hidden = true; hideSuggest(); input.focus();
    applyStateToUrl(true);
    loadSites();
  });

  $('#addBtn').addEventListener('click', () => openSiteModal());
  $('#filterBtn').addEventListener('click', openFilterModal);
  $('#signinBtn').addEventListener('click', () => openAuthModal('login'));
  // RSS drawer toggle (small screens).
  $('#rssToggleBtn').addEventListener('click', () => {
    const panel = $('#rssPanel');
    // Set the banner height as a CSS var; only the mobile drawer rule uses it,
    // so the desktop docked panel keeps its own top from the stylesheet.
    const topbar = $('#topbar');
    if (topbar) panel.style.setProperty('--banner-h', topbar.getBoundingClientRect().height + 'px');
    const willOpen = !panel.classList.contains('rsspanel--open');
    $('#favPanel').classList.remove('favpanel--open'); // close the other drawer
    panel.classList.toggle('rsspanel--open', willOpen);
    syncDrawerScrollLock();
  });
  // Favorites drawer toggle (small screens).
  $('#favToggleBtn').addEventListener('click', () => {
    const panel = $('#favPanel');
    const topbar = $('#topbar');
    if (topbar) panel.style.setProperty('--banner-h', topbar.getBoundingClientRect().height + 'px');
    const willOpen = !panel.classList.contains('favpanel--open');
    $('#rssPanel').classList.remove('rsspanel--open'); // close the other drawer
    panel.classList.toggle('favpanel--open', willOpen);
    syncDrawerScrollLock();
  });
  // Close result 3-dot menus when clicking elsewhere.
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.result__menu')) closeAllResultMenus();
  });

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
  $('#accountBtn').addEventListener('click', () => { dd.hidden = true; openSettingsPage(); });
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
  // Apply the chosen hero animation (random picks one per page load).
  const all = state.heroAnimations && state.heroAnimations.length
    ? state.heroAnimations
    : ['rise'];
  let anim = state.heroAnimation;
  if (!anim || anim === 'random') anim = all[Math.floor(Math.random() * all.length)];
  h.className = 'hero__word hero--anim-' + anim;
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
    state.heroAnimation = cfg.heroAnimation || 'random';
    state.heroAnimations = Array.isArray(cfg.heroAnimations) ? cfg.heroAnimations : [];
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
  loadRssSettings();    // fetch refresh interval and arm the auto-refresh
  // If loaded directly at /settings, open the settings page (requires login).
  if (window.location.pathname === '/settings') {
    if (state.user) openSettingsPage();
    else history.replaceState(null, '', '/');
  }
}

init();
