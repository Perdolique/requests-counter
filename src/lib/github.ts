import { ApiError } from './errors'
import { DataPayload } from './schemas'

const API_BASE_URL = 'https://api.github.com'
const API_VERSION = '2022-11-28'
const GITHUB_USER_AGENT = 'requests-counter-worker'
const MAX_ERROR_BODY_PREVIEW_LENGTH = 280
export const DEFAULT_WIDGET_TITLE = 'Copilot requests available today'

interface BillingPeriod {
  day?: number;
  month: number;
  year: number;
}

interface GitHubUser {
  login: string;
}

interface UsageItemRecord {
  discountQuantity?: number;
  grossQuantity?: number;
  netQuantity?: number;
}

interface PremiumUsageReport {
  usageItems: UsageItemRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  const isObject = typeof value === 'object' && value !== null && !Array.isArray(value)

  return isObject
}

function createHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': GITHUB_USER_AGENT,
    'X-GitHub-Api-Version': API_VERSION
  }
}

function getFiniteNumber(value: unknown): number | null {
  const isFiniteNumber = typeof value === 'number' && Number.isFinite(value)

  if (!isFiniteNumber) {
    return null
  }

  return value
}

function mapHttpStatusToError(status: number, message: string): ApiError {
  if (status === 401) {
    return new ApiError(400, 'GITHUB_TOKEN_INVALID', message)
  }

  if (status === 403) {
    return new ApiError(403, 'GITHUB_FORBIDDEN', message)
  }

  if (status === 429) {
    return new ApiError(429, 'GITHUB_RATE_LIMITED', message)
  }

  return new ApiError(503, 'GITHUB_NETWORK_ERROR', message)
}

async function parseApiResponse(response: Response): Promise<Record<string, unknown>> {
  const rawText = await response.text()
  let data: unknown = null
  const hasRawText = rawText.length > 0

  if (hasRawText) {
    try {
      data = JSON.parse(rawText)
    } catch {
      data = null
    }
  }

  const isOk = response.ok

  if (!isOk) {
    let messageValue: unknown = null

    if (isRecord(data)) {
      messageValue = data.message
    }

    const hasMessage = typeof messageValue === 'string' && messageValue.length > 0
    let detailMessage = 'Unknown GitHub API error'

    if (hasMessage) {
      detailMessage = messageValue as string
    } else if (hasRawText) {
      const compact = rawText.replace(/\s+/g, ' ').trim()
      const preview = compact.slice(0, MAX_ERROR_BODY_PREVIEW_LENGTH)
      const hasOverflow = compact.length > MAX_ERROR_BODY_PREVIEW_LENGTH
      const suffix = hasOverflow ? '...' : ''

      detailMessage = `Non-JSON response body: ${preview}${suffix}`
    }

    const message = `GitHub API returned status ${response.status}: ${detailMessage}`

    throw mapHttpStatusToError(response.status, message)
  }

  if (!isRecord(data)) {
    let message = 'GitHub API did not return a JSON object'

    if (hasRawText) {
      const compact = rawText.replace(/\s+/g, ' ').trim()
      const preview = compact.slice(0, MAX_ERROR_BODY_PREVIEW_LENGTH)
      const hasOverflow = compact.length > MAX_ERROR_BODY_PREVIEW_LENGTH
      const suffix = hasOverflow ? '...' : ''

      message = `GitHub API did not return a JSON object: ${preview}${suffix}`
    }

    throw new ApiError(503, 'GITHUB_NETWORK_ERROR', message)
  }

  return data
}

async function fetchCurrentUser(token: string): Promise<GitHubUser> {
  const response = await fetch(`${API_BASE_URL}/user`, {
    headers: createHeaders(token)
  })
  const data = await parseApiResponse(response)
  const login = data.login
  const hasValidLogin = typeof login === 'string' && login.length > 0

  if (!hasValidLogin) {
    throw new ApiError(503, 'GITHUB_NETWORK_ERROR', 'GitHub /user payload is missing login')
  }

  return {
    login
  }
}

async function fetchPremiumUsage(
  token: string,
  username: string,
  period: BillingPeriod
): Promise<PremiumUsageReport> {
  const params = new URLSearchParams({
    month: String(period.month),
    year: String(period.year)
  })
  const hasDay = typeof period.day === 'number'

  if (hasDay) {
    params.set('day', String(period.day))
  }

  const encodedUsername = encodeURIComponent(username)
  const url = `${API_BASE_URL}/users/${encodedUsername}/settings/billing/premium_request/usage?${params.toString()}`
  const response = await fetch(url, {
    headers: createHeaders(token)
  })
  const data = await parseApiResponse(response)
  const usageItemsValue = data.usageItems
  const isArray = Array.isArray(usageItemsValue)
  const usageItems: UsageItemRecord[] = []

  if (isArray) {
    for (const item of usageItemsValue) {
      const isObject = typeof item === 'object' && item !== null && !Array.isArray(item)

      if (isObject) {
        usageItems.push(item as UsageItemRecord)
      }
    }
  }

  return {
    usageItems
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
  let total = 0

  for (const item of report.usageItems) {
    total += getConsumedRequestsForItem(item)
  }

  return total
}

function getCurrentMonthPeriod(referenceDate: Date): BillingPeriod {
  return {
    month: referenceDate.getUTCMonth() + 1,
    year: referenceDate.getUTCFullYear()
  }
}

function getCurrentDayPeriod(referenceDate: Date): BillingPeriod {
  const monthPeriod = getCurrentMonthPeriod(referenceDate)

  return {
    day: referenceDate.getUTCDate(),
    month: monthPeriod.month,
    year: monthPeriod.year
  }
}

export function getDaysRemainingInMonth(referenceDate: Date): number {
  const currentDay = referenceDate.getUTCDate()
  const currentMonth = referenceDate.getUTCMonth()
  const currentYear = referenceDate.getUTCFullYear()
  const daysInMonthDate = new Date(Date.UTC(currentYear, currentMonth + 1, 0))
  const daysInMonth = daysInMonthDate.getUTCDate()

  return Math.max(1, daysInMonth - currentDay + 1)
}

function roundRequests(value: number): number {
  return Math.round(value * 100) / 100
}

function formatDisplay(todayAvailable: number, dailyTarget: number): string {
  const formatter = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2
  })
  const left = formatter.format(todayAvailable)
  const right = formatter.format(dailyTarget)

  return `${left}/${right}`
}

export function calculateMonthRemaining(
  todayAvailable: number,
  dailyTarget: number,
  daysRemaining: number
): number {
  // Total remaining = today's available + (daily target * remaining days after today)
  return roundRequests(todayAvailable + dailyTarget * (daysRemaining - 1))
}

export async function buildDataFromGitHub(
  pat: string,
  monthlyQuota: number,
  referenceDate: Date = new Date(),
  title: string = DEFAULT_WIDGET_TITLE
): Promise<DataPayload> {
  const user = await fetchCurrentUser(pat)
  const monthPeriod = getCurrentMonthPeriod(referenceDate)
  const dayPeriod = getCurrentDayPeriod(referenceDate)
  const monthUsagePromise = fetchPremiumUsage(pat, user.login, monthPeriod)
  const dayUsagePromise = fetchPremiumUsage(pat, user.login, dayPeriod)
  const usageReports = await Promise.all([monthUsagePromise, dayUsagePromise])
  const monthUsage = usageReports[0]
  const dayUsage = usageReports[1]

  const spentThisMonth = extractConsumedRequests(monthUsage)
  const spentToday = extractConsumedRequests(dayUsage)
  const daysRemaining = getDaysRemainingInMonth(referenceDate)
  const spentBeforeToday = Math.max(0, spentThisMonth - spentToday)
  const monthRemainingBeforeToday = Math.max(0, monthlyQuota - spentBeforeToday)
  const dailyTarget = monthRemainingBeforeToday / daysRemaining
  const todayAvailable = dailyTarget - spentToday
  const roundedTodayAvailable = roundRequests(todayAvailable)
  const roundedDailyTarget = roundRequests(dailyTarget)
  const display = formatDisplay(roundedTodayAvailable, roundedDailyTarget)
  const updatedAt = referenceDate.toISOString()
  const monthRemaining = calculateMonthRemaining(
    roundedTodayAvailable,
    roundedDailyTarget,
    daysRemaining
  )

  return {
    dailyTarget: roundedDailyTarget,
    daysRemaining,
    display,
    monthRemaining,
    title,
    todayAvailable: roundedTodayAvailable,
    updatedAt
  }
}
