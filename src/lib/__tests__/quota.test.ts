import { describe, expect, test } from 'vitest'
import {
  calculateQuotaBreakdown,
  getBudgetCreditQuota,
  getPlanQuota
} from '../quota'

describe('AI Credits quota helpers', () => {
  test.each([
    ['pro', 1_500],
    ['pro_plus', 7_000],
    ['max', 20_000]
  ] as const)('should return %s plan quota as %i AI Credits', (plan, expectedQuota) => {
    const planQuota = getPlanQuota(plan)

    expect(planQuota).toBe(expectedQuota)
  })

  test('should convert budget cents directly to paid AI Credits', () => {
    const budgetCreditQuota = getBudgetCreditQuota(1_000)

    expect(budgetCreditQuota).toBe(1_000)
  })

  test('should calculate remaining AI Credits across plan and budget', () => {
    const breakdown = calculateQuotaBreakdown(
      {
        budgetCents: 1_000,
        subscriptionPlan: 'pro'
      },
      1_600
    )

    expect(breakdown).toStrictEqual({
      budgetCreditQuota: 1_000,
      budgetRemaining: 900,
      configuredTotal: 2_500,
      planQuota: 1_500,
      planRemaining: 0,
      totalRemaining: 900
    })
  })
})
