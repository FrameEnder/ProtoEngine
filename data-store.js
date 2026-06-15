import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'protoengine.db');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SITES_FILE = path.join(DATA_DIR, 'sites.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const TAGLINE_FILE = path.join(DATA_DIR, 'tagline.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- Open a SQLite database ----
// Production uses better-sqlite3 (a compiled native module). The built-in
// node:sqlite (Node 22+) is used as a fallback so the same code can run and be
// tested where the native module isn't built. Both expose a compatible
// synchronous API: prepare(), .get/.all/.run, exec(), pragma/exec.
//
// Journal mode: WAL is fastest but needs working POSIX file locking and
// shared-memory mmap, which some NAS bind mounts and network filesystems
// (SMB/NFS, certain overlay/virtiofs setups) do NOT support — there it can
// silently hang on the first write. So we default to the rock-solid DELETE
// journal, which works on any filesystem, and only opt into WAL when the
// operator sets SQLITE_JOURNAL_MODE=WAL (e.g. on a known-good local disk).
// A busy_timeout guarantees a lock contention surfaces as an error instead of
// hanging forever.
const JOURNAL_MODE = (process.env.SQLITE_JOURNAL_MODE || 'DELETE').toUpperCase();
const VALID_JOURNAL = new Set(['DELETE', 'TRUNCATE', 'PERSIST', 'WAL', 'MEMORY']);
const journalMode = VALID_JOURNAL.has(JOURNAL_MODE) ? JOURNAL_MODE : 'DELETE';

let dbConn;
let driver = '';
try {
  const mod = await import('better-sqlite3');
  const Database = mod.default;
  dbConn = new Database(DB_FILE, { timeout: 8000 }); // wait up to 8s for a lock, then error
  dbConn.pragma('busy_timeout = 8000');
  dbConn.pragma('journal_mode = ' + journalMode);
  dbConn.pragma('foreign_keys = ON');
  dbConn.pragma('synchronous = NORMAL');
  driver = 'better-sqlite3';
} catch (e1) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    dbConn = new DatabaseSync(DB_FILE);
    dbConn.exec('PRAGMA busy_timeout = 8000;');
    dbConn.exec('PRAGMA journal_mode = ' + journalMode + ';');
    dbConn.exec('PRAGMA foreign_keys = ON;');
    dbConn.exec('PRAGMA synchronous = NORMAL;');
    driver = 'node:sqlite';
  } catch (e2) {
    throw new Error('No SQLite driver available. Install better-sqlite3. ' + e1.message);
  }
}
console.log(`[db] SQLite ready via ${driver} (journal=${journalMode}).`);

function prepare(sql) { return dbConn.prepare(sql); }
function exec(sql) { return dbConn.exec(sql); }

// ---- Schema ----
// Scalar columns are promoted for fields the app filters or looks up by;
// everything else (arrays/objects like favorites, rssFeeds, rssGroups, tags)
// lives in a JSON `extras` column. Rows reconstruct into the exact same plain
// objects the routes expect, so nothing downstream changes.
exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL,
    username_lc   TEXT NOT NULL UNIQUE,
    passwordHash  TEXT,
    role          TEXT,
    apiKeyId      TEXT,
    createdAt     TEXT,
    extras        TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_users_apikey ON users(apiKeyId);

  CREATE TABLE IF NOT EXISTS sites (
    id          TEXT PRIMARY KEY,
    name        TEXT,
    url         TEXT,
    description TEXT,
    ownerId     TEXT,
    seq         INTEGER,
    extras      TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_sites_owner ON sites(ownerId);

  CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

function nextSeq() {
  const row = prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM sites').get();
  return (row.m || 0) + 1;
}

// ---- Row <-> object mapping ----
const USER_COLS = ['id', 'username', 'passwordHash', 'role', 'apiKeyId', 'createdAt'];
function userToRow(u) {
  const extras = {};
  for (const [k, v] of Object.entries(u)) {
    if (!USER_COLS.includes(k) && k !== 'username_lc') extras[k] = v;
  }
  return {
    id: u.id,
    username: u.username,
    username_lc: (u.username || '').toLowerCase(),
    passwordHash: u.passwordHash ?? null,
    role: u.role ?? null,
    apiKeyId: u.apiKeyId ?? null,
    createdAt: u.createdAt ?? null,
    extras: JSON.stringify(extras),
  };
}
function rowToUser(r) {
  if (!r) return null;
  const extras = safeParse(r.extras);
  return {
    id: r.id,
    username: r.username,
    passwordHash: r.passwordHash,
    role: r.role,
    apiKeyId: r.apiKeyId,
    createdAt: r.createdAt,
    ...extras,
  };
}

const SITE_COLS = ['id', 'name', 'url', 'description', 'ownerId'];
function siteToRow(s, seq) {
  const extras = {};
  for (const [k, v] of Object.entries(s)) {
    if (!SITE_COLS.includes(k) && k !== 'seq') extras[k] = v;
  }
  return {
    id: s.id,
    name: s.name ?? null,
    url: s.url ?? null,
    description: s.description ?? null,
    ownerId: s.ownerId ?? null,
    seq: seq,
    extras: JSON.stringify(extras),
  };
}
function rowToSite(r) {
  if (!r) return null;
  const extras = safeParse(r.extras);
  return {
    id: r.id,
    name: r.name,
    url: r.url,
    description: r.description,
    ownerId: r.ownerId,
    ...extras,
  };
}
function safeParse(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }

// ---- Prepared statements ----
const stmt = {
  userById: prepare('SELECT * FROM users WHERE id = ?'),
  userByLc: prepare('SELECT * FROM users WHERE username_lc = ?'),
  userByApiKey: prepare('SELECT * FROM users WHERE apiKeyId = ?'),
  allUsers: prepare('SELECT * FROM users ORDER BY createdAt ASC'),
  insUser: prepare(`INSERT INTO users (id, username, username_lc, passwordHash, role, apiKeyId, createdAt, extras)
                    VALUES (@id, @username, @username_lc, @passwordHash, @role, @apiKeyId, @createdAt, @extras)`),
  updUser: prepare(`UPDATE users SET username=@username, username_lc=@username_lc, passwordHash=@passwordHash,
                    role=@role, apiKeyId=@apiKeyId, createdAt=@createdAt, extras=@extras WHERE id=@id`),
  delUser: prepare('DELETE FROM users WHERE id = ?'),

  siteById: prepare('SELECT * FROM sites WHERE id = ?'),
  allSites: prepare('SELECT * FROM sites ORDER BY seq ASC'),
  insSite: prepare(`INSERT INTO sites (id, name, url, description, ownerId, seq, extras)
                    VALUES (@id, @name, @url, @description, @ownerId, @seq, @extras)`),
  updSite: prepare(`UPDATE sites SET name=@name, url=@url, description=@description,
                    ownerId=@ownerId, seq=@seq, extras=@extras WHERE id=@id`),
  delSite: prepare('DELETE FROM sites WHERE id = ?'),
  clearSites: prepare('DELETE FROM sites'),

  getSetting: prepare('SELECT value FROM app_settings WHERE key = ?'),
  setSetting: prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?)
                       ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
  getMeta: prepare('SELECT value FROM meta WHERE key = ?'),
  setMeta: prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
};

// ---- Public db API (same shape as the old JSON store) ----
// Methods stay async so existing `await db.x()` callers are unaffected, even
// though SQLite operations are synchronous here.
export const db = {
  async getUsers() { return stmt.allUsers.all().map(rowToUser); },
  async getUserById(id) { return rowToUser(stmt.userById.get(id)); },
  async getUserByUsername(username) { return rowToUser(stmt.userByLc.get((username || '').toLowerCase())); },
  async getUserByApiKeyId(keyId) { if (!keyId) return null; return rowToUser(stmt.userByApiKey.get(keyId)); },
  async addUser(user) { stmt.insUser.run(userToRow(user)); return user; },
  async updateUser(id, patch) {
    const cur = rowToUser(stmt.userById.get(id));
    if (!cur) return null;
    const next = { ...cur, ...patch };
    stmt.updUser.run(userToRow(next));
    return next;
  },
  async deleteUser(id) { return (stmt.delUser.run(id).changes || 0) > 0; },

  async getSites() { return stmt.allSites.all().map(rowToSite); },
  async getSiteById(id) { return rowToSite(stmt.siteById.get(id)); },
  async addSite(site) { stmt.insSite.run(siteToRow(site, nextSeq())); return site; },
  async updateSite(id, patch) {
    const row = stmt.siteById.get(id);
    if (!row) return null;
    const next = { ...rowToSite(row), ...patch };
    stmt.updSite.run(siteToRow(next, row.seq));
    return next;
  },
  async deleteSite(id) { return (stmt.delSite.run(id).changes || 0) > 0; },
  async replaceAllSites(sites) {
    const list = Array.isArray(sites) ? sites : [];
    const doIt = (arr) => {
      stmt.clearSites.run();
      let i = 1;
      for (const s of arr) stmt.insSite.run(siteToRow(s, i++));
    };
    if (driver === 'better-sqlite3') {
      dbConn.transaction(doIt)(list);
    } else {
      exec('BEGIN');
      try { doIt(list); exec('COMMIT'); } catch (e) { exec('ROLLBACK'); throw e; }
    }
    return list;
  },
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
    const row = stmt.getSetting.get('branding');
    let s = {};
    if (row && row.value) { try { s = JSON.parse(row.value); } catch { s = {}; } }
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
    stmt.setSetting.run('branding', JSON.stringify(next));
    return next;
  },
};

// ---- One-time JSON -> SQLite migration ----
// Runs at startup. If legacy users.json/sites.json exist AND the DB is empty,
// import them, migrate branding, then rename the JSON files to *.json.migrated
// so the conversion only happens once. Safe to ship long-term: once retired,
// it no-ops.
function safeParseFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function retire(file) {
  try { if (fs.existsSync(file)) fs.renameSync(file, file + '.migrated'); } catch { /* non-fatal */ }
}
function migrateFromJsonIfNeeded() {
  const already = stmt.getMeta.get('migrated_from_json');
  if (already && already.value === 'yes') return;

  const userCount = prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const siteCount = prepare('SELECT COUNT(*) AS c FROM sites').get().c;
  const haveUsersJson = fs.existsSync(USERS_FILE);
  const haveSitesJson = fs.existsSync(SITES_FILE);

  if ((userCount === 0 && haveUsersJson) || (siteCount === 0 && haveSitesJson)) {
    let importedUsers = 0, importedSites = 0;

    if (userCount === 0 && haveUsersJson) {
      for (const u of (safeParseFile(USERS_FILE, []) || [])) {
        if (!u || !u.id || !u.username) continue;
        try { stmt.insUser.run(userToRow(u)); importedUsers++; } catch { /* skip dupes */ }
      }
    }
    if (siteCount === 0 && haveSitesJson) {
      let i = 1;
      for (const s of (safeParseFile(SITES_FILE, []) || [])) {
        if (!s || !s.id) continue;
        try { stmt.insSite.run(siteToRow(s, i++)); importedSites++; } catch { /* skip */ }
      }
    }

    if (fs.existsSync(SETTINGS_FILE)) {
      settings.write(safeParseFile(SETTINGS_FILE, {}) || {});
    } else if (fs.existsSync(TAGLINE_FILE)) {
      const t = safeParseFile(TAGLINE_FILE, null);
      if (t) settings.write({ taglines: t });
    }

    retire(USERS_FILE);
    retire(SITES_FILE);
    retire(SETTINGS_FILE);
    retire(TAGLINE_FILE);

    stmt.setMeta.run('migrated_from_json', 'yes');
    console.log(`[migrate] Imported ${importedUsers} users and ${importedSites} sites from JSON into SQLite.`);
    console.log('[migrate] Old .json files renamed to .json.migrated.');
  } else {
    stmt.setMeta.run('migrated_from_json', 'yes');
  }
}
migrateFromJsonIfNeeded();

// Paths exposed for backup/snapshot tooling.
export const paths = {
  DATA_DIR,
  DB_FILE,
  SITES_FILE,
  TAGLINE_FILE,
  SETTINGS_FILE,
  ICONS_DIR: path.join(__dirname, 'public', 'icons'),
};

export const dbDriver = driver;
