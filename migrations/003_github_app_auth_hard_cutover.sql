PRAGMA defer_foreign_keys = ON;
BEGIN TRANSACTION;

CREATE TABLE users_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  twitch_user_id TEXT NOT NULL UNIQUE,
  twitch_login TEXT NOT NULL,
  twitch_display_name TEXT NOT NULL,
  github_user_id TEXT,
  github_login TEXT,
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

INSERT INTO users_new (
  id,
  twitch_user_id,
  twitch_login,
  twitch_display_name,
  monthly_quota,
  obs_title,
  obs_uuid,
  created_at,
  updated_at
)
SELECT
  id,
  twitch_user_id,
  twitch_login,
  twitch_display_name,
  monthly_quota,
  obs_title,
  obs_uuid,
  created_at,
  updated_at
FROM users;

CREATE TABLE sessions_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO sessions_new (
  id,
  user_id,
  token_hash,
  expires_at,
  created_at
)
SELECT
  id,
  user_id,
  token_hash,
  expires_at,
  created_at
FROM sessions;

CREATE TABLE usage_cache_new (
  user_id INTEGER PRIMARY KEY,
  payload_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  payload_version INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO usage_cache_new (
  user_id,
  payload_json,
  updated_at,
  payload_version
)
SELECT
  user_id,
  payload_json,
  updated_at,
  payload_version
FROM usage_cache;

DROP TABLE sessions;
DROP TABLE usage_cache;
DROP TABLE users;

ALTER TABLE users_new RENAME TO users;
ALTER TABLE sessions_new RENAME TO sessions;
ALTER TABLE usage_cache_new RENAME TO usage_cache;

CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX idx_users_obs_uuid ON users(obs_uuid);

COMMIT;
