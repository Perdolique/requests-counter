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
import { DataPayload, UsageByPeriod, UsageByPeriodItem } from './schemas'

const API_BASE_URL = 'https://api.github.com'
const API_VERSION = '2026-03-10'
const GITHUB_USER_AGENT = 'requests-counter-worker'
const MAX_ERROR_BODY_PREVIEW_LENGTH = 280
const COPILOT_BILLING_PRODUCT = 'copilot'
const UNKNOWN_USAGE_LABEL = 'Unknown usage'
export const DEFAULT_WIDGET_TITLE = 'Copilot AI Credits available today'

interface BillingPeriod {
  day?: number;
  month: number;
  year: number;
}

interface GitHubUser {
  login: string;
}

export interface UsageItemRecord {
  discountAmount?: number;
  discountQuantity?: number;
  friendlySkuName?: unknown;
  grossAmount?: number;
  grossQuantity?: number;
  model?: unknown;
  netAmount?: number;
  netQuantity?: number;
  pricePerUnit?: number;
  product?: unknown;
  quantity?: number;
  sku?: unknown;
  unitType?: unknown;
}

export interface CopilotCreditUsageReport {
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

async function fetchCopilotCreditUsage(
  token: string,
  username: string,
  period: BillingPeriod
): Promise<CopilotCreditUsageReport> {
  const params = new URLSearchParams({
    month: String(period.month),
    product: COPILOT_BILLING_PRODUCT,
    year: String(period.year)
  })
  const hasDay = typeof period.day === 'number'

  if (hasDay) {
    params.set('day', String(period.day))
  }

  const encodedUsername = encodeURIComponent(username)
  const url = `${API_BASE_URL}/users/${encodedUsername}/settings/billing/usage/summary?${params.toString()}`
  const response = await fetch(url, {
    headers: createHeaders(token)
  })
  let data: Record<string, unknown>

  try {
    data = await parseApiResponse(response)
  } catch (error) {
    const isBillingUnavailableStatus = response.status === 403 || response.status === 404

    if (isBillingUnavailableStatus) {
      throw new ApiError(
        503,
        'GITHUB_BILLING_USAGE_UNAVAILABLE',
        'GitHub Copilot billing usage summary is unavailable for this account'
      )
    }

    throw error
  }

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

function getStringValue(value: unknown): string {
  const isString = typeof value === 'string'

  if (!isString) {
    return ''
  }

  return value.trim()
}

function normalizeBillingToken(value: unknown): string {
  const stringValue = getStringValue(value)

  return stringValue.toLowerCase().replace(/[\s_]+/g, '-')
}

function isCopilotProduct(value: unknown): boolean {
  const normalizedProduct = normalizeBillingToken(value)

  return normalizedProduct === COPILOT_BILLING_PRODUCT
}

function isCreditUnitType(value: unknown): boolean {
  const normalizedUnitType = normalizeBillingToken(value)

  return normalizedUnitType === 'credit'
    || normalizedUnitType === 'credits'
    || normalizedUnitType === 'ai-credit'
    || normalizedUnitType === 'ai-credits'
    || normalizedUnitType === 'ai-unit'
    || normalizedUnitType === 'ai-units'
}

function isKnownNonCreditUnitType(value: unknown): boolean {
  const normalizedUnitType = normalizeBillingToken(value)

  return normalizedUnitType === 'requests'
    || normalizedUnitType === 'minutes'
    || normalizedUnitType === 'gigabyte-hours'
    || normalizedUnitType === 'gigabytehours'
}

function isLegacyPremiumRequestItem(item: UsageItemRecord): boolean {
  const normalizedUnitType = normalizeBillingToken(item.unitType)
  const normalizedSku = normalizeBillingToken(item.sku)

  return normalizedUnitType === 'requests' || normalizedSku.includes('premium-request')
}

function isCopilotCreditUsageItem(item: UsageItemRecord): boolean {
  const isLegacyPremiumRequest = isLegacyPremiumRequestItem(item)

  if (isLegacyPremiumRequest) {
    return false
  }

  const isNonCreditUnitType = isKnownNonCreditUnitType(item.unitType)

  if (isNonCreditUnitType) {
    return false
  }

  const hasCreditUnitType = isCreditUnitType(item.unitType)
  const hasCopilotProduct = isCopilotProduct(item.product)
  const normalizedSku = normalizeBillingToken(item.sku)
  const hasCopilotSku = normalizedSku.includes('copilot')

  return hasCreditUnitType || hasCopilotProduct || hasCopilotSku
}

function getAmountAsCredits(value: number | null): number | null {
  if (value === null) {
    return null
  }

  return value * 100
}

function getConsumedCreditsForItem(item: UsageItemRecord): number {
  const isCreditUsage = isCopilotCreditUsageItem(item)

  if (!isCreditUsage) {
    return 0
  }

  const grossQuantity = getFiniteNumber(item.grossQuantity)

  if (grossQuantity !== null) {
    return grossQuantity
  }

  const quantity = getFiniteNumber(item.quantity)

  if (quantity !== null) {
    return quantity
  }

  const discountQuantity = getFiniteNumber(item.discountQuantity) ?? 0
  const netQuantityValue = getFiniteNumber(item.netQuantity)
  const hasNetQuantity = netQuantityValue !== null
  const hasDiscountQuantity = getFiniteNumber(item.discountQuantity) !== null

  if (hasNetQuantity || hasDiscountQuantity) {
    const netQuantity = netQuantityValue ?? 0

    return discountQuantity + netQuantity
  }

  const grossAmountCredits = getAmountAsCredits(getFiniteNumber(item.grossAmount))

  if (grossAmountCredits !== null) {
    return grossAmountCredits
  }

  const discountAmount = getFiniteNumber(item.discountAmount) ?? 0
  const netAmountValue = getFiniteNumber(item.netAmount)
  const hasNetAmount = netAmountValue !== null
  const hasDiscountAmount = getFiniteNumber(item.discountAmount) !== null

  if (hasNetAmount || hasDiscountAmount) {
    const netAmount = netAmountValue ?? 0

    return (discountAmount + netAmount) * 100
  }

  return 0
}

export function extractConsumedCredits(report: CopilotCreditUsageReport): number {
  let total = 0

  for (const item of report.usageItems) {
    total += getConsumedCreditsForItem(item)
  }

  return roundCredits(total)
}

function getUsageItemLabel(item: UsageItemRecord): string {
  const friendlySkuName = getStringValue(item.friendlySkuName)
  const hasFriendlySkuName = friendlySkuName.length > 0

  if (hasFriendlySkuName) {
    return friendlySkuName
  }

  const modelName = getStringValue(item.model)
  const hasModelName = modelName.length > 0

  if (hasModelName) {
    return modelName
  }

  const sku = getStringValue(item.sku)
  const hasSku = sku.length > 0

  if (hasSku) {
    return sku
  }

  return UNKNOWN_USAGE_LABEL
}

function createEmptyCopilotCreditUsageReport(): CopilotCreditUsageReport {
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

function hasCopilotCreditUsageItems(report: CopilotCreditUsageReport): boolean {
  for (const item of report.usageItems) {
    const isCreditUsage = isCopilotCreditUsageItem(item)

    if (isCreditUsage) {
      return true
    }
  }

  return false
}

export function extractUsageByLabel(report: CopilotCreditUsageReport): UsageByPeriodItem[] {
  const totalsByLabel = new Map<string, number>()

  for (const item of report.usageItems) {
    const consumedCredits = getConsumedCreditsForItem(item)
    const hasPositiveConsumedCredits = Number.isFinite(consumedCredits) && consumedCredits > 0

    if (!hasPositiveConsumedCredits) {
      continue
    }

    const label = getUsageItemLabel(item)
    const previousTotal = totalsByLabel.get(label) ?? 0

    totalsByLabel.set(label, previousTotal + consumedCredits)
  }

  const output: UsageByPeriodItem[] = []

  for (const [label, credits] of totalsByLabel.entries()) {
    output.push({
      credits: roundCredits(credits),
      label
    })
  }

  output.sort((left, right) => {
    const usageDifference = right.credits - left.credits
    const hasUsageDifference = usageDifference !== 0

    if (hasUsageDifference) {
      return usageDifference
    }

    return left.label.localeCompare(right.label)
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

function roundCredits(value: number): number {
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
  const monthUsagePromise = fetchCopilotCreditUsage(token, user.login, monthPeriod)
  const todayUsagePromise = fetchCopilotCreditUsage(token, user.login, todayPeriod)
  const yesterdayUsagePromise = fetchCopilotCreditUsage(token, user.login, yesterdayPeriod)
    .catch((error: unknown) => {
      const details = getErrorLogDetails(error)
      const payload = {
        event: 'github_yesterday_usage_failed',
        login: user.login,
        ...details
      }
      const serializedPayload = JSON.stringify(payload)

      console.warn(serializedPayload)

      return createEmptyCopilotCreditUsageReport()
    })
  const usageReports = await Promise.all([
    monthUsagePromise,
    todayUsagePromise,
    yesterdayUsagePromise
  ])
  const monthUsage = usageReports[0]
  const todayUsage = usageReports[1]
  const yesterdayUsage = usageReports[2]
  const hasUsageData = hasCopilotCreditUsageItems(monthUsage)
    || hasCopilotCreditUsageItems(todayUsage)
    || hasCopilotCreditUsageItems(yesterdayUsage)
  const spentThisMonth = extractConsumedCredits(monthUsage)
  const spentToday = extractConsumedCredits(todayUsage)
  const usageByPeriod: UsageByPeriod = {
    month: extractUsageByLabel(monthUsage),
    yesterday: extractUsageByLabel(yesterdayUsage),
    today: extractUsageByLabel(todayUsage)
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
      periodResetDate,
      title,
      tokenBucketCapacity,
      tokenBucketDailyRefill,
      todayAvailable: roundedTodayAvailable,
      updatedAt,
      usageByPeriod,
      usageUnit: 'ai_credits'
    },
    quotaBreakdown: quotaMetrics.quotaBreakdown
  }
}
