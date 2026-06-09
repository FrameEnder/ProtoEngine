# ProtoEngine

A self-hostable search engine for the websites your group, team, or homelab actually uses. It looks and behaves like dark-mode Google: a centered search, clean result listings with a favicon, the site name, a green-ish URL crumb, a description, and clickable tags at the bottom of each listing. Tags filter the results when tapped.

Listings live in a plain `data/sites.json` file. Accounts live in `data/users.json`. There is no external database to run.

## Features

- **Google-style results** with per-listing favicon, name, URL, description, and clickable tag chips that filter.
- **Accounts**: register, log in, log out. The **first account created becomes the admin** automatically.
- **Add websites** with a top-bar `+` button (visible only when signed in). The dialog collects name, URL, description, tags, and an uploaded favicon.
- **Roles**:
  - **User** — manage their own listings; change their own username and password.
  - **Moderator** — edit and delete any listing.
  - **Admin** — everything moderators can do, plus an **Admin panel** to delete users, change roles, reset passwords, and manage every listing.
- **Security**: bcrypt password hashing, HTTP-only signed session cookies, CSRF protection on every write, rate limiting on auth and writes, Helmet security headers with a strict Content-Security-Policy, upload type/size validation, and atomic JSON writes.

## Quick start (local)

```bash
npm install
cp .env.example .env        # then edit .env and set the two secrets
npm start
```

Open http://localhost:3000 and register — that first account is your admin.

Generate strong secrets for `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Set the output as `SESSION_SECRET`, run it again for `CSRF_SECRET`. If you skip this, the app generates temporary secrets and warns you; sessions then reset on every restart.

## Self-hosting with Podman or Docker

```bash
cp .env.example .env        # set SESSION_SECRET and CSRF_SECRET
podman-compose up -d        # or: docker compose up -d
```

The compose file persists three things via volumes so your data survives rebuilds:

- `./data` — the JSON datastore and session files
- `./public/icons` — uploaded favicons

The container runs as a non-root user. Put it behind a reverse proxy (nginx, Caddy, Traefik) that terminates TLS, and keep `NODE_ENV=production` so session cookies are marked `Secure`.

## Deploying on a UGREEN NAS (UGOS Pro) with Docker

UGOS Pro includes Docker and Compose. Build from the command line over SSH —
it's the most reliable path for a build-from-source app. Use the Docker
compose file (`compose.docker.yaml`), **not** the Podman one.

1. Enable SSH on the NAS: Control Panel → Terminal & SNMP → enable SSH.
2. SSH in and find a place for the app, e.g. a shared folder:
   ```bash
   ssh youruser@your-nas-ip
   cd /volume1/docker        # or wherever you keep app data
   ```
3. Copy the project there (via SCP, the File Manager, or git), then:
   ```bash
   cd searchengine
   id                        # note your uid= and gid=
   ```
4. Create `.env` from the example and set the secrets, plus `PUID`/`PGID`
   to the `uid`/`gid` from the previous step:
   ```bash
   cp .env.example .env
   nano .env
   # set SESSION_SECRET, CSRF_SECRET, and (if your user isn't 1000):
   #   PUID=1000
   #   PGID=1000
   ```
5. Build and start using the Docker compose file:
   ```bash
   docker compose -f compose.docker.yaml up -d --build
   ```
6. Open `http://your-nas-ip:3000` and register — the first account is admin.

Why a separate compose file: the Podman `compose.yaml` uses `userns_mode`
and `:Z` labels that Docker rejects or doesn't need. `compose.docker.yaml`
drops those and adds a `user:` directive (`PUID:PGID`) so the container can
write to the bind-mounted `./data` and `./public/icons` folders.

If you hit permission errors on `./data`, make the host folders owned by your
NAS user once: `sudo chown -R $(id -u):$(id -g) ./data ./public/icons`.

To expose it outside your LAN, use UGOS's reverse proxy (or your own) to put
HTTPS in front, then set `SECURE_COOKIES=true` in `.env` and restart.

## Account settings

Account settings is organized into tabs:

- **Login & security** — change username/password, generate or revoke your API key.
- **Customization** — profile picture and per-user background image.
- **RSS feeds** — add feed URLs and toggle, per feed, whether it's enabled and
  whether it appears on the main page and/or the search page. Enabled feeds
  render in a panel on the right side of the screen (on wide viewports), with
  entries merged and sorted newest-first. Feeds are fetched and parsed
  server-side (RSS 2.0 and Atom), cached briefly, with a guard against
  pointing feeds at internal/loopback hosts.

## API access

Each account can generate a personal API key from Account settings. The key
is shown once — copy it then. Send it as a Bearer token:

```bash
curl -H "Authorization: Bearer lmn_xxxx_yyyy" \
  https://your-host/api/sites?q=docs
```

API requests authenticate as that account and carry its permissions: a user
key can manage that user's own listings; a moderator key can edit any listing;
an admin key can use the admin endpoints. Token requests skip CSRF (that
protects cookie sessions, not tokens). Revoke a key any time from Account
settings; admins can revoke any user's key from the admin panel's Users tab.
Keys are stored hashed, never in plaintext.

Useful endpoints: `GET /api/sites` (search/list, public), `POST /api/sites`
(add), `PATCH/DELETE /api/sites/:id` (manage), `GET /api/config`. Writes via
multipart form or JSON, same fields as the web UI.

## Project layout

```
server.js            Express app: security middleware, sessions, CSRF, routing
data-store.js        Atomic JSON read/write with a per-file write queue
util.js              Validation + sanitization helpers
middleware/auth.js   Session loading and role/permission guards
routes/auth.js       register, login, logout, account self-service
routes/sites.js      list/search, add, edit, delete listings (+ icon upload)
routes/admin.js      user management (admin only)
public/              Frontend: index.html, styles.css, app.js
data/                users.json, sites.json, sessions/  (created at runtime)
```

## How permissions are enforced

Every mutating request is checked on the server, not just hidden in the UI:

- Adding a listing requires any signed-in account.
- Editing or deleting a listing requires being its owner, a moderator, or an admin.
- The admin panel routes require the admin role.
- The last remaining admin cannot be demoted or deleted, so you can never lock yourself out.

## Customizing the name and taglines

- **Brand name**: set `APP_NAME` in `.env` (defaults to `Lumen`). It appears in the page title, header, hero word, and sign-in dialog.
- **Taglines**: edit `data/tagline.json` — a JSON array of strings shown under the search box. One is picked at random per page load. The file is read fresh on every request, so edits apply on the next reload with no restart. If it's missing it's recreated with a default; if it's malformed the app falls back to the default rather than failing.

```json
[
  "Search the sites your people actually use.",
  "Your group's corner of the web, indexed.",
  "Find what your team built, fast."
]
```

## Notes

- Search matches across name, URL, description, and tags; multiple words are ANDed.
- URLs without a scheme get `https://` added automatically.
- Favicons accept PNG, JPG, GIF, WEBP, SVG, or ICO up to 512 KB.
- When a user is deleted, the admin chooses whether to also remove their listings or keep them (re-labeled as belonging to a deleted user).
