CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  twitch_user_id TEXT NOT NULL UNIQUE,
  twitch_login TEXT NOT NULL,
  twitch_display_name TEXT NOT NULL,
  pat_ciphertext TEXT,
  pat_iv TEXT,
  monthly_quota INTEGER,
  obs_uuid TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS usage_cache (
  user_id INTEGER PRIMARY KEY,
  payload_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  payload_version INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_users_obs_uuid ON users(obs_uuid);
