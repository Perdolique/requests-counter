# requests-counter

Cloudflare Worker service for a Twitch-authenticated GitHub requests counter with an OBS widget output.

## What this service does

- Signs users in with Twitch OAuth.
- Stores each user's GitHub PAT in encrypted form.
- Calculates "requests available today" from GitHub premium request usage.
- Exposes a public OBS widget URL (`/obs?uuid=...`) per user.
- Caches OBS payload in D1 for 5 minutes.

## Tech stack

- **Cloudflare Workers** (`wrangler 4.65.0`)
- **Hono 4.11.9** (API routing)
- **D1** (users, sessions, OBS cache)
- **Valibot 1.2.0** (runtime validation)
- **Assets binding** for static files (`public/*`)
- **TypeScript 5.9.3**

## Prerequisites

- Node.js 18+ + pnpm
- Cloudflare account with Workers and D1 enabled
- Twitch app (OAuth client ID and secret)
- GitHub PAT with `copilot_seat_management:read` scope for testing

## Local development

1. Install dependencies:

```bash
pnpm install
```

2. Copy environment file:

```bash
cp .env.example .env
```

3. Fill `.env` values.

4. Apply local migrations:

```bash
pnpm d1:migrate:local
```

5. Start the worker:

```bash
pnpm dev
```

`wrangler dev` reads `.env` automatically for local development.
Production routes are configured only in `env.production` to avoid local dev origin conflicts.

## Configuration

### Vars (`wrangler.jsonc`)

- `APP_BASE_URL`
- `TWITCH_CLIENT_ID`

Base `vars` are local defaults for `wrangler dev`.
Production overrides live under `env.production`.

### Secrets (`wrangler secret put ...`)

- `TWITCH_CLIENT_SECRET`
- `SESSION_SECRET`
- `PAT_ENCRYPTION_KEY_B64`

### Example `.env`

See `.env.example`:

```env
APP_BASE_URL=http://localhost:8787
TWITCH_CLIENT_ID=replace_with_twitch_client_id
TWITCH_CLIENT_SECRET=replace_with_twitch_client_secret
SESSION_SECRET=replace_with_session_secret
PAT_ENCRYPTION_KEY_B64=replace_with_base64_32_byte_key
```

## Database and migrations

Migration files:

- `migrations/001_init.sql`
- `migrations/002_add_obs_title.sql`

Commands:

```bash
pnpm d1:migrate:local
pnpm d1:migrate:remote
```

Main tables:

- `users`
- `sessions`
- `usage_cache`

## HTTP behavior

- API prefix is `/api/*`.
- Unknown API route returns JSON `404` (`NOT_FOUND`).
- Static routing:
  - `/` -> `public/index.html`
  - `/obs` -> `public/obs.html`
- Non-`GET`/`HEAD` requests outside `/api/*` return `405 Method Not Allowed`.

## API error format

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "..."
  }
}
```

Possible `error.code` values:

- `VALIDATION_ERROR`
- `UNAUTHORIZED`
- `NOT_FOUND`
- `GITHUB_TOKEN_INVALID`
- `GITHUB_FORBIDDEN`
- `GITHUB_RATE_LIMITED`
- `GITHUB_NETWORK_ERROR`

## API reference

### `GET /api/auth/twitch/login`

Starts Twitch OAuth flow.

Behavior:

- Sets `rc_oauth_state` cookie (10 min).
- Redirects (`302`) to Twitch authorize URL.

Auth required: no.

### `GET /api/auth/twitch/callback`

Completes OAuth flow.

Query params:

- `code`
- `state`

Behavior:

- Verifies `state` against `rc_oauth_state` cookie.
- On success:
  - upserts user
  - creates session
  - sets `rc_session` cookie (24h)
  - redirects (`302`) to `/`
- On state/code mismatch: redirects to `/?authError=invalid_oauth_state`.
- On Twitch/login failure: redirects to `/?authError=twitch_login_failed`.

Auth required: no.

### `POST /api/auth/logout`

Destroys current session and clears session cookie.

Response:

```json
{ "ok": true }
```

Auth required: no active session is tolerated; call is still valid.
Origin check: required.

### `DELETE /api/account`

Deletes current user and related data.

Behavior:

- Deletes row from `users`.
- `sessions` and `usage_cache` are removed by FK cascade.
- Clears session cookie.

Response:

```json
{ "ok": true }
```

Auth required: yes.
Origin check: required.

### `GET /api/me`

Returns current user profile and settings.

Response shape:

```json
{
  "cacheUpdatedAt": "2026-02-13T10:00:00.000Z",
  "hasPat": true,
  "monthlyQuota": 300,
  "obsTitle": "Copilot requests available today",
  "obsUrl": "https://counter.pepega.app/obs?uuid=...",
  "user": {
    "displayName": "Streamer",
    "login": "streamer_login",
    "twitchUserId": "123456"
  }
}
```

Notes:

- `cacheUpdatedAt` can be `null`.
- `monthlyQuota` can be `null`.
- `obsTitle` falls back to default title when empty/not set.

Auth required: yes.

### `PUT /api/settings`

Updates PAT/quota/title.

Accepted JSON fields (all optional, but at least one is required):

- `pat`: `string` (1..2048)
- `monthlyQuota`: `integer` (1..1_000_000_000)
- `obsTitle`: `string` (max 120)

Rules:

- At least one of `pat`, `monthlyQuota`, `obsTitle` must be provided.
- Empty `obsTitle` resets to default title.
- When saving PAT for the first time and no quota exists yet, `monthlyQuota` defaults to `300` (or uses provided value).
- PAT is validated against GitHub before save.
- Successful update clears cached OBS payload for the user.

Response:

```json
{ "ok": true }
```

Auth required: yes.
Origin check: required.

### `POST /api/obs/regenerate`

Regenerates user's OBS UUID and returns new OBS URL.

Response:

```json
{ "obsUrl": "https://counter.pepega.app/obs?uuid=..." }
```

Auth required: yes.
Origin check: required.

### `GET /api/obs-data?uuid=...`

Public endpoint consumed by OBS widget.

Query params:

- `uuid`: required, valid UUID.

Response shape:

```json
{
  "dailyTarget": 60.5,
  "todayAvailable": 42.25,
  "display": "42.25/60.5",
  "title": "Copilot requests available today",
  "updatedAt": "2026-02-13T10:00:00.000Z"
}
```

Behavior:

- Reads user by `obs_uuid`.
- Requires configured `monthly_quota` and encrypted PAT.
- Uses D1 cache (`usage_cache`) with TTL 5 minutes.
- Cache logic:
  - fresh cache -> return cache
  - stale/missing cache -> fetch GitHub and overwrite cache
  - stale/missing cache + GitHub failure -> return error (no stale fallback)

Auth required: no.

## Origin checks for mutating routes

All mutating API methods (`POST`, `PUT`, `PATCH`, `DELETE`) under `/api/*` require:

- `Origin` header present
- `Origin` exactly equal to `new URL(APP_BASE_URL).origin`

Otherwise request fails with `403 VALIDATION_ERROR`.

## OBS widget

- Personal OBS link format: `/obs?uuid=<uuid>`.
- Widget page polls `/api/obs-data` every 60 seconds.
- If URL is regenerated via `/api/obs/regenerate`, previous UUID stops working.

## Security notes

- PAT is never returned by API responses.
- PAT is encrypted with AES-GCM before storing in D1.
- Session cookie flags: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, `Max-Age=86400`.
- Session token is stored hashed in D1 (`SHA-256` over `SESSION_SECRET:token`).
- OAuth state cookie is also `HttpOnly`/`Secure` and short-lived.

## Deploy

1. Apply remote migrations:

```bash
pnpm d1:migrate:remote
```

2. Set required secrets:

```bash
wrangler secret put TWITCH_CLIENT_SECRET --env production
wrangler secret put SESSION_SECRET --env production
wrangler secret put PAT_ENCRYPTION_KEY_B64 --env production
```

3. Deploy worker:

```bash
pnpm deploy
```

`pnpm deploy` runs `wrangler deploy --env production`.

## Twitch app setup

OAuth redirect URL must point to your deployed worker callback:

- `https://<your-domain>/api/auth/twitch/callback`

`<your-domain>` must match `APP_BASE_URL`.

## Project structure

```
src/
├── lib/           # Business logic, middleware, utilities
├── types/         # TypeScript type definitions
└── worker.ts      # Main entry point

public/
├── index.html     # Main UI
├── index.js       # Main UI logic
├── obs.html       # OBS widget UI
└── obs.js         # OBS widget logic

migrations/
├── 001_init.sql          # Initial schema
└── 002_add_obs_title.sql # Add obs_title column
```

## Troubleshooting

### `PAT_ENCRYPTION_KEY_B64` errors

If you see messages like invalid base64 or invalid key length, generate a proper key:

```bash
openssl rand -base64 32 | tr -d '\n'
```

`PAT_ENCRYPTION_KEY_B64` must decode to exactly 32 bytes.

### PAT cannot be decrypted after key change

If you rotate `PAT_ENCRYPTION_KEY_B64`, old encrypted PAT values become undecryptable.
You must save PAT again in the UI so it is encrypted with the new key.

### `403` on mutating API calls

Check `Origin` header and `APP_BASE_URL` origin match.
This often fails when calling API from another domain/tool without setting `Origin`.

### Local D1 database not working

Make sure you run migrations before starting dev server:

```bash
pnpm d1:migrate:local
```
