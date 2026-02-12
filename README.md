# requests-counter

Minimal TypeScript + Hono server that renders a non-interactive OBS widget.

## What it does

- Reads `GITHUB_PAT` from `.env`
- Calls GitHub billing APIs for current UTC month and current UTC day
- Computes available premium requests for today
- Returns one HTML page on `GET /` with widget text:
  - `<todayAvailable>/<dailyTarget>` (for example `50.05/62.05`)
- Refreshes automatically every 5 minutes

If the API call fails, widget shows only:

- `¯\_(ツ)_/¯`

## Environment variables

Create `.env` from `.env.example`:

```bash
cp .env.example .env
```

Required:

- `GITHUB_PAT` — fine-grained token with `Plan: read`

Optional:

- `PORT` (default: `8787`)
- `HOST` (default: `0.0.0.0`)
- `MONTHLY_PREMIUM_REQUEST_QUOTA` (default: `1500`)
- `REFRESH_SECONDS` (default: `300`)

## Run

Install dependencies:

```bash
pnpm install
```

Start in dev/watch mode:

```bash
pnpm dev
```

Start without watcher:

```bash
pnpm start
```

Type check:

```bash
pnpm typecheck
```

## OBS setup

Use this URL in OBS Browser Source:

- `http://127.0.0.1:<PORT>/`

Example with default port:

- `http://127.0.0.1:8787/`

Recommended Browser Source dimensions:

- `900 x 240` for typical values
- If numbers are clipped on your scene, increase width to `1100`

## Formula

- `spentThisMonth` = sum of `grossQuantity` from monthly `usageItems`
- `spentToday` = sum of `grossQuantity` from daily `usageItems`
- `daysRemaining` = days left in current UTC month, including today
- `dailyTarget` = `(quota - spentThisMonth) / daysRemaining`
- `todayAvailable` = `max(0, dailyTarget - spentToday)`

## Security notes

- PAT is never accepted from query/body
- PAT is never rendered into HTML
- PAT is never logged
