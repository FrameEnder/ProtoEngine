import crypto from 'crypto';

export function uid() {
  return crypto.randomBytes(12).toString('hex');
}

// Trim and clamp a string to a max length. Returns '' for non-strings.
export function clampStr(v, max) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, max);
}

// Validate a username: 3-32 chars, letters/numbers/_/-/. only.
export function validUsername(u) {
  return typeof u === 'string' && /^[A-Za-z0-9_.-]{3,32}$/.test(u);
}

// Password must be at least 8 chars.
export function validPassword(p) {
  return typeof p === 'string' && p.length >= 8 && p.length <= 200;
}

// Normalize a URL and ensure it uses http/https. Returns null if invalid.
export function normalizeUrl(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

// Parse tags from an array or comma-separated string into a clean array.
export function parseTags(input) {
  let arr = [];
  if (Array.isArray(input)) arr = input;
  else if (typeof input === 'string') arr = input.split(',');
  const seen = new Set();
  const out = [];
  for (let t of arr) {
    if (typeof t !== 'string') continue;
    t = t.trim().toLowerCase().slice(0, 30);
    if (!t) continue;
    if (!/^[a-z0-9 +#.&_-]+$/.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 15) break;
  }
  return out;
}
