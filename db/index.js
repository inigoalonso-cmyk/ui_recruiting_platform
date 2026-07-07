const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Railway: mount a persistent volume at /data if you want the DB to survive
// redeploys. If there's no volume, we use a local file (it will be lost on each deploy).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'platform.db'));
db.pragma('journal_mode = WAL');
// Enforce declared foreign keys (SQLite defaults this OFF). Without it, the
// ON DELETE CASCADE on parameters/killer_questions/recruiters never fires, so
// deleting a job or recruiter folder would orphan its child rows.
db.pragma('foreign_keys = ON');

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
-- expected_answer is the answer that COUNTS AS A PASS for this question: some
-- questions are phrased so the desired answer is "false" (e.g. "Any restriction
-- that would stop you starting in 2 weeks?"). Defaults to 1 (true) so existing
-- rows keep the historical "true = pass" behavior.
CREATE TABLE IF NOT EXISTS killer_questions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1 CHECK (weight >= 0),
  expected_answer INTEGER NOT NULL DEFAULT 1 CHECK (expected_answer IN (0, 1)),
  added_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Runtime-editable app settings (single value per key), edited from the
-- Settings page rather than env vars so recruiters can change them live.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Job Info facts: free-form label/value pairs about a role (salary, location,
-- remote policy, start date…) that the candidate-facing "JobBot" voice agent
-- looks up. Shares the same jobs table as Screening. job_id NULL = general
-- facts that apply to every job (mirrors the parameters table).
CREATE TABLE IF NOT EXISTS job_info_facts (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  value TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_job_info_facts_job ON job_info_facts (job_id, sort_order);

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

-- ---------- RECRUITERS ----------
-- The Recruiters section mirrors the Screening Criteria folder pattern: one
-- folder per job title (recruiter_jobs), each holding a list of recruiter
-- contacts. An external automation reads the primary recruiter per job title
-- via GET /api/recruiters?job=... (matched case-insensitively on name).
CREATE TABLE IF NOT EXISTS recruiter_jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS recruiters (
  id TEXT PRIMARY KEY,
  recruiter_job_id TEXT NOT NULL REFERENCES recruiter_jobs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  calendar_link TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_recruiters_job
  ON recruiters (recruiter_job_id, created_at);
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
// Older DBs predate the per-question expected answer (Part 1). Default 1 (true)
// preserves the historical "true = pass" behavior for existing questions.
ensureColumn('killer_questions', 'expected_answer', 'expected_answer INTEGER NOT NULL DEFAULT 1');

// Seed settings defaults once (INSERT OR IGNORE keeps user-edited values).
// call_recording_enabled seeds from the legacy env var so behavior is unchanged
// on first boot; after that it's controlled from the Settings page.
const seedSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
seedSetting.run('pass_threshold', '8');
seedSetting.run('max_call_attempts', '3');
seedSetting.run('call_recording_enabled', process.env.INTERVIEW_RECORDING_ENABLED === 'true' ? '1' : '0');

module.exports = db;
