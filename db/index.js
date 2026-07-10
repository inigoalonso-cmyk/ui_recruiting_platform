const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Railway: mount a persistent volume at /data if you want the DB to survive
// redeploys. If there's no volume, we use a local file (it will be lost on each deploy).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'platform.db');

// Durability guard: this app stores ALL data (jobs, Job Info facts, screening
// parameters, killer questions, recruiters) in this one SQLite file. On Railway
// the container filesystem is EPHEMERAL — if DATA_DIR is not pointed at a mounted
// persistent volume, the file (and every recruiter edit) is wiped on each
// redeploy. Silently falling back to a local ./data dir is exactly how that data
// loss goes unnoticed, so make the situation loud in the logs at boot.
const onRailway = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID);
if (!process.env.DATA_DIR) {
  const warning =
    `[db] DATA_DIR is not set — using "${DATA_DIR}". This path is on the ` +
    `local/container filesystem. On Railway that is EPHEMERAL: all Job Info, ` +
    `screening and recruiter data will be WIPED on the next redeploy. Set ` +
    `DATA_DIR to a mounted volume path (e.g. /data) so data survives deploys.`;
  if (onRailway) console.warn(`\n${'!'.repeat(72)}\n${warning}\n${'!'.repeat(72)}\n`);
  else console.warn(`[db] ${warning}`);
} else {
  console.log(`[db] SQLite at ${DB_PATH} (DATA_DIR=${process.env.DATA_DIR}). Ensure a persistent volume is mounted at this path on Railway so data survives redeploys.`);
}

const db = new Database(DB_PATH);
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

-- Company FAQ (a.k.a. Global FAQ): company-wide, ROLE-INDEPENDENT facts the
-- JobBot voice agent can answer for ANY candidate regardless of the role they
-- applied to — office locations, funding, values/culture, interview process,
-- etc. Deliberately a SEPARATE table from job_info_facts: those are per-role
-- (and the job_id-NULL "General" ones get merged into every role's response),
-- whereas these stand alone and are served verbatim by GET /api/jobbot/global-faq.
-- Same free-form label/value + sort_order shape as job_info_facts so the
-- dashboard editor and the JobBot response mirror the Job Info tab exactly.
CREATE TABLE IF NOT EXISTS company_faq (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  value TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_company_faq_sort ON company_faq (sort_order, created_at);

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

-- ---------- UNANSWERED QUESTIONS (Suggested additions) ----------
-- Questions candidates asked the JobBot voice/chat agent that it could NOT
-- answer from the current Job Info facts. JobBot POSTs each one here (via a
-- dedicated write-only key, see requireUnansweredKey in routes/api.js). The
-- recruiter-facing "Suggested additions" view groups OPEN rows by exact-match
-- question text (case-insensitive, trimmed) and ranks them by frequency, so
-- recruiters see the most-asked gaps first and can turn them into Job Info
-- facts. role_label is the free-text role the agent reported (nullable — the
-- agent may not know it); it is NOT a foreign key to jobs, so these rows
-- survive job-folder deletes and don't need a cascade.
CREATE TABLE IF NOT EXISTS unanswered_questions (
  id TEXT PRIMARY KEY,
  role_label TEXT,
  question_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Aggregation groups OPEN rows by normalized text; this index keeps the
-- status filter + recency ordering cheap.
CREATE INDEX IF NOT EXISTS idx_unanswered_status
  ON unanswered_questions (status, created_at DESC);
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

// Seed the Company FAQ with starter content the FIRST time only (when the table
// is completely empty), so GET /api/jobbot/global-faq never returns an empty
// array before a recruiter has filled it in. Once any row exists — seeded or
// edited — this never runs again, so it can't clobber dashboard edits. The
// values below are starter placeholders; refine them from the Company FAQ tab.
const companyFaqCount = db.prepare('SELECT COUNT(*) AS n FROM company_faq').get().n;
if (companyFaqCount === 0) {
  const { randomUUID } = require('crypto');
  const seedFact = db.prepare('INSERT INTO company_faq (id, label, value, sort_order) VALUES (?, ?, ?, ?)');
  const COMPANY_FAQ_SEED = [
    ['Offices', 'San Francisco (HQ), Delaware, and Madrid, Spain.'],
    ['Funding', '~$62M raised total. Series B: $44M in September 2025, led by Base10 Partners (~$500M valuation), with a16z, Y Combinator, Tokio Marine, WaVe-X, and World Innovation Lab participating. Series A: $15.6M in December 2024, led by a16z.'],
    ['Founded', 'Founded in 2023 by Pablo Palafox, Luis Paarup, and Javi Palafox.'],
    ['Values / culture', 'Responsibility (full ownership of what you build, including bugs and uptime), Excellence, Warmth & Approachability, merit-based hiring (ability over seniority), and first-principles thinking.'],
    ['Interview process', 'Placeholder — fill in the standard interview process from the Company FAQ tab.'],
  ];
  const seedCompanyFaq = db.transaction((rows) => {
    rows.forEach(([label, value], i) => seedFact.run(randomUUID(), label, value, i));
  });
  seedCompanyFaq(COMPANY_FAQ_SEED);
  console.log(`[db] Seeded Company FAQ with ${COMPANY_FAQ_SEED.length} starter facts (table was empty).`);
}

module.exports = db;
