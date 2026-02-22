import * as v from 'valibot'
import { ApiError } from './errors'

const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const updateSettingsSchema = v.strictObject({
  monthlyQuota: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(1),
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
  dailyTarget: v.number(),
  daysRemaining: v.number(),
  display: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(64)
  ),
  monthRemaining: v.number(),
  title: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(120)
  ),
  todayAvailable: v.number(),
  updatedAt: v.pipe(
    v.string(),
    v.regex(isoTimestampPattern, 'updatedAt must be an ISO timestamp')
  )
})

const twitchTokenSchema = v.object({
  access_token: v.pipe(
    v.string(),
    v.minLength(1)
  )
})

const twitchUsersEnvelopeSchema = v.object({
  data: v.pipe(
    v.array(
      v.object({
        display_name: v.pipe(
          v.string(),
          v.minLength(1)
        ),
        id: v.pipe(
          v.string(),
          v.minLength(1)
        ),
        login: v.pipe(
          v.string(),
          v.minLength(1)
        )
      })
    ),
    v.minLength(1)
  )
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
  dailyTarget: number;
  daysRemaining: number;
  display: string;
  monthRemaining: number;
  title: string;
  todayAvailable: number;
  updatedAt: string;
}

export interface TwitchTokenPayload {
  accessToken: string;
}

export interface TwitchUserPayload {
  displayName: string;
  id: string;
  login: string;
}

export interface UpdateSettingsInput {
  hasMonthlyQuota: boolean;
  hasObsTitle: boolean;
  monthlyQuota: number | null;
  obsTitle: string;
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

export function parseTwitchTokenPayload(value: unknown): TwitchTokenPayload {
  const output = parseWithValidationError(() => v.parse(twitchTokenSchema, value))

  return {
    accessToken: output.access_token
  }
}

export function parseTwitchUserPayload(value: unknown): TwitchUserPayload {
  const output = parseWithValidationError(() => v.parse(twitchUsersEnvelopeSchema, value))
  const firstUser = output.data[0]

  return {
    displayName: firstUser.display_name,
    id: firstUser.id,
    login: firstUser.login
  }
}

export function parseUpdateSettingsInput(value: unknown): UpdateSettingsInput {
  const output = parseWithValidationError(() => v.parse(updateSettingsSchema, value))
  const hasMonthlyQuota = typeof output.monthlyQuota === 'number'
  const hasObsTitle = typeof output.obsTitle === 'string'
  const obsTitle = typeof output.obsTitle === 'string' ? output.obsTitle : ''
  const monthlyQuota = hasMonthlyQuota ? (output.monthlyQuota as number) : null

  return {
    hasMonthlyQuota,
    hasObsTitle,
    monthlyQuota,
    obsTitle
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
