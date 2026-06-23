import express from 'express';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import AdmZip from 'adm-zip';
import { db, paths, settings, HERO_ANIMATIONS } from '../data-store.js';
import { requireRole, ROLES, RANK } from '../middleware/auth.js';
import { validUsername, validPassword, sanitizeThemeColors } from '../util.js';

const router = express.Router();

// All admin routes require admin.
router.use(requireRole('admin'));

// Upload handling for snapshot import: accept a single .zip in memory.
const uploadZip = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB ceiling for a snapshot
}).single('snapshot');

function handleZipUpload(req, res, next) {
  uploadZip(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}

// Allowed favicon extensions (mirrors the upload route).
const ICON_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico']);

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    createdAt: u.createdAt,
    avatar: u.avatar || null,
    hasApiKey: !!u.apiKeyHash,
  };
}

// Revoke a specific user's API key (admin override).
async function revokeUserKey(id) {
  return db.updateUser(id, { apiKeyId: null, apiKeyHash: null, apiKeyCreatedAt: null });
}

// ---- Branding / site settings (admin only) ----
router.get('/settings', async (req, res) => {
  res.json({ settings: settings.read(), heroAnimations: HERO_ANIMATIONS });
});

router.patch('/settings', async (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (typeof b.appName === 'string') patch.appName = b.appName;
  if (typeof b.tabTitle === 'string') patch.tabTitle = b.tabTitle;
  if (Array.isArray(b.taglines)) patch.taglines = b.taglines;
  if (typeof b.heroAnimation === 'string') patch.heroAnimation = b.heroAnimation;
  if (['dark', 'light', 'custom'].includes(b.defaultTheme)) patch.defaultTheme = b.defaultTheme;
  if (b.defaultThemeColors !== undefined) patch.defaultThemeColors = sanitizeThemeColors(b.defaultThemeColors);
  if (typeof b.filterName === 'string') patch.filterName = b.filterName;
  if (Array.isArray(b.adminFilters)) {
    const ranks = ['user', 'moderator', 'admin'];
    const seen = new Set();
    patch.adminFilters = [];
    for (const f of b.adminFilters) {
      if (!f || typeof f.tag !== 'string') continue;
      const tag = f.tag.trim().toLowerCase().slice(0, 40);
      const minRank = ranks.includes(f.minRank) ? f.minRank : 'user';
      if (tag && !seen.has(tag)) { seen.add(tag); patch.adminFilters.push({ tag, minRank }); }
      if (patch.adminFilters.length >= 200) break;
    }
  }
  const next = settings.write(patch);
  res.json({ settings: next });
});

// List all users.
router.get('/users', async (req, res) => {
  const users = await db.getUsers();
  res.json({ users: users.map(publicUser) });
});

// Revoke a given user's API key (admin only).
router.delete('/users/:id/apikey', async (req, res) => {
  const target = await db.getUserById(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  await revokeUserKey(target.id);
  res.json({ ok: true });
});

// Modify a user: username, role, and/or password reset.
router.patch('/users/:id', async (req, res) => {
  const target = await db.getUserById(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found.' });

  const patch = {};
  const { username, role, newPassword } = req.body || {};

  if (typeof username === 'string' && username.trim() && username.trim() !== target.username) {
    if (!validUsername(username)) {
      return res.status(400).json({ error: 'Username must be 3–32 characters: letters, numbers, _ . -' });
    }
    const taken = await db.getUserByUsername(username);
    if (taken && taken.id !== target.id) {
      return res.status(409).json({ error: 'That username is taken.' });
    }
    patch.username = username.trim();
  }

  if (role !== undefined && role !== target.role) {
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role.' });
    // Prevent removing the last admin.
    if (target.role === 'admin' && role !== 'admin') {
      const users = await db.getUsers();
      const admins = users.filter((u) => u.role === 'admin');
      if (admins.length <= 1) {
        return res.status(400).json({ error: 'You cannot demote the last remaining admin.' });
      }
    }
    patch.role = role;
  }

  if (newPassword) {
    if (!validPassword(newPassword)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    patch.passwordHash = await bcrypt.hash(newPassword, 12);
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'Nothing to update.' });
  }
  const updated = await db.updateUser(target.id, patch);
  // If we renamed the user, update ownerName on their listings for display.
  if (patch.username) {
    const sites = await db.getSites();
    for (const s of sites) {
      if (s.ownerId === target.id) await db.updateSite(s.id, { ownerName: patch.username });
    }
  }
  res.json({ user: publicUser(updated) });
});

// Delete a user. Their listings are reassigned to "orphaned" but kept,
// unless ?purge=true is passed, in which case their listings are deleted too.
router.delete('/users/:id', async (req, res) => {
  const target = await db.getUserById(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.id === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account here.' });
  }
  if (target.role === 'admin') {
    const users = await db.getUsers();
    const admins = users.filter((u) => u.role === 'admin');
    if (admins.length <= 1) {
      return res.status(400).json({ error: 'You cannot delete the last remaining admin.' });
    }
  }

  const purge = req.query.purge === 'true';
  const sites = await db.getSites();
  for (const s of sites) {
    if (s.ownerId === target.id) {
      if (purge) await db.deleteSite(s.id);
      else await db.updateSite(s.id, { ownerId: null, ownerName: '(deleted user)' });
    }
  }
  await db.deleteUser(target.id);
  res.json({ ok: true });
});

// ---- Snapshot export / import ----
// A snapshot bundles the website catalog (sites.json), the taglines
// (tagline.json), and the uploaded favicons (public/icons/) into a single
// dated .zip. It deliberately EXCLUDES all account data (users, sessions).

// GET /api/admin/export -> streams a .zip download named by date.
router.get('/export', async (req, res) => {
  try {
    const zip = new AdmZip();

    // Website listings (always include, even if empty).
    const sites = await db.getSites();
    zip.addFile('sites.json', Buffer.from(JSON.stringify(sites, null, 2)));

    // Taglines, exported from the current settings.
    zip.addFile('tagline.json', Buffer.from(JSON.stringify(settings.read().taglines, null, 2)));

    // Uploaded favicons. Stored under icons/ inside the zip.
    if (fs.existsSync(paths.ICONS_DIR)) {
      for (const name of fs.readdirSync(paths.ICONS_DIR)) {
        if (name.startsWith('.')) continue; // skip .gitkeep etc.
        const full = path.join(paths.ICONS_DIR, name);
        if (fs.statSync(full).isFile()) zip.addLocalFile(full, 'icons');
      }
    }

    // A small manifest so imports can sanity-check the file.
    zip.addFile(
      'manifest.json',
      Buffer.from(JSON.stringify({
        type: 'protoengine-snapshot',
        version: 1,
        createdAt: new Date().toISOString(),
        siteCount: sites.length,
      }, null, 2))
    );

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const filename = `protoengine-snapshot-${stamp}.zip`;
    const buffer = zip.toBuffer();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (e) {
    res.status(500).json({ error: 'Could not build the snapshot.' });
  }
});

// POST /api/admin/import -> replaces the catalog from an uploaded snapshot.
// Clears current listings, taglines, and icons (NOT accounts) and restores
// from the zip. Validates and sanitizes everything from the archive.
router.post('/import', handleZipUpload, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Attach a snapshot .zip file.' });

  let zip;
  try {
    zip = new AdmZip(req.file.buffer);
  } catch {
    return res.status(400).json({ error: 'That file is not a valid .zip archive.' });
  }

  const entries = zip.getEntries();
  const byName = new Map(entries.map((e) => [e.entryName.replace(/\\/g, '/'), e]));

  // Require and parse sites.json.
  const sitesEntry = byName.get('sites.json');
  if (!sitesEntry) {
    return res.status(400).json({ error: 'This zip has no sites.json — it is not a valid snapshot.' });
  }
  let importedSites;
  try {
    importedSites = JSON.parse(sitesEntry.getData().toString('utf8'));
    if (!Array.isArray(importedSites)) throw new Error();
  } catch {
    return res.status(400).json({ error: 'sites.json in the snapshot is malformed.' });
  }

  // Collect which icon files the listings actually reference, so we only
  // restore icons that are in use.
  const referencedIcons = new Set();
  const cleanSites = [];
  for (const s of importedSites) {
    if (!s || typeof s !== 'object') continue;
    const site = {
      id: typeof s.id === 'string' ? s.id : undefined,
      name: typeof s.name === 'string' ? s.name.slice(0, 120) : '',
      url: typeof s.url === 'string' ? s.url.slice(0, 2000) : '',
      description: typeof s.description === 'string' ? s.description.slice(0, 600) : '',
      tags: Array.isArray(s.tags) ? s.tags.filter((t) => typeof t === 'string').slice(0, 15) : [],
      icon: null,
      ownerId: typeof s.ownerId === 'string' ? s.ownerId : null,
      ownerName: typeof s.ownerName === 'string' ? s.ownerName.slice(0, 60) : '(imported)',
      createdAt: typeof s.createdAt === 'string' ? s.createdAt : new Date().toISOString(),
      updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : new Date().toISOString(),
    };
    if (!site.id || !site.name || !site.url) continue; // skip incomplete rows
    // Only accept an icon path that points safely into /icons/.
    if (typeof s.icon === 'string' && s.icon.startsWith('/icons/')) {
      const base = path.basename(s.icon);
      if (ICON_EXT.has(path.extname(base).toLowerCase())) {
        site.icon = '/icons/' + base;
        referencedIcons.add(base);
      }
    }
    cleanSites.push(site);
  }

  // Extract icons from the zip safely (guard against path traversal / zip-slip
  // by reducing every entry to its basename and writing only into ICONS_DIR).
  const iconsToWrite = [];
  for (const e of entries) {
    const norm = e.entryName.replace(/\\/g, '/');
    if (!norm.startsWith('icons/') || e.isDirectory) continue;
    const base = path.basename(norm);
    if (!base || base.startsWith('.')) continue;
    if (!ICON_EXT.has(path.extname(base).toLowerCase())) continue;
    // Restore the icon whether or not a listing references it; harmless extras
    // are fine, and it keeps the snapshot faithful.
    iconsToWrite.push({ base, data: e.getData() });
  }

  // Optional taglines.
  let importedTaglines = null;
  const tagEntry = byName.get('tagline.json');
  if (tagEntry) {
    try {
      const parsed = JSON.parse(tagEntry.getData().toString('utf8'));
      if (Array.isArray(parsed)) {
        importedTaglines = parsed.filter((t) => typeof t === 'string').map((t) => t.slice(0, 200));
      }
    } catch { /* ignore bad taglines, keep current */ }
  }

  try {
    console.log(`[import] writing ${iconsToWrite.length} icons + ${cleanSites.length} listings…`);
    // 1. Clear and rewrite icons directory (preserve dotfiles like .gitkeep).
    if (fs.existsSync(paths.ICONS_DIR)) {
      for (const name of fs.readdirSync(paths.ICONS_DIR)) {
        if (name.startsWith('.')) continue;
        fs.unlinkSync(path.join(paths.ICONS_DIR, name));
      }
    } else {
      fs.mkdirSync(paths.ICONS_DIR, { recursive: true });
    }
    for (const { base, data } of iconsToWrite) {
      fs.writeFileSync(path.join(paths.ICONS_DIR, base), data);
    }

    // 2. Replace the listings atomically.
    await db.replaceAllSites(cleanSites);

    // 3. Replace taglines if the snapshot had them.
    if (importedTaglines && importedTaglines.length) {
      settings.write({ taglines: importedTaglines });
    }

    console.log(`[import] done: ${cleanSites.length} listings, ${iconsToWrite.length} icons.`);
    res.json({ ok: true, siteCount: cleanSites.length, iconCount: iconsToWrite.length });
  } catch (e) {
    console.error('[import] failed:', e && e.message ? e.message : e);
    res.status(500).json({ error: 'Import failed while writing data. Some data may be partially restored.' });
  }
});

export default router;
