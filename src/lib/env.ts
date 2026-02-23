import { AssetFetcher, D1Database } from '../types/cloudflare'

export interface EnvBindings {
  APP_BASE_URL: string;
  ASSETS: AssetFetcher;
  DB: D1Database;
  GITHUB_APP_CLIENT_ID: string;
  GITHUB_APP_CLIENT_SECRET: string;
  SECRETS_ENCRYPTION_KEY_B64: string;
  SESSION_SECRET: string;
}

export interface AuthUser {
  id: number;
  obsUuid: string;
  githubLogin: string;
  githubUserId: string;
}
