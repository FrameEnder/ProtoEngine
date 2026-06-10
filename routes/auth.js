import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { db } from '../data-store.js';
import { requireAuth } from '../middleware/auth.js';
import { uid, validUsername, validPassword, clampStr } from '../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AVATAR_DIR = path.join(__dirname, '..', 'public', 'avatars');
if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });
const BG_DIR = path.join(__dirname, '..', 'public', 'backgrounds');
if (!fs.existsSync(BG_DIR)) fs.mkdirSync(BG_DIR, { recursive: true });

const AVATAR_TYPES = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};
const uploadAvatar = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 }, // 1 MB
  fileFilter: (req, file, cb) => {
    if (AVATAR_TYPES[file.mimetype]) cb(null, true);
    else cb(new Error('Profile picture must be PNG, JPG, GIF, or WEBP.'));
  },
}).single('avatar');
function handleAvatar(req, res, next) {
  uploadAvatar(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}

// Background images can be larger than avatars (full-page art).
const uploadBg = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 }, // 6 MB
  fileFilter: (req, file, cb) => {
    if (AVATAR_TYPES[file.mimetype]) cb(null, true);
    else cb(new Error('Background must be PNG, JPG, GIF, or WEBP.'));
  },
}).single('background');
function handleBg(req, res, next) {
  uploadBg(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}

const router = express.Router();

// Return the signed-in user (or null), including profile fields.
router.get('/me', async (req, res) => {
  if (!req.user) return res.json({ user: null });
  const u = await db.getUserById(req.user.id);
  if (!u) return res.json({ user: null });
  res.json({
    user: {
      id: u.id,
      username: u.username,
      role: u.role,
      avatar: u.avatar || null,
      background: u.background || null,
      favorites: Array.isArray(u.favorites) ? u.favorites : [],
      hasApiKey: !!u.apiKeyHash,
    },
  });
});

// Register a new account. The very first account created becomes admin.
router.post('/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!validUsername(username)) {
    return res.status(400).json({ error: 'Username must be 3–32 characters: letters, numbers, _ . -' });
  }
  if (!validPassword(password)) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  const existing = await db.getUserByUsername(username);
  if (existing) return res.status(409).json({ error: 'That username is taken.' });

  const users = await db.getUsers();
  const role = users.length === 0 ? 'admin' : 'user';
  const hash = await bcrypt.hash(password, 12);
  const user = {
    id: uid(),
    username: username.trim(),
    passwordHash: hash,
    role,
    createdAt: new Date().toISOString(),
  };
  await db.addUser(user);
  req.session.userId = user.id;
  res.json({ user: { id: user.id, username: user.username, role: user.role } });
});

// Sign in.
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Enter a username and password.' });
  }
  const user = await db.getUserByUsername(username);
  // Always run a hash compare to reduce timing differences between
  // "no such user" and "wrong password".
  const hash = user ? user.passwordHash : '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
  const ok = await bcrypt.compare(password, hash);
  if (!user || !ok) {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Could not sign you in. Try again.' });
    req.session.userId = user.id;
    res.json({ user: { id: user.id, username: user.username, role: user.role } });
  });
});

// Sign out.
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('sid');
    res.json({ ok: true });
  });
});

// Change own username and/or password.
router.patch('/account', requireAuth, async (req, res) => {
  const { username, currentPassword, newPassword } = req.body || {};
  const me = await db.getUserById(req.user.id);
  if (!me) return res.status(404).json({ error: 'Account not found.' });

  const patch = {};

  if (typeof username === 'string' && username.trim() && username.trim() !== me.username) {
    if (!validUsername(username)) {
      return res.status(400).json({ error: 'Username must be 3–32 characters: letters, numbers, _ . -' });
    }
    const taken = await db.getUserByUsername(username);
    if (taken && taken.id !== me.id) {
      return res.status(409).json({ error: 'That username is taken.' });
    }
    patch.username = username.trim();
  }

  if (newPassword) {
    if (!(await bcrypt.compare(currentPassword || '', me.passwordHash))) {
      return res.status(403).json({ error: 'Your current password is incorrect.' });
    }
    if (!validPassword(newPassword)) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }
    patch.passwordHash = await bcrypt.hash(newPassword, 12);
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'Nothing to update.' });
  }
  const updated = await db.updateUser(me.id, patch);
  res.json({ user: { id: updated.id, username: updated.username, role: updated.role } });
});

// Upload or replace the current user's profile picture.
router.post('/avatar', requireAuth, handleAvatar, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose an image to upload.' });
  const me = await db.getUserById(req.user.id);
  if (!me) return res.status(404).json({ error: 'Account not found.' });

  // Remove any previous avatar file.
  if (me.avatar && me.avatar.startsWith('/avatars/')) {
    fs.promises.unlink(path.join(AVATAR_DIR, path.basename(me.avatar))).catch(() => {});
  }
  const ext = AVATAR_TYPES[req.file.mimetype];
  const name = uid() + ext;
  fs.writeFileSync(path.join(AVATAR_DIR, name), req.file.buffer);
  const avatar = '/avatars/' + name;
  await db.updateUser(me.id, { avatar });
  res.json({ avatar });
});

// Remove the current user's profile picture.
router.delete('/avatar', requireAuth, async (req, res) => {
  const me = await db.getUserById(req.user.id);
  if (!me) return res.status(404).json({ error: 'Account not found.' });
  if (me.avatar && me.avatar.startsWith('/avatars/')) {
    fs.promises.unlink(path.join(AVATAR_DIR, path.basename(me.avatar))).catch(() => {});
  }
  await db.updateUser(me.id, { avatar: null });
  res.json({ ok: true });
});

// Upload or replace the current user's background image.
router.post('/background', requireAuth, handleBg, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose an image to upload.' });
  const me = await db.getUserById(req.user.id);
  if (!me) return res.status(404).json({ error: 'Account not found.' });
  if (me.background && me.background.startsWith('/backgrounds/')) {
    fs.promises.unlink(path.join(BG_DIR, path.basename(me.background))).catch(() => {});
  }
  const ext = AVATAR_TYPES[req.file.mimetype];
  const name = uid() + ext;
  fs.writeFileSync(path.join(BG_DIR, name), req.file.buffer);
  const background = '/backgrounds/' + name;
  await db.updateUser(me.id, { background });
  res.json({ background });
});

// Remove the current user's background image.
router.delete('/background', requireAuth, async (req, res) => {
  const me = await db.getUserById(req.user.id);
  if (!me) return res.status(404).json({ error: 'Account not found.' });
  if (me.background && me.background.startsWith('/backgrounds/')) {
    fs.promises.unlink(path.join(BG_DIR, path.basename(me.background))).catch(() => {});
  }
  await db.updateUser(me.id, { background: null });
  res.json({ ok: true });
});

// ---- Favorites (per-user, ordered list of site IDs) ----

// Toggle a site as a favorite. Body: { siteId }. Adds to the end if absent,
// removes if present. Returns the updated ordered list.
router.post('/favorites/toggle', requireAuth, async (req, res) => {
  const me = await db.getUserById(req.user.id);
  if (!me) return res.status(404).json({ error: 'Account not found.' });
  const siteId = clampStr((req.body && req.body.siteId) || '', 40);
  if (!siteId) return res.status(400).json({ error: 'A site id is required.' });

  // Confirm the site exists before favoriting it.
  const site = await db.getSiteById(siteId);
  if (!site) return res.status(404).json({ error: 'Listing not found.' });

  let favorites = Array.isArray(me.favorites) ? me.favorites.slice() : [];
  const i = favorites.indexOf(siteId);
  if (i === -1) favorites.push(siteId);
  else favorites.splice(i, 1);
  await db.updateUser(me.id, { favorites });
  res.json({ favorites });
});

// Replace the favorites order (drag-and-drop reorder). Body: { order: [ids] }.
// Only ids already in the user's favorites are kept, in the given order.
router.patch('/favorites/order', requireAuth, async (req, res) => {
  const me = await db.getUserById(req.user.id);
  if (!me) return res.status(404).json({ error: 'Account not found.' });
  const order = Array.isArray(req.body && req.body.order) ? req.body.order : null;
  if (!order) return res.status(400).json({ error: 'An order array is required.' });

  const current = new Set(Array.isArray(me.favorites) ? me.favorites : []);
  // Keep only known favorites, in the requested order, de-duplicated.
  const seen = new Set();
  const next = [];
  for (const id of order) {
    if (current.has(id) && !seen.has(id)) { seen.add(id); next.push(id); }
  }
  // Append any favorites the client didn't mention (safety).
  for (const id of current) if (!seen.has(id)) next.push(id);
  await db.updateUser(me.id, { favorites: next });
  res.json({ favorites: next });
});

// Generate (or regenerate) an API key for the current user. The full key is
// returned ONCE here and never stored in plaintext — only a hash is kept.
router.post('/apikey', requireAuth, async (req, res) => {
  const me = await db.getUserById(req.user.id);
  if (!me) return res.status(404).json({ error: 'Account not found.' });

  const keyId = crypto.randomBytes(6).toString('hex');   // public lookup handle
  const secret = crypto.randomBytes(24).toString('hex');  // the secret part
  const fullKey = `lmn_${keyId}_${secret}`;
  const apiKeyHash = await bcrypt.hash(secret, 12);

  await db.updateUser(me.id, {
    apiKeyId: keyId,
    apiKeyHash,
    apiKeyCreatedAt: new Date().toISOString(),
  });
  // Returned once; the client must copy it now.
  res.json({ apiKey: fullKey, createdAt: new Date().toISOString() });
});

// Revoke the current user's own API key.
router.delete('/apikey', requireAuth, async (req, res) => {
  const me = await db.getUserById(req.user.id);
  if (!me) return res.status(404).json({ error: 'Account not found.' });
  await db.updateUser(me.id, { apiKeyId: null, apiKeyHash: null, apiKeyCreatedAt: null });
  res.json({ ok: true });
});

export default router;
