import { db } from '../data-store.js';

export const ROLES = ['user', 'moderator', 'admin'];
export const RANK = { user: 1, moderator: 2, admin: 3 };

// Attach the current user (minus password hash) to req.user on every request.
export async function loadUser(req, res, next) {
  if (req.session && req.session.userId) {
    const u = await db.getUserById(req.session.userId);
    if (u) {
      req.user = { id: u.id, username: u.username, role: u.role };
    } else {
      // Session points to a deleted user — clear it.
      req.session.destroy(() => {});
    }
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'You must be signed in.' });
  next();
}

// Require a minimum role rank (admin >= moderator >= user).
export function requireRole(minRole) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'You must be signed in.' });
    if (RANK[req.user.role] < RANK[minRole]) {
      return res.status(403).json({ error: 'You do not have permission to do that.' });
    }
    next();
  };
}
