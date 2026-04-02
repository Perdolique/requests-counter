import { describe, expect, test } from 'vitest'
import {
  type AvailableTodayMetricsInput,
  calculateAvailableTodayMetrics,
  DEFAULT_TOKEN_BUCKET_BANK_DAYS
} from '../available-today-algorithms'

function createMetricsInput(
  overrides: Partial<AvailableTodayMetricsInput> = {}
): AvailableTodayMetricsInput {
  return {
    daysRemaining: 30,
    referenceDate: new Date(Date.UTC(2026, 3, 1)),
    settings: {
      budgetCents: 0,
      subscriptionPlan: 'pro'
    },
    spentThisMonth: 0,
    spentToday: 0,
    tokenBucketBankDays: DEFAULT_TOKEN_BUCKET_BANK_DAYS,
    ...overrides
  }
}

describe(calculateAvailableTodayMetrics, () => {
  test('should keep daily pace metrics unchanged for the default algorithm', () => {
    const input = createMetricsInput({
      daysRemaining: 6,
      referenceDate: new Date(Date.UTC(2026, 3, 25)),
      spentThisMonth: 180,
      spentToday: 7
    })

    const result = calculateAvailableTodayMetrics('daily_pace', input)

    expect(result.dailyTarget).toBeCloseTo(21.17, 2)
    expect(result.todayAvailable).toBeCloseTo(14.17, 2)
    expect(result.hardPaceMetrics).toBeNull()
    expect(result.tokenBucketCapacity).toBeNull()
    expect(result.tokenBucketDailyRefill).toBeNull()
  })

  test('should cap carryover at the configured bank size without fetching prior days', () => {
    const input = createMetricsInput({
      daysRemaining: 25,
      referenceDate: new Date(Date.UTC(2026, 3, 6))
    })

    const result = calculateAvailableTodayMetrics('token_bucket', input)

    expect(result.dailyTarget).toBe(30)
    expect(result.todayAvailable).toBe(30)
    expect(result.tokenBucketDailyRefill).toBe(10)
    expect(result.tokenBucketCapacity).toBe(30)
    expect(result.hardPaceMetrics).toStrictEqual({
      dailyTarget: 12,
      todayAvailable: 12
    })
  })

  test('should spread previous overspend across remaining days and leave the bucket empty', () => {
    const input = createMetricsInput({
      daysRemaining: 29,
      referenceDate: new Date(Date.UTC(2026, 3, 2)),
      settings: {
        budgetCents: 0,
        subscriptionPlan: 'pro_plus'
      },
      spentThisMonth: 100
    })

    const result = calculateAvailableTodayMetrics('token_bucket', input)

    expect(result.dailyTarget).toBeCloseTo(48.28, 2)
    expect(result.todayAvailable).toBeCloseTo(48.28, 2)
    expect(result.tokenBucketDailyRefill).toBe(50)
    expect(result.tokenBucketCapacity).toBe(150)
    expect(result.hardPaceMetrics).toStrictEqual({
      dailyTarget: result.dailyTarget,
      todayAvailable: result.todayAvailable
    })
  })

  test('should spend down todays opening balance without going below zero', () => {
    const input = createMetricsInput({
      daysRemaining: 25,
      referenceDate: new Date(Date.UTC(2026, 3, 6)),
      spentToday: 12
    })

    const result = calculateAvailableTodayMetrics('token_bucket', input)

    expect(result.dailyTarget).toBe(30)
    expect(result.todayAvailable).toBe(18)
  })

  test('should never show more than the real month remaining', () => {
    const input = createMetricsInput({
      daysRemaining: 1,
      referenceDate: new Date(Date.UTC(2026, 3, 30)),
      spentThisMonth: 295
    })

    const result = calculateAvailableTodayMetrics('token_bucket', input)

    expect(result.dailyTarget).toBe(5)
    expect(result.todayAvailable).toBe(5)
    expect(result.monthRemaining).toBe(5)
  })
})
