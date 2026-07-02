const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Railway: mount a persistent volume at /data if you want the DB to survive
// redeploys. If there's no volume, we use a local file (it will be lost on each deploy).
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

-- job_id = NULL means "general parameter" (applies to all jobs)
CREATE TABLE IF NOT EXISTS parameters (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  weight REAL NOT NULL CHECK (weight >= 0 AND weight <= 10),
  added_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- killer_questions are the true/false criteria the Agent Interview phase asks
-- verbally. weight lets the interview score be a weighted average (default 1 =
-- equal weighting); recruiters keep entering questions with no extra fields.
CREATE TABLE IF NOT EXISTS killer_questions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1 CHECK (weight >= 0),
  added_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Prescreen (Phase 1) results land here.
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

-- Agent Interview (Phase 2) per-application state: the zero-engagement call
-- attempt counter and (as a fallback for Ashby's native stage-entry time) the
-- moment the application was first seen in the interview phase.
CREATE TABLE IF NOT EXISTS interview_state (
  application_id TEXT PRIMARY KEY,
  job_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  stage_entered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Raw result of each interview call, plus the deterministically-computed score.
CREATE TABLE IF NOT EXISTS interview_results (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  job_id TEXT,
  call_connected INTEGER,
  answers TEXT,               -- JSON: [{ question_id, answer: true|false|null }]
  callback_requested INTEGER,
  call_notes TEXT,
  score REAL,
  passed INTEGER,
  coverage_asked INTEGER,     -- questions actually asked/answered
  coverage_total INTEGER,     -- total killer questions for the job
  synced_to_ashby INTEGER DEFAULT 0,
  sync_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_interview_results_application
  ON interview_results (application_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_score_log_application
  ON score_log (ashby_application_id, created_at DESC);
`);

// ---------- Lightweight migrations for existing databases ----------
// Add columns introduced after the initial schema without wiping data.
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

// Older DBs have killer_questions without a weight column.
ensureColumn('killer_questions', 'weight', 'weight REAL NOT NULL DEFAULT 1');

module.exports = db;
