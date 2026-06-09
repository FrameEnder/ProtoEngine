import { db } from '../data-store.js';
import bcrypt from 'bcryptjs';

export const ROLES = ['user', 'moderator', 'admin'];
export const RANK = { user: 1, moderator: 2, admin: 3 };

// API keys have the form  lmn_<keyId>_<secret>  where keyId is a public
// lookup handle and secret is what we hash. Parse it into its parts.
export function parseApiKey(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.match(/^lmn_([A-Za-z0-9]+)_([A-Za-z0-9]+)$/);
  if (!m) return null;
  return { keyId: m[1], secret: m[2] };
}

// Resolve an Authorization: Bearer <key> header to a user (or null).
async function userFromApiKey(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  const parsed = parseApiKey(auth.slice(7).trim());
  if (!parsed) return null;
  const u = await db.getUserByApiKeyId(parsed.keyId);
  if (!u || !u.apiKeyHash) return null;
  const ok = await bcrypt.compare(parsed.secret, u.apiKeyHash);
  if (!ok) return null;
  return u;
}

// Attach the current user (minus secrets) to req.user on every request.
// Accepts EITHER a browser session OR an API key bearer token. When the
// request is authenticated via API key, req.viaApiKey is set true so the
// CSRF layer can skip it (CSRF protects cookie auth, not token auth).
export async function loadUser(req, res, next) {
  // 1. API key takes precedence if present (for programmatic clients).
  try {
    const apiUser = await userFromApiKey(req);
    if (apiUser) {
      req.user = { id: apiUser.id, username: apiUser.username, role: apiUser.role };
      req.viaApiKey = true;
      return next();
    }
  } catch {
    /* fall through to session auth */
  }

  // 2. Otherwise fall back to the browser session.
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
