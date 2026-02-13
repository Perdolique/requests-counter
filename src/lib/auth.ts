import { ApiError } from './errors'
import { EnvBindings, AuthUser } from './env'
import { parseTwitchTokenPayload, parseTwitchUserPayload } from './schemas'
import { sha256Hex } from './crypto'

const OAUTH_STATE_COOKIE_NAME = 'rc_oauth_state'
const OAUTH_STATE_MAX_AGE_SECONDS = 600
const SESSION_COOKIE_NAME = 'rc_session'
const SESSION_MAX_AGE_SECONDS = 86_400

interface TwitchUserRecord {
  displayName: string;
  id: string;
  login: string;
}

interface UserRow {
  id: number;
  obs_uuid: string;
  twitch_display_name: string;
  twitch_login: string;
  twitch_user_id: string;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''

  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  const base64 = btoa(binary)

  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function createOpaqueToken(byteLength: number = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength))
  const token = bytesToBase64Url(bytes)

  return token
}

function parseCookieHeader(cookieHeader: string | null): Record<string, string> {
  const output: Record<string, string> = {}

  if (!cookieHeader) {
    return output
  }

  const cookieParts = cookieHeader.split(';')

  for (const cookiePart of cookieParts) {
    const [namePart, ...valueParts] = cookiePart.trim().split('=')

    if (typeof namePart !== 'string' || namePart.length === 0) {
      continue
    }

    const value = valueParts.join('=')

    output[namePart] = value
  }

  return output
}

function buildCookie(name: string, value: string, maxAgeSeconds: number): string {
  const parts = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`
  ]

  const cookie = parts.join('; ')

  return cookie
}

function buildTwitchRedirectUri(env: EnvBindings): string {
  const callbackUrl = new URL('/api/auth/twitch/callback', env.APP_BASE_URL)

  return callbackUrl.toString()
}

async function hashSessionToken(token: string, sessionSecret: string): Promise<string> {
  const value = `${sessionSecret}:${token}`
  const hash = await sha256Hex(value)

  return hash
}

function mapUserRowToAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    obsUuid: row.obs_uuid,
    twitchDisplayName: row.twitch_display_name,
    twitchLogin: row.twitch_login,
    twitchUserId: row.twitch_user_id
  }
}

export function createOauthState(): string {
  const state = createOpaqueToken(24)

  return state
}

export function createOauthStateCookie(state: string): string {
  const cookie = buildCookie(OAUTH_STATE_COOKIE_NAME, state, OAUTH_STATE_MAX_AGE_SECONDS)

  return cookie
}

export function clearOauthStateCookie(): string {
  const cookie = buildCookie(OAUTH_STATE_COOKIE_NAME, '', 0)

  return cookie
}

export function createSessionCookie(token: string): string {
  const cookie = buildCookie(SESSION_COOKIE_NAME, token, SESSION_MAX_AGE_SECONDS)

  return cookie
}

export function clearSessionCookie(): string {
  const cookie = buildCookie(SESSION_COOKIE_NAME, '', 0)

  return cookie
}

export function getOauthStateFromRequest(request: Request): string | null {
  const cookies = parseCookieHeader(request.headers.get('Cookie'))
  const value = cookies[OAUTH_STATE_COOKIE_NAME] ?? null

  return value
}

export function getSessionTokenFromRequest(request: Request): string | null {
  const cookies = parseCookieHeader(request.headers.get('Cookie'))
  const value = cookies[SESSION_COOKIE_NAME] ?? null

  return value
}

export function buildTwitchAuthorizeUrl(env: EnvBindings, state: string): string {
  const params = new URLSearchParams({
    client_id: env.TWITCH_CLIENT_ID,
    redirect_uri: buildTwitchRedirectUri(env),
    response_type: 'code',
    state
  })
  const url = `https://id.twitch.tv/oauth2/authorize?${params.toString()}`

  return url
}

async function exchangeCodeForAccessToken(env: EnvBindings, code: string): Promise<string> {
  const bodyParams = new URLSearchParams({
    client_id: env.TWITCH_CLIENT_ID,
    client_secret: env.TWITCH_CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: buildTwitchRedirectUri(env)
  })
  const response = await fetch('https://id.twitch.tv/oauth2/token', {
    body: bodyParams.toString(),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    method: 'POST'
  })

  let payload: unknown = null

  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  const isOk = response.ok

  if (!isOk) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Twitch token exchange failed')
  }

  const tokenPayload = parseTwitchTokenPayload(payload)

  return tokenPayload.accessToken
}

async function fetchTwitchUser(env: EnvBindings, accessToken: string): Promise<TwitchUserRecord> {
  const response = await fetch('https://api.twitch.tv/helix/users', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Client-Id': env.TWITCH_CLIENT_ID
    }
  })

  let payload: unknown = null

  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  const isOk = response.ok

  if (!isOk) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Unable to fetch Twitch profile')
  }

  const userPayload = parseTwitchUserPayload(payload)

  return {
    displayName: userPayload.displayName,
    id: userPayload.id,
    login: userPayload.login
  }
}

async function upsertUser(env: EnvBindings, user: TwitchUserRecord): Promise<AuthUser> {
  const now = Date.now()
  const obsUuid = crypto.randomUUID()

  await env.DB
    .prepare(
      `INSERT INTO users (
        twitch_user_id,
        twitch_login,
        twitch_display_name,
        obs_uuid,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(twitch_user_id) DO UPDATE SET
        twitch_login = excluded.twitch_login,
        twitch_display_name = excluded.twitch_display_name,
        updated_at = excluded.updated_at`
    )
    .bind(user.id, user.login, user.displayName, obsUuid, now, now)
    .run()

  const row = await env.DB
    .prepare(
      `SELECT
        id,
        obs_uuid,
        twitch_display_name,
        twitch_login,
        twitch_user_id
      FROM users
      WHERE twitch_user_id = ?`
    )
    .bind(user.id)
    .first<UserRow>()

  if (!row) {
    throw new ApiError(503, 'VALIDATION_ERROR', 'Failed to persist user session')
  }

  const authUser = mapUserRowToAuthUser(row)

  return authUser
}

export async function upsertUserFromTwitchCode(env: EnvBindings, code: string): Promise<AuthUser> {
  const accessToken = await exchangeCodeForAccessToken(env, code)
  const twitchUser = await fetchTwitchUser(env, accessToken)
  const authUser = await upsertUser(env, twitchUser)

  return authUser
}

export async function createSession(env: EnvBindings, userId: number): Promise<string> {
  const now = Date.now()
  const expiresAt = now + SESSION_MAX_AGE_SECONDS * 1000

  await env.DB
    .prepare('DELETE FROM sessions WHERE expires_at <= ?')
    .bind(now)
    .run()

  const token = createOpaqueToken(32)
  const tokenHash = await hashSessionToken(token, env.SESSION_SECRET)

  await env.DB
    .prepare(
      `INSERT INTO sessions (
        user_id,
        token_hash,
        expires_at,
        created_at
      ) VALUES (?, ?, ?, ?)`
    )
    .bind(userId, tokenHash, expiresAt, now)
    .run()

  return token
}

export async function destroySession(env: EnvBindings, request: Request): Promise<void> {
  const token = getSessionTokenFromRequest(request)

  if (!token) {
    return
  }

  const tokenHash = await hashSessionToken(token, env.SESSION_SECRET)

  await env.DB
    .prepare('DELETE FROM sessions WHERE token_hash = ?')
    .bind(tokenHash)
    .run()
}

export async function getSessionUser(env: EnvBindings, request: Request): Promise<AuthUser | null> {
  const token = getSessionTokenFromRequest(request)

  if (!token) {
    return null
  }

  const tokenHash = await hashSessionToken(token, env.SESSION_SECRET)
  const now = Date.now()
  const row = await env.DB
    .prepare(
      `SELECT
        users.id,
        users.obs_uuid,
        users.twitch_display_name,
        users.twitch_login,
        users.twitch_user_id
      FROM sessions
      INNER JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?`
    )
    .bind(tokenHash, now)
    .first<UserRow>()

  if (!row) {
    return null
  }

  const authUser = mapUserRowToAuthUser(row)

  return authUser
}
