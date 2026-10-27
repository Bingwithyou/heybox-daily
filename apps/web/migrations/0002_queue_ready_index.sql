-- Filter today's queue and read its first eligible job without sorting all queued rows.
-- The date prefix also bounds cross-day recovery to jobs outside today.
-- Replace the old queue index so each state transition still updates just one queue index.
DROP INDEX jobs_ready;
CREATE INDEX jobs_ready ON jobs(status, date, available_at, created_at);
