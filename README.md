# Requests counter ([counter.pepega.app](https://counter.pepega.app))

Cloudflare Worker service for a Twitch-authenticated GitHub requests counter with an OBS widget output.

## What this service does

- Signs users in with Twitch OAuth.
- Connects each user to GitHub via GitHub App user tokens (no PAT input).
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
- GitHub App with user permission `Plan: read`

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
- `GITHUB_APP_CLIENT_ID`
- `TWITCH_CLIENT_ID`

Base `vars` are local defaults for `wrangler dev`.
Production overrides live under `env.production`.

### Secrets (`wrangler secret put ...`)

- `TWITCH_CLIENT_SECRET`
- `SESSION_SECRET`
- `GITHUB_APP_CLIENT_SECRET`
- `SECRETS_ENCRYPTION_KEY_B64`

### Example `.env`

See `.env.example`:

```env
APP_BASE_URL=http://localhost:8787
GITHUB_APP_CLIENT_ID=replace_with_github_app_client_id
GITHUB_APP_CLIENT_SECRET=replace_with_github_app_client_secret
TWITCH_CLIENT_ID=replace_with_twitch_client_id
TWITCH_CLIENT_SECRET=replace_with_twitch_client_secret
SESSION_SECRET=replace_with_session_secret
SECRETS_ENCRYPTION_KEY_B64=replace_with_base64_32_byte_key
```

## Database and migrations

Migration files:

- `migrations/001_init.sql`
- `migrations/002_add_obs_title.sql`
- `migrations/003_github_app_auth_hard_cutover.sql`

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
- `GITHUB_AUTH_FAILED`
- `GITHUB_TOKEN_INVALID`
- `GITHUB_FORBIDDEN`
- `GITHUB_RATE_LIMITED`
- `GITHUB_NETWORK_ERROR`

## API reference

### `GET /api/auth/twitch/login`

Starts Twitch OAuth flow.

Behavior:

- Sets `rc_oauth_state_twitch` cookie (10 min).
- Redirects (`302`) to Twitch authorize URL.

Auth required: no.

### `GET /api/auth/twitch/callback`

Completes OAuth flow.

Query params:

- `code`
- `state`

Behavior:

- Verifies `state` against `rc_oauth_state_twitch` cookie.
- On success:
  - upserts user
  - creates session
  - sets `rc_session` cookie (24h)
  - redirects (`302`) to `/`
- On state/code mismatch: redirects to `/?authError=invalid_oauth_state`.
- On Twitch/login failure: redirects to `/?authError=twitch_login_failed`.

Auth required: no.

### `GET /api/auth/github/login`

Starts GitHub App user authorization flow for the currently signed-in user.

Behavior:

- Requires active Twitch session.
- Creates GitHub OAuth state and stores it in `rc_oauth_state_github`.
- Redirects (`302`) to GitHub authorize URL.

Auth required: yes.

### `GET /api/auth/github/callback`

Completes GitHub App user authorization flow.

Query params:

- `code` (on success)
- `state`
- `error` / `error_description` (when user cancels or GitHub rejects)

Behavior:

- Requires active Twitch session (otherwise redirects to `/?githubAuthError=session_expired`).
- Verifies `state` against `rc_oauth_state_github`.
- Exchanges `code` for expiring GitHub App user tokens (access + refresh).
- Fetches GitHub user profile (`/user`) and stores encrypted tokens + GitHub login metadata.
- Clears cached OBS payload so next load uses fresh auth state.
- Redirects to `/?githubAuth=connected` on success.
- Redirects to `/?githubAuthError=cancelled` on `access_denied`.
- Redirects to `/?githubAuthError=state` on state mismatch.
- Redirects to `/?githubAuthError=failed` on other errors.

Auth required: Twitch session required for successful completion.

### `POST /api/auth/github/disconnect`

Removes stored GitHub connection (access/refresh tokens and metadata).

Behavior:

- Clears all `github_*` auth fields for the user.
- Clears cached OBS payload.

Response:

```json
{ "ok": true }
```

Auth required: yes.
Origin check: required.

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
  "githubAuthStatus": "connected",
  "githubConnected": true,
  "githubLogin": "octocat",
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
- `githubAuthStatus` is one of `missing`, `connected`, `reconnect_required`.
- `monthlyQuota` can be `null`.
- `obsTitle` falls back to default title when empty/not set.

Auth required: yes.

### `PUT /api/settings`

Updates quota/title.

Accepted JSON fields (all optional, but at least one is required):

- `monthlyQuota`: `integer` (1..1_000_000_000)
- `obsTitle`: `string` (max 120)

Rules:

- At least one of `monthlyQuota`, `obsTitle` must be provided.
- Empty `obsTitle` resets to default title.
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
- Requires configured `monthly_quota` and GitHub connection (stored encrypted GitHub App user tokens).
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

- GitHub access/refresh tokens are never returned by API responses.
- GitHub access/refresh tokens are encrypted with AES-GCM before storing in D1.
- Session cookie flags: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, `Max-Age=86400`.
- Session token is stored hashed in D1 (`SHA-256` over `SESSION_SECRET:token`).
- OAuth state cookies (`rc_oauth_state_twitch`, `rc_oauth_state_github`) are `HttpOnly`/`Secure` and short-lived.

## Deploy

1. Apply remote migrations:

```bash
pnpm d1:migrate:remote
```

2. Set required secrets:

```bash
pnpx wrangler secret put TWITCH_CLIENT_SECRET --env production
pnpx wrangler secret put SESSION_SECRET --env production
pnpx wrangler secret put GITHUB_APP_CLIENT_SECRET --env production
pnpx wrangler secret put SECRETS_ENCRYPTION_KEY_B64 --env production
```

3. Deploy worker:

```bash
pnpm run deploy
```

`pnpm deploy` runs `wrangler deploy --env production`.

## Twitch app setup

OAuth redirect URL must point to your deployed worker callback:

- `https://<your-domain>/api/auth/twitch/callback`

`<your-domain>` must match `APP_BASE_URL`.

## GitHub App setup

Configure your GitHub App with:

- User permissions: `Plan` -> `Read-only`
- Callback URL: `https://<your-domain>/api/auth/github/callback`

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
├── 001_init.sql                          # Initial schema
├── 002_add_obs_title.sql                 # Add obs_title column
└── 003_github_app_auth_hard_cutover.sql  # Replace PAT with GitHub App user auth
```

## Troubleshooting

### `SECRETS_ENCRYPTION_KEY_B64` errors

If you see messages like invalid base64 or invalid key length, generate a proper key:

```bash
openssl rand -base64 32 | tr -d '\n'
```

`SECRETS_ENCRYPTION_KEY_B64` must decode to exactly 32 bytes.

### Stored GitHub tokens cannot be decrypted after key change

If you rotate `SECRETS_ENCRYPTION_KEY_B64`, old encrypted GitHub tokens become undecryptable.
Users must reconnect GitHub so new tokens are encrypted with the new key.

### `403` on mutating API calls

Check `Origin` header and `APP_BASE_URL` origin match.
This often fails when calling API from another domain/tool without setting `Origin`.

### Local D1 database not working

Make sure you run migrations before starting dev server:

```bash
pnpm d1:migrate:local
```
