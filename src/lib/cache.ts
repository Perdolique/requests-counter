import { D1Database } from '../types/cloudflare'
import { QuotaBreakdown } from './quota'
import {
  DataPayload,
  parseCachedDashboardState
} from './schemas'

const CACHE_TTL_MS = 5 * 60 * 1000
const PAYLOAD_VERSION = 7

interface UsageCacheRow {
  payload_json: string;
  payload_version: number;
  updated_at: number;
}

export interface CachedData {
  isFresh: boolean;
  payload: DataPayload;
  quotaBreakdown: QuotaBreakdown;
  updatedAt: number;
}

export async function deleteCache(db: D1Database, userId: number): Promise<void> {
  await db
    .prepare('DELETE FROM usage_cache WHERE user_id = ?')
    .bind(userId)
    .run()
}

export async function getCacheUpdatedAt(db: D1Database, userId: number): Promise<number | null> {
  const row = await db
    .prepare('SELECT updated_at FROM usage_cache WHERE user_id = ?')
    .bind(userId)
    .first<{ updated_at: number }>()

  if (!row) {
    return null
  }

  return row.updated_at
}

export async function loadCachedData(db: D1Database, userId: number): Promise<CachedData | null> {
  const row = await db
    .prepare(
      `SELECT
        payload_json,
        payload_version,
        updated_at
      FROM usage_cache
      WHERE user_id = ?`
    )
    .bind(userId)
    .first<UsageCacheRow>()

  if (!row) {
    return null
  }

  const hasExpectedVersion = row.payload_version === PAYLOAD_VERSION

  if (!hasExpectedVersion) {
    console.warn(JSON.stringify({ event: 'cache_invalid_version', userId, version: row.payload_version }))
    await deleteCache(db, userId)
    return null
  }

  const updatedAtIsValid = Number.isFinite(row.updated_at) && row.updated_at > 0

  if (!updatedAtIsValid) {
    console.warn(JSON.stringify({ event: 'cache_invalid_timestamp', userId }))
    await deleteCache(db, userId)
    return null
  }

  let parsedPayload: unknown = null

  try {
    parsedPayload = JSON.parse(row.payload_json)
  } catch {
    console.warn(JSON.stringify({ event: 'cache_json_parse_failed', userId }))
    await deleteCache(db, userId)
    return null
  }

  let cachedState: {
    payload: DataPayload;
    quotaBreakdown: QuotaBreakdown;
  }

  try {
    cachedState = parseCachedDashboardState(parsedPayload)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.warn(JSON.stringify({ event: 'cache_schema_validation_failed', userId, error: errorMessage }))
    await deleteCache(db, userId)
    return null
  }

  const ageMs = Date.now() - row.updated_at
  const isFresh = ageMs <= CACHE_TTL_MS

  return {
    isFresh,
    payload: cachedState.payload,
    quotaBreakdown: cachedState.quotaBreakdown,
    updatedAt: row.updated_at
  }
}

export async function saveDataCache(
  db: D1Database,
  userId: number,
  payload: DataPayload,
  quotaBreakdown: QuotaBreakdown,
  updatedAt: number
): Promise<void> {
  const payloadJson = JSON.stringify({
    payload,
    quotaBreakdown
  })

  await db
    .prepare(
      `INSERT INTO usage_cache (
        user_id,
        payload_json,
        updated_at,
        payload_version
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at,
        payload_version = excluded.payload_version`
    )
    .bind(userId, payloadJson, updatedAt, PAYLOAD_VERSION)
    .run()
}
