-- Postgres schema for the recruiting platform (migrated from SQLite/better-sqlite3).
-- Type mapping chosen to keep the API/JSON contracts IDENTICAL to the SQLite app:
--   * IDs stay TEXT (app-generated UUIDs), not serial.
--   * 0/1 flag columns stay INTEGER (NOT boolean) so JSON keeps returning 0/1.
--   * created_at/updated_at stay TEXT in 'YYYY-MM-DD HH24:MI:SS' UTC format
--     (matching SQLite's datetime('now')) so the frontend's date parsing is unchanged.
-- Idempotent: safe to run on every boot (CREATE ... IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ashby_job_id TEXT,
  mode TEXT NOT NULL DEFAULT 'normal',
  created_at TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS')
);

-- Hierarchy (Model B): a folder may be a child ("variant") of a parent "role"
-- folder. parent_id NULL = top-level. Deleting a parent removes its variants,
-- consistent with "deleting a folder removes everything in it". Additive column
-- (ADD ... IF NOT EXISTS) so existing rows just get parent_id = NULL.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS parent_id TEXT REFERENCES jobs(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_jobs_parent ON jobs (parent_id);

-- job_id = NULL means "general parameter" (applies to all jobs)
CREATE TABLE IF NOT EXISTS parameters (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  weight DOUBLE PRECISION NOT NULL CHECK (weight >= 0 AND weight <= 10),
  added_by TEXT,
  created_at TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS')
);
-- The "fixed" parameter is a single large block of evaluable job-description text
-- pulled from Ashby by the sync workflow (Role Overview / responsibilities /
-- requirements / operating principles — the About/Why-join/GDPR sections are
-- dropped upstream). It is kept visually distinct from the recruiter-authored
-- weighted criteria; `body` holds the extracted text. Applied idempotently on
-- every boot (this file is the project's migration mechanism).
ALTER TABLE parameters ADD COLUMN IF NOT EXISTS is_fixed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE parameters ADD COLUMN IF NOT EXISTS body TEXT;
-- At most one fixed parameter per job folder (NULLs are distinct, so the virtual
-- General bucket is unaffected — it never gets a fixed parameter anyway).
CREATE UNIQUE INDEX IF NOT EXISTS parameters_one_fixed_per_job ON parameters (job_id) WHERE is_fixed;

CREATE TABLE IF NOT EXISTS killer_questions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  weight DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK (weight >= 0),
  expected_answer INTEGER NOT NULL DEFAULT 1 CHECK (expected_answer IN (0, 1)),
  added_by TEXT,
  created_at TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS job_info_facts (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  value TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_job_info_facts_job ON job_info_facts (job_id, sort_order);

CREATE TABLE IF NOT EXISTS company_faq (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  value TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_company_faq_sort ON company_faq (sort_order, created_at);

CREATE TABLE IF NOT EXISTS score_log (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  ashby_candidate_id TEXT,
  ashby_application_id TEXT,
  score DOUBLE PRECISION,
  status TEXT,
  breakdown TEXT,
  synced_to_ashby INTEGER DEFAULT 0,
  sync_error TEXT,
  created_at TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS interview_state (
  application_id TEXT PRIMARY KEY,
  job_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  stage_entered_at TEXT,
  created_at TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS interview_results (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  job_id TEXT,
  call_connected INTEGER,
  answers TEXT,
  callback_requested INTEGER,
  call_notes TEXT,
  score DOUBLE PRECISION,
  passed INTEGER,
  coverage_asked INTEGER,
  coverage_total INTEGER,
  synced_to_ashby INTEGER DEFAULT 0,
  sync_error TEXT,
  created_at TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_interview_results_application
  ON interview_results (application_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_score_log_application
  ON score_log (ashby_application_id, created_at DESC);

CREATE TABLE IF NOT EXISTS recruiter_jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS recruiters (
  id TEXT PRIMARY KEY,
  recruiter_job_id TEXT NOT NULL REFERENCES recruiter_jobs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  calendar_link TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_recruiters_job
  ON recruiters (recruiter_job_id, created_at);

CREATE TABLE IF NOT EXISTS unanswered_questions (
  id TEXT PRIMARY KEY,
  role_label TEXT,
  question_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  created_at TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_unanswered_status
  ON unanswered_questions (status, created_at DESC);

CREATE TABLE IF NOT EXISTS dev_test_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  candidate_name TEXT,
  cv_filename TEXT,
  cv_text TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'error')),
  score DOUBLE PRECISION,
  rationale TEXT,
  passed INTEGER,
  parameter_breakdown TEXT,
  parameter_reasoning TEXT,
  config_snapshot TEXT,
  error TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_dev_test_runs_job ON dev_test_runs (job_id, created_at DESC);

-- Unique per Ashby job id, but only for rows that HAVE one (hand-made folders are NULL).
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_ashby_job_id
  ON jobs (ashby_job_id) WHERE ashby_job_id IS NOT NULL;

-- Model B linking: a folder ↔ many Ashby jobs. Each Ashby job id belongs to
-- exactly ONE folder (UNIQUE), so a candidate's application.jobId resolves to a
-- single folder. Additive for now (the legacy jobs.ashby_job_id stays until
-- folders are re-linked via the picker), so nothing existing breaks.
CREATE TABLE IF NOT EXISTS job_ashby_links (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  ashby_job_id TEXT NOT NULL UNIQUE,
  ashby_job_title TEXT,
  created_at TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_job_ashby_links_job ON job_ashby_links (job_id);
