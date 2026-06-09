import express from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../data-store.js';
import { requireAuth } from '../middleware/auth.js';
import { uid, validUsername, validPassword } from '../util.js';

const router = express.Router();

// Return the signed-in user (or null).
router.get('/me', (req, res) => {
  res.json({ user: req.user || null });
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

export default router;
