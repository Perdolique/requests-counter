ALTER TABLE users ADD COLUMN subscription_plan TEXT NOT NULL DEFAULT 'pro';
ALTER TABLE users ADD COLUMN budget_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN include_budget INTEGER NOT NULL DEFAULT 1;

UPDATE users
SET
  subscription_plan = CASE
    WHEN monthly_quota IS NOT NULL AND monthly_quota >= 1500 THEN 'pro_plus'
    ELSE 'pro'
  END,
  budget_cents = CASE
    WHEN monthly_quota IS NULL OR monthly_quota <= 300 THEN 0
    WHEN monthly_quota < 1500 THEN (monthly_quota - 300) * 4
    WHEN monthly_quota = 1500 THEN 0
    ELSE (monthly_quota - 1500) * 4
  END,
  include_budget = 1;
