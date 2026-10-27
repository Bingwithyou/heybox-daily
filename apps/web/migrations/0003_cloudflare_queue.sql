ALTER TABLE jobs ADD COLUMN queue_token TEXT;
ALTER TABLE jobs ADD COLUMN queue_published INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN dispatch_until INTEGER NOT NULL DEFAULT 0;
CREATE INDEX jobs_dispatch ON jobs(status,date,queue_published,available_at,created_at,dispatch_until);
CREATE INDEX jobs_queue_token ON jobs(queue_token);
