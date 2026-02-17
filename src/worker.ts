import { Hono } from 'hono'
import {
  buildTwitchAuthorizeUrl,
  clearOauthStateCookie,
  clearSessionCookie,
  createOauthState,
  createOauthStateCookie,
  createSession,
  createSessionCookie,
  destroySession,
  getOauthStateFromRequest,
  getSessionUser,
  upsertUserFromTwitchCode
} from './lib/auth'
import { deleteObsCache, getCacheUpdatedAt, loadCachedObsData, saveObsDataCache } from './lib/cache'
import { decryptPat, encryptPat } from './lib/crypto'
import { ApiError, errorResponse, fromUnknownError } from './lib/errors'
import { AuthUser, EnvBindings } from './lib/env'
import { buildObsDataFromGitHub, DEFAULT_OBS_WIDGET_TITLE } from './lib/github'
import { parseObsUuid, parseUpdateSettingsInput, ObsDataPayload } from './lib/schemas'

interface UserSettingsRow {
  monthly_quota: number | null;
  obs_title: string | null;
  obs_uuid: string;
  pat_ciphertext: string | null;
  pat_iv: string | null;
}

interface ObsUserRow {
  id: number;
  monthly_quota: number | null;
  obs_title: string | null;
  pat_ciphertext: string | null;
  pat_iv: string | null;
}

type AppEnv = {
  Bindings: EnvBindings;
}

type RequiredEnvKey =
  | 'APP_BASE_URL'
  | 'PAT_ENCRYPTION_KEY_B64'
  | 'SESSION_SECRET'
  | 'TWITCH_CLIENT_ID'
  | 'TWITCH_CLIENT_SECRET'

interface EnvRequirementRule {
  path: string;
  requiredKeys: RequiredEnvKey[];
}

type ObsDataResolutionSource =
  | 'cache_hit'
  | 'github_live'
  | 'github_live_failed'
  | 'cache_stale_fallback'

const DEFAULT_MONTHLY_QUOTA = 300
const ENV_REQUIREMENT_RULES: EnvRequirementRule[] = [
  {
    path: '/api/auth/twitch/login',
    requiredKeys: ['APP_BASE_URL', 'TWITCH_CLIENT_ID']
  },
  {
    path: '/api/auth/twitch/callback',
    requiredKeys: ['APP_BASE_URL', 'SESSION_SECRET', 'TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET']
  },
  {
    path: '/api/auth/logout',
    requiredKeys: ['APP_BASE_URL', 'SESSION_SECRET']
  },
  {
    path: '/api/account',
    requiredKeys: ['APP_BASE_URL', 'SESSION_SECRET']
  },
  {
    path: '/api/me',
    requiredKeys: ['APP_BASE_URL', 'SESSION_SECRET']
  },
  {
    path: '/api/obs-data',
    requiredKeys: ['PAT_ENCRYPTION_KEY_B64']
  },
  {
    path: '/api/obs/regenerate',
    requiredKeys: ['APP_BASE_URL', 'SESSION_SECRET']
  },
  {
    path: '/api/settings',
    requiredKeys: ['APP_BASE_URL', 'SESSION_SECRET']
  }
]

const app = new Hono<AppEnv>()

function getEnvValueByKey(env: EnvBindings, key: RequiredEnvKey): string {
  if (key === 'APP_BASE_URL') {
    return env.APP_BASE_URL
  }

  if (key === 'PAT_ENCRYPTION_KEY_B64') {
    return env.PAT_ENCRYPTION_KEY_B64
  }

  if (key === 'SESSION_SECRET') {
    return env.SESSION_SECRET
  }

  if (key === 'TWITCH_CLIENT_ID') {
    return env.TWITCH_CLIENT_ID
  }

  return env.TWITCH_CLIENT_SECRET
}

function getValidatedAppBaseUrl(value: string): URL {
  let parsedUrl: URL

  try {
    parsedUrl = new URL(value)
  } catch {
    throw new ApiError(500, 'VALIDATION_ERROR', 'APP_BASE_URL must be a valid absolute URL')
  }

  const protocol = parsedUrl.protocol
  const isHttpProtocol = protocol === 'http:' || protocol === 'https:'

  if (!isHttpProtocol) {
    throw new ApiError(500, 'VALIDATION_ERROR', 'APP_BASE_URL must use http or https')
  }

  return parsedUrl
}

function getRequiredEnvKeys(pathname: string): RequiredEnvKey[] {
  for (const rule of ENV_REQUIREMENT_RULES) {
    const isMatchedPath = rule.path === pathname

    if (isMatchedPath) {
      return rule.requiredKeys
    }
  }

  return []
}

function assertRequiredEnvForPath(env: EnvBindings, pathname: string): void {
  const requiredKeys = getRequiredEnvKeys(pathname)

  for (const key of requiredKeys) {
    const value = getEnvValueByKey(env, key)
    const isPresent = typeof value === 'string' && value.length > 0

    if (!isPresent) {
      throw new ApiError(500, 'VALIDATION_ERROR', `${key} is not configured`)
    }

    const isBaseUrlKey = key === 'APP_BASE_URL'

    if (isBaseUrlKey) {
      getValidatedAppBaseUrl(value)
    }
  }
}

function getRequestId(request: Request): string {
  const cfRay = request.headers.get('CF-Ray')
  const hasCfRay = typeof cfRay === 'string' && cfRay.length > 0

  if (hasCfRay) {
    return cfRay
  }

  return crypto.randomUUID()
}

function getErrorMessage(error: unknown): string | null {
  if (error instanceof ApiError) {
    const message = error.message
    const hasMessage = typeof message === 'string' && message.length > 0

    if (hasMessage) {
      return message
    }

    return null
  }

  if (error instanceof Error) {
    const message = error.message
    const hasMessage = typeof message === 'string' && message.length > 0

    if (hasMessage) {
      return message
    }
  }

  return null
}

function logRequestError(
  error: unknown,
  requestId: string
): void {
  const errorMessage = getErrorMessage(error)
  const message = typeof errorMessage === 'string' && errorMessage.length > 0
    ? errorMessage
    : 'Unexpected server error'
  const payload = {
    event: 'worker_error',
    message,
    requestId
  }
  const serialized = JSON.stringify(payload)

  console.error(serialized)
}

function logObsDataResolution(
  requestId: string,
  source: ObsDataResolutionSource,
  userId: number
): void {
  const payload = {
    event: 'obs_data_resolution',
    requestId,
    source,
    userId
  }
  const serialized = JSON.stringify(payload)

  console.info(serialized)
}

function createJsonResponse(
  payload: unknown,
  status: number = 200,
  cookies: string[] = [],
  extraHeaders?: HeadersInit
): Response {
  const headers = new Headers(extraHeaders)

  headers.set('Content-Type', 'application/json; charset=utf-8')

  for (const cookie of cookies) {
    headers.append('Set-Cookie', cookie)
  }

  const serialized = JSON.stringify(payload)

  return new Response(serialized, {
    headers,
    status
  })
}

function createRedirectResponse(
  location: string,
  cookies: string[] = [],
  extraHeaders?: HeadersInit
): Response {
  const headers = new Headers(extraHeaders)

  headers.set('Location', location)

  for (const cookie of cookies) {
    headers.append('Set-Cookie', cookie)
  }

  return new Response(null, {
    headers,
    status: 302
  })
}

function normalizeObsTitle(value: string | null): string {
  const normalizedValue = typeof value === 'string' ? value.trim() : ''
  const hasValue = normalizedValue.length > 0

  if (!hasValue) {
    return DEFAULT_OBS_WIDGET_TITLE
  }

  return normalizedValue
}

function appOrigin(env: EnvBindings): string {
  const parsed = getValidatedAppBaseUrl(env.APP_BASE_URL)
  const origin = parsed.origin

  return origin
}

function buildAppUrl(env: EnvBindings, pathAndQuery: string): string {
  const baseUrl = getValidatedAppBaseUrl(env.APP_BASE_URL)
  const url = new URL(pathAndQuery, baseUrl)

  return url.toString()
}

function shouldCheckOrigin(method: string): boolean {
  const checkMethods = ['DELETE', 'PATCH', 'POST', 'PUT']
  const includesMethod = checkMethods.includes(method)

  return includesMethod
}

function validateOriginHeader(request: Request, env: EnvBindings): void {
  const origin = request.headers.get('Origin')
  const expectedOrigin = appOrigin(env)
  const hasOrigin = typeof origin === 'string' && origin.length > 0

  if (!hasOrigin) {
    throw new ApiError(403, 'VALIDATION_ERROR', 'Origin header is required')
  }

  const isAllowedOrigin = origin === expectedOrigin

  if (!isAllowedOrigin) {
    throw new ApiError(403, 'VALIDATION_ERROR', 'Origin header is invalid')
  }
}

async function requireAuthUser(request: Request, env: EnvBindings): Promise<AuthUser> {
  const authUser = await getSessionUser(env, request)

  if (!authUser) {
    throw new ApiError(401, 'UNAUTHORIZED', 'You need to sign in first')
  }

  return authUser
}

function rewriteAssetPath(request: Request): Request {
  const url = new URL(request.url)
  const pathname = url.pathname

  if (pathname === '/') {
    url.pathname = '/index.html'
  }

  if (pathname === '/obs') {
    url.pathname = '/obs.html'
  }

  const rewrittenRequest = new Request(url.toString(), request)

  return rewrittenRequest
}

app.onError((error, context) => {
  const request = context.req.raw
  const requestId = getRequestId(request)
  const normalized = fromUnknownError(error)
  const response = errorResponse(
    normalized.status,
    normalized.code,
    normalized.message,
    {
      'X-Request-Id': requestId
    }
  )

  logRequestError(error, requestId)

  return response
})

app.use('/api/*', async (context, next) => {
  const requestUrl = new URL(context.req.url)
  const pathname = requestUrl.pathname

  assertRequiredEnvForPath(context.env, pathname)

  const method = context.req.method
  const checkOrigin = shouldCheckOrigin(method)

  if (checkOrigin) {
    validateOriginHeader(context.req.raw, context.env)
  }

  await next()
})

app.get('/api/auth/twitch/login', (context) => {
  const state = createOauthState()
  const authorizeUrl = buildTwitchAuthorizeUrl(context.env, state)
  const stateCookie = createOauthStateCookie(state)
  const response = createRedirectResponse(authorizeUrl, [stateCookie])

  return response
})

app.get('/api/auth/twitch/callback', async (context) => {
  const callbackUrl = new URL(context.req.url)
  const oauthCode = callbackUrl.searchParams.get('code')
  const incomingState = callbackUrl.searchParams.get('state')
  const savedState = getOauthStateFromRequest(context.req.raw)
  const hasIncomingState = typeof incomingState === 'string' && incomingState.length > 0
  const stateMatches = hasIncomingState && savedState === incomingState

  if (!stateMatches || typeof oauthCode !== 'string' || oauthCode.length === 0) {
    const redirectUrl = buildAppUrl(context.env, '/?authError=invalid_oauth_state')
    const response = createRedirectResponse(redirectUrl, [clearOauthStateCookie()])

    return response
  }

  try {
    const authUser = await upsertUserFromTwitchCode(context.env, oauthCode)
    const sessionToken = await createSession(context.env, authUser.id)
    const redirectUrl = buildAppUrl(context.env, '/')
    const response = createRedirectResponse(redirectUrl, [
      clearOauthStateCookie(),
      createSessionCookie(sessionToken)
    ])

    return response
  } catch (error) {
    const request = context.req.raw
    const requestId = getRequestId(request)
    const redirectUrl = buildAppUrl(context.env, '/?authError=twitch_login_failed')
    const response = createRedirectResponse(
      redirectUrl,
      [clearOauthStateCookie()],
      {
        'X-Request-Id': requestId
      }
    )

    logRequestError(error, requestId)

    return response
  }
})

app.post('/api/auth/logout', async (context) => {
  await destroySession(context.env, context.req.raw)

  const response = createJsonResponse(
    {
      ok: true
    },
    200,
    [clearSessionCookie()]
  )

  return response
})

app.delete('/api/account', async (context) => {
  const authUser = await requireAuthUser(context.req.raw, context.env)

  await context.env.DB
    .prepare('DELETE FROM users WHERE id = ?')
    .bind(authUser.id)
    .run()

  const response = createJsonResponse(
    {
      ok: true
    },
    200,
    [clearSessionCookie()]
  )

  return response
})

app.get('/api/me', async (context) => {
  const authUser = await requireAuthUser(context.req.raw, context.env)
  const settingsRow = await context.env.DB
    .prepare(
      `SELECT
        monthly_quota,
        obs_title,
        obs_uuid,
        pat_ciphertext,
        pat_iv
      FROM users
      WHERE id = ?`
    )
    .bind(authUser.id)
    .first<UserSettingsRow>()

  if (!settingsRow) {
    throw new ApiError(404, 'NOT_FOUND', 'User was not found')
  }

  const hasPat =
    typeof settingsRow.pat_ciphertext === 'string' && settingsRow.pat_ciphertext.length > 0
  const hasQuota = typeof settingsRow.monthly_quota === 'number'
  const monthlyQuota = hasQuota ? settingsRow.monthly_quota : null
  const obsTitle = normalizeObsTitle(settingsRow.obs_title)
  const obsUrl = buildAppUrl(context.env, `/obs?uuid=${encodeURIComponent(settingsRow.obs_uuid)}`)

  let dashboardData: ObsDataPayload | null = null

  if (hasPat && hasQuota) {
    const cached = await loadCachedObsData(context.env.DB, authUser.id)
    const hasFreshCache = Boolean(cached?.isFresh)
    const patCiphertext = settingsRow.pat_ciphertext
    const patIv = settingsRow.pat_iv
    const hasValidCredentials =
      typeof patCiphertext === 'string' &&
      patCiphertext.length > 0 &&
      typeof patIv === 'string' &&
      patIv.length > 0

    // If cache is not fresh and we have valid credentials, try to refresh from GitHub
    if (!hasFreshCache && hasValidCredentials && monthlyQuota !== null) {
      try {
        const pat = await decryptPat(
          patCiphertext,
          patIv,
          context.env.PAT_ENCRYPTION_KEY_B64
        )
        const livePayload = await buildObsDataFromGitHub(pat, monthlyQuota, new Date(), obsTitle)
        const parsedUpdatedAt = Date.parse(livePayload.updatedAt)
        const hasValidUpdatedAt = Number.isFinite(parsedUpdatedAt)
        const updatedAt = hasValidUpdatedAt ? parsedUpdatedAt : Date.now()

        await saveObsDataCache(context.env.DB, authUser.id, livePayload, updatedAt)

        // Use the fresh data
        dashboardData = livePayload
      } catch (error) {
        // If refresh fails, fall back to stale cache if available
        if (cached) {
          dashboardData = cached.payload
        }
        // If no cache available, dashboardData remains null
      }
    } else if (cached) {
      // Use cached data when: 1) cache is fresh, or 2) cache is stale but refresh is not possible
      dashboardData = cached.payload
    }
  }

  // Get cache updated at after potential refresh
  const cacheUpdatedAt = await getCacheUpdatedAt(context.env.DB, authUser.id)
  const cacheUpdatedAtIso =
    typeof cacheUpdatedAt === 'number' ? new Date(cacheUpdatedAt).toISOString() : null

  return Response.json({
    cacheUpdatedAt: cacheUpdatedAtIso,
    dashboardData,
    hasPat,
    monthlyQuota,
    obsTitle,
    obsUrl,
    user: {
      displayName: authUser.twitchDisplayName,
      login: authUser.twitchLogin,
      twitchUserId: authUser.twitchUserId
    }
  })
})

app.put('/api/settings', async (context) => {
  const authUser = await requireAuthUser(context.req.raw, context.env)

  let body: unknown = null

  try {
    body = await context.req.json()
  } catch {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Request body must be valid JSON')
  }

  const input = parseUpdateSettingsInput(body)
  const hasAnyUpdate = input.hasMonthlyQuota || input.hasObsTitle || input.hasPat

  if (!hasAnyUpdate) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Provide at least one field: pat, monthlyQuota, obsTitle')
  }

  const currentRow = await context.env.DB
    .prepare(
      `SELECT
        monthly_quota,
        obs_title
      FROM users
      WHERE id = ?`
    )
    .bind(authUser.id)
    .first<{ monthly_quota: number | null; obs_title: string | null }>()

  if (!currentRow) {
    throw new ApiError(404, 'NOT_FOUND', 'User was not found')
  }

  const currentMonthlyQuota = typeof currentRow.monthly_quota === 'number'
    ? currentRow.monthly_quota
    : null
  const shouldApplyDefaultMonthlyQuota =
    input.hasPat && currentMonthlyQuota === null && !input.hasMonthlyQuota
  const nextExplicitMonthlyQuota = shouldApplyDefaultMonthlyQuota
    ? DEFAULT_MONTHLY_QUOTA
    : (input.hasMonthlyQuota ? input.monthlyQuota : null)
  const nextMonthlyQuota = nextExplicitMonthlyQuota === null
    ? currentMonthlyQuota
    : nextExplicitMonthlyQuota
  const normalizedObsTitle = input.obsTitle.trim()
  const nextStoredObsTitle = input.hasObsTitle
    ? (normalizedObsTitle.length > 0 ? normalizedObsTitle : null)
    : currentRow.obs_title
  const resolvedObsTitle = normalizeObsTitle(nextStoredObsTitle)
  let encrypted: { ciphertext: string; iv: string } | null = null

  if (input.hasPat) {
    const hasNextMonthlyQuota = typeof nextMonthlyQuota === 'number'

    if (!hasNextMonthlyQuota) {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        'monthlyQuota is required when saving PAT for the first time'
      )
    }

    const probeDate = new Date()

    await buildObsDataFromGitHub(input.pat, nextMonthlyQuota, probeDate, resolvedObsTitle)
    encrypted = await encryptPat(input.pat, context.env.PAT_ENCRYPTION_KEY_B64)
  }

  const now = Date.now()
  const updateClauses: string[] = []
  const updateValues: unknown[] = []

  if (input.hasPat && encrypted) {
    updateClauses.push('pat_ciphertext = ?')
    updateValues.push(encrypted.ciphertext)
    updateClauses.push('pat_iv = ?')
    updateValues.push(encrypted.iv)
  }

  const shouldUpdateMonthlyQuota = typeof nextExplicitMonthlyQuota === 'number'

  if (shouldUpdateMonthlyQuota) {
    updateClauses.push('monthly_quota = ?')
    updateValues.push(nextExplicitMonthlyQuota)
  }

  if (input.hasObsTitle) {
    updateClauses.push('obs_title = ?')
    updateValues.push(nextStoredObsTitle)
  }

  const hasNoFieldUpdates = updateClauses.length === 0

  if (hasNoFieldUpdates) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'No updatable fields were provided')
  }

  updateClauses.push('updated_at = ?')
  updateValues.push(now)
  updateValues.push(authUser.id)
  const updateSql = `UPDATE users SET ${updateClauses.join(', ')} WHERE id = ?`

  await context.env.DB
    .prepare(updateSql)
    .bind(...updateValues)
    .run()

  await deleteObsCache(context.env.DB, authUser.id)

  return Response.json({
    ok: true
  })
})

app.post('/api/obs/regenerate', async (context) => {
  const authUser = await requireAuthUser(context.req.raw, context.env)
  const obsUuid = crypto.randomUUID()
  const now = Date.now()

  await context.env.DB
    .prepare(
      `UPDATE users
      SET
        obs_uuid = ?,
        updated_at = ?
      WHERE id = ?`
    )
    .bind(obsUuid, now, authUser.id)
    .run()

  const obsUrl = buildAppUrl(context.env, `/obs?uuid=${encodeURIComponent(obsUuid)}`)

  return Response.json({
    obsUrl
  })
})

app.get('/api/obs-data', async (context) => {
  const request = context.req.raw
  const requestId = getRequestId(request)
  const uuidInput = context.req.query('uuid')
  const obsUuid = parseObsUuid(uuidInput)
  const userRow = await context.env.DB
    .prepare(
      `SELECT
        id,
        monthly_quota,
        obs_title,
        pat_ciphertext,
        pat_iv
      FROM users
      WHERE obs_uuid = ?`
    )
    .bind(obsUuid)
    .first<ObsUserRow>()

  if (!userRow) {
    throw new ApiError(404, 'NOT_FOUND', 'OBS source was not found')
  }

  const monthlyQuota = userRow.monthly_quota
  const obsTitle = normalizeObsTitle(userRow.obs_title)
  const patCiphertext = userRow.pat_ciphertext
  const patIv = userRow.pat_iv
  const hasQuota = typeof monthlyQuota === 'number'
  const hasCipher = typeof patCiphertext === 'string' && patCiphertext.length > 0
  const hasIv = typeof patIv === 'string' && patIv.length > 0

  if (!hasQuota || !hasCipher || !hasIv) {
    throw new ApiError(404, 'NOT_FOUND', 'OBS source is not configured yet')
  }

  const cached = await loadCachedObsData(context.env.DB, userRow.id)
  const hasFreshCache = Boolean(cached?.isFresh)

  if (hasFreshCache && cached) {
    logObsDataResolution(requestId, 'cache_hit', userRow.id)

    return Response.json(cached.payload)
  }

  try {
    const pat = await decryptPat(
      patCiphertext,
      patIv,
      context.env.PAT_ENCRYPTION_KEY_B64
    )
    const livePayload = await buildObsDataFromGitHub(pat, monthlyQuota, new Date(), obsTitle)
    const parsedUpdatedAt = Date.parse(livePayload.updatedAt)
    const hasValidUpdatedAt = Number.isFinite(parsedUpdatedAt)
    const updatedAt = hasValidUpdatedAt ? parsedUpdatedAt : Date.now()

    await saveObsDataCache(context.env.DB, userRow.id, livePayload, updatedAt)
    logObsDataResolution(requestId, 'github_live', userRow.id)

    return Response.json(livePayload)
  } catch (error) {
    logObsDataResolution(requestId, 'github_live_failed', userRow.id)

    if (cached) {
      logObsDataResolution(requestId, 'cache_stale_fallback', userRow.id)
      return Response.json(cached.payload)
    }

    const normalized = fromUnknownError(error)
    const isGitHubError = normalized.code.startsWith('GITHUB_')

    if (isGitHubError) {
      return errorResponse(503, normalized.code, normalized.message)
    }

    return errorResponse(normalized.status, normalized.code, normalized.message)
  }
})

app.all('/api/*', () => {
  return errorResponse(404, 'NOT_FOUND', 'Route not found')
})

app.all('*', async (context) => {
  const method = context.req.method
  const isReadMethod = method === 'GET' || method === 'HEAD'

  if (!isReadMethod) {
    return new Response('Method Not Allowed', {
      status: 405
    })
  }

  const assetRequest = rewriteAssetPath(context.req.raw)

  return context.env.ASSETS.fetch(assetRequest)
})

export default app
