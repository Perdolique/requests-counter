import * as v from 'valibot'
import { ApiError } from './errors'
import { CopilotSubscriptionPlan, QuotaBreakdown } from './quota'

const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const updateSettingsSchema = v.strictObject({
  availableTodayAlgorithmId: v.optional(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(64)
    )
  ),
  availableTodayTokenBucketBankDays: v.optional(
    v.union([
      v.literal(3),
      v.literal(5),
      v.literal(7)
    ])
  ),
  subscriptionPlan: v.optional(
    v.picklist(['pro', 'pro_plus'])
  ),
  budgetCents: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(0),
      v.maxValue(1_000_000_000)
    )
  ),
  obsTitle: v.optional(
    v.pipe(
      v.string(),
      v.maxLength(120)
    )
  )
})

const uuidSchema = v.pipe(
  v.string(),
  v.regex(uuidPattern, 'Invalid UUID')
)

const dataSchema = v.object({
  configuredTotal: v.number(),
  dailyTarget: v.number(),
  daysRemaining: v.number(),
  display: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(64)
  ),
  hasUsageData: v.boolean(),
  hardPaceDailyTarget: v.nullable(v.number()),
  hardPaceDisplay: v.nullable(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(64)
    )
  ),
  hardPaceTodayAvailable: v.nullable(v.number()),
  monthRemaining: v.number(),
  modelUsageByPeriod: v.object({
    month: v.array(
      v.object({
        model: v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(200)
        ),
        requests: v.number()
      })
    ),
    yesterday: v.array(
      v.object({
        model: v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(200)
        ),
        requests: v.number()
      })
    ),
    today: v.array(
      v.object({
        model: v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(200)
        ),
        requests: v.number()
      })
    )
  }),
  periodResetDate: v.pipe(
    v.string(),
    v.regex(isoTimestampPattern, 'periodResetDate must be an ISO timestamp')
  ),
  title: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(120)
  ),
  tokenBucketCapacity: v.nullable(v.number()),
  tokenBucketDailyRefill: v.nullable(v.number()),
  todayAvailable: v.number(),
  updatedAt: v.pipe(
    v.string(),
    v.regex(isoTimestampPattern, 'updatedAt must be an ISO timestamp')
  )
})

const quotaBreakdownSchema = v.object({
  budgetRemaining: v.number(),
  budgetRequestQuota: v.number(),
  configuredTotal: v.number(),
  planQuota: v.number(),
  planRemaining: v.number(),
  totalRemaining: v.number()
})

const cachedDashboardStateSchema = v.object({
  payload: dataSchema,
  quotaBreakdown: quotaBreakdownSchema
})

const githubAppTokenSchema = v.object({
  access_token: v.pipe(
    v.string(),
    v.minLength(1)
  ),
  expires_in: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(1)
  ),
  refresh_token: v.pipe(
    v.string(),
    v.minLength(1)
  ),
  refresh_token_expires_in: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(1)
  ),
  token_type: v.pipe(
    v.string(),
    v.minLength(1)
  )
})

const githubOauthCallbackQuerySchema = v.strictObject({
  code: v.optional(v.string()),
  error: v.optional(v.string()),
  error_description: v.optional(v.string()),
  state: v.optional(v.string())
})

export interface DataPayload {
  configuredTotal: number;
  dailyTarget: number;
  daysRemaining: number;
  display: string;
  hasUsageData: boolean;
  hardPaceDailyTarget: number | null;
  hardPaceDisplay: string | null;
  hardPaceTodayAvailable: number | null;
  monthRemaining: number;
  modelUsageByPeriod: ModelUsageByPeriod;
  periodResetDate: string;
  title: string;
  tokenBucketCapacity: number | null;
  tokenBucketDailyRefill: number | null;
  todayAvailable: number;
  updatedAt: string;
}

export interface MonthlyModelUsageItem {
  model: string;
  requests: number;
}

export interface ModelUsageByPeriod {
  month: MonthlyModelUsageItem[];
  yesterday: MonthlyModelUsageItem[];
  today: MonthlyModelUsageItem[];
}

export interface UpdateSettingsInput {
  availableTodayAlgorithmId: string | null;
  hasAvailableTodayAlgorithmId: boolean;
  availableTodayTokenBucketBankDays: 3 | 5 | 7 | null;
  hasAvailableTodayTokenBucketBankDays: boolean;
  budgetCents: number | null;
  hasBudgetCents: boolean;
  hasObsTitle: boolean;
  hasSubscriptionPlan: boolean;
  obsTitle: string;
  subscriptionPlan: CopilotSubscriptionPlan | null;
}

export interface CachedDashboardState {
  payload: DataPayload;
  quotaBreakdown: QuotaBreakdown;
}

export interface GitHubAppTokenPayload {
  accessToken: string;
  accessTokenExpiresInSeconds: number;
  refreshToken: string;
  refreshTokenExpiresInSeconds: number;
  tokenType: string;
}

export interface GitHubOauthCallbackQuery {
  code: string | null;
  error: string | null;
  errorDescription: string | null;
  state: string | null;
}

function parseWithValidationError<T>(callback: () => T): T {
  try {
    const output = callback()

    return output
  } catch {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Payload validation failed')
  }
}

export function parseObsUuid(value: unknown): string {
  const output = parseWithValidationError(() => v.parse(uuidSchema, value))

  return output
}

export function parseDataPayload(value: unknown): DataPayload {
  const output = parseWithValidationError(() => v.parse(dataSchema, value))

  return output
}

export function parseUpdateSettingsInput(value: unknown): UpdateSettingsInput {
  const output = parseWithValidationError(() => v.parse(updateSettingsSchema, value))
  const hasAvailableTodayAlgorithmId = typeof output.availableTodayAlgorithmId === 'string'
  const hasAvailableTodayTokenBucketBankDays = typeof output.availableTodayTokenBucketBankDays === 'number'
  const hasSubscriptionPlan = typeof output.subscriptionPlan === 'string'
  const hasBudgetCents = typeof output.budgetCents === 'number'
  const hasObsTitle = typeof output.obsTitle === 'string'
  const availableTodayAlgorithmId = hasAvailableTodayAlgorithmId
    ? output.availableTodayAlgorithmId as string
    : null
  const availableTodayTokenBucketBankDays = hasAvailableTodayTokenBucketBankDays
    ? output.availableTodayTokenBucketBankDays as 3 | 5 | 7
    : null
  const obsTitle = typeof output.obsTitle === 'string' ? output.obsTitle : ''
  const subscriptionPlan = hasSubscriptionPlan
    ? output.subscriptionPlan as CopilotSubscriptionPlan
    : null
  const budgetCents = hasBudgetCents ? output.budgetCents as number : null

  return {
    availableTodayAlgorithmId,
    hasAvailableTodayAlgorithmId,
    availableTodayTokenBucketBankDays,
    hasAvailableTodayTokenBucketBankDays,
    budgetCents,
    hasBudgetCents,
    hasObsTitle,
    hasSubscriptionPlan,
    obsTitle,
    subscriptionPlan
  }
}

export function parseQuotaBreakdown(value: unknown): QuotaBreakdown {
  const output = parseWithValidationError(() => v.parse(quotaBreakdownSchema, value))

  return {
    budgetRemaining: output.budgetRemaining,
    budgetRequestQuota: output.budgetRequestQuota,
    configuredTotal: output.configuredTotal,
    planQuota: output.planQuota,
    planRemaining: output.planRemaining,
    totalRemaining: output.totalRemaining
  }
}

export function parseCachedDashboardState(value: unknown): CachedDashboardState {
  const output = parseWithValidationError(() => v.parse(cachedDashboardStateSchema, value))

  return {
    payload: output.payload,
    quotaBreakdown: output.quotaBreakdown
  }
}

export function parseGitHubAppTokenPayload(value: unknown): GitHubAppTokenPayload {
  const output = parseWithValidationError(() => v.parse(githubAppTokenSchema, value))

  return {
    accessToken: output.access_token,
    accessTokenExpiresInSeconds: output.expires_in,
    refreshToken: output.refresh_token,
    refreshTokenExpiresInSeconds: output.refresh_token_expires_in,
    tokenType: output.token_type
  }
}

export function parseGitHubOauthCallbackQuery(value: unknown): GitHubOauthCallbackQuery {
  const output = parseWithValidationError(() => v.parse(githubOauthCallbackQuerySchema, value))

  return {
    code: typeof output.code === 'string' && output.code.length > 0 ? output.code : null,
    error: typeof output.error === 'string' && output.error.length > 0 ? output.error : null,
    errorDescription:
      typeof output.error_description === 'string' && output.error_description.length > 0
        ? output.error_description
        : null,
    state: typeof output.state === 'string' && output.state.length > 0 ? output.state : null
  }
}
