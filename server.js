import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { doubleCsrf } from 'csrf-csrf';
import FileStoreFactory from 'session-file-store';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

import { loadUser } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import siteRoutes from './routes/sites.js';
import adminRoutes from './routes/admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
// Whether to mark cookies `Secure` (HTTPS-only). This MUST be off when
// serving over plain http:// (e.g. http://127.0.0.1) or the browser will
// silently drop the session cookie and you'll appear logged out on every
// request. Turn it on (SECURE_COOKIES=true) only when you have HTTPS,
// typically via a reverse proxy. Defaults off so http access works.
const SECURE_COOKIES = process.env.SECURE_COOKIES === 'true';

// Brand name shown throughout the UI. Set APP_NAME in .env to rebrand;
// defaults to "Lumen". Clamp length and strip characters that could break
// HTML injection, since this value is interpolated into the page.
const APP_NAME = (process.env.APP_NAME || 'Lumen')
  .replace(/[<>&"'`]/g, '')
  .trim()
  .slice(0, 40) || 'Lumen';

// Taglines shown under the search box. Stored in data/tagline.json as a JSON
// array of strings, e.g. ["First tagline.", "Second tagline."]. One is shown
// at random per page load. Edit the file any time — it's read fresh on each
// request, so no restart is needed. Created with a default if missing.
const TAGLINE_FILE = path.join(__dirname, 'data', 'tagline.json');
const DEFAULT_TAGLINES = ['Search the sites your people actually use.'];

function ensureTaglineFile() {
  try {
    if (!fs.existsSync(TAGLINE_FILE)) {
      fs.mkdirSync(path.dirname(TAGLINE_FILE), { recursive: true });
      fs.writeFileSync(TAGLINE_FILE, JSON.stringify(DEFAULT_TAGLINES, null, 2));
    }
  } catch {
    /* non-fatal: we fall back to defaults at read time */
  }
}
ensureTaglineFile();

// Read, validate, and sanitize taglines. Always returns a non-empty array.
function loadTaglines() {
  try {
    const raw = fs.readFileSync(TAGLINE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const list = (Array.isArray(parsed) ? parsed : [parsed])
      .filter((t) => typeof t === 'string')
      .map((t) => t.trim().slice(0, 200))
      .filter(Boolean);
    return list.length ? list : DEFAULT_TAGLINES;
  } catch {
    return DEFAULT_TAGLINES;
  }
}

// Secrets: read from env, or generate ephemeral ones (with a warning).
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const CSRF_SECRET = process.env.CSRF_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET || !process.env.CSRF_SECRET) {
  console.warn(
    '\x1b[33m[warn] SESSION_SECRET / CSRF_SECRET not set in .env — using ephemeral secrets.\n' +
      '       Sessions will be invalidated on restart. Set them in .env for production.\x1b[0m'
  );
}

// Behind a reverse proxy (nginx/caddy) terminating TLS, this lets Express
// trust the X-Forwarded-Proto header so Secure cookies work correctly.
if (SECURE_COOKIES) app.set('trust proxy', 1);

// Build a CSP per request that explicitly includes the origin the page was
// served from (scheme + host). Relying on 'self' alone can fail to match
// scripts/styles on bare-IP or LAN origins in some browsers; naming the
// origin explicitly avoids that while staying same-origin only.
app.use((req, res, next) => {
  const host = req.headers.host || 'localhost';
  const proto = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const origin = `${proto}://${host}`;
  res.setHeader(
    'Content-Security-Policy',
    [
      `default-src 'self' ${origin}`,
      `script-src 'self' ${origin}`,
      `script-src-elem 'self' ${origin}`,
      `style-src 'self' 'unsafe-inline' ${origin}`,
      `style-src-elem 'self' 'unsafe-inline' ${origin}`,
      `img-src 'self' ${origin} data: https:`,
      `connect-src 'self' ${origin}`,
      `object-src 'none'`,
      `base-uri 'self'`,
      `form-action 'self'`,
      `frame-ancestors 'none'`,
    ].join('; ')
  );
  next();
});

app.use(
  helmet({
    // CSP is set manually above (per-request, origin-aware), so disable
    // helmet's own CSP to avoid two conflicting policy headers.
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    originAgentCluster: false,
    // HSTS tells browsers to force every future request to this host over
    // HTTPS — and it's cached for months. On a plain-HTTP service (e.g.
    // http://LAN-IP:3000) that breaks all asset loading. Only enable it when
    // you actually serve HTTPS (SECURE_COOKIES=true behind a TLS proxy).
    hsts: SECURE_COOKIES,
  })
);

app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(cookieParser(SESSION_SECRET));

const FileStore = FileStoreFactory(session);
app.use(
  session({
    name: 'sid',
    store: new FileStore({
      path: path.join(__dirname, 'data', 'sessions'),
      retries: 1,
      ttl: 60 * 60 * 24 * 7,
      logFn: () => {},
    }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: SECURE_COOKIES,
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    },
  })
);

// ---- CSRF protection (double-submit cookie) ----
const { generateToken, doubleCsrfProtection } = doubleCsrf({
  getSecret: () => CSRF_SECRET,
  cookieName: SECURE_COOKIES ? '__Host-csrf' : 'csrf',
  cookieOptions: { sameSite: 'lax', secure: SECURE_COOKIES, path: '/' },
  size: 64,
  getTokenFromRequest: (req) => req.headers['x-csrf-token'],
});

// ---- CORS for API-key clients (e.g. the browser extension) ----
// Cross-origin API access is allowed ONLY for requests that carry an
// Authorization header (API-key / Bearer auth) or are safe GET reads. We
// reflect the request origin and do NOT allow credentials, so cookie-based
// sessions remain strictly same-origin (the browser UI is unaffected).
app.use('/api', (req, res, next) => {
  const hasBearer = (req.headers.authorization || '').startsWith('Bearer ');
  const origin = req.headers.origin;
  const isRead = req.method === 'GET' || req.method === 'HEAD';
  if (origin && (hasBearer || isRead || req.method === 'OPTIONS')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-CSRF-Token');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Endpoint the frontend calls to obtain a CSRF token.
app.get('/api/csrf', (req, res) => {
  res.json({ token: generateToken(req, res) });
});

// Public config the frontend reads on load (brand name, etc.).
app.get('/api/config', (req, res) => {
  res.json({ appName: APP_NAME, taglines: loadTaglines() });
});

app.use(loadUser);

// ---- Rate limiters ----
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'You are doing that too quickly. Slow down a moment.' },
});

// Apply CSRF to all mutating API routes.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // API-key (bearer token) requests don't use cookies, so CSRF — which
  // defends cookie-based auth — doesn't apply to them.
  if (req.viaApiKey) return next();
  return doubleCsrfProtection(req, res, next);
});

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth', authRoutes);
app.use('/api/sites', writeLimiter, siteRoutes);
app.use('/api/admin', adminRoutes);

// Serve index.html with the brand name injected, so the title and header
// are correct on first paint (no flash of the default name). Other static
// assets fall through to express.static below.
const INDEX_PATH = path.join(__dirname, 'public', 'index.html');
function sendIndex(req, res) {
  fs.readFile(INDEX_PATH, 'utf8', (err, html) => {
    if (err) return res.status(500).send('Could not load the page.');
    res.type('html').send(html.replaceAll('{{APP_NAME}}', APP_NAME));
  });
}
app.get('/', sendIndex);
app.get('/index.html', sendIndex);
// /search is a client-side route; serve the same SPA shell so direct loads,
// refreshes, and shared links like /search?q=foo&p=2 work.
app.get('/search', sendIndex);

// Static frontend + uploaded icons.
app.use(express.static(path.join(__dirname, 'public')));

// CSRF errors -> clean 403.
app.use((err, req, res, next) => {
  if (err && err.code === 'EBADCSRFTOKEN') {
    return res.status(403).json({ error: 'Security token expired. Refresh the page and try again.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

app.listen(PORT, () => {
  console.log(`\x1b[36m${APP_NAME} running at http://localhost:${PORT}\x1b[0m`);
  console.log('The first account you register becomes the admin.');
});
