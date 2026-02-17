import { D1Database } from '../types/cloudflare'
import { loadCachedData, saveDataCache } from './cache'
import { decryptPat } from './crypto'
import { buildDataFromGitHub } from './github'
import { DataPayload } from './schemas'

export type DataResolutionSource =
  | 'cache_hit'
  | 'github_live'
  | 'github_live_failed'
  | 'cache_stale_fallback'

export interface LoadDataResult {
  payload: DataPayload;
  source: DataResolutionSource;
}

export interface LoadDataInput {
  db: D1Database;
  now?: Date;
  monthlyQuota: number;
  title: string;
  patCiphertext: string | null;
  patEncryptionKeyB64: string;
  patIv: string | null;
  userId: number;
}

function hasValidPatCredentials(
  input: LoadDataInput
): input is LoadDataInput & { patCiphertext: string; patIv: string } {
  const hasCiphertext = typeof input.patCiphertext === 'string' && input.patCiphertext.length > 0
  const hasIv = typeof input.patIv === 'string' && input.patIv.length > 0

  return hasCiphertext && hasIv
}

function resolveCacheUpdatedAtFromPayload(payloadUpdatedAt: string, fallbackTimestamp: number): number {
  const parsedUpdatedAt = Date.parse(payloadUpdatedAt)
  const hasValidUpdatedAt = Number.isFinite(parsedUpdatedAt)

  if (hasValidUpdatedAt) {
    return parsedUpdatedAt
  }

  return fallbackTimestamp
}

export async function loadData(input: LoadDataInput): Promise<LoadDataResult | null> {
  const cached = await loadCachedData(input.db, input.userId)
  const hasFreshCache = Boolean(cached?.isFresh)

  if (hasFreshCache && cached) {
    return {
      payload: cached.payload,
      source: 'cache_hit'
    }
  }

  const hasValidCredentials = hasValidPatCredentials(input)

  if (!hasValidCredentials) {
    if (cached) {
      return {
        payload: cached.payload,
        source: 'cache_stale_fallback'
      }
    }

    return null
  }

  const referenceDate = input.now ?? new Date()

  try {
    const pat = await decryptPat(input.patCiphertext, input.patIv, input.patEncryptionKeyB64)
    const livePayload = await buildDataFromGitHub(
      pat,
      input.monthlyQuota,
      referenceDate,
      input.title
    )
    const fallbackTimestamp = referenceDate.getTime()
    const cacheUpdatedAt = resolveCacheUpdatedAtFromPayload(livePayload.updatedAt, fallbackTimestamp)

    await saveDataCache(input.db, input.userId, livePayload, cacheUpdatedAt)

    return {
      payload: livePayload,
      source: 'github_live'
    }
  } catch (error) {
    if (cached) {
      return {
        payload: cached.payload,
        source: 'cache_stale_fallback'
      }
    }

    throw error
  }
}
