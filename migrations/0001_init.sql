CREATE TABLE transfers (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('uploading', 'ready', 'purged')),
  ready_at INTEGER,
  expires_at INTEGER,
  total_size INTEGER NOT NULL,
  file_count INTEGER NOT NULL,
  download_count INTEGER NOT NULL DEFAULT 0,
  last_notified_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX transfers_status_exp ON transfers (status, expires_at);

CREATE TABLE files (
  transfer_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT 'application/octet-stream',
  crc32 INTEGER,
  mpu_id TEXT,
  uploaded INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (transfer_id, idx)
);

-- A download event carries its own title, so a notice never needs the
-- transfer row (see spec/Transfer.tla, NoLostNotice).
CREATE TABLE downloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transfer_id TEXT NOT NULL,
  title TEXT NOT NULL,
  what TEXT NOT NULL,
  at INTEGER NOT NULL,
  ip TEXT, country TEXT, city TEXT, ua TEXT,
  notified INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX downloads_pending ON downloads (notified, transfer_id);
