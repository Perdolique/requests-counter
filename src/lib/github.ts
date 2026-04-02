import { ApiError } from './errors'
import {
  calculateAvailableTodayMetrics,
  type AvailableTodayAlgorithmId,
  type TokenBucketBankDays
} from './available-today-algorithms'
import {
  CopilotQuotaSettings,
  QuotaBreakdown
} from './quota'
import { DataPayload, ModelUsageByPeriod, MonthlyModelUsageItem } from './schemas'

const API_BASE_URL = 'https://api.github.com'
const API_VERSION = '2022-11-28'
const GITHUB_USER_AGENT = 'requests-counter-worker'
const MAX_ERROR_BODY_PREVIEW_LENGTH = 280
const UNKNOWN_MODEL_LABEL = 'Unknown model'
export const DEFAULT_WIDGET_TITLE = 'Copilot premium requests available today'

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
  model?: unknown;
  netQuantity?: number;
}

interface PremiumUsageReport {
  usageItems: UsageItemRecord[];
}

export interface BuildDataFromGitHubResult {
  payload: DataPayload;
  quotaBreakdown: QuotaBreakdown;
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

function normalizeModelName(value: unknown): string {
  const isString = typeof value === 'string'

  if (!isString) {
    return UNKNOWN_MODEL_LABEL
  }

  const normalized = value.trim()
  const hasModelName = normalized.length > 0

  if (!hasModelName) {
    return UNKNOWN_MODEL_LABEL
  }

  return normalized
}

function createEmptyPremiumUsageReport(): PremiumUsageReport {
  return {
    usageItems: []
  }
}

function getErrorLogDetails(error: unknown): Record<string, string> {
  if (error instanceof ApiError) {
    return {
      code: error.code,
      message: error.message
    }
  }

  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name
    }
  }

  return {
    message: String(error)
  }
}

function extractUsageByModel(report: PremiumUsageReport): MonthlyModelUsageItem[] {
  const totalsByModel = new Map<string, number>()

  for (const item of report.usageItems) {
    const consumedRequests = getConsumedRequestsForItem(item)
    const hasPositiveConsumedRequests = Number.isFinite(consumedRequests) && consumedRequests > 0

    if (!hasPositiveConsumedRequests) {
      continue
    }

    const modelName = normalizeModelName(item.model)
    const previousTotal = totalsByModel.get(modelName) ?? 0

    totalsByModel.set(modelName, previousTotal + consumedRequests)
  }

  const output: MonthlyModelUsageItem[] = []

  for (const [model, requests] of totalsByModel.entries()) {
    output.push({
      model,
      requests: roundRequests(requests)
    })
  }

  output.sort((left, right) => {
    const usageDifference = right.requests - left.requests
    const hasUsageDifference = usageDifference !== 0

    if (hasUsageDifference) {
      return usageDifference
    }

    return left.model.localeCompare(right.model)
  })

  return output
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

function getRelativeDayPeriod(referenceDate: Date, offsetDays: number): BillingPeriod {
  const date = new Date(referenceDate)

  date.setUTCDate(date.getUTCDate() + offsetDays)

  return getCurrentDayPeriod(date)
}

export function getDaysRemainingInMonth(referenceDate: Date): number {
  const currentDay = referenceDate.getUTCDate()
  const currentMonth = referenceDate.getUTCMonth()
  const currentYear = referenceDate.getUTCFullYear()
  const daysInMonthDate = new Date(Date.UTC(currentYear, currentMonth + 1, 0))
  const daysInMonth = daysInMonthDate.getUTCDate()

  return Math.max(1, daysInMonth - currentDay + 1)
}

export function getPeriodResetDate(referenceDate: Date): string {
  const nextMonthStart = new Date(Date.UTC(
    referenceDate.getUTCFullYear(),
    referenceDate.getUTCMonth() + 1,
    1
  ))

  return nextMonthStart.toISOString()
}

function roundRequests(value: number): number {
  return Math.round(value * 100) / 100
}

function normalizeNegativeZero(value: number): number {
  const isNegativeZero = Object.is(value, -0)

  if (isNegativeZero) {
    return 0
  }

  return value
}

function formatDisplay(todayAvailable: number, dailyTarget: number): string {
  const formatter = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2
  })
  const left = formatter.format(todayAvailable)
  const right = formatter.format(dailyTarget)

  return `${left}/${right}`
}

export async function buildDataFromGitHub(
  token: string,
  availableTodayAlgorithmId: AvailableTodayAlgorithmId,
  availableTodayTokenBucketBankDays: TokenBucketBankDays,
  quotaSettings: CopilotQuotaSettings,
  referenceDate: Date = new Date(),
  title: string = DEFAULT_WIDGET_TITLE
): Promise<BuildDataFromGitHubResult> {
  const user = await fetchCurrentUser(token)
  const monthPeriod = getCurrentMonthPeriod(referenceDate)
  const todayPeriod = getCurrentDayPeriod(referenceDate)
  const yesterdayPeriod = getRelativeDayPeriod(referenceDate, -1)
  const monthUsagePromise = fetchPremiumUsage(token, user.login, monthPeriod)
  const todayUsagePromise = fetchPremiumUsage(token, user.login, todayPeriod)
  const yesterdayUsagePromise = fetchPremiumUsage(token, user.login, yesterdayPeriod)
    .catch((error: unknown) => {
      const details = getErrorLogDetails(error)
      const payload = {
        event: 'github_yesterday_usage_failed',
        login: user.login,
        ...details
      }
      const serializedPayload = JSON.stringify(payload)

      console.warn(serializedPayload)

      return createEmptyPremiumUsageReport()
    })
  const usageReports = await Promise.all([
    monthUsagePromise,
    todayUsagePromise,
    yesterdayUsagePromise
  ])
  const monthUsage = usageReports[0]
  const todayUsage = usageReports[1]
  const yesterdayUsage = usageReports[2]
  const hasUsageData = true
  const spentThisMonth = extractConsumedRequests(monthUsage)
  const spentToday = extractConsumedRequests(todayUsage)
  const modelUsageByPeriod: ModelUsageByPeriod = {
    month: extractUsageByModel(monthUsage),
    yesterday: extractUsageByModel(yesterdayUsage),
    today: extractUsageByModel(todayUsage)
  }
  const daysRemaining = getDaysRemainingInMonth(referenceDate)
  const periodResetDate = getPeriodResetDate(referenceDate)
  const quotaMetricsInput = {
    daysRemaining,
    referenceDate,
    settings: quotaSettings,
    spentThisMonth,
    spentToday,
    tokenBucketBankDays: availableTodayTokenBucketBankDays
  }
  const quotaMetrics = calculateAvailableTodayMetrics(availableTodayAlgorithmId, quotaMetricsInput)
  const roundedTodayAvailable = normalizeNegativeZero(quotaMetrics.todayAvailable)
  const roundedDailyTarget = normalizeNegativeZero(quotaMetrics.dailyTarget)
  const hardPaceTodayAvailable = quotaMetrics.hardPaceMetrics
    ? normalizeNegativeZero(quotaMetrics.hardPaceMetrics.todayAvailable)
    : null
  const hardPaceDailyTarget = quotaMetrics.hardPaceMetrics
    ? normalizeNegativeZero(quotaMetrics.hardPaceMetrics.dailyTarget)
    : null
  const hardPaceDisplay = quotaMetrics.hardPaceMetrics
    ? formatDisplay(hardPaceTodayAvailable ?? 0, hardPaceDailyTarget ?? 0)
    : null
  const tokenBucketCapacity = quotaMetrics.tokenBucketCapacity === null
    ? null
    : normalizeNegativeZero(quotaMetrics.tokenBucketCapacity)
  const tokenBucketDailyRefill = quotaMetrics.tokenBucketDailyRefill === null
    ? null
    : normalizeNegativeZero(quotaMetrics.tokenBucketDailyRefill)
  const display = formatDisplay(roundedTodayAvailable, roundedDailyTarget)
  const updatedAt = referenceDate.toISOString()

  return {
    payload: {
      configuredTotal: quotaMetrics.quotaBreakdown.configuredTotal,
      dailyTarget: roundedDailyTarget,
      daysRemaining,
      display,
      hasUsageData,
      hardPaceDailyTarget,
      hardPaceDisplay,
      hardPaceTodayAvailable,
      monthRemaining: quotaMetrics.monthRemaining,
      modelUsageByPeriod,
      periodResetDate,
      title,
      tokenBucketCapacity,
      tokenBucketDailyRefill,
      todayAvailable: roundedTodayAvailable,
      updatedAt
    },
    quotaBreakdown: quotaMetrics.quotaBreakdown
  }
}
