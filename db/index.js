const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Railway: monta un volumen persistente en /data si quieres que la DB sobreviva
// a los redeploys. Si no hay volumen, usamos un archivo local (se perderá en cada deploy).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'platform.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ashby_job_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- job_id = NULL significa "parámetro general" (aplica a todos los puestos)
CREATE TABLE IF NOT EXISTS parameters (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  weight REAL NOT NULL CHECK (weight >= 0 AND weight <= 10),
  added_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS killer_questions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  added_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS score_log (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  ashby_candidate_id TEXT,
  ashby_application_id TEXT,
  score REAL,
  status TEXT,
  breakdown TEXT,
  synced_to_ashby INTEGER DEFAULT 0,
  sync_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

module.exports = db;
