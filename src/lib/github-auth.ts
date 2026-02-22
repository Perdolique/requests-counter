import { D1Database } from '../types/cloudflare'
import { encryptSecret, decryptSecret } from './crypto'
import { ApiError } from './errors'
import { EnvBindings } from './env'
import { parseGitHubAppTokenPayload } from './schemas'

const GITHUB_API_BASE_URL = 'https://api.github.com'
const GITHUB_AUTH_BASE_URL = 'https://github.com'
const GITHUB_USER_AGENT = 'requests-counter-worker'
const GITHUB_API_VERSION = '2022-11-28'
const ACCESS_TOKEN_EXPIRY_SAFETY_MS = 60_000

interface GitHubTokenEndpointErrorPayload {
  error?: unknown;
  error_description?: unknown;
}

interface GitHubUserProfile {
  id: string;
  login: string;
}

interface GitHubTokenRow {
  github_access_token_ciphertext: string | null;
  github_access_token_expires_at: number | null;
  github_access_token_iv: string | null;
  github_auth_invalid_at: number | null;
  github_login: string | null;
  github_refresh_token_ciphertext: string | null;
  github_refresh_token_expires_at: number | null;
  github_refresh_token_iv: string | null;
  github_user_id: string | null;
}

interface GitHubTokenBundle {
  accessToken: string | null;
  accessTokenExpiresAt: number | null;
  authInvalidAt: number | null;
  githubLogin: string | null;
  githubUserId: string | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: number | null;
}

interface SaveGitHubTokenBundleInput {
  accessToken: string;
  accessTokenExpiresAt: number;
  githubLogin?: string;
  githubUserId?: string;
  refreshToken: string;
  refreshTokenExpiresAt: number;
  setConnectedAt: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  const isObject = typeof value === 'object' && value !== null && !Array.isArray(value)

  return isObject
}

function buildGitHubCallbackUrl(env: EnvBindings): string {
  const callbackUrl = new URL('/api/auth/github/callback', env.APP_BASE_URL)

  return callbackUrl.toString()
}

function parseGitHubUserProfile(value: unknown): GitHubUserProfile {
  const isObject = isRecord(value)

  if (!isObject) {
    throw new ApiError(502, 'GITHUB_AUTH_FAILED', 'GitHub /user response is not a JSON object')
  }

  const loginValue = value.login
  const idValue = value.id
  const hasLogin = typeof loginValue === 'string' && loginValue.length > 0
  const hasIdNumber = typeof idValue === 'number' && Number.isFinite(idValue)
  const hasIdString = typeof idValue === 'string' && idValue.length > 0

  if (!hasLogin || (!hasIdNumber && !hasIdString)) {
    throw new ApiError(502, 'GITHUB_AUTH_FAILED', 'GitHub /user response is missing login or id')
  }

  const id = hasIdString ? (idValue as string) : String(idValue)

  return {
    id,
    login: loginValue as string
  }
}

async function parseJsonOrText(response: Response): Promise<{
  payload: unknown;
  rawText: string;
}> {
  const rawText = await response.text()
  const hasRawText = rawText.length > 0
  let payload: unknown = null

  if (hasRawText) {
    try {
      payload = JSON.parse(rawText)
    } catch {
      payload = null
    }
  }

  return {
    payload,
    rawText
  }
}

function getGitHubTokenEndpointErrorMessage(
  payload: unknown,
  rawText: string,
  status: number
): string {
  const hasPayloadObject = isRecord(payload)

  if (hasPayloadObject) {
    const errorPayload = payload as GitHubTokenEndpointErrorPayload
    const errorCode = typeof errorPayload.error === 'string' ? errorPayload.error : null
    const errorDescription = typeof errorPayload.error_description === 'string'
      ? errorPayload.error_description
      : null
    const hasErrorCode = typeof errorCode === 'string' && errorCode.length > 0
    const hasErrorDescription = typeof errorDescription === 'string' && errorDescription.length > 0

    if (hasErrorCode || hasErrorDescription) {
      const parts: string[] = []

      if (hasErrorCode && errorCode) {
        parts.push(errorCode)
      }

      if (hasErrorDescription && errorDescription) {
        parts.push(errorDescription)
      }

      return `GitHub token endpoint error (${status}): ${parts.join(': ')}`
    }
  }

  const compact = rawText.replace(/\s+/g, ' ').trim()
  const hasCompactText = compact.length > 0

  if (hasCompactText) {
    return `GitHub token endpoint error (${status}): ${compact}`
  }

  return `GitHub token endpoint error (${status})`
}

async function requestGitHubToken(
  env: EnvBindings,
  params: URLSearchParams
): Promise<ReturnType<typeof parseGitHubAppTokenPayload>> {
  const response = await fetch(`${GITHUB_AUTH_BASE_URL}/login/oauth/access_token`, {
    body: params.toString(),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': GITHUB_USER_AGENT
    },
    method: 'POST'
  })
  const parsedResponse = await parseJsonOrText(response)
  const payload = parsedResponse.payload
  const rawText = parsedResponse.rawText
  const message = getGitHubTokenEndpointErrorMessage(payload, rawText, response.status)

  if (!response.ok) {
    throw new ApiError(502, 'GITHUB_AUTH_FAILED', message)
  }

  const hasPayloadObject = isRecord(payload)

  if (hasPayloadObject) {
    const errorValue = payload.error
    const hasEndpointError = typeof errorValue === 'string' && errorValue.length > 0

    if (hasEndpointError) {
      throw new ApiError(502, 'GITHUB_AUTH_FAILED', message)
    }
  }

  const tokenPayload = parseGitHubAppTokenPayload(payload)
  const tokenTypeLower = tokenPayload.tokenType.toLowerCase()
  const isBearer = tokenTypeLower === 'bearer'

  if (!isBearer) {
    throw new ApiError(502, 'GITHUB_AUTH_FAILED', `Unsupported GitHub token type: ${tokenPayload.tokenType}`)
  }

  const hasClientId = typeof env.GITHUB_APP_CLIENT_ID === 'string' && env.GITHUB_APP_CLIENT_ID.length > 0

  if (!hasClientId) {
    throw new ApiError(500, 'VALIDATION_ERROR', 'GITHUB_APP_CLIENT_ID is not configured')
  }

  return tokenPayload
}

async function loadGitHubTokenRow(db: D1Database, userId: number): Promise<GitHubTokenRow | null> {
  const row = await db
    .prepare(
      `SELECT
        github_user_id,
        github_login,
        github_access_token_ciphertext,
        github_access_token_iv,
        github_access_token_expires_at,
        github_refresh_token_ciphertext,
        github_refresh_token_iv,
        github_refresh_token_expires_at,
        github_auth_invalid_at
      FROM users
      WHERE id = ?`
    )
    .bind(userId)
    .first<GitHubTokenRow>()

  if (!row) {
    return null
  }

  return row
}

async function decryptOptionalSecret(
  ciphertext: string | null,
  iv: string | null,
  keyBase64: string
): Promise<string | null> {
  const hasCiphertext = typeof ciphertext === 'string' && ciphertext.length > 0
  const hasIv = typeof iv === 'string' && iv.length > 0

  if (!hasCiphertext || !hasIv) {
    return null
  }

  const plainText = await decryptSecret(ciphertext, iv, keyBase64)

  return plainText
}

function isRefreshTokenEndpointInvalidError(error: unknown): boolean {
  if (!(error instanceof ApiError)) {
    return false
  }

  const isGitHubAuthError = error.code === 'GITHUB_AUTH_FAILED'

  if (!isGitHubAuthError) {
    return false
  }

  const message = error.message.toLowerCase()
  const knownMarkers = ['bad_refresh_token', 'invalid_grant', 'expired', 'revoked']
  const hasKnownMarker = knownMarkers.some((marker) => message.includes(marker))

  return hasKnownMarker
}

function isGitHubAuthMarkedInvalid(bundle: GitHubTokenBundle): boolean {
  const authInvalidAt = bundle.authInvalidAt
  const hasInvalidMarker = typeof authInvalidAt === 'number' && authInvalidAt > 0

  return hasInvalidMarker
}

function createGitHubTokenInvalidError(): ApiError {
  return new ApiError(
    400,
    'GITHUB_TOKEN_INVALID',
    'GitHub connection expired or was revoked. Reconnect GitHub.'
  )
}

async function markGitHubAuthInvalid(db: D1Database, userId: number, now: number): Promise<void> {
  await db
    .prepare(
      `UPDATE users
      SET
        github_auth_invalid_at = ?,
        updated_at = ?
      WHERE id = ?`
    )
    .bind(now, now, userId)
    .run()
}

function hasFreshAccessToken(bundle: GitHubTokenBundle, now: number): bundle is GitHubTokenBundle & {
  accessToken: string;
  accessTokenExpiresAt: number;
} {
  const hasAccessToken = typeof bundle.accessToken === 'string' && bundle.accessToken.length > 0
  const hasAccessTokenExpiry = typeof bundle.accessTokenExpiresAt === 'number'
  const expiresAt = hasAccessTokenExpiry ? (bundle.accessTokenExpiresAt as number) : 0
  const isFresh = expiresAt > now + ACCESS_TOKEN_EXPIRY_SAFETY_MS

  return hasAccessToken && hasAccessTokenExpiry && isFresh
}

function hasRefreshToken(bundle: GitHubTokenBundle): bundle is GitHubTokenBundle & { refreshToken: string } {
  const hasRefresh = typeof bundle.refreshToken === 'string' && bundle.refreshToken.length > 0

  return hasRefresh
}

function isConnectedRow(row: GitHubTokenRow): boolean {
  const hasRefreshCipher = typeof row.github_refresh_token_ciphertext === 'string'
    && row.github_refresh_token_ciphertext.length > 0
  const hasRefreshIv = typeof row.github_refresh_token_iv === 'string'
    && row.github_refresh_token_iv.length > 0

  return hasRefreshCipher && hasRefreshIv
}

function getAbsoluteExpiryTimestamp(now: number, expiresInSeconds: number): number {
  const expiresAt = now + expiresInSeconds * 1000

  return expiresAt
}

async function buildGitHubTokenBundleFromRow(
  env: EnvBindings,
  row: GitHubTokenRow
): Promise<GitHubTokenBundle | null> {
  const isConnected = isConnectedRow(row)

  if (!isConnected) {
    return null
  }

  const accessToken = await decryptOptionalSecret(
    row.github_access_token_ciphertext,
    row.github_access_token_iv,
    env.SECRETS_ENCRYPTION_KEY_B64
  )
  const refreshToken = await decryptOptionalSecret(
    row.github_refresh_token_ciphertext,
    row.github_refresh_token_iv,
    env.SECRETS_ENCRYPTION_KEY_B64
  )
  const accessTokenExpiresAt = typeof row.github_access_token_expires_at === 'number'
    ? row.github_access_token_expires_at
    : null
  const refreshTokenExpiresAt = typeof row.github_refresh_token_expires_at === 'number'
    ? row.github_refresh_token_expires_at
    : null

  return {
    accessToken,
    accessTokenExpiresAt,
    authInvalidAt: typeof row.github_auth_invalid_at === 'number' ? row.github_auth_invalid_at : null,
    githubLogin: typeof row.github_login === 'string' ? row.github_login : null,
    githubUserId: typeof row.github_user_id === 'string' ? row.github_user_id : null,
    refreshToken,
    refreshTokenExpiresAt
  }
}

export function buildGitHubAuthorizeUrl(env: EnvBindings, state: string): string {
  const params = new URLSearchParams({
    client_id: env.GITHUB_APP_CLIENT_ID,
    redirect_uri: buildGitHubCallbackUrl(env),
    state
  })
  const authorizeUrl = `${GITHUB_AUTH_BASE_URL}/login/oauth/authorize?${params.toString()}`

  return authorizeUrl
}

export async function exchangeGitHubCodeForUserTokenBundle(
  env: EnvBindings,
  code: string
): Promise<ReturnType<typeof parseGitHubAppTokenPayload>> {
  const params = new URLSearchParams({
    client_id: env.GITHUB_APP_CLIENT_ID,
    client_secret: env.GITHUB_APP_CLIENT_SECRET,
    code,
    redirect_uri: buildGitHubCallbackUrl(env)
  })
  const tokenPayload = await requestGitHubToken(env, params)

  return tokenPayload
}

export async function refreshGitHubUserAccessToken(
  env: EnvBindings,
  refreshToken: string
): Promise<ReturnType<typeof parseGitHubAppTokenPayload>> {
  const params = new URLSearchParams({
    client_id: env.GITHUB_APP_CLIENT_ID,
    client_secret: env.GITHUB_APP_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  })
  const tokenPayload = await requestGitHubToken(env, params)

  return tokenPayload
}

export async function fetchGitHubUserProfile(accessToken: string): Promise<GitHubUserProfile> {
  const response = await fetch(`${GITHUB_API_BASE_URL}/user`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': GITHUB_USER_AGENT,
      'X-GitHub-Api-Version': GITHUB_API_VERSION
    }
  })
  const parsedResponse = await parseJsonOrText(response)
  const payload = parsedResponse.payload
  const rawText = parsedResponse.rawText

  if (!response.ok) {
    const message = getGitHubTokenEndpointErrorMessage(payload, rawText, response.status)

    throw new ApiError(502, 'GITHUB_AUTH_FAILED', `GitHub user fetch failed: ${message}`)
  }

  const profile = parseGitHubUserProfile(payload)

  return profile
}

export async function saveGitHubTokenBundle(
  env: EnvBindings,
  db: D1Database,
  userId: number,
  input: SaveGitHubTokenBundleInput
): Promise<void> {
  const encryptedAccessToken = await encryptSecret(input.accessToken, env.SECRETS_ENCRYPTION_KEY_B64)
  const encryptedRefreshToken = await encryptSecret(input.refreshToken, env.SECRETS_ENCRYPTION_KEY_B64)
  const now = Date.now()
  const updateClauses: string[] = [
    'github_access_token_ciphertext = ?',
    'github_access_token_iv = ?',
    'github_access_token_expires_at = ?',
    'github_refresh_token_ciphertext = ?',
    'github_refresh_token_iv = ?',
    'github_refresh_token_expires_at = ?',
    'github_auth_invalid_at = NULL',
    'github_token_updated_at = ?'
  ]
  const values: unknown[] = [
    encryptedAccessToken.ciphertext,
    encryptedAccessToken.iv,
    input.accessTokenExpiresAt,
    encryptedRefreshToken.ciphertext,
    encryptedRefreshToken.iv,
    input.refreshTokenExpiresAt,
    now
  ]
  const hasGitHubLogin = typeof input.githubLogin === 'string' && input.githubLogin.length > 0
  const hasGitHubUserId = typeof input.githubUserId === 'string' && input.githubUserId.length > 0

  if (hasGitHubLogin && input.githubLogin) {
    updateClauses.push('github_login = ?')
    values.push(input.githubLogin)
  }

  if (hasGitHubUserId && input.githubUserId) {
    updateClauses.push('github_user_id = ?')
    values.push(input.githubUserId)
  }

  if (input.setConnectedAt) {
    updateClauses.push('github_connected_at = ?')
    values.push(now)
  }

  updateClauses.push('updated_at = ?')
  values.push(now)
  values.push(userId)

  const updateSql = `UPDATE users SET ${updateClauses.join(', ')} WHERE id = ?`

  await db
    .prepare(updateSql)
    .bind(...values)
    .run()
}

export async function clearGitHubConnection(db: D1Database, userId: number): Promise<void> {
  const now = Date.now()

  await db
    .prepare(
      `UPDATE users
      SET
        github_user_id = NULL,
        github_login = NULL,
        github_access_token_ciphertext = NULL,
        github_access_token_iv = NULL,
        github_access_token_expires_at = NULL,
        github_refresh_token_ciphertext = NULL,
        github_refresh_token_iv = NULL,
        github_refresh_token_expires_at = NULL,
        github_connected_at = NULL,
        github_token_updated_at = NULL,
        github_auth_invalid_at = NULL,
        updated_at = ?
      WHERE id = ?`
    )
    .bind(now, userId)
    .run()
}

export async function loadGitHubTokenBundle(
  env: EnvBindings,
  db: D1Database,
  userId: number
): Promise<GitHubTokenBundle | null> {
  const row = await loadGitHubTokenRow(db, userId)

  if (!row) {
    return null
  }

  const bundle = await buildGitHubTokenBundleFromRow(env, row)

  return bundle
}

async function getValidGitHubAccessTokenForUserInternal(
  env: EnvBindings,
  db: D1Database,
  userId: number,
  allowRereadRetry: boolean
): Promise<string | null> {
  const now = Date.now()
  const bundle = await loadGitHubTokenBundle(env, db, userId)

  if (!bundle) {
    return null
  }

  const hasFreshToken = hasFreshAccessToken(bundle, now)

  if (hasFreshToken) {
    return bundle.accessToken
  }

  const authMarkedInvalid = isGitHubAuthMarkedInvalid(bundle)

  if (authMarkedInvalid) {
    throw createGitHubTokenInvalidError()
  }

  const canRefresh = hasRefreshToken(bundle)

  if (!canRefresh) {
    return null
  }

  try {
    const refreshed = await refreshGitHubUserAccessToken(env, bundle.refreshToken)
    const refreshedAccessTokenExpiresAt = getAbsoluteExpiryTimestamp(
      now,
      refreshed.accessTokenExpiresInSeconds
    )
    const refreshedRefreshTokenExpiresAt = getAbsoluteExpiryTimestamp(
      now,
      refreshed.refreshTokenExpiresInSeconds
    )

    await saveGitHubTokenBundle(env, db, userId, {
      accessToken: refreshed.accessToken,
      accessTokenExpiresAt: refreshedAccessTokenExpiresAt,
      refreshToken: refreshed.refreshToken,
      refreshTokenExpiresAt: refreshedRefreshTokenExpiresAt,
      setConnectedAt: false
    })

    return refreshed.accessToken
  } catch (error) {
    if (allowRereadRetry) {
      const rereadNow = Date.now()
      const rereadBundle = await loadGitHubTokenBundle(env, db, userId)
      const hasRetryToken = rereadBundle !== null && hasFreshAccessToken(rereadBundle, rereadNow)

      if (hasRetryToken && rereadBundle) {
        return rereadBundle.accessToken
      }
    }

    const isInvalidRefresh = isRefreshTokenEndpointInvalidError(error)

    if (isInvalidRefresh) {
      await markGitHubAuthInvalid(db, userId, now)
      throw createGitHubTokenInvalidError()
    }

    throw error
  }
}

export async function getValidGitHubAccessTokenForUser(
  env: EnvBindings,
  db: D1Database,
  userId: number
): Promise<string | null> {
  const accessToken = await getValidGitHubAccessTokenForUserInternal(env, db, userId, true)

  return accessToken
}
