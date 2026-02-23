PRAGMA defer_foreign_keys = ON;

DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS usage_cache;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_user_id TEXT NOT NULL UNIQUE,
  github_login TEXT NOT NULL,
  github_access_token_ciphertext TEXT,
  github_access_token_iv TEXT,
  github_access_token_expires_at INTEGER,
  github_refresh_token_ciphertext TEXT,
  github_refresh_token_iv TEXT,
  github_refresh_token_expires_at INTEGER,
  github_connected_at INTEGER,
  github_token_updated_at INTEGER,
  github_auth_invalid_at INTEGER,
  monthly_quota INTEGER,
  obs_title TEXT,
  obs_uuid TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE usage_cache (
  user_id INTEGER PRIMARY KEY,
  payload_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  payload_version INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX idx_users_obs_uuid ON users(obs_uuid);
