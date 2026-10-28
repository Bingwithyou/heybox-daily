CREATE TABLE sms_sends (
  key TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sms_sends_expiry ON sms_sends(expires_at);

-- Receipts contain no credential or browser secret. They fence duplicate enrollment.
CREATE TABLE login_receipts (
  challenge TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  version TEXT NOT NULL,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX login_receipts_expiry ON login_receipts(expires_at);
