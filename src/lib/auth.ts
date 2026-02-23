import { ApiError } from './errors'
import { sha256Hex } from './crypto'
import { EnvBindings, AuthUser } from './env'

const OAUTH_STATE_MAX_AGE_SECONDS = 600
const SESSION_COOKIE_NAME = 'rc_session'
const SESSION_MAX_AGE_SECONDS = 86_400

type OauthProvider = 'github'

interface GitHubUserIdentity {
  githubLogin: string;
  githubUserId: string;
}

interface UserRow {
  github_login: string;
  github_user_id: string;
  id: number;
  obs_uuid: string;
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

async function hashSessionToken(token: string, sessionSecret: string): Promise<string> {
  const value = `${sessionSecret}:${token}`
  const hash = await sha256Hex(value)

  return hash
}

function mapUserRowToAuthUser(row: UserRow): AuthUser {
  return {
    githubLogin: row.github_login,
    githubUserId: row.github_user_id,
    id: row.id,
    obsUuid: row.obs_uuid
  }
}

function getOauthStateCookieName(provider: OauthProvider): string {
  const isGitHubProvider = provider === 'github'

  if (!isGitHubProvider) {
    throw new ApiError(500, 'VALIDATION_ERROR', 'Unsupported OAuth provider')
  }

  return 'rc_oauth_state_github'
}

export function createOauthState(): string {
  const state = createOpaqueToken(24)

  return state
}

export function createOauthStateCookie(provider: OauthProvider, state: string): string {
  const cookieName = getOauthStateCookieName(provider)
  const cookie = buildCookie(cookieName, state, OAUTH_STATE_MAX_AGE_SECONDS)

  return cookie
}

export function clearOauthStateCookie(provider: OauthProvider): string {
  const cookieName = getOauthStateCookieName(provider)
  const cookie = buildCookie(cookieName, '', 0)

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

export function getOauthStateFromRequest(
  request: Request,
  provider: OauthProvider
): string | null {
  const cookies = parseCookieHeader(request.headers.get('Cookie'))
  const cookieName = getOauthStateCookieName(provider)
  const value = cookies[cookieName] ?? null

  return value
}

export function getSessionTokenFromRequest(request: Request): string | null {
  const cookies = parseCookieHeader(request.headers.get('Cookie'))
  const value = cookies[SESSION_COOKIE_NAME] ?? null

  return value
}

export async function upsertUserFromGitHubIdentity(
  env: EnvBindings,
  identity: GitHubUserIdentity
): Promise<AuthUser> {
  const now = Date.now()
  const obsUuid = crypto.randomUUID()

  await env.DB
    .prepare(
      `INSERT INTO users (
        github_user_id,
        github_login,
        obs_uuid,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(github_user_id) DO UPDATE SET
        github_login = excluded.github_login,
        updated_at = excluded.updated_at`
    )
    .bind(identity.githubUserId, identity.githubLogin, obsUuid, now, now)
    .run()

  const row = await env.DB
    .prepare(
      `SELECT
        github_login,
        github_user_id,
        id,
        obs_uuid
      FROM users
      WHERE github_user_id = ?`
    )
    .bind(identity.githubUserId)
    .first<UserRow>()

  if (!row) {
    throw new ApiError(503, 'VALIDATION_ERROR', 'Failed to persist user session')
  }

  const authUser = mapUserRowToAuthUser(row)

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
        users.github_login,
        users.github_user_id,
        users.id,
        users.obs_uuid
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
