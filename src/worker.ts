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
import { deleteCache, getCacheUpdatedAt } from './lib/cache'
import { loadData, type DataResolutionSource } from './lib/data-loader'
import { ApiError, errorResponse, fromUnknownError } from './lib/errors'
import { AuthUser, EnvBindings } from './lib/env'
import {
  buildGitHubAuthorizeUrl,
  clearGitHubConnection,
  exchangeGitHubCodeForUserTokenBundle,
  fetchGitHubUserProfile,
  saveGitHubTokenBundle
} from './lib/github-auth'
import { DEFAULT_WIDGET_TITLE } from './lib/github'

import {
  parseGitHubOauthCallbackQuery,
  parseObsUuid,
  parseUpdateSettingsInput
} from './lib/schemas'

interface UserSettingsRow {
  github_auth_invalid_at: number | null;
  github_login: string | null;
  github_refresh_token_ciphertext: string | null;
  github_refresh_token_iv: string | null;
  monthly_quota: number | null;
  obs_title: string | null;
  obs_uuid: string;
}

interface UserDataRow {
  github_refresh_token_ciphertext: string | null;
  github_refresh_token_iv: string | null;
  id: number;
  monthly_quota: number | null;
  obs_title: string | null;
}

type AppEnv = {
  Bindings: EnvBindings;
}

type RequiredEnvKey =
  | 'APP_BASE_URL'
  | 'GITHUB_APP_CLIENT_ID'
  | 'GITHUB_APP_CLIENT_SECRET'
  | 'SECRETS_ENCRYPTION_KEY_B64'
  | 'SESSION_SECRET'
  | 'TWITCH_CLIENT_ID'
  | 'TWITCH_CLIENT_SECRET'

interface EnvRequirementRule {
  path: string;
  requiredKeys: RequiredEnvKey[];
}

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
    path: '/api/auth/github/login',
    requiredKeys: ['APP_BASE_URL', 'SESSION_SECRET', 'GITHUB_APP_CLIENT_ID']
  },
  {
    path: '/api/auth/github/callback',
    requiredKeys: [
      'APP_BASE_URL',
      'SESSION_SECRET',
      'GITHUB_APP_CLIENT_ID',
      'GITHUB_APP_CLIENT_SECRET',
      'SECRETS_ENCRYPTION_KEY_B64'
    ]
  },
  {
    path: '/api/auth/github/disconnect',
    requiredKeys: ['APP_BASE_URL', 'SESSION_SECRET']
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
    requiredKeys: [
      'APP_BASE_URL',
      'SESSION_SECRET',
      'GITHUB_APP_CLIENT_ID',
      'GITHUB_APP_CLIENT_SECRET',
      'SECRETS_ENCRYPTION_KEY_B64'
    ]
  },
  {
    path: '/api/obs-data',
    requiredKeys: [
      'GITHUB_APP_CLIENT_ID',
      'GITHUB_APP_CLIENT_SECRET',
      'SECRETS_ENCRYPTION_KEY_B64'
    ]
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

  if (key === 'GITHUB_APP_CLIENT_ID') {
    return env.GITHUB_APP_CLIENT_ID
  }

  if (key === 'GITHUB_APP_CLIENT_SECRET') {
    return env.GITHUB_APP_CLIENT_SECRET
  }

  if (key === 'SECRETS_ENCRYPTION_KEY_B64') {
    return env.SECRETS_ENCRYPTION_KEY_B64
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

type DataResolutionLogEvent = DataResolutionSource | 'github_live_failed'

function logDataResolution(
  requestId: string,
  source: DataResolutionLogEvent,
  userId: number
): void {
  const payload = {
    event: 'data_resolution',
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

function stripHtmlTags(value: string): string {
  return value.replace(/<[^>]*>/g, '')
}

function normalizeObsTitle(value: string | null): string {
  const trimmedValue = typeof value === 'string' ? value.trim() : ''
  const sanitizedValue = stripHtmlTags(trimmedValue)
  const hasValue = sanitizedValue.length > 0

  if (!hasValue) {
    return DEFAULT_WIDGET_TITLE
  }

  return sanitizedValue
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
  const stateCookie = createOauthStateCookie('twitch', state)
  const response = createRedirectResponse(authorizeUrl, [stateCookie])

  return response
})

app.get('/api/auth/twitch/callback', async (context) => {
  const callbackUrl = new URL(context.req.url)
  const oauthCode = callbackUrl.searchParams.get('code')
  const incomingState = callbackUrl.searchParams.get('state')
  const savedState = getOauthStateFromRequest(context.req.raw, 'twitch')
  const hasIncomingState = typeof incomingState === 'string' && incomingState.length > 0
  const stateMatches = hasIncomingState && savedState === incomingState

  if (!stateMatches || typeof oauthCode !== 'string' || oauthCode.length === 0) {
    const redirectUrl = buildAppUrl(context.env, '/?authError=invalid_oauth_state')
    const response = createRedirectResponse(redirectUrl, [clearOauthStateCookie('twitch')])

    return response
  }

  try {
    const authUser = await upsertUserFromTwitchCode(context.env, oauthCode)
    const sessionToken = await createSession(context.env, authUser.id)
    const redirectUrl = buildAppUrl(context.env, '/')
    const response = createRedirectResponse(redirectUrl, [
      clearOauthStateCookie('twitch'),
      createSessionCookie(sessionToken)
    ])

    return response
  } catch (error) {
    const request = context.req.raw
    const requestId = getRequestId(request)
    const redirectUrl = buildAppUrl(context.env, '/?authError=twitch_login_failed')
    const response = createRedirectResponse(
      redirectUrl,
      [clearOauthStateCookie('twitch')],
      {
        'X-Request-Id': requestId
      }
    )

    logRequestError(error, requestId)

    return response
  }
})

app.get('/api/auth/github/login', async (context) => {
  await requireAuthUser(context.req.raw, context.env)

  const state = createOauthState()
  const authorizeUrl = buildGitHubAuthorizeUrl(context.env, state)
  const stateCookie = createOauthStateCookie('github', state)
  const response = createRedirectResponse(authorizeUrl, [stateCookie])

  return response
})

app.get('/api/auth/github/callback', async (context) => {
  const authUser = await getSessionUser(context.env, context.req.raw)

  if (!authUser) {
    const redirectUrl = buildAppUrl(context.env, '/?githubAuthError=session_expired')
    const response = createRedirectResponse(redirectUrl, [clearOauthStateCookie('github')])

    return response
  }

  const callbackUrl = new URL(context.req.url)
  const callbackQuery = parseGitHubOauthCallbackQuery({
    code: callbackUrl.searchParams.get('code') ?? undefined,
    error: callbackUrl.searchParams.get('error') ?? undefined,
    error_description: callbackUrl.searchParams.get('error_description') ?? undefined,
    state: callbackUrl.searchParams.get('state') ?? undefined
  })
  const savedState = getOauthStateFromRequest(context.req.raw, 'github')
  const stateMatches = typeof callbackQuery.state === 'string' && savedState === callbackQuery.state

  if (!stateMatches) {
    const redirectUrl = buildAppUrl(context.env, '/?githubAuthError=state')
    const response = createRedirectResponse(redirectUrl, [clearOauthStateCookie('github')])

    return response
  }

  const hasError = typeof callbackQuery.error === 'string' && callbackQuery.error.length > 0

  if (hasError) {
    const isCancelled = callbackQuery.error === 'access_denied'
    const errorFlag = isCancelled ? 'cancelled' : 'failed'
    const redirectUrl = buildAppUrl(context.env, `/?githubAuthError=${encodeURIComponent(errorFlag)}`)
    const response = createRedirectResponse(redirectUrl, [clearOauthStateCookie('github')])

    return response
  }

  const hasCode = typeof callbackQuery.code === 'string' && callbackQuery.code.length > 0

  if (!hasCode || !callbackQuery.code) {
    const redirectUrl = buildAppUrl(context.env, '/?githubAuthError=failed')
    const response = createRedirectResponse(redirectUrl, [clearOauthStateCookie('github')])

    return response
  }

  try {
    const now = Date.now()
    const tokenBundle = await exchangeGitHubCodeForUserTokenBundle(context.env, callbackQuery.code)
    const githubProfile = await fetchGitHubUserProfile(tokenBundle.accessToken)
    const accessTokenExpiresAt = now + tokenBundle.accessTokenExpiresInSeconds * 1000
    const refreshTokenExpiresAt = now + tokenBundle.refreshTokenExpiresInSeconds * 1000

    await saveGitHubTokenBundle(context.env, context.env.DB, authUser.id, {
      accessToken: tokenBundle.accessToken,
      accessTokenExpiresAt,
      githubLogin: githubProfile.login,
      githubUserId: githubProfile.id,
      refreshToken: tokenBundle.refreshToken,
      refreshTokenExpiresAt,
      setConnectedAt: true
    })
    await deleteCache(context.env.DB, authUser.id)

    const redirectUrl = buildAppUrl(context.env, '/?githubAuth=connected')
    const response = createRedirectResponse(redirectUrl, [clearOauthStateCookie('github')])

    return response
  } catch (error) {
    const request = context.req.raw
    const requestId = getRequestId(request)
    const redirectUrl = buildAppUrl(context.env, '/?githubAuthError=failed')
    const response = createRedirectResponse(
      redirectUrl,
      [clearOauthStateCookie('github')],
      {
        'X-Request-Id': requestId
      }
    )

    logRequestError(error, requestId)

    return response
  }
})

app.post('/api/auth/github/disconnect', async (context) => {
  const authUser = await requireAuthUser(context.req.raw, context.env)

  await clearGitHubConnection(context.env.DB, authUser.id)
  await deleteCache(context.env.DB, authUser.id)

  return Response.json({
    ok: true
  })
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
        github_auth_invalid_at,
        github_login,
        github_refresh_token_ciphertext,
        github_refresh_token_iv,
        monthly_quota,
        obs_title,
        obs_uuid
      FROM users
      WHERE id = ?`
    )
    .bind(authUser.id)
    .first<UserSettingsRow>()

  if (!settingsRow) {
    throw new ApiError(404, 'NOT_FOUND', 'User was not found')
  }

  const cacheUpdatedAt = await getCacheUpdatedAt(context.env.DB, authUser.id)
  const hasRefreshTokenCiphertext =
    typeof settingsRow.github_refresh_token_ciphertext === 'string'
    && settingsRow.github_refresh_token_ciphertext.length > 0
  const hasRefreshTokenIv =
    typeof settingsRow.github_refresh_token_iv === 'string' && settingsRow.github_refresh_token_iv.length > 0
  const githubConnected = hasRefreshTokenCiphertext && hasRefreshTokenIv
  const githubAuthInvalid =
    typeof settingsRow.github_auth_invalid_at === 'number' && settingsRow.github_auth_invalid_at > 0
  const githubAuthStatus = !githubConnected
    ? 'missing'
    : (githubAuthInvalid ? 'reconnect_required' : 'connected')
  const hasQuota = typeof settingsRow.monthly_quota === 'number'
  const monthlyQuota = hasQuota ? settingsRow.monthly_quota : null
  const obsTitle = normalizeObsTitle(settingsRow.obs_title)
  const githubLogin = typeof settingsRow.github_login === 'string' ? settingsRow.github_login : null
  const cacheUpdatedAtIso =
    typeof cacheUpdatedAt === 'number' ? new Date(cacheUpdatedAt).toISOString() : null
  const obsUrl = buildAppUrl(context.env, `/obs?uuid=${encodeURIComponent(settingsRow.obs_uuid)}`)

  let dashboardData: {
    dailyTarget: number;
    daysRemaining: number;
    display: string;
    monthRemaining: number;
    todayAvailable: number;
  } | null = null

  if (githubConnected && hasQuota) {
    try {
      const result = await loadData({
        db: context.env.DB,
        env: context.env,
        monthlyQuota: settingsRow.monthly_quota as number,
        title: obsTitle,
        userId: authUser.id
      })

      if (result) {
        console.log(JSON.stringify({ event: 'dashboard_loaded', userId: authUser.id, source: result.source }))
        dashboardData = {
          dailyTarget: result.payload.dailyTarget,
          daysRemaining: result.payload.daysRemaining,
          display: result.payload.display,
          monthRemaining: result.payload.monthRemaining,
          todayAvailable: result.payload.todayAvailable
        }
      } else {
        console.warn(JSON.stringify({ event: 'dashboard_null', userId: authUser.id }))
      }
    } catch (error) {
      const errorCode = error instanceof ApiError ? error.code : 'UNKNOWN'
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error(JSON.stringify({ event: 'dashboard_failed', userId: authUser.id, error: errorCode, message: errorMessage }))
      // dashboard data unavailable; continue without it
    }
  }

  return Response.json({
    cacheUpdatedAt: cacheUpdatedAtIso,
    dashboardData,
    githubAuthStatus,
    githubConnected,
    githubLogin,
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
  const hasAnyUpdate = input.hasMonthlyQuota || input.hasObsTitle

  if (!hasAnyUpdate) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Provide at least one field: monthlyQuota, obsTitle')
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

  const nextExplicitMonthlyQuota = input.hasMonthlyQuota ? input.monthlyQuota : null
  const normalizedObsTitle = input.obsTitle.trim()
  const nextStoredObsTitle = input.hasObsTitle
    ? (normalizedObsTitle.length > 0 ? normalizedObsTitle : null)
    : currentRow.obs_title

  const now = Date.now()
  const updateClauses: string[] = []
  const updateValues: unknown[] = []

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

  await deleteCache(context.env.DB, authUser.id)

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
        github_refresh_token_ciphertext,
        github_refresh_token_iv,
        id,
        monthly_quota,
        obs_title
      FROM users
      WHERE obs_uuid = ?`
    )
    .bind(obsUuid)
    .first<UserDataRow>()

  if (!userRow) {
    throw new ApiError(404, 'NOT_FOUND', 'OBS source was not found')
  }

  const monthlyQuota = userRow.monthly_quota
  const obsTitle = normalizeObsTitle(userRow.obs_title)
  const githubRefreshTokenCiphertext = userRow.github_refresh_token_ciphertext
  const githubRefreshTokenIv = userRow.github_refresh_token_iv
  const hasQuota = typeof monthlyQuota === 'number'
  const hasCipher = typeof githubRefreshTokenCiphertext === 'string'
    && githubRefreshTokenCiphertext.length > 0
  const hasIv = typeof githubRefreshTokenIv === 'string' && githubRefreshTokenIv.length > 0

  if (!hasQuota || !hasCipher || !hasIv) {
    throw new ApiError(404, 'NOT_FOUND', 'OBS source is not configured yet')
  }

  try {
    const result = await loadData({
      db: context.env.DB,
      env: context.env,
      monthlyQuota,
      title: obsTitle,
      userId: userRow.id
    })

    if (!result) {
      throw new ApiError(404, 'NOT_FOUND', 'OBS source is not configured yet')
    }

    logDataResolution(requestId, result.source, userRow.id)

    return Response.json(result.payload)
  } catch (error) {
    if (error instanceof ApiError) {
      throw error
    }

    logDataResolution(requestId, 'github_live_failed', userRow.id)

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
