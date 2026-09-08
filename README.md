# Social Site

A full-service social media platform. No ads. No algorithms. Just people.

## Philosophy

- Chronological feeds by default
- User-controlled feed filters
- No algorithmic ranking
- No ads
- No dark patterns
- Modular architecture

## Tech Stack

- **Backend:** Node.js + Express + TypeScript + SQLite (better-sqlite3)
- **Frontend:** React 18 + TypeScript + Vite
- **Auth:** JWT tokens (7-day expiry)
- **Database:** SQLite with WAL mode, foreign keys enabled

## Quick Start

```bash
npm install
npm run dev
```

### npm lifecycle-script policy

npm 12 blocks dependency lifecycle scripts unless the project explicitly
approves them. The version-pinned `allowScripts` entries in `package.json`
approve only the native tooling required by this lockfile:

- `better-sqlite3@11.10.0` downloads and verifies a compatible prebuilt SQLite
  binding, or builds the binding from source with `node-gyp` when necessary.
- `esbuild@0.21.5` and `esbuild@0.28.2` select, prepare, and version-check the
  platform-specific esbuild executables used by Vite and `tsx`.

When one of these packages changes version, review its lifecycle script and
update the pinned approval instead of adding an unversioned or blanket
approval. `npm install-scripts ls` should report no blocked required scripts
after installation.

Opens:
- Frontend: http://localhost:5174
- API: http://localhost:3003 (proxied through Vite)

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start both API server + Vite dev server |
| `npm run server` | Start API server only |
| `npm run client` | Start Vite dev server only |
| `npm run build` | TypeScript check + Vite production build |
| `npm run seed` | Seed isolated development storage |
| `npm run seed -- --reset --confirm-dev-reset` | Reset and reseed isolated development storage |
| `npm run cleanup:test-data -- --confirm-dev-cleanup` | Remove known test data from isolated development storage |
| `npm run smoke` | Start a temporary isolated API and run smoke checks |
| `npm run smoke:live` | Run read-only smoke checks against an already-running target |
| `npm run preview` | Preview production build |

Development commands force `NODE_ENV=development`; they do not inherit a production mode from `.env`.

## API Endpoints

### Auth
- `POST /api/auth/register` — Create account
- `POST /api/auth/login` — Log in
- `GET /api/auth/me` — Current user
- `GET /api/auth/providers` — Which social providers are configured
- `GET /api/auth/google` — Start Google OAuth login
- `GET /api/auth/google/callback` — Google OAuth callback
- `GET /api/auth/steam` — Start Steam OpenID login
- `GET /api/auth/steam/callback` — Steam OpenID callback

### Feed
- `GET /api/feed?level=everyone|extended|friends|world` — Chronological Home feed. Native levels may include user-controlled World Feed injection; `world` returns only approved RSS/podcast items.

### Posts
- `POST /api/posts` — Create post
- `GET /api/posts/:id` — Get post
- `DELETE /api/posts/:id` — Delete post

### Users
- `GET /api/users/:username` — User profile
- `PUT /api/users/profile` — Update own profile
- `GET /api/users?q=` — Search users
- `GET /api/users/me/games` — Current user's game preferences

### Follows
- `POST /api/follows/:userId` — Follow
- `DELETE /api/follows/:userId` — Unfollow

### Likes
- `POST /api/likes/:postId` — Like
- `DELETE /api/likes/:postId` — Unlike

### Comments
- `POST /api/comments/:postId` — Add comment
- `GET /api/comments/:postId` — Get comments

### Reposts
- `POST /api/reposts/:postId` — Repost

### Groups
- `POST /api/groups` — Create group
- `GET /api/groups` — List groups
- `GET /api/groups/:id` — Group detail + feed
- `POST /api/groups/:id/join` — Join
- `POST /api/groups/:id/leave` — Leave

### Notifications
- `GET /api/notifications` — List notifications
- `GET /api/notifications/unread-count` — Unread count
- `POST /api/notifications/read-all` — Mark all read

### Admin
- `GET /api/admin/users` — List users
- `POST /api/admin/users/:id/ban` — Ban user
- `POST /api/admin/users/:id/unban` — Unban user
- `DELETE /api/admin/users/:id` — Delete user (cascades posts, follows, likes, groups, notifications, etc.)
- `POST /api/admin/users/:id/verify` — Verify user
- `POST /api/admin/users/:id/unverify` — Unverify user (not allowed on admins)
- `POST /api/admin/users/:id/role` — Change user role
- `GET /api/admin/posts` — List posts
- `POST /api/admin/posts/:id/hide` — Hide post
- `POST /api/admin/posts/:id/unhide` — Unhide post
- `POST /api/reports` — Submit a post/comment report (verified users; rate-limited, visible targets only)
- `GET /api/admin/reports` — Review reports (admin only)

**Admin user deletion rules:**
- Admin cannot delete their own account
- Admin cannot delete the last remaining admin account
- Deleting a user cascades: posts, comments, follows, likes, reactions, notifications, group memberships (and groups they own), reports they filed, game preferences, LFG posts, block/mute rows, OAuth provider links, RSS comments, RSS source blocks
- `reports.resolved_by` is nulled before delete (nullable FK, no cascade)

### Games
- `GET /api/games?q=` — Game catalog search/list
- `GET /api/games/:slug` — Game detail, LFG, live servers, and opted-in player discovery
- `POST /api/games/:slug/profile` — Add or update a game on your profile
- `DELETE /api/games/:slug/profile` — Remove a game from your profile

Users can list games they play as profile expression, including platform, play style, mic preference, LFG status, favorite status, visibility, and notes. Game Discovery is opt-in: listed games can remain visible on a profile, but same-game player discovery only shows verified, non-banned, opted-in users who expose that game. Profile privacy and block/mute rules still apply. Matching is explicit shared-game matching and filters only, not algorithmic ranking.

## Database

SQLite runs in WAL mode. Storage is selected centrally by `server/config.ts`:

| Mode | Database default | Uploads default |
|------|------------------|-----------------|
| Development (default) | `data/dev-social.db` | `uploads-dev/` |
| Production (`NODE_ENV=production`) | `data/social.db` | `uploads/` |
| Test (`NODE_ENV=test`) | Explicit `DATABASE_PATH` required | Explicit `UPLOADS_DIR` required |

Set `DATABASE_PATH` and `UPLOADS_DIR` to override these paths. Relative values
are resolved from the repository root. Non-production processes refuse paths
that resolve to production storage, including symlink aliases. Test mode has no
fallback. Parent directories are created only after configuration passes these
checks.

The isolated smoke harness creates both test paths under a unique
`/tmp/refugecloud-smoke.*` directory and removes them when it exits:

```bash
npm run smoke
```

To inspect an existing deployed site without starting a server, use:

```bash
SMOKE_BASE_URL=https://refugecloud.com npm run smoke:live
```

Core tables include:
- users, posts, follows, likes, groups_table, group_members, notifications, reports, user_auth_providers

## Environment

Copy `.env.example` to `.env` and fill in values.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3003` | API server port |
| `DATABASE_PATH` | mode-dependent | SQLite file; relative paths resolve from repository root |
| `UPLOADS_DIR` | mode-dependent | Media directory; relative paths resolve from repository root |
| `JWT_SECRET` | dev secret | JWT signing secret |
| `SESSION_SECRET` | dev secret | Express session secret for OAuth |
| `APP_BASE_URL` | `http://localhost:3003` | Backend base URL |
| `WEB_BASE_URL` | `http://localhost:5174` | Frontend base URL |
| `GOOGLE_CLIENT_ID` | — | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | — | Google OAuth client secret |
| `GOOGLE_CALLBACK_URL` | — | Google redirect URI |
| `STEAM_API_KEY` | — | Steam Web API key |
| `STEAM_RETURN_URL` | — | Steam OpenID return URL |

## Google OAuth Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Create a project → OAuth consent screen (External, add test users)
3. Create OAuth 2.0 Client ID (Web application)
4. Add authorized redirect URI:
   - `http://localhost:3003/api/auth/google/callback`
   - (or your APP_BASE_URL + /api/auth/google/callback)
5. Copy Client ID and Client Secret to `.env`

## Steam OpenID Setup

1. Get a Steam Web API key at [https://steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey)
2. Set `STEAM_API_KEY` in `.env`
3. Set `STEAM_RETURN_URL` to `http://localhost:3003/api/auth/steam/callback`
4. No redirect URI registration needed — Steam uses OpenID return URL

## Staging / Production Requirements

Before pointing a real domain at this app, complete all of the following.

### Required — will fail to start without these in production

| Step | What to do |
|------|------------|
| `JWT_SECRET` | Set to a random 48+ byte hex string. Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `SESSION_SECRET` | Same as above, use a different value |
| `NODE_ENV=production` | The server **refuses to start** if either secret is missing when `NODE_ENV=production` |

### Required — for secure HTTPS operation

| Step | What to do |
|------|------------|
| Use HTTPS | The session cookie uses `secure: true` in production — HTTP will break OAuth sessions |
| `TRUST_PROXY=1` | Set this when running behind Nginx Proxy Manager. Required for rate limiting to see real client IPs |
| Update `WEB_BASE_URL` | Set to your real frontend domain (e.g. `https://yourdomain.com`) |
| Update `APP_BASE_URL` | Set to your real API domain (e.g. `https://yourdomain.com` or `https://api.yourdomain.com`) |

### Parked — not yet enabled

| Feature | Status |
|---------|--------|
| Direct video uploads | Disabled (`ENABLE_VIDEO_UPLOADS=false`). Requires storage/bandwidth planning before enabling. |
| Email verification / password reset | Not implemented. Parked until real domain + email provider are configured. |
| OAuth (Google / Steam) | Works but requires real callback URLs registered with each provider. |

### Never do these

- Do not commit `.env` to version control
- Do not share `JWT_SECRET` or `SESSION_SECRET`
- Do not run with the dev fallback secrets in production (`JWT_SECRET` empty = server refuses to start)

### Quick production checklist

```bash
# 1. Copy and fill in secrets
cp .env.example .env
# Edit .env: set JWT_SECRET, SESSION_SECRET, NODE_ENV=production, TRUST_PROXY=1,
#            WEB_BASE_URL, APP_BASE_URL, DATABASE_PATH=data/social.db,
#            UPLOADS_DIR=uploads

# 2. Build
npm run build

# 3. Start (production)
npm run start
```

## LAN Testing

For testing from another machine on the LAN, update `.env`:
```
APP_BASE_URL=http://192.168.254.181:3003
WEB_BASE_URL=http://192.168.254.181:5174
GOOGLE_CALLBACK_URL=http://192.168.254.181:3003/api/auth/google/callback
STEAM_RETURN_URL=http://192.168.254.181:3003/api/auth/steam/callback
```
The server listens on `0.0.0.0` by default, so it's reachable from LAN.

**Production note:** Set `NODE_ENV=production` and `TRUST_PROXY=1` in `.env`. The server auto-enables `cookie.secure` and enforces required secrets. See the Staging / Production Requirements section.

## Local LAN OAuth Setup

### Google Cloud Console

1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Create a project → Configure OAuth consent screen
   - User Type: External
   - Add test users (your email)
3. Create OAuth 2.0 Client ID:
   - Application type: **Web application**
   - Authorized JavaScript origins:
     - `http://192.168.254.181:5174`
     - `http://192.168.254.181:3003`
   - Authorized redirect URI:
     - `http://192.168.254.181:3003/api/auth/google/callback`
4. Copy Client ID and Client Secret into `.env`:
   ```
   GOOGLE_CLIENT_ID=123456789-xxxxx.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-xxxxx
   ```

### Steam

1. Get a Steam Web API key at https://steamcommunity.com/dev/apikey
   - Domain: `192.168.254.181` (or your LAN IP)
2. Add to `.env`:
   ```
   STEAM_API_KEY=YOUR_STEAM_KEY
   ```
3. The `STEAM_RETURN_URL` should already be set in `.env` to:
   `http://192.168.254.181:3003/api/auth/steam/callback`

### Verify Setup

```bash
curl http://localhost:3003/api/auth/providers
# {"google":true,"steam":true}  ← both should be true when configured
```

When not configured, clicking Google or Steam buttons will show:
- "Google login is not configured yet" (in the UI)
- Redirect to login page with error message (from backend)

## World Feed (RSS)

The World Feed pulls content from external RSS sources into a chronological feed of excerpts. Every RSS item is clearly labeled with its source name and includes an "Open original" link pointing to the publisher's website.

**Philosophy:** External content is never presented as native/local content. No ads, no tracking, no algorithmic ranking. Pure chronological order by published date.

## Home Feed Controls

Home feed levels control the native social circle:
- **Everyone** — public native posts from verified users
- **Friends of Friends** — people you follow plus extended circle
- **Just Friends** — your posts and people you follow
- **Approved World Feeds** — only approved RSS/podcast items

The **World Feed on Home** preference controls whether approved RSS/podcast items are mixed into normal native Home feeds:
- **Off** — only native posts appear
- **Few** — occasionally adds approved RSS/podcast items
- **Balanced** — adds more approved RSS/podcast items

Injected external items remain visibly labeled as World Feed/RSS/podcast content and are rendered separately from native posts. RSS source blocking applies to Home injection. Native block/mute still applies to native posts. No engagement data, ads, boosted posts, or algorithmic ranking are used.

### How It Works

1. Admins add RSS sources via the Admin Dashboard → RSS Sources tab
2. Admins manually fetch sources ("Fetch" or "Fetch All Active")
3. RSS items are parsed, sanitized (scripts/stripped), and stored as excerpts
4. Duplicate items are automatically skipped (matched by source + GUID)
5. The World Feed displays items chronologically at `/world`

### Public Access

The World Feed at `/world` is **publicly accessible** without an account. Unauthenticated visitors can:
- Browse all RSS items chronologically
- Filter by category and source
- Read existing local discussions/comments
- Click "Open original" links

Unauthenticated visitors **cannot**:
- Post comments (login required)
- Block/unblock RSS sources (login required)
- Access any account-required features

A "Log in to join the discussion or customize your sources" prompt appears near interaction areas for logged-out visitors.

### API Routes

| Endpoint | Access | Description |
|----------|--------|-------------|
| `GET /api/world-feed` | Public | World Feed items (supports `?sourceId=&category=&limit=&offset=`) |
| `GET /api/world-feed/sources` | Public | Active sources and categories |
| `GET /api/admin/rss/sources` | Admin | List all RSS sources |
| `POST /api/admin/rss/sources` | Admin | Add a new RSS source |
| `PATCH /api/admin/rss/sources/:id` | Admin | Update source (name, URL, active status, etc.) |
| `POST /api/admin/rss/sources/:id/fetch` | Admin | Fetch a single source now |
| `POST /api/admin/rss/fetch-all` | Admin | Fetch all active sources now |

## Seed Data

```bash
npm run seed
npm run seed -- --reset --confirm-dev-reset
```

Both commands are restricted to isolated non-production storage. Reset requires
the explicit confirmation flag shown above. Production mode or production
database/upload paths cause a loud refusal before SQLite is opened.

Demo accounts created by seed:
- `alice` / `demo1234`
- `bob` / `demo1234`
- `admin` / `admin1234`

Seed also creates follows, posts, likes, comments, groups, notifications, and optional RSS sources (Ars Technica, NASA).

## Gaming Source Bundle

The seed script includes 6 gaming RSS sources covering PC gaming, console news, industry updates, and platform blogs. All gaming feeds are external RSS items — they are never presented as native/local content.

**Included gaming sources (all verified working):**

| Source | Category | Coverage |
|--------|----------|----------|
| PC Gamer | Gaming / PC | PC gaming news, reviews, hardware |
| Rock Paper Shotgun | Gaming / PC | PC gaming culture, reviews, opinion |
| Eurogamer | Gaming | Multi-platform gaming news, reviews |
| Nintendo Life | Gaming / Console | Nintendo news, reviews, eShop |
| GamesIndustry.biz | Gaming / Industry | Game industry business, development |
| Steam Blog | Gaming / Platform | Official Steam platform updates |

**U.S.-sourced Gaming sources:**

| Source | Category |
|--------|----------|
| IGN | Gaming |
| GameSpot | Gaming |
| Polygon | Gaming |
| Kotaku | Gaming |
| Destructoid | Gaming |
| Ars Technica Gaming | Gaming |
| Xbox Wire | Gaming / Platform |
| PlayStation Blog | Gaming / Platform |

**Tech / AI / Hardware sources:**

| Source | Category |
|--------|----------|
| Ars Technica | Tech |
| The Verge | Tech |
| Hacker News | Tech |
| GitHub Blog | Tech |
| Mozilla Blog | Tech |
| NVIDIA Blog | Tech / AI |
| Raspberry Pi | Tech / Hardware |

**Skipped sources (no working RSS found):**
- NVIDIA Newsroom (XML parse error)
- AMD Blog (XML parse error)
- Intel Newsroom (404)
- Game Informer (no RSS feed)
- Giant Bomb (no RSS feed)

**Important notes:**
- All items show source name badge, category, and "Open original →" link
- Admins can deactivate or remove any source from the Admin RSS panel
- Feed URLs may change — admins can edit URLs in the admin panel
- Only excerpts/snippets are stored (max 2000 chars), with attribution

## Media Uploads

**Enabled now:**
- Image uploads (JPG, PNG, GIF, WebP) — max 5MB
- YouTube/external video embeds — normal URLs, shorts, youtu.be links

**Intentionally disabled:**
- SVG uploads are disabled for safety. Use JPG, PNG, GIF, or WebP.
- Direct video uploads (`ENABLE_VIDEO_UPLOADS=false`)
- Can be enabled later with `ENABLE_VIDEO_UPLOADS=true`
- Future video hosting requires serious storage/bandwidth planning

**Feature flags (.env):**

| Variable | Default |
|----------|---------|
| `ENABLE_IMAGE_UPLOADS` | `true` |
| `ENABLE_EXTERNAL_VIDEO_EMBEDS` | `true` |
| `ENABLE_VIDEO_UPLOADS` | `false` |
| `MAX_IMAGE_UPLOAD_MB` | `5` |
| `MAX_AVATAR_UPLOAD_MB` | `2` |
| `MAX_VIDEO_UPLOAD_MB` | `250` |

**Future video support:** The `post_media` table already supports `media_type='video'` with columns for `duration_seconds`, `thumbnail_url`, `processing_status`. When video uploads are enabled, no schema changes needed.

**Production notes:**
- Development media is stored in `uploads-dev/` by default (gitignored)
- Production media is stored in `uploads/` when production mode is explicitly selected
- Production should use object storage (S3, R2) or CDN
- `uploads/` directory must be backed up
- No autoplay on embedded videos
