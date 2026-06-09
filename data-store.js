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
  ICONS_DIR: path.join(__dirname, 'public', 'icons'),
};
