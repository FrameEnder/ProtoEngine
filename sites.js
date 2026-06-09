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
  const tag = clampStr(req.query.tag, 30).toLowerCase();

  let results = sites;
  if (tag) {
    results = results.filter((s) => (s.tags || []).includes(tag));
  }
  if (q) {
    const terms = q.split(/\s+/).filter(Boolean);
    results = results.filter((s) => {
      const hay = [s.name, s.url, s.description, ...(s.tags || [])].join(' ').toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }
  results = [...results].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

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
    matched,         // total matching the query/tag
    total: sites.length, // total in the engine
    page: returnAll ? 1 : page,
    pageCount: returnAll ? 1 : pageCount,
    perPage: PER_PAGE,
  });
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
