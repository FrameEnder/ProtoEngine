<div align="center">

# 🔎 ProtoEngine

### A self-hosted, dark-mode search engine for your group's corner of the web.

*Index the sites your people actually use — and find them in one clean, fast search.*

</div>

---

ProtoEngine is a small, self-contained web app for building a private,
searchable directory of websites. Add the links your team, guild, family, or
community relies on, tag them, and search across everything from one tidy
dark-mode page. It runs as a single container, stores everything in one SQLite
file, and needs no external services.

```
┌─────────────────────────────────────────────┐
│                                               │
│                ProtoEngine                    │
│       ╭───────────────────────────────╮       │
│       │  🔍  search your sites…       │       │
│       ╰───────────────────────────────╯       │
│                                               │
│   Search the sites your people actually use.  │
│                                               │
└─────────────────────────────────────────────┘
```

---

## ✨ Features

| | |
|---|---|
| 🔍 **Instant search** | Results show favicon, name, URL, description, and clickable tag chips that filter as you go. Multi-tag filters, sort options, and autocomplete suggestions. |
| 👥 **Accounts & roles** | Register / log in / log out. The **first account becomes admin**. Three tiers: User, Moderator, Admin. |
| ➕ **Add & manage listings** | A `+` button (signed-in only) opens a dialog for name, URL, description, tags, and an uploaded favicon. |
| ⭐ **Favorites** | Pin sites to a personal favorites panel. Drag-and-drop to reorder, switch between **grid and list** views, edit mode for quick removal. Remembered per account. |
| 📰 **RSS feeds & groups** | Add any number of feeds, organize them into **groups**, and switch between groups from the feed panel. Entries are merged and sorted newest-first, fetched and parsed server-side (RSS 2.0 + Atom). |
| 🎨 **Custom branding** | Admins set the brand name, browser tab title, taglines, and pick from **15 hero animations** — all from the Admin panel, no restart needed. |
| 🖼️ **Personalization** | Per-user profile picture and background image, with a frosted-glass results panel over your wallpaper. |
| 🔑 **API access** | Each account can mint a personal API key (Bearer token) carrying its own permissions. |
| 🛡️ **Secure by default** | bcrypt hashing, signed HTTP-only sessions, CSRF on every write, rate limiting, security headers with a strict Content-Security-Policy, upload validation, and transactional SQLite writes. |
| 💾 **Backup & restore** | Download a dated `.zip` snapshot of all listings, taglines, and favicons — and restore it on any instance. |

---

## 🚀 Quick start (local)

```bash
npm install
cp .env.example .env        # then edit .env and set the two secrets
npm start
```

Open **http://localhost:3000** and register — that first account is your admin.

> **Generate strong secrets** for `.env`:
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```
> Use the output as `SESSION_SECRET`, run it again for `CSRF_SECRET`. Skip this
> and the app generates temporary secrets and warns you — sessions then reset
> on every restart.

---

## 🐳 Running with Docker

```bash
cp .env.example .env        # set SESSION_SECRET and CSRF_SECRET
docker compose -f compose.docker.yaml up -d --build
```

Open **http://localhost:3000** and register — the first account is admin.

Your data survives rebuilds through these volumes:

| Volume | Holds |
|---|---|
| `./data` | the SQLite database (`protoengine.db`) + session files |
| `./public/icons` | uploaded favicons |
| `./public/avatars` | profile pictures |
| `./public/backgrounds` | per-user background images |

The container runs as a **non-root user**. If the bind-mounted folders aren't
writable, set `PUID`/`PGID` in `.env` to your host user's id and group (find
them with `id`), or take ownership of the folders once:

```bash
sudo chown -R $(id -u):$(id -g) ./data ./public/icons ./public/avatars ./public/backgrounds
```

To serve it beyond your LAN, put a TLS-terminating reverse proxy in front, keep
`NODE_ENV=production`, and set `SECURE_COOKIES=true` so session cookies are
marked `Secure`. Over plain HTTP, leave `SECURE_COOKIES=false` or logins won't
persist.

---

## ⚙️ Configuration

All configuration is through environment variables (in `.env`):

| Variable | Default | Purpose |
|---|---|---|
| `SESSION_SECRET` | *(required)* | Signs session cookies. Use 32+ random bytes. |
| `CSRF_SECRET` | *(required)* | Signs CSRF tokens. Use 32+ random bytes. |
| `PORT` | `3000` | Port the app listens on. |
| `SECURE_COOKIES` | `false` | Set `true` **only** behind HTTPS, or logins won't persist over plain HTTP. |
| `SQLITE_JOURNAL_MODE` | `DELETE` | SQLite journal mode. Safe everywhere; opt into `WAL` only on a known-good local disk. |
| `PUID` / `PGID` | `1000` | Host user/group the container writes as (Docker bind mounts). |

> The brand name, tab title, taglines, and hero animation are all set from the
> **Admin panel → Branding** page inside the app — no environment variable or
> restart required.

---

## ⚙️ Settings & personalization

Settings live on a dedicated full-page view with a vertical tab rail:

- **Account** — profile picture, username, password.
- **Customization** — your background image.
- **RSS** — manage feeds and groups (collapsible sections) and the refresh interval.
- **Developer** — generate or revoke your personal API key.
- **Admin Panel** *(admins only)* — Branding, Users, Listings, and Backup.

### 📰 RSS feeds & groups

Add feed URLs under **Settings → RSS**, then create **groups** and assign any
feed to any number of groups. The feed panel on the right shows a dropdown
where the group label sits: pick **All Feeds** (every enabled feed) or any
group, and your choice is remembered per account. Entries are fetched and
parsed server-side, cached briefly, and guarded against pointing at
internal/loopback hosts.

---

## 🔑 API access

Mint a personal API key under **Settings → Developer**. It's shown once — copy
it then. Send it as a Bearer token:

```bash
curl -H "Authorization: Bearer lmn_xxxx_yyyy" \
  https://your-host/api/sites?q=docs
```

API requests authenticate as that account and carry its permissions — a user
key manages that user's own listings, a moderator key edits any listing, an
admin key reaches the admin endpoints. Token requests skip CSRF (that protects
cookie sessions, not tokens). Keys are stored **hashed, never in plaintext**,
and can be revoked any time (admins can revoke anyone's from the Users tab).

**Useful endpoints:**

| Method | Endpoint | Notes |
|---|---|---|
| `GET` | `/api/sites` | search / list (public) |
| `POST` | `/api/sites` | add a listing |
| `PATCH` / `DELETE` | `/api/sites/:id` | manage a listing |
| `GET` | `/api/config` | brand name, taglines, animation |

Writes accept multipart form or JSON, with the same fields as the web UI.

---

## 🛡️ How permissions work

| Role | Can do |
|---|---|
| **User** | Manage their own listings; change their own username, password, avatar, background; manage their own favorites, RSS feeds/groups, and API key. |
| **Moderator** | Everything a user can, plus edit or delete **any** listing. |
| **Admin** | Everything, plus the Admin panel: manage users and roles, reset passwords, manage every listing, edit branding, and run backups. |

The **first account to register becomes the admin** automatically.

---

## 🧱 Architecture

```
server.js            Express app: security middleware, sessions, CSRF, routing
data-store.js        SQLite data layer (better-sqlite3)
util.js              Validation + sanitization helpers
middleware/auth.js   Session loading and role/permission guards
routes/
  auth.js            register, login, logout, account self-service, favorites
  sites.js           list/search, add, edit, delete listings (+ icon upload)
  admin.js           users, roles, branding, backup/restore
  rss.js             feeds, groups, aggregated entries
public/
  index.html         single-page shell
  app.js             the entire frontend (vanilla JS, no framework)
  styles.css         dark-mode design system
data/                protoengine.db, sessions/  (created at runtime)
```

**Storage** is a single SQLite database (`data/protoengine.db`) via
`better-sqlite3` — real tables, indexes, and transactions, but still just one
file in your volume with no separate database server.

---

## 🧰 Troubleshooting

| Symptom | Fix |
|---|---|
| Logins don't persist | Over plain HTTP, set `SECURE_COOKIES=false`. Set it `true` only behind HTTPS. |
| Sessions reset on restart | Set real `SESSION_SECRET` / `CSRF_SECRET` in `.env`. |
| Permission errors on `./data` | Set `PUID`/`PGID` to your host user, or `chown` the bind-mounted folders. |
| Imports or saves hang | Leave `SQLITE_JOURNAL_MODE` on the default `DELETE`; WAL needs locking that some mounts lack. |
| First Docker build is slow | Expected — it compiles `better-sqlite3`'s native addon once. |

---

<div align="center">

**ProtoEngine** · self-hosted search for the sites your people actually use.

</div>
