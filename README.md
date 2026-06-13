import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SITES_FILE = path.join(DATA_DIR, 'sites.json');

// Ensure data directory and files exist
function ensure(file, fallback) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
}
ensure(USERS_FILE, []);
ensure(SITES_FILE, []);

// Simple in-process write queue to serialize writes per file (avoids races
// in a single-process self-hosted deployment).
const queues = new Map();
function withLock(file, fn) {
  const prev = queues.get(file) || Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(file, next.catch(() => {}));
  return next;
}

async function readJSON(file) {
  const raw = await fsp.readFile(file, 'utf8');
  return JSON.parse(raw || '[]');
}

// Atomic write: write to temp file then rename.
async function writeJSON(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, file);
}

export const db = {
  // ---- Users ----
  async getUsers() {
    return readJSON(USERS_FILE);
  },
  async getUserById(id) {
    const users = await readJSON(USERS_FILE);
    return users.find((u) => u.id === id) || null;
  },
  async getUserByUsername(username) {
    const users = await readJSON(USERS_FILE);
    const lc = username.toLowerCase();
    return users.find((u) => u.username.toLowerCase() === lc) || null;
  },
  // Find a user by the public id portion of their API key. The secret itself
  // is verified separately (hash compare) by the caller.
  async getUserByApiKeyId(keyId) {
    if (!keyId) return null;
    const users = await readJSON(USERS_FILE);
    return users.find((u) => u.apiKeyId === keyId) || null;
  },
  async addUser(user) {
    return withLock(USERS_FILE, async () => {
      const users = await readJSON(USERS_FILE);
      users.push(user);
      await writeJSON(USERS_FILE, users);
      return user;
    });
  },
  async updateUser(id, patch) {
    return withLock(USERS_FILE, async () => {
      const users = await readJSON(USERS_FILE);
      const idx = users.findIndex((u) => u.id === id);
      if (idx === -1) return null;
      users[idx] = { ...users[idx], ...patch };
      await writeJSON(USERS_FILE, users);
      return users[idx];
    });
  },
  async deleteUser(id) {
    return withLock(USERS_FILE, async () => {
      const users = await readJSON(USERS_FILE);
      const next = users.filter((u) => u.id !== id);
      await writeJSON(USERS_FILE, next);
      return users.length !== next.length;
    });
  },

  // ---- Sites ----
  async getSites() {
    return readJSON(SITES_FILE);
  },
  async getSiteById(id) {
    const sites = await readJSON(SITES_FILE);
    return sites.find((s) => s.id === id) || null;
  },
  async addSite(site) {
    return withLock(SITES_FILE, async () => {
      const sites = await readJSON(SITES_FILE);
      sites.push(site);
      await writeJSON(SITES_FILE, sites);
      return site;
    });
  },
  async updateSite(id, patch) {
    return withLock(SITES_FILE, async () => {
      const sites = await readJSON(SITES_FILE);
      const idx = sites.findIndex((s) => s.id === id);
      if (idx === -1) return null;
      sites[idx] = { ...sites[idx], ...patch };
      await writeJSON(SITES_FILE, sites);
      return sites[idx];
    });
  },
  async deleteSite(id) {
    return withLock(SITES_FILE, async () => {
      const sites = await readJSON(SITES_FILE);
      const next = sites.filter((s) => s.id !== id);
      await writeJSON(SITES_FILE, next);
      return sites.length !== next.length;
    });
  },
  // Atomically replace the entire sites list (used by snapshot import).
  async replaceAllSites(sites) {
    return withLock(SITES_FILE, async () => {
      await writeJSON(SITES_FILE, Array.isArray(sites) ? sites : []);
      return sites;
    });
  },
};

// Paths exposed for backup/snapshot tooling.
export const paths = {
  DATA_DIR,
  SITES_FILE,
  TAGLINE_FILE: path.join(DATA_DIR, 'tagline.json'),
  SETTINGS_FILE: path.join(DATA_DIR, 'settings.json'),
  ICONS_DIR: path.join(__dirname, 'public', 'icons'),
};

// ---- Branding & site settings (admin-editable) ----
export const HERO_ANIMATIONS = [
  'rise', 'fade-in', 'pop', 'flip', 'wave', 'drop', 'zoom', 'blur-in',
  'slide-left', 'swing', 'bounce', 'glow', 'typewriter', 'spin-in', 'rubber',
];
const DEFAULT_TAGLINES = ['Search the sites your people actually use.'];
const ENV_APP_NAME = (process.env.APP_NAME || 'ProtoEngine')
  .replace(/[<>&"'`]/g, '').trim().slice(0, 40) || 'ProtoEngine';

function sanitizeName(s, fallback) {
  const out = String(s || '').replace(/[<>&"'`]/g, '').trim().slice(0, 40);
  return out || fallback;
}
function sanitizeTaglines(arr) {
  const list = (Array.isArray(arr) ? arr : [])
    .filter((t) => typeof t === 'string')
    .map((t) => t.trim().slice(0, 200))
    .filter(Boolean);
  return list.length ? list : DEFAULT_TAGLINES.slice();
}

export const settings = {
  read() {
    let s = {};
    try { s = JSON.parse(fs.readFileSync(paths.SETTINGS_FILE, 'utf8')); } catch { s = {}; }
    const appName = sanitizeName(s.appName, ENV_APP_NAME);
    return {
      appName,
      tabTitle: sanitizeName(s.tabTitle, appName),
      taglines: sanitizeTaglines(s.taglines),
      heroAnimation: (s.heroAnimation === 'random' || HERO_ANIMATIONS.includes(s.heroAnimation)) ? s.heroAnimation : 'random',
    };
  },
  write(patch) {
    const next = { ...this.read(), ...patch };
    next.appName = sanitizeName(next.appName, ENV_APP_NAME);
    next.tabTitle = sanitizeName(next.tabTitle, next.appName);
    next.taglines = sanitizeTaglines(next.taglines);
    if (next.heroAnimation !== 'random' && !HERO_ANIMATIONS.includes(next.heroAnimation)) next.heroAnimation = 'random';
    try {
      fs.mkdirSync(paths.DATA_DIR, { recursive: true });
      fs.writeFileSync(paths.SETTINGS_FILE, JSON.stringify(next, null, 2));
    } catch { /* non-fatal */ }
    return next;
  },
};
