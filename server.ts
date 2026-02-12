import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { html } from 'hono/html'

const API_BASE_URL = 'https://api.github.com'
const API_VERSION = '2022-11-28'
const DEFAULT_PORT = 8787
const DEFAULT_HOST = '0.0.0.0'
const DEFAULT_MONTHLY_PREMIUM_REQUEST_QUOTA = 1500
const DEFAULT_REFRESH_SECONDS = 300
const ERROR_WIDGET_VALUE = '¯\\_(ツ)_/¯'

type ApiErrorCode =
  | 'TOKEN_INVALID'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'NETWORK_ERROR'

interface BillingPeriod {
  year: number;
  month: number;
  day?: number;
}

interface GitHubUser {
  login: string;
}

interface UsageItemRecord {
  grossQuantity?: number;
  discountQuantity?: number;
  netQuantity?: number;
  [key: string]: unknown;
}

interface PremiumUsageReport {
  usageItems: UsageItemRecord[];
  [key: string]: unknown;
}

interface WidgetValue {
  todayAvailable: number;
  dailyTarget: number;
}

class AppError extends Error {
  code: ApiErrorCode

  constructor(code: ApiErrorCode, message: string) {
    super(message)
    this.name = 'AppError'
    this.code = code
  }
}

function loadEnvFile(filePath: string) {
  let content = ''

  try {
    content = readFileSync(filePath, 'utf8')
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') {
      return
    }

    throw new Error('Failed to read .env file.')
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }

    const separatorIndex = line.indexOf('=')
    if (separatorIndex === -1) {
      continue
    }

    const key = line.slice(0, separatorIndex).trim()
    if (!key) {
      continue
    }

    let value = line.slice(separatorIndex + 1).trim()
    const isWrappedInSingleQuotes = value.startsWith("'") && value.endsWith("'")
    const isWrappedInDoubleQuotes = value.startsWith('"') && value.endsWith('"')
    if (isWrappedInSingleQuotes || isWrappedInDoubleQuotes) {
      value = value.slice(1, -1)
    }

    if (process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  return null
}

function getPositiveIntegerEnv(name: string, fallback: number): number {
  const rawValue = process.env[name]
  if (!rawValue) {
    return fallback
  }

  const parsedValue = Number.parseInt(rawValue, 10)
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    console.warn(`[config] ${name} is invalid. Using default value ${fallback}.`)
    return fallback
  }

  return parsedValue
}

function getHostEnv(name: string, fallback: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    return fallback
  }

  return value
}

function getRequiredToken(): string {
  const token = process.env.GITHUB_PAT?.trim()
  if (!token) {
    throw new Error('Missing required environment variable GITHUB_PAT in .env file.')
  }

  return token
}

function mapHttpStatusToErrorCode(status: number): ApiErrorCode {
  if (status === 401) {
    return 'TOKEN_INVALID'
  }

  if (status === 403) {
    return 'FORBIDDEN'
  }

  if (status === 404) {
    return 'NOT_FOUND'
  }

  if (status === 429) {
    return 'RATE_LIMITED'
  }

  return 'NETWORK_ERROR'
}

function createHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
  }
}

async function parseJsonResponse(response: Response): Promise<Record<string, unknown>> {
  let data: unknown = null
  try {
    data = (await response.json()) as unknown
  } catch {
    data = null
  }

  if (!response.ok) {
    const errorCode = mapHttpStatusToErrorCode(response.status)
    const message =
      isRecord(data) && typeof data.message === 'string' && data.message.length > 0
        ? `GitHub API status ${response.status}: ${data.message}`
        : `GitHub API status ${response.status}`
    throw new AppError(errorCode, message)
  }

  if (!isRecord(data)) {
    throw new AppError('NETWORK_ERROR', 'GitHub API response is not a JSON object.')
  }

  return data
}

async function fetchCurrentUser(token: string): Promise<GitHubUser> {
  const response = await fetch(`${API_BASE_URL}/user`, {
    headers: createHeaders(token),
  })

  const data = await parseJsonResponse(response)
  if (typeof data.login !== 'string' || data.login.length === 0) {
    throw new AppError('NETWORK_ERROR', 'GitHub API user payload is missing login.')
  }

  return { login: data.login }
}

async function fetchPremiumUsage(
  token: string,
  username: string,
  period: BillingPeriod,
): Promise<PremiumUsageReport> {
  const params = new URLSearchParams({
    year: String(period.year),
    month: String(period.month),
  })

  if (typeof period.day === 'number') {
    params.set('day', String(period.day))
  }

  const url = `${API_BASE_URL}/users/${encodeURIComponent(username)}/settings/billing/premium_request/usage?${params.toString()}`
  const response = await fetch(url, {
    headers: createHeaders(token),
  })
  const data = await parseJsonResponse(response)
  const usageItems = Array.isArray(data.usageItems)
    ? data.usageItems.filter(isRecord).map((item) => item as UsageItemRecord)
    : []

  return {
    ...data,
    usageItems,
  }
}

function getConsumedRequestsForItem(item: UsageItemRecord): number {
  const grossQuantity = getFiniteNumber(item.grossQuantity)
  if (grossQuantity !== null) {
    return grossQuantity
  }

  const discountQuantity = getFiniteNumber(item.discountQuantity) ?? 0
  const netQuantity = getFiniteNumber(item.netQuantity) ?? 0
  return discountQuantity + netQuantity
}

function extractConsumedRequests(report: PremiumUsageReport): number {
  return report.usageItems.reduce((total, item) => total + getConsumedRequestsForItem(item), 0)
}

function getCurrentMonthPeriod(referenceDate: Date): BillingPeriod {
  return {
    year: referenceDate.getUTCFullYear(),
    month: referenceDate.getUTCMonth() + 1,
  }
}

function getCurrentDayPeriod(referenceDate: Date): BillingPeriod {
  return {
    ...getCurrentMonthPeriod(referenceDate),
    day: referenceDate.getUTCDate(),
  }
}

function getDaysRemainingInMonth(referenceDate: Date): number {
  const year = referenceDate.getUTCFullYear()
  const month = referenceDate.getUTCMonth()
  const day = referenceDate.getUTCDate()
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return Math.max(1, daysInMonth - day + 1)
}

function roundRequests(value: number): number {
  return Math.round(value * 100) / 100
}

async function calculateWidgetValue(token: string, monthlyQuota: number): Promise<WidgetValue> {
  const referenceDate = new Date()
  const monthPeriod = getCurrentMonthPeriod(referenceDate)
  const dayPeriod = getCurrentDayPeriod(referenceDate)
  const user = await fetchCurrentUser(token)
  const [monthUsageReport, dayUsageReport] = await Promise.all([
    fetchPremiumUsage(token, user.login, monthPeriod),
    fetchPremiumUsage(token, user.login, dayPeriod),
  ])

  const spentThisMonth = extractConsumedRequests(monthUsageReport)
  const spentToday = extractConsumedRequests(dayUsageReport)
  const daysRemaining = getDaysRemainingInMonth(referenceDate)
  const monthRemaining = Math.max(0, monthlyQuota - spentThisMonth)
  const dailyTarget = monthRemaining / daysRemaining
  const todayAvailable = Math.max(0, dailyTarget - spentToday)

  return {
    todayAvailable: roundRequests(todayAvailable),
    dailyTarget: roundRequests(dailyTarget),
  }
}

function renderWidgetHtml(value: string, refreshSeconds: number) {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta http-equiv="refresh" content="${String(refreshSeconds)}" />
        <title>Requests Counter</title>
        <style>
          html,
          body {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            background: transparent;
          }

          body {
            display: grid;
            place-items: start;
            font-family: 'Avenir Next', 'Trebuchet MS', 'Segoe UI', sans-serif;
          }

          .widgetShell {
            display: inline-grid;
            padding: 8px;
          }

          .widgetCard {
            display: grid;
            gap: 8px;
            width: fit-content;
            max-width: min(100vw - 16px, 1000px);
            padding: 14px 18px 16px;
            border-radius: 18px;
            border: 1px solid rgba(255, 255, 255, 0.2);
            background:
              linear-gradient(150deg, rgba(24, 33, 44, 0.86) 0%, rgba(10, 14, 21, 0.7) 100%);
            box-shadow:
              0 14px 34px rgba(0, 0, 0, 0.44),
              inset 0 1px 0 rgba(255, 255, 255, 0.08);
            backdrop-filter: blur(3px);
          }

          .widgetLabel {
            margin: 0;
            font-size: clamp(1rem, calc(2.5vw), 1.5rem);
            font-weight: 800;
            letter-spacing: 0.03em;
            text-transform: uppercase;
            color: rgba(235, 245, 255, 0.9);
            text-shadow: 0 1px 6px rgba(0, 0, 0, 0.45);
          }

          .widgetValue {
            margin: 0;
            font-size: clamp(2.4rem, 9.6vw, 7rem);
            line-height: 0.92;
            font-weight: 900;
            letter-spacing: -0.02em;
            color: #f7fbf9;
            text-shadow: 0 2px 16px rgba(0, 0, 0, 0.42), 0 0 3px rgba(0, 0, 0, 0.62);
            font-variant-numeric: tabular-nums;
            white-space: nowrap;
          }
        </style>
      </head>
      <body>
        <main class="widgetShell">
          <section class="widgetCard">
            <p class="widgetLabel">Copilot requests available today</p>
            <p class="widgetValue">${value}</p>
          </section>
        </main>
      </body>
    </html>`
}

function logSafeError(error: unknown) {
  if (error instanceof AppError) {
    console.error(`[widget] ${error.code}: ${error.message}`)
    return
  }

  if (error instanceof Error) {
    console.error(`[widget] NETWORK_ERROR: ${error.message}`)
    return
  }

  console.error('[widget] NETWORK_ERROR')
}

function failStartup(message: string): never {
  console.error(`[startup] ${message}`)
  process.exit(1)
}

try {
  loadEnvFile(resolve(process.cwd(), '.env'))
} catch {
  failStartup('Failed to read .env file.')
}

let token = ''
try {
  token = getRequiredToken()
} catch {
  failStartup('Missing required environment variable GITHUB_PAT in .env file.')
}

const port = getPositiveIntegerEnv('PORT', DEFAULT_PORT)
const host = getHostEnv('HOST', DEFAULT_HOST)
const monthlyQuota = getPositiveIntegerEnv(
  'MONTHLY_PREMIUM_REQUEST_QUOTA',
  DEFAULT_MONTHLY_PREMIUM_REQUEST_QUOTA,
)
const refreshSeconds = getPositiveIntegerEnv('REFRESH_SECONDS', DEFAULT_REFRESH_SECONDS)
const requestsFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 2,
})

const app = new Hono()

app.get('/', async (context: unknown) => {
  const htmlContext = context as {
    html: (body: ReturnType<typeof renderWidgetHtml>) => Response
  }

  try {
    const widgetValue = await calculateWidgetValue(token, monthlyQuota)
    const renderedValue = `${requestsFormatter.format(widgetValue.todayAvailable)}/${requestsFormatter.format(widgetValue.dailyTarget)}`
    return htmlContext.html(renderWidgetHtml(renderedValue, refreshSeconds))
  } catch (error) {
    logSafeError(error)
    return htmlContext.html(renderWidgetHtml(ERROR_WIDGET_VALUE, refreshSeconds))
  }
})

serve(
  {
    fetch: app.fetch,
    port,
    hostname: host,
  },
  (info: { port: number }) => {
    console.log(`[startup] OBS widget bind address: http://${host}:${info.port}/`)
    console.log(`[startup] OBS local URL: http://127.0.0.1:${info.port}/`)
  },
)
