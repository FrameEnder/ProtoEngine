import express from 'express';
import { XMLParser } from 'fast-xml-parser';
import { db } from '../data-store.js';
import { requireAuth } from '../middleware/auth.js';
import { uid, normalizeUrl, clampStr } from '../util.js';

const router = express.Router();

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
});

// In-memory cache of fetched feeds: url -> { at, entries }. Keeps the right
// panel snappy and avoids hammering source servers.
const feedCache = new Map();
const CACHE_MS = 60 * 1000; // 60s fetch cache (dedupes rapid refreshes)

function asArray(x) {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

// Pull a plain string out of a value that might be a string or an object
// like { '#text': '...' } or an Atom link object.
function textOf(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    if (typeof v['#text'] === 'string') return v['#text'];
  }
  return '';
}

// Strip HTML tags and collapse whitespace for a clean snippet.
// Common named HTML entities mapped to their characters. Numeric references
// (&#8217; and &#x2019;) are handled generically below, so this table only
// needs the named ones that feeds commonly use.
const NAMED_ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  ndash: '\u2013', mdash: '\u2014',
  lsquo: '\u2018', rsquo: '\u2019', sbquo: '\u201A',
  ldquo: '\u201C', rdquo: '\u201D', bdquo: '\u201E',
  hellip: '\u2026', middot: '\u00B7', bull: '\u2022',
  copy: '\u00A9', reg: '\u00AE', trade: '\u2122',
  deg: '\u00B0', plusmn: '\u00B1', times: '\u00D7', divide: '\u00F7',
  frac12: '\u00BD', frac14: '\u00BC', frac34: '\u00BE',
  laquo: '\u00AB', raquo: '\u00BB',
  euro: '\u20AC', pound: '\u00A3', cent: '\u00A2', yen: '\u00A5',
  sect: '\u00A7', para: '\u00B6', dagger: '\u2020', Dagger: '\u2021',
  prime: '\u2032', Prime: '\u2033',
  larr: '\u2190', rarr: '\u2192', uarr: '\u2191', darr: '\u2193', harr: '\u2194',
  eacute: '\u00E9', egrave: '\u00E8', agrave: '\u00E0', ccedil: '\u00E7',
  uuml: '\u00FC', ouml: '\u00F6', auml: '\u00E4', ntilde: '\u00F1',
};

// Decode HTML entities: named (&rsquo;), decimal (&#8217;), and hex (&#x2019;).
function decodeEntities(str) {
  return String(str).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      // Numeric reference: decimal (#123) or hex (#x1F).
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10FFFF) {
        try { return String.fromCodePoint(code); } catch { return match; }
      }
      return match;
    }
    // Named reference.
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)
      ? NAMED_ENTITIES[body]
      : match;
  });
}

// Strip HTML tags and decode entities for a clean snippet. Decodes twice to
// handle feeds that double-encode (e.g. "&amp;rsquo;").
function clean(html, max = 280) {
  let out = String(html || '').replace(/<[^>]*>/g, ' ');
  out = decodeEntities(out);
  // A second pass resolves double-encoded entities; harmless if there were
  // none (no remaining &…; sequences to decode).
  if (out.includes('&')) out = decodeEntities(out);
  return out.replace(/\s+/g, ' ').trim().slice(0, max);
}

// Clean a title: strip any tags, decode entities (twice for double-encoding),
// collapse whitespace. Kept longer than summaries.
function cleanTitle(s) {
  let out = String(s || '').replace(/<[^>]*>/g, ' ');
  out = decodeEntities(out);
  if (out.includes('&')) out = decodeEntities(out);
  return out.replace(/\s+/g, ' ').trim().slice(0, 300);
}

// Normalize a parsed RSS 2.0 or Atom document into a common shape.
function normalizeFeed(xmlObj) {
  // RSS 2.0
  if (xmlObj.rss && xmlObj.rss.channel) {
    const ch = xmlObj.rss.channel;
    const title = cleanTitle(textOf(ch.title)) || 'Untitled feed';
    const items = asArray(ch.item).map((it) => ({
      title: cleanTitle(textOf(it.title)) || '(no title)',
      link: textOf(it.link),
      date: textOf(it.pubDate) || textOf(it['dc:date']) || '',
      summary: clean(textOf(it.description) || textOf(it['content:encoded'])),
    }));
    return { title, items };
  }
  // Atom
  if (xmlObj.feed) {
    const f = xmlObj.feed;
    const title = cleanTitle(textOf(f.title)) || 'Untitled feed';
    const items = asArray(f.entry).map((e) => {
      // Atom links can be an array of {@_href,@_rel}; prefer rel="alternate".
      let link = '';
      const links = asArray(e.link);
      const alt = links.find((l) => l['@_rel'] === 'alternate') || links[0];
      if (alt) link = alt['@_href'] || '';
      return {
        title: cleanTitle(textOf(e.title)) || '(no title)',
        link,
        date: textOf(e.updated) || textOf(e.published) || '',
        summary: clean(textOf(e.summary) || textOf(e.content)),
      };
    });
    return { title, items };
  }
  return { title: 'Unknown feed', items: [] };
}

async function fetchFeed(url) {
  const cached = feedCache.get(url);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.data;

  // Basic SSRF guard: refuse obvious internal/loopback/link-local targets so
  // a feed URL can't be used to probe the host's private network.
  try {
    const h = new URL(url).hostname.toLowerCase();
    const blocked =
      h === 'localhost' || h === '0.0.0.0' || h.endsWith('.local') ||
      /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) ||
      /^169\.254\./.test(h) || /^::1$/.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h);
    if (blocked) throw new Error('blocked host');
  } catch (e) {
    throw new Error('Feed host not allowed.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Lumen-RSS/1.0', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const xml = parser.parse(text);
    const data = normalizeFeed(xml);
    feedCache.set(url, { at: Date.now(), data });
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

// ---- Feed management (per user) ----

// List the current user's configured feeds plus the refresh interval.
router.get('/feeds', requireAuth, async (req, res) => {
  const u = await db.getUserById(req.user.id);
  if (!u) return res.status(404).json({ error: 'Account not found.' });
  res.json({
    feeds: u.rssFeeds || [],
    refreshMinutes: Number.isFinite(u.rssRefreshMinutes) ? u.rssRefreshMinutes : 5,
  });
});

// Update RSS settings (currently just the refresh interval, in minutes).
router.patch('/settings', requireAuth, async (req, res) => {
  const u = await db.getUserById(req.user.id);
  if (!u) return res.status(404).json({ error: 'Account not found.' });
  let m = parseInt((req.body && req.body.refreshMinutes), 10);
  if (!Number.isInteger(m) || m < 1) return res.status(400).json({ error: 'Refresh must be at least 1 minute.' });
  if (m > 1440) m = 1440; // cap at 24h
  await db.updateUser(u.id, { rssRefreshMinutes: m });
  res.json({ refreshMinutes: m });
});

// Add a feed.
router.post('/feeds', requireAuth, async (req, res) => {
  const u = await db.getUserById(req.user.id);
  if (!u) return res.status(404).json({ error: 'Account not found.' });
  const url = normalizeUrl((req.body && req.body.url) || '');
  if (!url) return res.status(400).json({ error: 'Enter a valid feed URL.' });

  const feeds = u.rssFeeds || [];
  if (feeds.length >= 30) return res.status(400).json({ error: 'Feed limit reached (30).' });
  if (feeds.some((f) => f.url === url)) return res.status(409).json({ error: 'That feed is already added.' });

  // Validate by fetching it once; store the discovered title.
  let title = '';
  try {
    const data = await fetchFeed(url);
    title = data.title || '';
    if (!data.items) throw new Error();
  } catch {
    return res.status(400).json({ error: 'Could not read that as an RSS or Atom feed.' });
  }

  const feed = { id: uid(), url, title, enabled: true, onMain: true, onSearch: false };
  feeds.push(feed);
  await db.updateUser(u.id, { rssFeeds: feeds });
  res.json({ feed });
});

// Update a feed's toggles.
router.patch('/feeds/:id', requireAuth, async (req, res) => {
  const u = await db.getUserById(req.user.id);
  if (!u) return res.status(404).json({ error: 'Account not found.' });
  const feeds = u.rssFeeds || [];
  const f = feeds.find((x) => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: 'Feed not found.' });

  const b = req.body || {};
  if (typeof b.enabled === 'boolean') f.enabled = b.enabled;
  if (typeof b.onMain === 'boolean') f.onMain = b.onMain;
  if (typeof b.onSearch === 'boolean') f.onSearch = b.onSearch;
  await db.updateUser(u.id, { rssFeeds: feeds });
  res.json({ feed: f });
});

// Delete a feed.
router.delete('/feeds/:id', requireAuth, async (req, res) => {
  const u = await db.getUserById(req.user.id);
  if (!u) return res.status(404).json({ error: 'Account not found.' });
  const feeds = (u.rssFeeds || []).filter((x) => x.id !== req.params.id);
  await db.updateUser(u.id, { rssFeeds: feeds });
  res.json({ ok: true });
});

// ---- Aggregated entries for display ----
// Returns merged, date-sorted entries from the user's enabled feeds that are
// flagged for the requested context (?context=main|search).
router.get('/entries', requireAuth, async (req, res) => {
  const u = await db.getUserById(req.user.id);
  if (!u) return res.status(404).json({ error: 'Account not found.' });
  const context = clampStr(req.query.context, 10);
  const feeds = (u.rssFeeds || []).filter((f) => {
    if (!f.enabled) return false;
    if (context === 'main') return f.onMain;
    if (context === 'search') return f.onSearch;
    return f.onMain || f.onSearch;
  });

  const out = [];
  await Promise.all(feeds.map(async (f) => {
    try {
      const data = await fetchFeed(f.url);
      // Favicon derived from the feed's own URL origin as a fallback, and
      // per-entry from each item's link domain when available.
      for (const item of data.items.slice(0, 12)) {
        out.push({
          feedId: f.id,
          feedTitle: data.title || f.title || '',
          title: item.title,
          link: item.link,
          summary: item.summary,
          date: item.date,
          favicon: faviconFor(item.link || f.url),
          ts: item.date ? Date.parse(item.date) || 0 : 0,
        });
      }
    } catch {
      /* skip unreachable feeds silently */
    }
  }));

  out.sort((a, b) => b.ts - a.ts);
  res.json({ entries: out.slice(0, 60) });
});

// Build a favicon URL for a page link: its origin + /favicon.ico. The browser
// loads this directly in an <img>, so no server-side fetch is needed.
function faviconFor(link) {
  try {
    const u = new URL(link);
    return `${u.origin}/favicon.ico`;
  } catch {
    return null;
  }
}

export default router;
