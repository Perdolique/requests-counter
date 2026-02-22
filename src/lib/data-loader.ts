import { D1Database } from '../types/cloudflare'
import { loadCachedData, saveDataCache } from './cache'
import { EnvBindings } from './env'
import { getValidGitHubAccessTokenForUser } from './github-auth'
import { buildDataFromGitHub } from './github'
import { DataPayload } from './schemas'

export type DataResolutionSource =
  | 'cache_hit'
  | 'github_live'
  | 'cache_stale_fallback'

export interface LoadDataResult {
  payload: DataPayload;
  source: DataResolutionSource;
}

export interface LoadDataInput {
  db: D1Database;
  env: EnvBindings;
  monthlyQuota: number;
  now?: Date;
  title: string;
  userId: number;
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

  const referenceDate = input.now ?? new Date()

  try {
    const githubAccessToken = await getValidGitHubAccessTokenForUser(input.env, input.db, input.userId)
    const hasGitHubAccessToken = typeof githubAccessToken === 'string' && githubAccessToken.length > 0

    if (!hasGitHubAccessToken) {
      if (cached) {
        return {
          payload: cached.payload,
          source: 'cache_stale_fallback'
        }
      }

      return null
    }

    const livePayload = await buildDataFromGitHub(
      githubAccessToken,
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
