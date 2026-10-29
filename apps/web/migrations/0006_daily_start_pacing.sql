ALTER TABLE jobs ADD COLUMN dispatch_at INTEGER NOT NULL DEFAULT 0;
CREATE TABLE daily_scheduler (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  next_start_at INTEGER NOT NULL DEFAULT 0,
  next_dispatch_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO daily_scheduler(id) VALUES(1);
