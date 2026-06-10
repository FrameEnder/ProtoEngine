import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { db } from '../data-store.js';
import { requireAuth, requireRole, RANK } from '../middleware/auth.js';
import { uid, clampStr, normalizeUrl, parseTags } from '../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICON_DIR = path.join(__dirname, '..', 'public', 'icons');
if (!fs.existsSync(ICON_DIR)) fs.mkdirSync(ICON_DIR, { recursive: true });

const router = express.Router();

const ALLOWED_ICON_TYPES = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 512 * 1024 }, // 512 KB
  fileFilter: (req, file, cb) => {
    if (ALLOWED_ICON_TYPES[file.mimetype]) cb(null, true);
    else cb(new Error('Icon must be PNG, JPG, GIF, WEBP, SVG, or ICO.'));
  },
}).single('icon');

// Wrap multer so its errors return clean JSON.
function handleIcon(req, res, next) {
  upload(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}

function saveIcon(file) {
  if (!file) return null;
  const ext = ALLOWED_ICON_TYPES[file.mimetype];
  const name = uid() + ext;
  fs.writeFileSync(path.join(ICON_DIR, name), file.buffer);
  return '/icons/' + name;
}

function removeIcon(iconPath) {
  if (!iconPath || !iconPath.startsWith('/icons/')) return;
  const full = path.join(ICON_DIR, path.basename(iconPath));
  fs.promises.unlink(full).catch(() => {});
}

// Can the current user edit/delete this site?
function canManageSite(user, site) {
  if (!user) return false;
  if (RANK[user.role] >= RANK.moderator) return true; // moderators + admins
  return site.ownerId === user.id; // users manage their own
}

// List + search all sites. Public.
router.get('/', async (req, res) => {
  const sites = await db.getSites();
  const q = clampStr(req.query.q, 200).toLowerCase();
  // `tag` may be a single value or a comma-separated list; all must match.
  const tagParam = clampStr(req.query.tag, 300).toLowerCase();
  const wantTags = tagParam ? tagParam.split(',').map((t) => t.trim()).filter(Boolean) : [];
  const sort = clampStr(req.query.sort, 20) || 'newest';
  const hasIcon = req.query.hasIcon; // 'true' | 'false' | undefined

  let results = sites;
  if (wantTags.length) {
    results = results.filter((s) => {
      const tags = s.tags || [];
      return wantTags.every((t) => tags.includes(t));
    });
  }
  if (hasIcon === 'true') results = results.filter((s) => !!s.icon);
  else if (hasIcon === 'false') results = results.filter((s) => !s.icon);
  if (q) {
    const terms = q.split(/\s+/).filter(Boolean);
    results = results.filter((s) => {
      const hay = [s.name, s.url, s.description, ...(s.tags || [])].join(' ').toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }

  // Sorting options.
  const byCreated = (a, b) => (a.createdAt || '').localeCompare(b.createdAt || '');
  const byName = (a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
  results = [...results];
  switch (sort) {
    case 'oldest': results.sort(byCreated); break;
    case 'name': results.sort(byName); break;
    case 'name_desc': results.sort((a, b) => byName(b, a)); break;
    case 'newest':
    default: results.sort((a, b) => byCreated(b, a)); break;
  }

  // Pagination: 10 per page. `page` is 1-indexed; clamp to valid range.
  // `all=true` bypasses paging (used by the admin Listings tab).
  const PER_PAGE = 10;
  const matched = results.length;
  const returnAll = req.query.all === 'true';
  const pageCount = Math.max(1, Math.ceil(matched / PER_PAGE));
  let page = parseInt(req.query.page, 10);
  if (!Number.isInteger(page) || page < 1) page = 1;
  if (page > pageCount) page = pageCount;
  const start = (page - 1) * PER_PAGE;
  const pageItems = returnAll ? results : results.slice(start, start + PER_PAGE);

  res.json({
    sites: pageItems,
    matched,
    total: sites.length,
    page: returnAll ? 1 : page,
    pageCount: returnAll ? 1 : pageCount,
    perPage: PER_PAGE,
  });
});

// Return all distinct tags with usage counts, most-used first. Public.
// Powers the filter popup and the tag picker when adding listings.
router.get('/tags', async (req, res) => {
  const sites = await db.getSites();
  const counts = new Map();
  for (const s of sites) {
    for (const t of s.tags || []) {
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  const tags = [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  res.json({ tags });
});

// Autocomplete suggestions for the search box. Returns up to 5 suggestions
// drawn from listing names, tags, and notable words, ranked by relevance to
// the typed prefix. Public (search is open to everyone).
router.get('/suggest', async (req, res) => {
  const q = clampStr(req.query.q, 100).toLowerCase().trim();
  if (!q) return res.json({ suggestions: [] });
  const sites = await db.getSites();

  // Score candidates: a name/tag that starts with the query ranks above one
  // that merely contains it. De-duplicate case-insensitively.
  const seen = new Set();
  const scored = [];
  function consider(text, type, weight) {
    if (!text) return;
    const low = text.toLowerCase();
    const idx = low.indexOf(q);
    if (idx === -1) return;
    const key = type + ':' + low;
    if (seen.has(key)) return;
    seen.add(key);
    // Lower score = better. Prefix match (idx 0) beats mid-string; shorter
    // text beats longer; names rank above tags by the weight.
    const score = (idx === 0 ? 0 : 100) + idx + text.length * 0.1 + weight;
    scored.push({ value: text, type, score });
  }

  for (const s of sites) {
    consider(s.name, 'name', 0);
    for (const t of s.tags || []) consider(t, 'tag', 50);
  }

  scored.sort((a, b) => a.score - b.score);
  const suggestions = scored.slice(0, 5).map(({ value, type }) => ({ value, type }));
  res.json({ suggestions });
});

// Add a new site. Any signed-in user.
router.post('/', requireAuth, handleIcon, async (req, res) => {
  const name = clampStr(req.body.name, 120);
  const description = clampStr(req.body.description, 600);
  const url = normalizeUrl(req.body.url);
  const tags = parseTags(req.body.tags);

  if (!name) return res.status(400).json({ error: 'A name is required.' });
  if (!url) return res.status(400).json({ error: 'Enter a valid URL.' });
  if (!description) return res.status(400).json({ error: 'A description is required.' });

  const icon = saveIcon(req.file);
  const site = {
    id: uid(),
    name,
    url,
    description,
    tags,
    icon,
    ownerId: req.user.id,
    ownerName: req.user.username,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await db.addSite(site);
  res.json({ site });
});

// Update a site. Owner, moderator, or admin.
router.patch('/:id', requireAuth, handleIcon, async (req, res) => {
  const site = await db.getSiteById(req.params.id);
  if (!site) return res.status(404).json({ error: 'That listing no longer exists.' });
  if (!canManageSite(req.user, site)) {
    return res.status(403).json({ error: 'You do not have permission to edit this listing.' });
  }

  const patch = { updatedAt: new Date().toISOString() };
  if (req.body.name !== undefined) {
    const name = clampStr(req.body.name, 120);
    if (!name) return res.status(400).json({ error: 'A name is required.' });
    patch.name = name;
  }
  if (req.body.url !== undefined) {
    const url = normalizeUrl(req.body.url);
    if (!url) return res.status(400).json({ error: 'Enter a valid URL.' });
    patch.url = url;
  }
  if (req.body.description !== undefined) {
    const description = clampStr(req.body.description, 600);
    if (!description) return res.status(400).json({ error: 'A description is required.' });
    patch.description = description;
  }
  if (req.body.tags !== undefined) {
    patch.tags = parseTags(req.body.tags);
  }
  if (req.file) {
    removeIcon(site.icon);
    patch.icon = saveIcon(req.file);
  } else if (req.body.removeIcon === 'true') {
    removeIcon(site.icon);
    patch.icon = null;
  }

  const updated = await db.updateSite(site.id, patch);
  res.json({ site: updated });
});

// Delete a site. Owner, moderator, or admin.
router.delete('/:id', requireAuth, async (req, res) => {
  const site = await db.getSiteById(req.params.id);
  if (!site) return res.status(404).json({ error: 'That listing no longer exists.' });
  if (!canManageSite(req.user, site)) {
    return res.status(403).json({ error: 'You do not have permission to delete this listing.' });
  }
  removeIcon(site.icon);
  await db.deleteSite(site.id);
  res.json({ ok: true });
});

export default router;
