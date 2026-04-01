ALTER TABLE users ADD COLUMN available_today_algorithm_id TEXT NOT NULL DEFAULT 'daily_pace';

UPDATE users
SET available_today_algorithm_id = 'daily_pace'
WHERE available_today_algorithm_id IS NULL OR available_today_algorithm_id = '';
