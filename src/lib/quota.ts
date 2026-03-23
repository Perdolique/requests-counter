export const PREMIUM_REQUEST_PRICE_CENTS = 4
export const DEFAULT_COPILOT_SUBSCRIPTION_PLAN = 'pro'

export type CopilotSubscriptionPlan = 'pro' | 'pro_plus'

export interface CopilotQuotaSettings {
  budgetCents: number;
  subscriptionPlan: CopilotSubscriptionPlan;
}

export interface QuotaBreakdown {
  budgetRemaining: number;
  budgetRequestQuota: number;
  configuredTotal: number;
  planQuota: number;
  planRemaining: number;
  totalRemaining: number;
}

export interface QuotaDailyMetrics {
  dailyTarget: number;
  monthRemaining: number;
  quotaBreakdown: QuotaBreakdown;
  todayAvailable: number;
}

export interface QuotaDailyMetricsInput {
  daysRemaining: number;
  settings: CopilotQuotaSettings;
  spentThisMonth: number;
  spentToday: number;
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

function roundQuotaValue(value: number): number {
  const roundedValue = roundRequests(value)
  const normalizedValue = normalizeNegativeZero(roundedValue)

  return normalizedValue
}

export function isCopilotSubscriptionPlan(value: string): value is CopilotSubscriptionPlan {
  return value === 'pro' || value === 'pro_plus'
}

export function getPlanQuota(subscriptionPlan: CopilotSubscriptionPlan): number {
  if (subscriptionPlan === 'pro_plus') {
    return 1_500
  }

  return 300
}

export function getBudgetRequestQuota(budgetCents: number): number {
  const safeBudgetCents = Number.isFinite(budgetCents) ? Math.max(0, Math.floor(budgetCents)) : 0

  return Math.floor(safeBudgetCents / PREMIUM_REQUEST_PRICE_CENTS)
}

export function resolveQuotaSettingsFromLegacyMonthlyQuota(
  monthlyQuota: number | null
): CopilotQuotaSettings {
  const safeMonthlyQuota = typeof monthlyQuota === 'number' && Number.isFinite(monthlyQuota)
    ? Math.max(0, Math.floor(monthlyQuota))
    : 0

  if (safeMonthlyQuota >= 1_500) {
    return {
      budgetCents: Math.max(0, safeMonthlyQuota - 1_500) * PREMIUM_REQUEST_PRICE_CENTS,
      subscriptionPlan: 'pro_plus'
    }
  }

  if (safeMonthlyQuota > 300) {
    return {
      budgetCents: Math.max(0, safeMonthlyQuota - 300) * PREMIUM_REQUEST_PRICE_CENTS,
      subscriptionPlan: DEFAULT_COPILOT_SUBSCRIPTION_PLAN
    }
  }

  return {
    budgetCents: 0,
    subscriptionPlan: DEFAULT_COPILOT_SUBSCRIPTION_PLAN
  }
}

export function calculateQuotaBreakdown(
  settings: CopilotQuotaSettings,
  spentThisMonth: number
): QuotaBreakdown {
  const planQuota = getPlanQuota(settings.subscriptionPlan)
  const budgetRequestQuota = getBudgetRequestQuota(settings.budgetCents)
  const safeSpentThisMonth = Number.isFinite(spentThisMonth) ? Math.max(0, spentThisMonth) : 0
  const paidSpentThisMonth = Math.max(0, safeSpentThisMonth - planQuota)
  const rawPlanRemaining = Math.max(0, planQuota - safeSpentThisMonth)
  const rawBudgetRemaining = Math.max(0, budgetRequestQuota - paidSpentThisMonth)
  const rawConfiguredTotal = planQuota + budgetRequestQuota
  const rawTotalRemaining = rawPlanRemaining + rawBudgetRemaining

  return {
    budgetRemaining: roundQuotaValue(rawBudgetRemaining),
    budgetRequestQuota: roundQuotaValue(budgetRequestQuota),
    configuredTotal: roundQuotaValue(rawConfiguredTotal),
    planQuota: roundQuotaValue(planQuota),
    planRemaining: roundQuotaValue(rawPlanRemaining),
    totalRemaining: roundQuotaValue(rawTotalRemaining)
  }
}

export function createConfiguredQuotaBreakdown(settings: CopilotQuotaSettings): QuotaBreakdown {
  return calculateQuotaBreakdown(settings, 0)
}

export function calculateQuotaDailyMetrics(input: QuotaDailyMetricsInput): QuotaDailyMetrics {
  const daysRemaining = Math.max(1, input.daysRemaining)
  const planQuota = getPlanQuota(input.settings.subscriptionPlan)
  const budgetRequestQuota = getBudgetRequestQuota(input.settings.budgetCents)
  const safeSpentThisMonth = Number.isFinite(input.spentThisMonth) ? Math.max(0, input.spentThisMonth) : 0
  const safeSpentToday = Number.isFinite(input.spentToday) ? Math.max(0, input.spentToday) : 0
  const spentBeforeToday = Math.max(0, safeSpentThisMonth - safeSpentToday)
  const paidSpentBeforeToday = Math.max(0, spentBeforeToday - planQuota)
  const planRemainingBeforeToday = Math.max(0, planQuota - spentBeforeToday)
  const budgetRemainingBeforeToday = Math.max(0, budgetRequestQuota - paidSpentBeforeToday)
  const effectiveRemainingBeforeToday = planRemainingBeforeToday + budgetRemainingBeforeToday
  const effectiveSpentToday = safeSpentToday
  const rawDailyTarget = effectiveRemainingBeforeToday / daysRemaining
  const rawTodayAvailable = rawDailyTarget - effectiveSpentToday
  const quotaBreakdown = calculateQuotaBreakdown(input.settings, safeSpentThisMonth)

  return {
    dailyTarget: roundQuotaValue(rawDailyTarget),
    monthRemaining: quotaBreakdown.totalRemaining,
    quotaBreakdown,
    todayAvailable: roundQuotaValue(rawTodayAvailable)
  }
}
