-- Use the existing database. No image, note, access key or review is stored here.
CREATE TABLE IF NOT EXISTS rate_buckets (
  scope TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  hits INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_review_attempts (
  id TEXT PRIMARY KEY,
  day_key TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d','now')),
  month_key TEXT NOT NULL DEFAULT (strftime('%Y-%m','now')),
  state TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','completed','failed','legacy'))
);
CREATE INDEX IF NOT EXISTS ai_review_attempts_day ON ai_review_attempts(day_key);
CREATE INDEX IF NOT EXISTS ai_review_attempts_month ON ai_review_attempts(month_key);
-- Carry over the existing paid-attempt counters once, including failed attempts.
-- Run before enabling the new worker. The old paid endpoint must be disabled.
INSERT OR IGNORE INTO ai_review_attempts(id,day_key,month_key,state)
  SELECT 'legacy:' || id,day_key,month_key,'legacy' FROM ai_attempts;
CREATE TRIGGER IF NOT EXISTS ai_review_attempts_limit
BEFORE INSERT ON ai_review_attempts WHEN NEW.state != 'legacy'
BEGIN
  SELECT (CASE WHEN (SELECT COUNT(*) FROM ai_review_attempts WHERE month_key=NEW.month_key) >= 50
    THEN RAISE(ABORT,'MONTHLY_LIMIT') END);
  SELECT (CASE WHEN (SELECT COUNT(*) FROM ai_review_attempts WHERE day_key=NEW.day_key) >= 5
    THEN RAISE(ABORT,'DAILY_LIMIT') END);
END;
