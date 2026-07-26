CREATE TABLE IF NOT EXISTS leads(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  need TEXT,
  budget TEXT,
  posted_at TEXT,
  client TEXT,
  contact_type TEXT,
  contact TEXT,
  tags TEXT,
  score INTEGER DEFAULT 0,
  query TEXT,
  status TEXT DEFAULT 'nouveau',
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(score DESC);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_source ON leads(source);

CREATE TABLE IF NOT EXISTS scans(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL,
  sources TEXT,
  limit_count INTEGER,
  result_count INTEGER,
  saved_count INTEGER,
  new_count INTEGER,
  errors TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);
CREATE TABLE IF NOT EXISTS alerts(id INTEGER PRIMARY KEY AUTOINCREMENT,lead_id INTEGER,channel TEXT NOT NULL,status TEXT NOT NULL,message TEXT,created_at TEXT NOT NULL);

INSERT OR IGNORE INTO settings(key,value) VALUES
('hot_score','70'),
('telegram_enabled','0'),
('telegram_bot_token',''),
('telegram_chat_id',''),
('webhook_enabled','0'),
('webhook_url',''),
('email_enabled','0'),
('resend_api_key',''),
('email_from',''),
('email_to',''),
('google_api_key',''),
('google_cx',''),
('x_bearer_token',''),
('telegram_source_bot_token',''),
('telegram_source_chats',''),
('feeds_text','# Ajoutez une URL RSS/Atom par ligne.\n# Utilisez uniquement des flux/API autorisés.\n');
