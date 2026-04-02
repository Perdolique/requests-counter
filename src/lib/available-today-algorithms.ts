import {
  calculateQuotaDailyMetrics,
  type QuotaDailyMetrics,
  type QuotaDailyMetricsInput
} from './quota'

export const DEFAULT_AVAILABLE_TODAY_ALGORITHM_ID = 'daily_pace'
export const DEFAULT_TOKEN_BUCKET_BANK_DAYS = 3
export const TOKEN_BUCKET_BANK_DAYS_OPTIONS = [3, 5, 7] as const

export type AvailableTodayAlgorithmId = 'daily_pace' | 'token_bucket'
export type TokenBucketBankDays = typeof TOKEN_BUCKET_BANK_DAYS_OPTIONS[number]

export interface AvailableTodayAlgorithm {
  bankDaysOptions?: TokenBucketBankDays[];
  description: string;
  examples: string[];
  explanation: string;
  id: AvailableTodayAlgorithmId;
  isDefault: boolean;
  name: string;
}

export interface AvailableTodaySecondaryMetrics {
  dailyTarget: number;
  todayAvailable: number;
}

export interface AvailableTodayMetricsInput extends QuotaDailyMetricsInput {
  referenceDate: Date;
  tokenBucketBankDays: TokenBucketBankDays;
}

export interface AvailableTodayMetricsResult extends QuotaDailyMetrics {
  hardPaceMetrics: AvailableTodaySecondaryMetrics | null;
  tokenBucketCapacity: number | null;
  tokenBucketDailyRefill: number | null;
}

const AVAILABLE_TODAY_ALGORITHMS: AvailableTodayAlgorithm[] = [
  {
    description: 'Spread the rest of your monthly requests evenly across the remaining days.',
    examples: [
      '120 left, 6 days left, 7 used today -> 13 available today',
      '40 left, 2 days left, 0 used today -> 20 available today'
    ],
    explanation: 'We take the requests left this month, divide them by the remaining days, and subtract what you already spent today.',
    id: 'daily_pace',
    isDefault: true,
    name: 'Daily Pace'
  },
  {
    bankDaysOptions: [...TOKEN_BUCKET_BANK_DAYS_OPTIONS],
    description: 'Build up a capped comfort bank so quiet days can roll into a small burst later.',
    examples: [
      '1500/month over 30 days -> refill 50/day; with a 3-day bank the cap is 150',
      'Skip two quiet days and the widget can still top out at 150 instead of snowballing toward 400+'
    ],
    explanation: 'The bucket refills once per UTC day, keeps at most a few days of allowance, and never goes below zero after you spend it.',
    id: 'token_bucket',
    isDefault: false,
    name: 'Token Bucket'
  }
]

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

function roundQuotaValue(value: number): number {
  const roundedValue = roundRequests(value)
  const normalizedValue = normalizeNegativeZero(roundedValue)

  return normalizedValue
}

function getDaysInUtcMonth(referenceDate: Date): number {
  const currentYear = referenceDate.getUTCFullYear()
  const currentMonth = referenceDate.getUTCMonth()
  const monthEnd = new Date(Date.UTC(currentYear, currentMonth + 1, 0))

  return monthEnd.getUTCDate()
}

function getSafeSpentValue(value: number): number {
  const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0

  return safeValue
}

function calculateTokenBucketMetrics(input: AvailableTodayMetricsInput): AvailableTodayMetricsResult {
  const hardPaceMetrics = calculateQuotaDailyMetrics(input)
  const configuredTotal = Math.max(0, hardPaceMetrics.quotaBreakdown.configuredTotal)
  const daysInMonth = getDaysInUtcMonth(input.referenceDate)
  const daysRemaining = Math.max(1, input.daysRemaining)
  const refillPerDay = configuredTotal / daysInMonth
  const capacity = refillPerDay * input.tokenBucketBankDays
  const storedCapacity = Math.max(0, capacity - refillPerDay)
  const safeSpentToday = getSafeSpentValue(input.spentToday)
  const safeSpentThisMonth = getSafeSpentValue(input.spentThisMonth)
  const spentBeforeToday = Math.max(0, safeSpentThisMonth - safeSpentToday)
  const monthRemainingBeforeToday = Math.max(0, configuredTotal - spentBeforeToday)
  const elapsedDaysBeforeToday = Math.max(0, daysInMonth - daysRemaining)
  const expectedSpentBeforeToday = refillPerDay * elapsedDaysBeforeToday
  const paceVariance = expectedSpentBeforeToday - spentBeforeToday
  const storedBalance = Math.min(
    storedCapacity,
    Math.max(0, paceVariance)
  )
  const debtTotal = Math.max(0, -paceVariance)
  const debtPerRemainingDay = debtTotal / daysRemaining
  const baseTodayQuota = Math.max(0, refillPerDay - debtPerRemainingDay)
  const openingBalanceToday = Math.min(
    capacity,
    monthRemainingBeforeToday,
    baseTodayQuota + storedBalance
  )
  const closingBalance = Math.max(0, openingBalanceToday - safeSpentToday)

  return {
    dailyTarget: roundQuotaValue(openingBalanceToday),
    hardPaceMetrics: {
      dailyTarget: hardPaceMetrics.dailyTarget,
      todayAvailable: hardPaceMetrics.todayAvailable
    },
    monthRemaining: hardPaceMetrics.monthRemaining,
    quotaBreakdown: hardPaceMetrics.quotaBreakdown,
    tokenBucketCapacity: roundQuotaValue(capacity),
    tokenBucketDailyRefill: roundQuotaValue(refillPerDay),
    todayAvailable: roundQuotaValue(closingBalance)
  }
}

export function getAvailableTodayAlgorithms(): AvailableTodayAlgorithm[] {
  return AVAILABLE_TODAY_ALGORITHMS.map((algorithm) => ({
    ...algorithm,
    bankDaysOptions: algorithm.bankDaysOptions ? [...algorithm.bankDaysOptions] : undefined,
    examples: [...algorithm.examples]
  }))
}

export function isAvailableTodayAlgorithmId(value: string): value is AvailableTodayAlgorithmId {
  return value === 'daily_pace' || value === 'token_bucket'
}

export function isTokenBucketBankDays(value: number): value is TokenBucketBankDays {
  return value === 3 || value === 5 || value === 7
}

export function resolveAvailableTodayAlgorithmId(
  value: string | null | undefined
): AvailableTodayAlgorithmId {
  if (typeof value === 'string' && isAvailableTodayAlgorithmId(value)) {
    return value
  }

  return DEFAULT_AVAILABLE_TODAY_ALGORITHM_ID
}

export function resolveTokenBucketBankDays(
  value: number | null | undefined
): TokenBucketBankDays {
  if (typeof value === 'number' && isTokenBucketBankDays(value)) {
    return value
  }

  return DEFAULT_TOKEN_BUCKET_BANK_DAYS
}

export function getAvailableTodayAlgorithmById(
  value: string | null | undefined
): AvailableTodayAlgorithm {
  const algorithmId = resolveAvailableTodayAlgorithmId(value)
  const matchedAlgorithm = AVAILABLE_TODAY_ALGORITHMS.find((algorithm) => algorithm.id === algorithmId)

  if (matchedAlgorithm) {
    return {
      ...matchedAlgorithm,
      bankDaysOptions: matchedAlgorithm.bankDaysOptions
        ? [...matchedAlgorithm.bankDaysOptions]
        : undefined,
      examples: [...matchedAlgorithm.examples]
    }
  }

  const defaultAlgorithm = AVAILABLE_TODAY_ALGORITHMS[0]

  return {
    ...defaultAlgorithm,
    bankDaysOptions: defaultAlgorithm.bankDaysOptions
      ? [...defaultAlgorithm.bankDaysOptions]
      : undefined,
    examples: [...defaultAlgorithm.examples]
  }
}

export function calculateAvailableTodayMetrics(
  algorithmId: AvailableTodayAlgorithmId,
  input: AvailableTodayMetricsInput
): AvailableTodayMetricsResult {
  if (algorithmId === 'token_bucket') {
    return calculateTokenBucketMetrics(input)
  }

  const dailyPaceMetrics = calculateQuotaDailyMetrics(input)

  return {
    ...dailyPaceMetrics,
    hardPaceMetrics: null,
    tokenBucketCapacity: null,
    tokenBucketDailyRefill: null
  }
}
