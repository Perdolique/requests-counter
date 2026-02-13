import * as v from 'valibot'
import { ApiError } from './errors'

const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const updateSettingsSchema = v.object({
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
  ),
  pat: v.optional(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(2048)
    )
  )
})

const uuidSchema = v.pipe(
  v.string(),
  v.regex(uuidPattern, 'Invalid UUID')
)

const obsDataSchema = v.object({
  dailyTarget: v.number(),
  display: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(64)
  ),
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

export interface ObsDataPayload {
  dailyTarget: number;
  display: string;
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
  hasPat: boolean;
  monthlyQuota: number | null;
  obsTitle: string;
  pat: string;
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

export function parseObsDataPayload(value: unknown): ObsDataPayload {
  const output = parseWithValidationError(() => v.parse(obsDataSchema, value))

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
  const hasPat = typeof output.pat === 'string'
  const obsTitle = typeof output.obsTitle === 'string' ? output.obsTitle : ''
  const pat = typeof output.pat === 'string' ? output.pat : ''
  const monthlyQuota = hasMonthlyQuota ? (output.monthlyQuota as number) : null

  return {
    hasMonthlyQuota,
    hasObsTitle,
    hasPat,
    monthlyQuota,
    obsTitle,
    pat
  }
}
