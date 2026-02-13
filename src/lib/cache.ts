import { D1Database } from '../types/cloudflare'
import { ObsDataPayload, parseObsDataPayload } from './schemas'

const CACHE_TTL_MS = 5 * 60 * 1000
const OBS_PAYLOAD_VERSION = 1

interface UsageCacheRow {
  payload_json: string;
  payload_version: number;
  updated_at: number;
}

export interface CachedObsData {
  isFresh: boolean;
  payload: ObsDataPayload;
  updatedAt: number;
}

export async function deleteObsCache(db: D1Database, userId: number): Promise<void> {
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

export async function loadCachedObsData(db: D1Database, userId: number): Promise<CachedObsData | null> {
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

  const hasExpectedVersion = row.payload_version === OBS_PAYLOAD_VERSION

  if (!hasExpectedVersion) {
    return null
  }

  const updatedAtIsValid = Number.isFinite(row.updated_at) && row.updated_at > 0

  if (!updatedAtIsValid) {
    return null
  }

  let parsedPayload: unknown = null

  try {
    parsedPayload = JSON.parse(row.payload_json)
  } catch {
    return null
  }

  let payload: ObsDataPayload

  try {
    payload = parseObsDataPayload(parsedPayload)
  } catch {
    return null
  }

  const ageMs = Date.now() - row.updated_at
  const isFresh = ageMs <= CACHE_TTL_MS

  return {
    isFresh,
    payload,
    updatedAt: row.updated_at
  }
}

export async function saveObsDataCache(
  db: D1Database,
  userId: number,
  payload: ObsDataPayload,
  updatedAt: number
): Promise<void> {
  const payloadJson = JSON.stringify(payload)

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
    .bind(userId, payloadJson, updatedAt, OBS_PAYLOAD_VERSION)
    .run()
}
