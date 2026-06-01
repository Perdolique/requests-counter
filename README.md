# GitHub Copilot AI Credits Counter ([counter.pepega.app](https://counter.pepega.app))

Cloudflare Worker service for counting GitHub Copilot AI Credits with a GitHub-authenticated dashboard and OBS widget output.

## What this service does

- Signs users in with GitHub OAuth (GitHub App user tokens).
- Stores encrypted GitHub access/refresh tokens in D1.
- Lets users configure Copilot subscription plan, optional monthly budget, and optional OBS widget title.
- Calculates “AI Credits available today” from GitHub Copilot billing usage summary data.
- Serves an OBS-friendly JSON endpoint and a simple dashboard UI.

## Tech stack

- Cloudflare Workers + Hono
- Cloudflare D1
- Plain HTML/CSS/JS frontend (served as static assets from Worker)
- TypeScript
- `valibot` for validation

## Prerequisites

- Node.js 20+
- `pnpm`
- Cloudflare account + D1 database
- GitHub App with user permission `Plan: read`

## GitHub billing API preflight

The app uses GitHub's user billing summary endpoint for Copilot AIC data:

```bash
gh api --method GET \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2026-03-10" \
  "/users/<username>/settings/billing/usage/summary?year=2026&month=6&product=copilot"
```

If the response contains only legacy `unitType: "requests"` rows or an empty `usageItems`
array, the dashboard treats it as no AIC usage data yet.

This endpoint is a public preview GitHub API. It requires a GitHub App user token
or fine-grained PAT with user `Plan: read`, and user-level results only cover
Copilot usage billed directly to that personal account.

## Local development

1. Install dependencies:

```bash
pnpm install
```

2. Create local secrets file (optional) or use Wrangler secrets/local env.

3. Apply migrations locally:

```bash
pnpm d1:migrate:local
```

4. Start dev server:

```bash
pnpm dev
```

5. Open `http://localhost:8787`

## Configuration

### Vars (`wrangler.jsonc`)

Required vars:

- `APP_BASE_URL`
- `GITHUB_APP_CLIENT_ID`

### Secrets (`wrangler secret put ...`)

Required secrets:

- `GITHUB_APP_CLIENT_SECRET`
- `SESSION_SECRET`
- `SECRETS_ENCRYPTION_KEY_B64`

### Example `.env`

```env
APP_BASE_URL=http://localhost:8787
GITHUB_APP_CLIENT_ID=replace_with_github_app_client_id
GITHUB_APP_CLIENT_SECRET=replace_with_github_app_client_secret
SESSION_SECRET=replace_with_session_secret
SECRETS_ENCRYPTION_KEY_B64=replace_with_base64_32_byte_key
```

`SECRETS_ENCRYPTION_KEY_B64` must be a base64-encoded 32-byte key.

## Database and migrations

Migrations live in `migrations/` and are applied in order.

Key auth-related migrations:

- `migrations/003_github_app_auth_hard_cutover.sql`
- `migrations/004_github_only_auth_hard_cutover.sql` (destructive reset to GitHub-only auth)

`004_github_only_auth_hard_cutover.sql` drops and recreates:

- `users`
- `sessions`
- `usage_cache`

This is intentional and will remove existing users/sessions/cache data.

Apply migrations:

```bash
pnpm d1:migrate:local
pnpm d1:migrate:remote
```

## HTTP behavior

- All API routes live under `/api/*`
- Mutating routes (`POST`, `PUT`, `DELETE`, `PATCH`) require a valid `Origin` header matching `APP_BASE_URL`
- Auth/session cookies are `HttpOnly`, `Secure`, `SameSite=Lax`
- API responses are JSON unless redirecting during OAuth flow

## API error format

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable message"
  }
}
```

## API reference

### `GET /api/auth/github/login`

Starts GitHub OAuth flow.

Behavior:

- Creates OAuth `state`
- Sets `rc_oauth_state_github` cookie (10 min)
- Redirects (`302`) to GitHub authorize URL

Auth required: No

### `GET /api/auth/github/callback`

Completes GitHub OAuth flow and creates a session.

Query params:

- `code`
- `state`
- `error`
- `error_description`

Behavior:

- Verifies `state` against `rc_oauth_state_github`
- Exchanges `code` for expiring GitHub App user tokens (access + refresh)
- Fetches GitHub user profile (`/user`)
- Creates/updates user by `github_user_id`
- Stores encrypted tokens + GitHub login metadata
- Clears cached OBS payload for the user
- Creates session and sets `rc_session`
- Redirects to `/?auth=connected` on success
- Redirects to `/?authError=cancelled` on `access_denied`
- Redirects to `/?authError=state` on state mismatch
- Redirects to `/?authError=failed` on other errors

Auth required: No (this endpoint creates auth session)

### `POST /api/auth/logout`

Destroys current session and clears `rc_session` cookie.

Response:

```json
{
  "ok": true
}
```

Auth required: No (safe to call even without active session)

### `DELETE /api/account`

Deletes the current user and related data (via foreign keys / cascades).

Response:

```json
{
  "ok": true
}
```

Also clears `rc_session` cookie.

Auth required: Yes

### `GET /api/me`

Returns dashboard/profile state for the current signed-in user.

Response example:

```json
{
  "cacheUpdatedAt": "2026-02-23T10:00:00.000Z",
  "dashboardData": {
    "dailyTarget": 120,
    "daysRemaining": 7,
    "display": "137/120",
    "monthRemaining": 960,
    "usageByPeriod": {
      "month": [
        {
          "label": "copilot_ai_credit",
          "credits": 120
        }
      ],
      "yesterday": [
        {
          "label": "copilot_ai_credit",
          "credits": 9
        }
      ],
      "today": []
    },
    "todayAvailable": 137,
    "usageUnit": "ai_credits"
  },
  "githubAuthStatus": "connected",
  "budgetCents": 1000,
  "budgetCreditQuota": 1000,
  "obsTitle": "Copilot AI Credits available today",
  "obsUrl": "https://counter.pepega.app/obs?uuid=...",
  "planQuota": 1500,
  "quotaBreakdown": {
    "budgetCreditQuota": 1000,
    "budgetRemaining": 1000,
    "configuredTotal": 2500,
    "planQuota": 1500,
    "planRemaining": 1500,
    "totalRemaining": 2500
  },
  "subscriptionPlan": "pro",
  "usageUnit": "ai_credits",
  "user": {
    "githubLogin": "octocat",
    "githubUserId": "12345678"
  }
}
```

Notes:

- `githubAuthStatus` is one of `missing`, `connected`, `reconnect_required`
- `dashboardData` may be `null` if quota or GitHub auth is not ready / temporarily failed
- `dashboardData.display` format is `<todayAvailable>/<dailyTarget>`; `todayAvailable` may be negative when today's spend exceeds the target
- `subscriptionPlan` is one of `pro`, `pro_plus`, `max`
- `budgetCents` is stored in USD cents; `budgetCreditQuota` equals `budgetCents` because `1 AI credit = $0.01`
- budget is always counted in dashboard totals when `budgetCents > 0`
- `quotaBreakdown` contains both configured quota and remaining quota split into plan and budget components
- `cacheUpdatedAt` may be `null`
- legacy request-based Copilot rows (`unitType: "requests"`) are intentionally not counted in AIC-only mode

Auth required: Yes

### `PUT /api/settings`

Updates user settings.

Request body (at least one field required):

```json
{
  "subscriptionPlan": "pro",
  "budgetCents": 1000,
  "obsTitle": "Copilot AI Credits available today"
}
```

Rules:

- `subscriptionPlan`: `pro`, `pro_plus`, or `max`
- `budgetCents`: integer, min `0`, max `1_000_000_000`
- `obsTitle`: string, max 120 chars; empty string resets to default title

Response:

```json
{
  "ok": true
}
```

Auth required: Yes

### `POST /api/obs/regenerate`

Regenerates the authenticated user's OBS UUID.

Response:

```json
{
  "obsUrl": "https://counter.pepega.app/obs?uuid=..."
}
```

Auth required: Yes

### `GET /api/obs-data?uuid=...`

Returns OBS widget payload for a public OBS UUID.

Requirements:

- valid `uuid`
- user exists
- user has migrated Copilot quota settings
- user has stored GitHub auth tokens

Behavior:

- uses cached data when fresh
- fetches GitHub and refreshes cache when needed
- returns `404` if widget is not configured yet
- may return `503` on upstream GitHub/API issues

Response example:

```json
{
  "dailyTarget": 120,
  "daysRemaining": 7,
  "display": "-15/120",
  "monthRemaining": 960,
  "usageByPeriod": {
    "month": [
      {
        "label": "copilot_ai_credit",
        "credits": 120
      }
    ],
    "yesterday": [
      {
        "label": "copilot_ai_credit",
        "credits": 9
      }
    ],
    "today": []
  },
  "title": "Copilot AI Credits available today",
  "todayAvailable": -15,
  "updatedAt": "2026-02-23T10:00:00.000Z",
  "usageUnit": "ai_credits"
}
```

Auth required: No

## Origin checks for mutating routes

The Worker validates `Origin` on mutating routes (`POST`, `PUT`, `DELETE`, `PATCH`).

If you call APIs manually (curl/Postman/browser extension), use:

- `Origin: <APP_BASE_URL origin>`

Otherwise the API returns `403`.

## OBS widget

- UI page: `/`
- OBS page: `/obs?uuid=<uuid>`
- OBS data API: `/api/obs-data?uuid=<uuid>`

The OBS page loads widget data from `/api/obs-data` and can be added as a Browser Source in OBS.

## Security notes

- GitHub access/refresh tokens are never returned by API responses
- GitHub access/refresh tokens are encrypted with AES-GCM before storing in D1
- Session tokens are hashed before storing in D1
- OAuth state cookie (`rc_oauth_state_github`) is short-lived and `HttpOnly`/`Secure`
- Session cookie (`rc_session`) is `HttpOnly`/`Secure`

## Deploy

Deploy production Worker:

```bash
pnpm deploy
```

Set required secrets first (example):

```bash
pnpx wrangler secret put SESSION_SECRET --env production
pnpx wrangler secret put GITHUB_APP_CLIENT_SECRET --env production
pnpx wrangler secret put SECRETS_ENCRYPTION_KEY_B64 --env production
```

## GitHub App setup

Configure your GitHub App with:

- User authorization callback URL: `https://<your-domain>/api/auth/github/callback`
- User permissions: `Plan: Read`

The app uses GitHub App user-to-server OAuth tokens (expiring access + refresh tokens).

## Project structure

```text
.
├── migrations/
│   ├── 001_init.sql
│   ├── 002_add_obs_title.sql
│   ├── 003_github_app_auth_hard_cutover.sql
│   └── 004_github_only_auth_hard_cutover.sql
├── public/
│   ├── index.html
│   ├── index.js
│   ├── obs.html
│   └── obs.js
├── src/
│   ├── lib/
│   │   ├── auth.ts
│   │   ├── cache.ts
│   │   ├── crypto.ts
│   │   ├── data-loader.ts
│   │   ├── env.ts
│   │   ├── errors.ts
│   │   ├── github-auth.ts
│   │   ├── github.ts
│   │   └── schemas.ts
│   └── worker.ts
├── wrangler.jsonc
└── README.md
```

## Troubleshooting

### `SECRETS_ENCRYPTION_KEY_B64` errors

Use a base64-encoded 32-byte key.

Example (Node.js):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### Stored GitHub tokens cannot be decrypted after key change

If you rotate `SECRETS_ENCRYPTION_KEY_B64`, old encrypted GitHub tokens become undecryptable.
Users must sign in with GitHub again so new tokens are stored with the new key.

### `403` on mutating API calls

Make sure the request includes a valid `Origin` header equal to `APP_BASE_URL` origin.

### Local D1 database not working

Reset local migrations and re-apply:

```bash
rm -rf .wrangler/state
pnpm d1:migrate:local
```
