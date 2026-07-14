const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const RECORDINGS_DIR = path.join(DATA_DIR, 'recordings');
fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS calls (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  token            TEXT UNIQUE NOT NULL,
  homeowner_name   TEXT NOT NULL,
  phone            TEXT NOT NULL,
  email            TEXT,
  property_address TEXT NOT NULL,
  agreement_ref    TEXT,
  terms            TEXT,
  created_by       TEXT NOT NULL DEFAULT 'homeowner',
  status           TEXT NOT NULL DEFAULT 'pending',
  vapi_call_id     TEXT,
  transcript       TEXT,
  summary          TEXT,
  analysis_json    TEXT,
  flags_json       TEXT,
  recording_file   TEXT,
  recording_url    TEXT,
  duration_seconds REAL,
  ended_reason     TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  started_at       TEXT,
  completed_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_calls_vapi_call_id ON calls (vapi_call_id);
CREATE INDEX IF NOT EXISTS idx_calls_status ON calls (status);
`);

// Additive migrations for databases created before these columns existed.
const existingCols = db.prepare('PRAGMA table_info(calls)').all().map((c) => c.name);
for (const col of ['monthly_payment', 'escalator', 'term_length', 'offset_percent']) {
  if (!existingCols.includes(col)) db.exec(`ALTER TABLE calls ADD COLUMN ${col} TEXT`);
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

function getOrCreateSecret(key) {
  let value = getSetting(key);
  if (!value) {
    value = crypto.randomBytes(32).toString('hex');
    setSetting(key, value);
  }
  return value;
}

function createCall(data) {
  const token = crypto.randomBytes(16).toString('hex');
  const info = db
    .prepare(
      `INSERT INTO calls (token, homeowner_name, phone, email, property_address, agreement_ref, terms, created_by,
                          monthly_payment, escalator, term_length, offset_percent)
       VALUES (@token, @homeowner_name, @phone, @email, @property_address, @agreement_ref, @terms, @created_by,
               @monthly_payment, @escalator, @term_length, @offset_percent)`
    )
    .run({ token, monthly_payment: null, escalator: null, term_length: null, offset_percent: null, ...data });
  return db.prepare('SELECT * FROM calls WHERE id = ?').get(info.lastInsertRowid);
}

module.exports = {
  db,
  DATA_DIR,
  RECORDINGS_DIR,
  getSetting,
  setSetting,
  getOrCreateSecret,
  createCall,
  getCallByToken: (token) => db.prepare('SELECT * FROM calls WHERE token = ?').get(token),
  getCallById: (id) => db.prepare('SELECT * FROM calls WHERE id = ?').get(id),
  getCallByVapiId: (vapiCallId) =>
    db.prepare('SELECT * FROM calls WHERE vapi_call_id = ?').get(vapiCallId),
  listCalls: () => db.prepare('SELECT * FROM calls ORDER BY created_at DESC').all(),
};
