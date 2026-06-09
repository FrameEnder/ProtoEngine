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
const CACHE_MS = 5 * 60 * 1000; // 5 minutes

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
function clean(html, max = 280) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// Normalize a parsed RSS 2.0 or Atom document into a common shape.
function normalizeFeed(xmlObj) {
  // RSS 2.0
  if (xmlObj.rss && xmlObj.rss.channel) {
    const ch = xmlObj.rss.channel;
    const title = textOf(ch.title) || 'Untitled feed';
    const items = asArray(ch.item).map((it) => ({
      title: textOf(it.title) || '(no title)',
      link: textOf(it.link),
      date: textOf(it.pubDate) || textOf(it['dc:date']) || '',
      summary: clean(textOf(it.description) || textOf(it['content:encoded'])),
    }));
    return { title, items };
  }
  // Atom
  if (xmlObj.feed) {
    const f = xmlObj.feed;
    const title = textOf(f.title) || 'Untitled feed';
    const items = asArray(f.entry).map((e) => {
      // Atom links can be an array of {@_href,@_rel}; prefer rel="alternate".
      let link = '';
      const links = asArray(e.link);
      const alt = links.find((l) => l['@_rel'] === 'alternate') || links[0];
      if (alt) link = alt['@_href'] || '';
      return {
        title: textOf(e.title) || '(no title)',
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

// List the current user's configured feeds.
router.get('/feeds', requireAuth, async (req, res) => {
  const u = await db.getUserById(req.user.id);
  if (!u) return res.status(404).json({ error: 'Account not found.' });
  res.json({ feeds: u.rssFeeds || [] });
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
      for (const item of data.items.slice(0, 12)) {
        out.push({
          feedId: f.id,
          feedTitle: data.title || f.title || '',
          title: item.title,
          link: item.link,
          summary: item.summary,
          date: item.date,
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

export default router;
