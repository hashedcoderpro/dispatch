const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS lead_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id INTEGER NOT NULL,
  phone TEXT NOT NULL,
  name TEXT,
  custom1 TEXT,
  custom2 TEXT,
  opted_out INTEGER DEFAULT 0,
  FOREIGN KEY(list_id) REFERENCES lead_lists(id)
);

CREATE TABLE IF NOT EXISTS message_rosters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS message_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  roster_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  FOREIGN KEY(roster_id) REFERENCES message_rosters(id)
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  list_id INTEGER NOT NULL,
  roster_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  rotation_mode TEXT DEFAULT 'sequential',
  status TEXT DEFAULT 'draft',
  rate_per_sms REAL DEFAULT 0,
  throttle_ms INTEGER DEFAULT 300,
  created_at TEXT DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL,
  lead_id INTEGER NOT NULL,
  template_id INTEGER,
  phone TEXT NOT NULL,
  message_text TEXT NOT NULL,
  data_coding INTEGER,
  vendor_message_id TEXT,
  send_error_code INTEGER,
  send_status TEXT DEFAULT 'pending',
  message_count INTEGER DEFAULT 1,
  message_parts INTEGER DEFAULT 1,
  cost REAL DEFAULT 0,
  dlr_status TEXT,
  dlr_status_id TEXT,
  dlr_received_at TEXT,
  sent_at TEXT
);

CREATE TABLE IF NOT EXISTS balance_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  amount REAL NOT NULL,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaign_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL,
  list_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  label TEXT,
  sort_order INTEGER DEFAULT 0,
  FOREIGN KEY(campaign_id) REFERENCES campaigns(id),
  FOREIGN KEY(list_id) REFERENCES lead_lists(id)
);
`);

try { db.exec('ALTER TABLE sends ADD COLUMN source TEXT'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE sends ADD COLUMN segment_label TEXT'); } catch (e) { /* already exists */ }

db.exec(`
CREATE TABLE IF NOT EXISTS sender_id_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requested_by TEXT NOT NULL,
  source TEXT NOT NULL,
  otus_sender_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  description TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT
);
`);

// seed default settings if missing
const defaults = {
  vacotel_base_url: 'https://otusprivategw.com',
  vacotel_username: '',
  vacotel_password: '',
  vacotel_api_id: '',
  otus_portal_cookies: '',
  test_mode: '1',
  default_rate_per_sms: '0.05'
};
const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setStmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(defaults)) {
  if (!getStmt.get(k)) setStmt.run(k, v);
}

module.exports = db;
