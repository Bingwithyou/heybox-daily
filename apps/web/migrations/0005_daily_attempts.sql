CREATE TABLE job_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  retry_at INTEGER,
  status TEXT NOT NULL,
  result TEXT
);
CREATE INDEX job_attempts_job ON job_attempts(job_id, started_at);
CREATE INDEX job_attempts_state ON job_attempts(status, finished_at);
CREATE INDEX jobs_lease ON jobs(lease);
