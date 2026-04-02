ALTER TABLE users ADD COLUMN available_today_token_bucket_bank_days INTEGER NOT NULL DEFAULT 3;

UPDATE users
SET available_today_token_bucket_bank_days = 3
WHERE available_today_token_bucket_bank_days IS NULL
  OR available_today_token_bucket_bank_days NOT IN (3, 5, 7);
