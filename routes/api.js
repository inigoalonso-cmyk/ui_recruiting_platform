const express = require('express');
const { v4: uuid } = require('uuid');
const fetch = require('node-fetch');
const multer = require('multer');
const db = require('../db');
const ashby = require('./ashby');
const { scoreAnswers } = require('./scoring');
const { canonicalizeRole } = require('./roles');

const router = express.Router();

// In-memory upload handler for dev-sandbox test CVs (PDF/DOCX/TXT). Kept small:
// these are single test resumes, never bulk data.
const uploadCv = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// ---------- Runtime settings (editable from the Settings page) ----------
const SETTING_DEFAULTS = { pass_threshold: '8', max_call_attempts: '3', call_recording_enabled: '0' };

// Folder lifecycle modes (see db/index.js for the full contract). The 5-min
// Prescreening cron only scores folders in 'production'; 'development' is the
// manual sandbox; 'normal' is the editing/parked state that nobody scores.
const JOB_MODES = ['normal', 'development', 'production'];

async function getSetting(key) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : SETTING_DEFAULTS[key];
}
async function setSetting(key, value) {
  await db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, String(value));
}
async function getPassThreshold() {
  const n = Number(await getSetting('pass_threshold'));
  return Number.isFinite(n) ? n : 8;
}
async function getMaxCallAttempts() {
  const n = parseInt(await getSetting('max_call_attempts'), 10);
  return Number.isInteger(n) && n > 0 ? n : 3;
}
async function getRecordingEnabled() {
  return (await getSetting('call_recording_enabled')) === '1';
}

// ---------- Middleware: protect endpoints called by external workflows (Happy Robot) ----------
// Each external surface has its OWN api-key env var, deliberately kept separate
// to limit the blast radius of a leak:
//   INTERNAL_API_KEY             — scoring + interview writes (most powerful)
//   JOBBOT_API_KEY               — read-only Job Info for the candidate JobBot
//   UNANSWERED_QUESTIONS_API_KEY — write-only: enqueue "suggested additions" rows
//   ASHBY_SYNC_API_KEY           — create/update job folders + facts (Ashby sync)
// If the matching env var is unset we don't block (dev mode).
const keyGuard = (envName) => (req, res, next) => {
  const configured = process.env[envName];
  if (!configured) return next(); // if not configured, we don't block (dev mode)
  if (req.header('x-api-key') !== configured) {
    return res.status(401).json({ error: 'invalid or missing x-api-key' });
  }
  next();
};
const requireInternalKey = keyGuard('INTERNAL_API_KEY');
const requireJobbotKey = keyGuard('JOBBOT_API_KEY');
const requireUnansweredKey = keyGuard('UNANSWERED_QUESTIONS_API_KEY');
const requireSyncKey = keyGuard('ASHBY_SYNC_API_KEY');

// ---------- JOBS (folders) ----------
// Optional ?mode= filter (normal | development | production) so the prescreening
// cron can fetch only the roles it should score in one call, e.g.
// GET /api/jobs?mode=production. Without the param, returns every folder.
router.get('/jobs', async (req, res) => {
  const { mode } = req.query;
  if (mode !== undefined) {
    if (!JOB_MODES.includes(mode)) {
      return res.status(400).json({ error: `mode must be one of: ${JOB_MODES.join(', ')}` });
    }
    const jobs = await db.prepare('SELECT * FROM jobs WHERE mode = ? ORDER BY created_at DESC').all(mode);
    return res.json(jobs);
  }
  const jobs = await db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all();
  res.json(jobs);
});

// Roles the prescreening cron should score right now, returned as a referenceable
// OBJECT (a bare JSON array body is not cleanly addressable from the workflow's
// HTTP node — only its first element's fields get exposed). The workflow reads
// job_ids to keep only candidates whose role is in production before the loop.
// GET /api/jobs/production -> { job_ids: [...], count: N }
router.get('/jobs/production', async (req, res) => {
  const rows = await db.prepare("SELECT id FROM jobs WHERE mode = 'production' ORDER BY created_at DESC").all();
  const jobIds = rows.map((r) => r.id);
  res.json({ job_ids: jobIds, count: jobIds.length });
});

// ---------- ASHBY (read-only proxy for the folder→Ashby-job linking picker) ----------
// Lists Ashby jobs (default: Open) so the dashboard can offer a dropdown instead of
// free-text ids. READ-ONLY — never writes to Ashby. Uses ASHBY_API_KEY (Railway var);
// Ashby auth is HTTP Basic with the key as username and an empty password.
//
// The Ashby round-trip is ~1.3s and the picker re-fetches on every folder open, so we
// cache the result per status for a short TTL. Repeated opens are then instant. Pass
// ?fresh=1 to bypass the cache (e.g. right after creating a job in Ashby).
const ashbyJobsCache = new Map(); // status -> { at: epoch_ms, jobs: [...] }
const ASHBY_JOBS_TTL_MS = 3 * 60 * 1000;
router.get('/ashby/jobs', async (req, res) => {
  const apiKey = process.env.ASHBY_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'ASHBY_API_KEY is not configured on the server' });
  // ?status=Open (default) | Closed | Archived. job.list is paginated via a cursor.
  const status = req.query.status ? [String(req.query.status)] : ['Open'];
  const cacheKey = status.join(',');
  if (!req.query.fresh) {
    const hit = ashbyJobsCache.get(cacheKey);
    if (hit && Date.now() - hit.at < ASHBY_JOBS_TTL_MS) {
      return res.json({ jobs: hit.jobs, count: hit.jobs.length, cached: true });
    }
  }
  const auth = 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64');
  const jobs = [];
  let cursor = null;
  let guard = 0;
  try {
    do {
      const body = cursor ? { status, cursor } : { status };
      // Retry a couple of times: the connection can prematurely close mid-body.
      let data;
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await fetch('https://api.ashbyhq.com/job.list', {
            method: 'POST',
            headers: { Authorization: auth, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          data = await r.json();
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      if (lastErr) throw lastErr;
      if (!data || !data.success) {
        throw new Error((data && data.errors && data.errors[0]) || 'Ashby job.list failed');
      }
      for (const j of data.results || []) jobs.push({ id: j.id, title: j.title, status: j.status });
      cursor = data.moreDataAvailable ? data.nextCursor : null;
    } while (cursor && ++guard < 20);
  } catch (err) {
    return res.status(502).json({ error: `could not reach Ashby: ${err.message}` });
  }
  jobs.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  ashbyJobsCache.set(cacheKey, { at: Date.now(), jobs });
  res.json({ jobs, count: jobs.length });
});

router.post('/jobs', async (req, res) => {
  const { name, ashby_job_id, parent_id } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  // An Ashby job id links this folder to exactly one Ashby job and can only be
  // used once. Check for a clash up front so we return a clear 409 instead of a
  // raw unique-constraint 500.
  const ashbyId = ashby_job_id && String(ashby_job_id).trim() ? String(ashby_job_id).trim() : null;
  if (ashbyId) {
    const clash = await db.prepare('SELECT name FROM jobs WHERE ashby_job_id = ?').get(ashbyId);
    if (clash) return res.status(409).json({ error: `That Ashby job ID is already linked to the folder "${clash.name}". An Ashby ID can only be used once.` });
  }
  // Optional parent for a "variant" subfolder — one level of nesting only
  // (a role folder with variants; a variant can't itself have variants).
  let parentId = null;
  if (parent_id) {
    const parent = await db.prepare('SELECT id, parent_id FROM jobs WHERE id = ?').get(parent_id);
    if (!parent) return res.status(404).json({ error: 'parent folder not found' });
    if (parent.parent_id) return res.status(400).json({ error: 'only one level of nesting: cannot create a subfolder under a subfolder' });
    parentId = parent.id;
  }
  const id = uuid();
  // New manual folders start in 'normal' so the recruiter can set up criteria and
  // test them in the sandbox before promoting to 'production'.
  await db.prepare("INSERT INTO jobs (id, name, ashby_job_id, mode, parent_id) VALUES (?, ?, ?, 'normal', ?)").run(id, name.trim(), ashbyId, parentId);
  // The parent just became a "role folder" (it has a variant). Role folders are
  // criteria templates that stay in Edit — only their variants go live — so drop
  // the parent back to 'normal' if a recruiter had left it in development/production.
  if (parentId) {
    await db.prepare("UPDATE jobs SET mode = 'normal' WHERE id = ? AND mode != 'normal'").run(parentId);
  }
  res.status(201).json(await db.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
});

// Switch a folder's lifecycle mode (normal | development | production). This is
// the single control behind the folder-header state selector; the 5-min cron
// reads it (via /evaluation-config) to decide whether to score the folder.
router.put('/jobs/:id/mode', async (req, res) => {
  const { mode } = req.body;
  if (!JOB_MODES.includes(mode)) {
    return res.status(400).json({ error: `mode must be one of: ${JOB_MODES.join(', ')}` });
  }
  const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  // A role folder with variants is a criteria template — it stays in Edit; only
  // its (leaf) variants go to Development/Production.
  const hasChildren = await db.prepare('SELECT 1 FROM jobs WHERE parent_id = ? LIMIT 1').get(req.params.id);
  if (hasChildren && mode !== 'normal') {
    return res.status(409).json({ error: 'This is a role folder with variants — keep it in Edit and set its variants to Development/Production instead.' });
  }
  // A folder can only go live once it's linked to a real Ashby job (a Model B
  // job_ashby_links row) — otherwise the cron has no Ashby job id to match
  // candidates against. The legacy jobs.ashby_job_id field does NOT count: many
  // folders carry placeholder slugs there from the old seed, which would let a
  // truly unlinked folder slip into Production.
  if (mode === 'production') {
    const linked = await db.prepare('SELECT 1 FROM job_ashby_links WHERE job_id = ? LIMIT 1').get(req.params.id);
    if (!linked) {
      return res.status(409).json({ error: 'Link an Ashby job to this folder before setting it to Production.' });
    }
  }
  await db.prepare('UPDATE jobs SET mode = ? WHERE id = ?').run(mode, req.params.id);
  res.json(await db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id));
});

router.put('/jobs/:id', async (req, res) => {
  const { name, ashby_job_id } = req.body;
  const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });

  // ashby_job_id semantics: undefined = leave unchanged; '' (or null) = unlink;
  // a non-empty value = link it, which must be unique across folders.
  let nextAshby = job.ashby_job_id;
  if (ashby_job_id !== undefined) {
    const trimmed = ashby_job_id === null ? '' : String(ashby_job_id).trim();
    if (trimmed === '') {
      nextAshby = null;
    } else {
      const clash = await db.prepare('SELECT name FROM jobs WHERE ashby_job_id = ? AND id != ?').get(trimmed, req.params.id);
      if (clash) return res.status(409).json({ error: `That Ashby job ID is already linked to the folder "${clash.name}". An Ashby ID can only be used once.` });
      nextAshby = trimmed;
    }
  }
  await db.prepare('UPDATE jobs SET name = COALESCE(?, name), ashby_job_id = ? WHERE id = ?')
    .run(name || null, nextAshby, req.params.id);
  res.json(await db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id));
});

// Re-parent a folder (drag-and-drop in the sidebar): make it a variant of another
// folder (parent_id = target) or move it back to the top level (parent_id = null).
// One level of nesting only.
router.put('/jobs/:id/parent', async (req, res) => {
  const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'folder not found' });
  const raw = req.body ? req.body.parent_id : undefined;
  const target = (raw === null || raw === undefined || raw === '') ? null : String(raw);

  if (target === null) {
    await db.prepare('UPDATE jobs SET parent_id = NULL WHERE id = ?').run(job.id);
    return res.json(await db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id));
  }
  if (target === job.id) return res.status(400).json({ error: 'a folder cannot be its own parent' });
  const parent = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(target);
  if (!parent) return res.status(404).json({ error: 'target folder not found' });
  if (parent.parent_id) return res.status(400).json({ error: 'only one level of nesting — the target is already a variant' });
  // The folder being moved can't itself have variants (that would be two levels deep).
  const hasChildren = await db.prepare('SELECT 1 FROM jobs WHERE parent_id = ? LIMIT 1').get(job.id);
  if (hasChildren) return res.status(400).json({ error: 'this folder has its own variants — move those out first' });
  await db.prepare('UPDATE jobs SET parent_id = ? WHERE id = ?').run(parent.id, job.id);
  // The target now holds a variant, so it becomes a "role folder" — a criteria
  // template that stays in Edit. Auto-demote it from development/production rather
  // than blocking the recruiter (mirrors the create-variant flow).
  if (parent.mode !== 'normal') {
    await db.prepare("UPDATE jobs SET mode = 'normal' WHERE id = ?").run(parent.id);
  }
  res.json(await db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id));
});

router.delete('/jobs/:id', async (req, res) => {
  // ON DELETE CASCADE removes everything hanging off this folder: its parameters,
  // killer_questions, job_info_facts, dev_test_runs and job_ashby_links — AND, via
  // jobs.parent_id, every VARIANT subfolder under it (and their children in turn).
  // So deleting a role folder deletes all its variants. History tables (score_log,
  // interview_*) keep their rows (job_id is plain TEXT, no FK) on purpose.
  await db.prepare('DELETE FROM jobs WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// ---------- PARAMETERS (general if :jobId === 'general', or per job) ----------
router.get('/jobs/:jobId/parameters', async (req, res) => {
  const jobId = req.params.jobId === 'general' ? null : req.params.jobId;
  const rows = jobId === null
    ? await db.prepare('SELECT * FROM parameters WHERE job_id IS NULL ORDER BY created_at').all()
    : await db.prepare('SELECT * FROM parameters WHERE job_id = ? ORDER BY created_at').all(jobId);
  res.json(rows);
});

// Combined folder-open read: parameters + killer questions in ONE request (both
// queries fire concurrently server-side). Halves the round-trips when opening a
// folder vs fetching /parameters and /killer-questions separately.
router.get('/jobs/:jobId/screening', async (req, res) => {
  const jobId = req.params.jobId === 'general' ? null : req.params.jobId;
  const [parameters, killer_questions] = await Promise.all([
    jobId === null
      ? db.prepare('SELECT * FROM parameters WHERE job_id IS NULL ORDER BY created_at').all()
      : db.prepare('SELECT * FROM parameters WHERE job_id = ? ORDER BY created_at').all(jobId),
    jobId === null
      ? Promise.resolve([])
      : db.prepare('SELECT * FROM killer_questions WHERE job_id = ? ORDER BY created_at').all(jobId),
  ]);
  res.json({ parameters, killer_questions });
});

router.post('/jobs/:jobId/parameters', async (req, res) => {
  const jobId = req.params.jobId === 'general' ? null : req.params.jobId;
  const { name, weight, added_by } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  // 'general' (jobId null) is valid; any other jobId must be a real job.
  if (jobId !== null && !(await db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(jobId))) {
    return res.status(404).json({ error: 'job not found' });
  }
  const w = Number(weight);
  // Match the DB CHECK (0..10) here so an out-of-range weight is a clean 400
  // instead of surfacing as a 500 from the constraint violation.
  if (Number.isNaN(w) || w < 0 || w > 10) return res.status(400).json({ error: 'weight must be a number between 0 and 10' });
  const id = uuid();
  await db.prepare('INSERT INTO parameters (id, job_id, name, weight, added_by) VALUES (?, ?, ?, ?, ?)')
    .run(id, jobId, name.trim(), w, added_by || null);
  res.status(201).json(await db.prepare('SELECT * FROM parameters WHERE id = ?').get(id));
});

router.put('/parameters/:id', async (req, res) => {
  const { name, weight, body } = req.body;
  const existing = await db.prepare('SELECT * FROM parameters WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'parameter not found' });
  const w = weight !== undefined ? Number(weight) : existing.weight;
  // Normal criteria are 0-10 (importance); the fixed parameter (job description) is
  // 0-100 (an absolute percentage of the score).
  const maxW = existing.is_fixed ? 100 : 10;
  if (Number.isNaN(w) || w < 0 || w > maxW) {
    return res.status(400).json({ error: `weight must be a number between 0 and ${maxW}` });
  }
  // `body` (the fixed parameter's extracted text) is optional; only touched when
  // the caller sends it, so a normal weight/name edit never clears it.
  const newBody = body !== undefined ? (body === null ? null : String(body)) : existing.body;
  await db.prepare('UPDATE parameters SET name = COALESCE(?, name), weight = ?, body = ? WHERE id = ?')
    .run(name || null, w, newBody, req.params.id);
  res.json(await db.prepare('SELECT * FROM parameters WHERE id = ?').get(req.params.id));
});

router.delete('/parameters/:id', async (req, res) => {
  await db.prepare('DELETE FROM parameters WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// ---------- KILLER QUESTIONS (per job) ----------
router.get('/jobs/:jobId/killer-questions', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM killer_questions WHERE job_id = ? ORDER BY created_at').all(req.params.jobId);
  res.json(rows);
});

// Coerce a variety of truthy/falsy JSON shapes into 1/0 (defaulting to true).
function toExpected(v) {
  if (v === undefined || v === null || v === '') return 1;
  if (v === true || v === 1 || v === '1' || v === 'true') return 1;
  if (v === false || v === 0 || v === '0' || v === 'false') return 0;
  return 1;
}

router.post('/jobs/:jobId/killer-questions', async (req, res) => {
  const { question, added_by, weight, expected_answer } = req.body;
  if (!question || !question.trim()) return res.status(400).json({ error: 'question is required' });
  // Killer questions are per real job (no 'general'). Reject unknown jobs with
  // a clean 404 rather than letting the FK constraint surface as a 500.
  if (!(await db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(req.params.jobId))) {
    return res.status(404).json({ error: 'job not found' });
  }
  // weight is optional (defaults to 1); the interview phase uses it for a
  // weighted score, but recruiters don't have to set it.
  const w = weight === undefined || weight === null || weight === '' ? 1 : Number(weight);
  if (Number.isNaN(w) || w < 0) return res.status(400).json({ error: 'weight must be a non-negative number' });
  const expected = toExpected(expected_answer); // defaults to 1 (true)
  const id = uuid();
  await db.prepare('INSERT INTO killer_questions (id, job_id, question, weight, expected_answer, added_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, req.params.jobId, question.trim(), w, expected, added_by || null);
  res.status(201).json(await db.prepare('SELECT * FROM killer_questions WHERE id = ?').get(id));
});

router.put('/killer-questions/:id', async (req, res) => {
  const existing = await db.prepare('SELECT * FROM killer_questions WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'killer question not found' });
  const { question, added_by, weight, expected_answer } = req.body;
  if (question !== undefined && !question.trim()) return res.status(400).json({ error: 'question cannot be empty' });
  const w = weight === undefined || weight === null || weight === '' ? existing.weight : Number(weight);
  if (Number.isNaN(w) || w < 0) return res.status(400).json({ error: 'weight must be a non-negative number' });
  const expected = expected_answer === undefined ? existing.expected_answer : toExpected(expected_answer);
  await db.prepare(`
    UPDATE killer_questions SET
      question = COALESCE(?, question),
      weight = ?,
      expected_answer = ?,
      added_by = ?
    WHERE id = ?
  `).run(
    question !== undefined ? question.trim() : null,
    w,
    expected,
    added_by !== undefined ? (added_by || null) : existing.added_by,
    req.params.id,
  );
  res.json(await db.prepare('SELECT * FROM killer_questions WHERE id = ?').get(req.params.id));
});

router.delete('/killer-questions/:id', async (req, res) => {
  await db.prepare('DELETE FROM killer_questions WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// ---------- JOB INFO FACTS (per job; job_id NULL = general) ----------
// Recruiter-facing label/value facts for the candidate-facing JobBot agent.
router.get('/jobs/:jobId/job-info', async (req, res) => {
  const jobId = req.params.jobId === 'general' ? null : req.params.jobId;
  const rows = jobId === null
    ? await db.prepare('SELECT * FROM job_info_facts WHERE job_id IS NULL ORDER BY sort_order, created_at').all()
    : await db.prepare('SELECT * FROM job_info_facts WHERE job_id = ? ORDER BY sort_order, created_at').all(jobId);
  res.json(rows);
});

router.post('/jobs/:jobId/job-info', async (req, res) => {
  const jobId = req.params.jobId === 'general' ? null : req.params.jobId;
  const { label, value } = req.body;
  if (!label || !label.trim()) return res.status(400).json({ error: 'label is required' });
  if (value === undefined || value === null || !String(value).trim()) return res.status(400).json({ error: 'value is required' });
  if (jobId !== null && !(await db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(jobId))) {
    return res.status(404).json({ error: 'job not found' });
  }
  // Append to the end of this job's list.
  const nextRow = jobId === null
    ? await db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM job_info_facts WHERE job_id IS NULL').get()
    : await db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM job_info_facts WHERE job_id = ?').get(jobId);
  const id = uuid();
  await db.prepare('INSERT INTO job_info_facts (id, job_id, label, value, sort_order) VALUES (?, ?, ?, ?, ?)')
    .run(id, jobId, label.trim(), String(value).trim(), nextRow.n);
  res.status(201).json(await db.prepare('SELECT * FROM job_info_facts WHERE id = ?').get(id));
});

router.put('/job-info/:id', async (req, res) => {
  const existing = await db.prepare('SELECT * FROM job_info_facts WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'fact not found' });
  const { label, value } = req.body;
  if (label !== undefined && !label.trim()) return res.status(400).json({ error: 'label cannot be empty' });
  if (value !== undefined && !String(value).trim()) return res.status(400).json({ error: 'value cannot be empty' });
  await db.prepare(`
    UPDATE job_info_facts
       SET label = COALESCE(?, label), value = COALESCE(?, value), updated_at = datetime('now')
     WHERE id = ?
  `).run(
    label !== undefined ? label.trim() : null,
    value !== undefined ? String(value).trim() : null,
    req.params.id,
  );
  res.json(await db.prepare('SELECT * FROM job_info_facts WHERE id = ?').get(req.params.id));
});

router.delete('/job-info/:id', async (req, res) => {
  await db.prepare('DELETE FROM job_info_facts WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// ---------- ASHBY SYNC (enrich-only, called by the HappyRobot workflow) ----------
// One-shot endpoint that enriches an ALREADY-LINKED dashboard folder with facts
// pulled from a single Ashby job, so the workflow doesn't have to orchestrate the
// read/merge itself.
//
// ENRICH-ONLY (decided 2026-07-22): this endpoint NEVER creates, adopts, renames,
// or moves folders. It resolves the target folder purely through the Model B link
// (job_ashby_links.ashby_job_id → job_id). If the incoming Ashby job isn't linked
// to any folder, it's skipped — so recruiters stay in control of folder structure
// and we avoid folder explosion. Given the Ashby job id + facts, it:
//   1. Resolves the folder via its job_ashby_links row; skips if there is none.
//   2. Fills in ONLY the facts we don't already have BY LABEL (case-insensitive).
//      It NEVER overwrites or deletes — so facts a recruiter edited by hand (and
//      any Ashby fact that later disappears) are preserved.
//   3. Touches ONLY Job Info; Screening (parameters / killer questions) is left
//      untouched.
// Everything runs in a single transaction so a partial failure leaves no
// half-synced folder behind.
router.post('/sync/ashby-job', requireSyncKey, async (req, res) => {
  const { ashby_job_id, title, facts } = req.body || {};
  const ashbyId = ashby_job_id == null ? '' : String(ashby_job_id).trim();
  if (!ashbyId) return res.status(400).json({ error: 'ashby_job_id is required' });
  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: 'title is required' });
  }
  if (facts !== undefined && !Array.isArray(facts)) {
    return res.status(400).json({ error: 'facts must be an array of { label, value }' });
  }

  // Validate/normalize facts up front so we reject a bad payload before writing.
  const cleanFacts = [];
  for (const f of facts || []) {
    if (!f || typeof f !== 'object') {
      return res.status(400).json({ error: 'each fact must be an object { label, value }' });
    }
    const label = f.label == null ? '' : String(f.label).trim();
    const value = f.value == null ? '' : String(f.value).trim();
    if (!label) return res.status(400).json({ error: 'each fact needs a non-empty label' });
    if (!value) continue; // skip empty values rather than write a blank fact
    cleanFacts.push({ label, value });
  }

  try {
    const result = await db.transaction(async (txDb) => {
      // 1. ENRICH-ONLY: never create or adopt folders. Resolve the folder via the
      //    Ashby link (Model B) and only fill facts on a folder the recruiter has
      //    already linked to this Ashby job (via the picker). If it's not linked,
      //    skip it — no new folders are ever created. (`title` is accepted for
      //    logging/compat but not used to resolve or create anything.)
      const link = await txDb.prepare('SELECT * FROM job_ashby_links WHERE ashby_job_id = ?').get(ashbyId);
      if (!link) {
        return { skipped: true, action: 'skipped', ashby_job_id: ashbyId, note: 'no folder is linked to this Ashby job' };
      }
      const job = await txDb.prepare('SELECT * FROM jobs WHERE id = ?').get(link.job_id);
      const action = 'updated';

      // 2. Fill in ONLY the facts we don't already have (match by label,
      //    case-insensitive) — never overwrite a fact a recruiter may have edited.
      const existing = await txDb.prepare('SELECT * FROM job_info_facts WHERE job_id = ?').all(job.id);
      const seen = new Set(existing.map((r) => r.label.toLowerCase()));
      let maxSort = existing.reduce((m, r) => Math.max(m, r.sort_order), -1);
      let inserted = 0;
      let skipped = 0;
      for (const { label, value } of cleanFacts) {
        if (seen.has(label.toLowerCase())) { skipped += 1; continue; }
        maxSort += 1;
        await txDb.prepare('INSERT INTO job_info_facts (id, job_id, label, value, sort_order) VALUES (?, ?, ?, ?, ?)')
          .run(uuid(), job.id, label, value, maxSort);
        seen.add(label.toLowerCase());
        inserted += 1;
      }

      return { job: { id: job.id, name: job.name, parent_id: job.parent_id, mode: job.mode }, action, ashby_job_id: ashbyId, facts: { inserted, skipped } };
    });
    res.status(200).json(result);
  } catch (err) {
    console.error('[sync/ashby-job] failed:', err);
    res.status(500).json({ error: 'sync failed', detail: err.message });
  }
});

// ---------- ASHBY DESCRIPTION SYNC (called by the HappyRobot workflow) ----------
// Stores the evaluable part of an Ashby job description as the folder's single
// "fixed" parameter. The workflow's AI node has already stripped the noise
// (About/Why-join/GDPR) and keeps only Role Overview / responsibilities /
// requirements / operating principles; this endpoint just persists that text.
//
// Like /sync/ashby-job it is ENRICH-ONLY and link-scoped:
//   1. Resolves the folder via its job_ashby_links row; skips if there is none.
//   2. Skips if the folder ALREADY has a fixed parameter — a recruiter may have
//      edited its text or set its weight, and we never clobber that.
//   3. Otherwise creates the fixed parameter with a high default weight (10) so
//      it stands out; the recruiter tunes the % afterwards.
const FIXED_PARAM_LABEL = 'Job description (from Ashby)';
router.post('/sync/ashby-description', requireSyncKey, async (req, res) => {
  const { ashby_job_id, description } = req.body || {};
  const ashbyId = ashby_job_id == null ? '' : String(ashby_job_id).trim();
  const text = description == null ? '' : String(description).trim();
  if (!ashbyId) return res.status(400).json({ error: 'ashby_job_id is required' });
  if (!text) return res.status(400).json({ error: 'description is required' });

  try {
    const result = await db.transaction(async (txDb) => {
      const link = await txDb.prepare('SELECT * FROM job_ashby_links WHERE ashby_job_id = ?').get(ashbyId);
      if (!link) {
        return { skipped: true, action: 'skipped', ashby_job_id: ashbyId, note: 'no folder is linked to this Ashby job' };
      }
      const job = await txDb.prepare('SELECT * FROM jobs WHERE id = ?').get(link.job_id);
      const existing = await txDb.prepare('SELECT id FROM parameters WHERE job_id = ? AND is_fixed = true').get(job.id);
      if (existing) {
        return {
          skipped: true, action: 'skipped', ashby_job_id: ashbyId,
          job: { id: job.id, name: job.name }, note: 'folder already has a fixed parameter',
        };
      }
      const id = uuid();
      await txDb.prepare('INSERT INTO parameters (id, job_id, name, weight, added_by, is_fixed, body) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, job.id, FIXED_PARAM_LABEL, 10, 'Ashby sync', true, text);
      return { action: 'created', ashby_job_id: ashbyId, job: { id: job.id, name: job.name }, parameter_id: id };
    });
    res.status(200).json(result);
  } catch (err) {
    console.error('[sync/ashby-description] failed:', err);
    res.status(500).json({ error: 'sync failed', detail: err.message });
  }
});

// ---------- LINKED JOB DESCRIPTIONS (called by the HappyRobot workflow) ----------
// One call that returns the raw Ashby job-description text for every LINKED folder.
// This exists so the workflow NEVER has to call Ashby per-item inside a loop — that
// shape can't be validated cleanly by HappyRobot (it re-tests the per-item webhook
// with no loop data, gets an Ashby error, and blocks the downstream reference). Here
// the dashboard does the Ashby reads itself (it already holds the Ashby key): it lists
// postings to map each linked jobId -> its jobPosting id, then pulls each posting's
// descriptionPlain. The workflow then just loops this list, runs its AI extraction over
// jobs[].description, and posts the cleaned text back to /sync/ashby-description.
router.get('/ashby/linked-descriptions', requireSyncKey, async (req, res) => {
  try {
    const links = await db.prepare('SELECT ashby_job_id FROM job_ashby_links').all();
    const linked = new Set(links.map((r) => String(r.ashby_job_id)));
    if (linked.size === 0) return res.json({ jobs: [], count: 0 });

    const list = await ashby.listJobPostings();
    const postings = ((list && list.results) || []).filter((p) => p && linked.has(String(p.jobId)));

    const jobs = [];
    for (const p of postings) {
      let description = '';
      try {
        const info = await ashby.getJobPostingInfo(p.id);
        description = (info && info.results && info.results.descriptionPlain) || '';
      } catch (e) {
        console.error(`[ashby/linked-descriptions] jobPosting.info failed for ${p.id}:`, e.message);
      }
      jobs.push({ ashby_job_id: p.jobId, title: p.title || null, description });
    }
    res.json({ jobs, count: jobs.length });
  } catch (err) {
    console.error('[ashby/linked-descriptions] failed:', err);
    res.status(500).json({ error: 'failed to fetch linked descriptions', detail: err.message });
  }
});

// ---------- READ-ONLY: list applications for ONE Ashby job (integration Phase 1) ----------
// Safety: `job_id` is REQUIRED, so this can only ever read a single job's applications
// (scope it to the test "Football Player" job). This endpoint does NOT write anything to
// Ashby — it is purely for inspecting who has applied and the real response shape before
// we build any score/advance/archive step. Optional ?status=Active|Archived|Hired|Lead.
router.get('/ashby/applications', requireSyncKey, async (req, res) => {
  const jobId = String(req.query.job_id || '').trim();
  if (!jobId) return res.status(400).json({ error: 'job_id query param is required' });
  const status = req.query.status ? String(req.query.status) : undefined;
  try {
    const data = await ashby.listApplications({ jobId, status });
    res.json({
      job_id: jobId,
      count: data && data.results ? data.results.length : 0,
      moreDataAvailable: data && data.moreDataAvailable,
      nextCursor: data && data.nextCursor,
      applications: (data && data.results) || [],
    });
  } catch (err) {
    console.error('[ashby/applications] failed:', err);
    res.status(502).json({ error: 'ashby application.list failed', detail: err.message });
  }
});

// ---------- READ-ONLY: candidates to screen, WITH their CV text ----------
// THE single feed the prescreening workflow reads. Two modes:
//   * ?job_id=<ashby_job_id>  → that one job (used for the Football Player test).
//   * no job_id               → EVERY folder currently in production mode (the real
//                               run). If nothing is in production, returns 0
//                               candidates — so the workflow safely no-ops until a
//                               job is put live.
// Each candidate carries: application_id, candidate_id, name, current stage, the
// parsed cv_text, the owning folder id (`job_id`, for /jobs/:id/evaluation-config)
// and the ashby_job_id. Read-only — never writes.
router.get('/ashby/candidates-to-screen', requireSyncKey, async (req, res) => {
  const reqJobId = String(req.query.job_id || '').trim();
  // Only screen candidates who APPLIED themselves (status Active). Sourced leads
  // (status Lead) are NOT auto-screened. Caller can override with ?status= (used
  // only to point the Football Player dry-run test at its Lead test candidates).
  const status = req.query.status ? String(req.query.status) : 'Active';
  try {
    // Resolve which jobs to scan → [{ ashbyJobId, folderId, folderName }].
    let targets;
    if (reqJobId) {
      const link = await db.prepare(
        'SELECT j.id AS folder_id, j.name AS folder_name FROM job_ashby_links l JOIN jobs j ON j.id = l.job_id WHERE l.ashby_job_id = ?',
      ).get(reqJobId);
      targets = [{ ashbyJobId: reqJobId, folderId: link && link.folder_id, folderName: link && link.folder_name }];
    } else {
      const rows = await db.prepare(
        "SELECT l.ashby_job_id, j.id AS folder_id, j.name AS folder_name FROM job_ashby_links l JOIN jobs j ON j.id = l.job_id WHERE j.mode = 'production'",
      ).all();
      targets = rows.map((r) => ({ ashbyJobId: r.ashby_job_id, folderId: r.folder_id, folderName: r.folder_name }));
    }

    const candidates = [];
    for (const t of targets) {
      const data = await ashby.listApplications({ jobId: t.ashbyJobId, status });
      const apps = (data && data.results) || [];
      for (const app of apps) {
        const cand = app.candidate || {};
        const candidateId = cand.id || app.candidateId || null;
        const stage = app.currentInterviewStage || app.interviewStage || {};
        const entry = {
          application_id: app.id,
          candidate_id: candidateId,
          name: cand.name || null,
          job_id: t.folderId, // dashboard FOLDER id, for /jobs/:id/evaluation-config
          ashby_job_id: t.ashbyJobId,
          folder_name: t.folderName,
          current_stage: stage.title || null,
          current_stage_id: stage.id || null,
          has_resume: false,
          cv_text: '',
        };
        try {
          if (candidateId) {
            const file = await ashby.getResumeBuffer(candidateId);
            if (file) {
              entry.has_resume = true;
              entry.resume_name = file.name;
              entry.cv_text = (await parsePdfWithRetry(file.buffer)).trim();
            }
          }
        } catch (e) {
          entry.cv_error = e.message;
        }
        candidates.push(entry);
      }
    }
    res.json({
      mode: reqJobId ? 'single-job' : 'all-production',
      jobs_scanned: targets.length,
      status,
      count: candidates.length,
      candidates,
    });
  } catch (err) {
    console.error('[ashby/candidates-to-screen] failed:', err);
    res.status(502).json({ error: 'ashby candidates-to-screen failed', detail: err.message });
  }
});

// ---------- READ-ONLY: raw candidate.info (find the resume file handle) ----------
// So we can see exactly how Ashby exposes the resume/CV (resumeFileHandle, fileHandles…)
// before building the CV fetch. No writes.
router.get('/ashby/candidate-raw', requireSyncKey, async (req, res) => {
  const candidateId = String(req.query.candidate_id || '').trim();
  if (!candidateId) return res.status(400).json({ error: 'candidate_id query param is required' });
  try {
    const data = await ashby.getCandidateInfo(candidateId);
    res.json(data);
  } catch (err) {
    console.error('[ashby/candidate-raw] failed:', err);
    res.status(502).json({ error: 'ashby candidate.info failed', detail: err.message });
  }
});

// ---------- READ-ONLY: fetch + parse a candidate's resume/CV text ----------
// candidate.info -> resumeFileHandle -> file.info (temp URL) -> download PDF ->
// pdf-parse. This is the CV text the prescreening AI scores. No writes.
router.get('/ashby/candidate-cv', requireSyncKey, async (req, res) => {
  const candidateId = String(req.query.candidate_id || '').trim();
  if (!candidateId) return res.status(400).json({ error: 'candidate_id query param is required' });
  try {
    const file = await ashby.getResumeBuffer(candidateId);
    if (!file) return res.json({ candidate_id: candidateId, has_resume: false, cv_text: '' });
    const text = (await parsePdfWithRetry(file.buffer)).trim();
    res.json({
      candidate_id: candidateId,
      has_resume: true,
      resume_name: file.name,
      chars: text.length,
      cv_text_preview: text.slice(0, 400),
    });
  } catch (err) {
    console.error('[ashby/candidate-cv] failed:', err);
    res.status(502).json({ error: 'ashby resume fetch/parse failed', detail: err.message });
  }
});

// ---------- READ-ONLY: list Ashby custom fields (integration Phase 1) ----------
// To find the id of the "score" custom field the prescreening will write to (and its
// objectType). No writes — just inspects what fields exist in the Ashby account.
router.get('/ashby/custom-fields', requireSyncKey, async (req, res) => {
  try {
    const data = await ashby.listCustomFields();
    const results = (data && data.results) || [];
    res.json({
      count: results.length,
      fields: results.map((f) => ({ id: f.id, title: f.title, objectType: f.objectType, fieldType: f.fieldType })),
    });
  } catch (err) {
    console.error('[ashby/custom-fields] failed:', err);
    res.status(502).json({ error: 'ashby customField.list failed', detail: err.message });
  }
});

// ---------- TEST WRITE: set "AI Score Test" on ONE candidate (integration Phase 2) ----------
// Deliberately locked down so it can only ever do the safe thing:
//   * the field id is HARDCODED to "AI Score Test" — it can NEVER touch the real
//     "AI Score" field.
//   * it writes to exactly ONE candidate (candidate_id is required) — no loop.
//   * DRY-RUN by default: it just returns the intended write. Only ?live=1 performs
//     the real Ashby write.
// This is a throwaway helper to validate the write direction; it is NOT the workflow.
const AI_SCORE_TEST_FIELD_ID = '6eca71db-7cfe-4e13-ad54-e31bed8c5529'; // Ashby "AI Score Test" (Candidate, String)
// Prescreen decision (confirmed with Jackson 2026-07-23): pass = score strictly > 8
// → NO stage movement (candidate stays put). fail = score <= 8 → archive as
// "Lacks Skills/Qualifications". The archive STAGE is resolved per-application from
// its own interview plan (this constant is only a last-resort fallback for the
// Football Player plan); the archive REASON is org-wide.
const PRESCREEN_PASS_THRESHOLD = 8;
const ARCHIVE_REASON_LACKS_SKILLS = 'd826e7f7-b796-4280-9c78-6059c260ebee'; // "Lacks Skills/Qualifications" (RejectedByOrg)
const FALLBACK_ARCHIVED_STAGE_ID = 'e2f91e41-aca6-45bd-bfc1-7c590c4e0ff7'; // Football Player plan "Archived" stage
router.post('/ashby/test-write-score', requireSyncKey, async (req, res) => {
  const candidateId = String(req.query.candidate_id || (req.body && req.body.candidate_id) || '').trim();
  const score = req.query.score != null ? req.query.score : (req.body && req.body.score);
  const live = req.query.live === '1';
  if (!candidateId) return res.status(400).json({ error: 'candidate_id is required' });
  if (score == null || String(score) === '') return res.status(400).json({ error: 'score is required' });

  const plan = {
    objectType: 'Candidate',
    objectId: candidateId,
    fieldId: AI_SCORE_TEST_FIELD_ID,
    field_title: 'AI Score Test',
    value: String(score),
  };
  if (!live) return res.json({ ok: true, dry_run: true, note: 'add &live=1 to actually write', plan });

  try {
    const r = await ashby.setCustomFieldScore({
      objectId: candidateId, objectType: 'Candidate', fieldId: AI_SCORE_TEST_FIELD_ID, value: String(score),
    });
    res.json({ ok: true, dry_run: false, wrote: plan, ashby_success: !!(r && r.success) });
  } catch (err) {
    console.error('[ashby/test-write-score] failed:', err);
    res.status(502).json({ error: 'ashby customField.setValue failed', detail: err.message });
  }
});

// ---------- READ-ONLY: list interview stages of a plan (integration Phase 3) ----------
// To find the "next" stage to advance to and the Archived-type stage. No writes.
router.get('/ashby/interview-stages', requireSyncKey, async (req, res) => {
  const planId = String(req.query.plan_id || '').trim();
  if (!planId) return res.status(400).json({ error: 'plan_id query param is required' });
  try {
    const data = await ashby.listInterviewStages(planId);
    const results = (data && data.results) || [];
    res.json({
      count: results.length,
      stages: results.map((s) => ({ id: s.id, title: s.title, type: s.type, order: s.orderInInterviewPlan })),
    });
  } catch (err) {
    console.error('[ashby/interview-stages] failed:', err);
    res.status(502).json({ error: 'ashby interviewStage.list failed', detail: err.message });
  }
});

// ---------- READ-ONLY: list archive reasons (integration Phase 3) ----------
// To pick an archiveReasonId for the "did not pass -> archive" path. No writes.
router.get('/ashby/archive-reasons', requireSyncKey, async (req, res) => {
  try {
    const data = await ashby.listArchiveReasons();
    const results = (data && data.results) || [];
    res.json({
      count: results.length,
      reasons: results.map((r) => ({ id: r.id, text: r.text || r.title, reasonType: r.reasonType })),
    });
  } catch (err) {
    console.error('[ashby/archive-reasons] failed:', err);
    res.status(502).json({ error: 'ashby archiveReason.list failed', detail: err.message });
  }
});

// ---------- TEST: move ONE application's stage (advance or archive) (Phase 3) ----------
// Locked down: writes to exactly ONE application_id, to the stage_id you pass
// explicitly, and DRY-RUN unless ?live=1. For archiving (target is an Archived-type
// stage) pass &archive_reason_id=. Reversible — you can move it back. Not the workflow.
router.post('/ashby/test-change-stage', requireSyncKey, async (req, res) => {
  const applicationId = String(req.query.application_id || '').trim();
  const stageId = String(req.query.stage_id || '').trim();
  const archiveReasonId = req.query.archive_reason_id ? String(req.query.archive_reason_id) : undefined;
  const live = req.query.live === '1';
  if (!applicationId || !stageId) {
    return res.status(400).json({ error: 'application_id and stage_id are required' });
  }
  const plan = { applicationId, interviewStageId: stageId, archiveReasonId: archiveReasonId || null };
  if (!live) return res.json({ ok: true, dry_run: true, note: 'add &live=1 to actually move', plan });
  try {
    const r = await ashby.changeApplicationStage({ applicationId, interviewStageId: stageId, archiveReasonId });
    res.json({ ok: true, dry_run: false, moved: plan, ashby_success: !!(r && r.success) });
  } catch (err) {
    console.error('[ashby/test-change-stage] failed:', err);
    res.status(502).json({ error: 'ashby application.changeStage failed', detail: err.message });
  }
});

// ---------- PRESCREEN RESULT SINK (called by the prescreening workflow) ----------
// The workflow POSTs each candidate's score + pass/fail here. The DASHBOARD is the
// ONLY thing that then writes to Ashby (score custom field + advance/archive), so all
// the danger + safety guards live here, in code — never in a workflow node.
//
// Body: { score (number, required), candidate_id?, ashby_job_id? } — candidate/job
// are resolved from the application if not sent. Decision: score > 8 = pass (write
// score, no stage change); score <= 8 = fail (write score + archive).
//
// DOUBLE GUARD before any Ashby write: (1) ASHBY_WRITE_ENABLED === 'true' AND (2) the
// owning dashboard folder is in production mode. If either is false it's a DRY-RUN —
// logs the intended plan and returns without touching Ashby. Since only Football
// Player is ever set to production, no other job can be written even if posted here.
router.post('/candidates/:appId/prescreen-result', requireInternalKey, async (req, res) => {
  const appId = String(req.params.appId || '');
  if (!appId) return res.status(400).json({ error: 'appId (application id) is required' });
  const body = req.body || {};
  const numScore = Number(body.score);
  if (!Number.isFinite(numScore)) return res.status(400).json({ error: 'a numeric score is required' });

  const passed = numScore > PRESCREEN_PASS_THRESHOLD;

  // Resolve candidate + job + interview plan from the application itself (single
  // source of truth; the workflow only has to send the application id + score).
  let app;
  try {
    const info = await ashby.getApplicationInfo(appId);
    app = (info && info.results) || {};
  } catch (err) {
    return res.status(502).json({ error: 'could not resolve application from Ashby', detail: err.message });
  }
  const candidateId = body.candidate_id || (app.candidate && app.candidate.id) || null;
  const ashbyJobId = body.ashby_job_id || (app.job && app.job.id) || app.jobId || null;
  const planId = (app.currentInterviewStage && app.currentInterviewStage.interviewPlanId) || null;

  const plan = {
    application_id: appId,
    candidate_id: candidateId,
    ashby_job_id: ashbyJobId,
    score: numScore,
    passed,
    field: 'AI Score Test',
    action: passed ? 'write score only (no stage change)' : 'write score + archive (Lacks Skills/Qualifications)',
  };

  // GUARD 1 — global kill switch. GUARD 2 — the owning dashboard folder must be in
  // production mode. Both must hold, or this is a DRY-RUN (logs the plan, no Ashby
  // write). Only Football Player is ever put in production, so nothing else can be
  // touched even if the workflow posts it.
  const enabled = process.env.ASHBY_WRITE_ENABLED === 'true';
  let folder = null;
  if (ashbyJobId) {
    folder = await db.prepare(
      'SELECT j.id, j.name, j.mode FROM job_ashby_links l JOIN jobs j ON j.id = l.job_id WHERE l.ashby_job_id = ?',
    ).get(ashbyJobId);
  }
  const isProd = !!folder && folder.mode === 'production';

  if (!enabled || !isProd) {
    const reason = !enabled ? 'ASHBY_WRITE_ENABLED is not "true"' : 'owning folder is not in production mode';
    console.log(`[prescreen-result] DRY-RUN (${reason}):`, JSON.stringify(plan));
    return res.json({
      ok: true,
      dry_run: true,
      reason,
      folder: folder ? { name: folder.name, mode: folder.mode } : null,
      plan,
    });
  }

  // ---- LIVE writes (production folder + kill switch on) ----
  const done = { score_written: false, archived: false };
  try {
    if (candidateId) {
      await ashby.setCustomFieldScore({
        objectId: candidateId,
        objectType: 'Candidate',
        fieldId: AI_SCORE_TEST_FIELD_ID,
        value: String(numScore),
      });
      done.score_written = true;
    }
    if (!passed) {
      // Resolve THIS application's own Archived-type stage (correct across jobs/plans).
      let archivedStageId = FALLBACK_ARCHIVED_STAGE_ID;
      if (planId) {
        try {
          const st = await ashby.listInterviewStages(planId);
          const archived = ((st && st.results) || []).find((s) => s.type === 'Archived');
          if (archived && archived.id) archivedStageId = archived.id;
        } catch (e) {
          console.warn('[prescreen-result] stage resolve failed, using fallback:', e.message);
        }
      }
      await ashby.changeApplicationStage({
        applicationId: appId,
        interviewStageId: archivedStageId,
        archiveReasonId: ARCHIVE_REASON_LACKS_SKILLS,
      });
      done.archived = true;
    }
    console.log('[prescreen-result] LIVE write done:', JSON.stringify({ plan, done }));
    return res.json({ ok: true, dry_run: false, plan, done });
  } catch (err) {
    console.error('[prescreen-result] LIVE write failed:', err);
    return res.status(502).json({ ok: false, error: 'ashby write failed', detail: err.message, plan, done });
  }
});

// ---------- COMPANY FAQ (a.k.a. Global FAQ; company-wide, role-independent) ----------
// Recruiter-facing label/value facts the JobBot agent can answer for ANY
// candidate regardless of role (offices, funding, values, interview process…).
// A single flat global list — no job_id, no folders. Same open (browser)
// access as the Job Info CRUD above; the read-only JobBot surface is the
// separately-keyed GET /jobbot/global-faq below.
router.get('/company-faq', async (req, res) => {
  res.json(await db.prepare('SELECT * FROM company_faq ORDER BY sort_order, created_at').all());
});

router.post('/company-faq', async (req, res) => {
  const { label, value } = req.body;
  if (!label || !label.trim()) return res.status(400).json({ error: 'label is required' });
  if (value === undefined || value === null || !String(value).trim()) return res.status(400).json({ error: 'value is required' });
  const nextRow = await db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM company_faq').get();
  const id = uuid();
  await db.prepare('INSERT INTO company_faq (id, label, value, sort_order) VALUES (?, ?, ?, ?)')
    .run(id, label.trim(), String(value).trim(), nextRow.n);
  res.status(201).json(await db.prepare('SELECT * FROM company_faq WHERE id = ?').get(id));
});

router.put('/company-faq/:id', async (req, res) => {
  const existing = await db.prepare('SELECT * FROM company_faq WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'fact not found' });
  const { label, value } = req.body;
  if (label !== undefined && !label.trim()) return res.status(400).json({ error: 'label cannot be empty' });
  if (value !== undefined && !String(value).trim()) return res.status(400).json({ error: 'value cannot be empty' });
  await db.prepare(`
    UPDATE company_faq
       SET label = COALESCE(?, label), value = COALESCE(?, value), updated_at = datetime('now')
     WHERE id = ?
  `).run(
    label !== undefined ? label.trim() : null,
    value !== undefined ? String(value).trim() : null,
    req.params.id,
  );
  res.json(await db.prepare('SELECT * FROM company_faq WHERE id = ?').get(req.params.id));
});

router.delete('/company-faq/:id', async (req, res) => {
  await db.prepare('DELETE FROM company_faq WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// JobBot-facing lookup: GET /jobinfo/lookup?job=...
// Resolves a job by Ashby job id first, then by name (case-insensitive), and
// returns its facts (job-specific first, then general facts that apply to all
// jobs). Always 200 with a `found` flag; 400 only when `job` is missing.
router.get('/jobinfo/lookup', requireInternalKey, async (req, res) => {
  const q = (req.query.job || '').trim();
  if (!q) return res.status(400).json({ error: 'job query parameter is required' });

  let job = await db.prepare('SELECT id, name, ashby_job_id FROM jobs WHERE ashby_job_id = ?').get(q);
  if (!job) job = await db.prepare('SELECT id, name, ashby_job_id FROM jobs WHERE lower(trim(name)) = lower(?)').get(q);
  if (!job) return res.json({ found: false });

  const jobFacts = await db.prepare('SELECT label, value FROM job_info_facts WHERE job_id = ? ORDER BY sort_order, created_at').all(job.id);
  const generalFacts = await db.prepare('SELECT label, value FROM job_info_facts WHERE job_id IS NULL ORDER BY sort_order, created_at').all();
  res.json({
    found: true,
    job: { id: job.id, name: job.name, ashby_job_id: job.ashby_job_id || null },
    facts: [...jobFacts, ...generalFacts],
  });
});

// ---------- READ-ONLY JOBBOT API (consumed by the external HappyRobot agent) ----------
// A clean, documented, read-only JSON surface the external HappyRobot voice/chat
// agent calls at runtime to fetch job facts. Namespaced under /jobbot so it never
// collides with the UI's own /jobs routes above, and protected by a dedicated
// read-only key (JOBBOT_API_KEY, see requireJobbotKey) sent as x-api-key —
// separate from INTERNAL_API_KEY to limit blast radius. GET only — no writes.

// Turn a job name into a URL-safe slug ("Field Engineer" -> "field-engineer").
function jobSlug(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Resolve a job by (in order) id, Ashby job id, exact case-insensitive name, or
// derived slug. Returns the job row ({ id, name, ashby_job_id }) or null.
async function resolveJobByTitleOrSlug(q) {
  const needle = String(q || '').trim();
  if (!needle) return null;
  let job = await db.prepare('SELECT id, name, ashby_job_id FROM jobs WHERE id = ? OR ashby_job_id = ?').get(needle, needle);
  if (!job) job = await db.prepare('SELECT id, name, ashby_job_id FROM jobs WHERE lower(trim(name)) = lower(?)').get(needle);
  if (!job) {
    const wanted = jobSlug(needle);
    job = (await db.prepare('SELECT id, name, ashby_job_id FROM jobs').all()).find((j) => jobSlug(j.name) === wanted) || null;
  }
  return job;
}

// General facts (job_id NULL) that apply to every job, in display order.
async function generalFacts() {
  return await db.prepare('SELECT label, value FROM job_info_facts WHERE job_id IS NULL ORDER BY sort_order, created_at').all();
}

// 1. List every configured job so the caller can validate/match a role name.
router.get('/jobbot/jobs', requireJobbotKey, async (req, res) => {
  const jobs = await db.prepare('SELECT name, ashby_job_id FROM jobs ORDER BY name').all();
  res.json({
    jobs: jobs.map((j) => ({
      title: j.name,
      slug: jobSlug(j.name),
      ashby_job_id: j.ashby_job_id || null,
    })),
  });
});

// 3. General facts that apply to every job. Registered BEFORE the :titleOrSlug
// route below so the literal "general" is never captured as a job name/slug.
router.get('/jobbot/jobs/general', requireJobbotKey, async (req, res) => {
  res.json({ title: 'General', slug: 'general', facts: await generalFacts() });
});

// 4. Company-wide FAQ (a.k.a. Global FAQ): role-INDEPENDENT facts that apply to
// every candidate no matter which role they applied to (offices, funding,
// values/culture, interview process…). Takes NO role parameter — the same
// response for every call. Read from the standalone company_faq table (NOT
// job_info_facts), so this content is never merged into per-role responses.
// Registered BEFORE the :titleOrSlug route so "global-faq" is never captured as
// a job name/slug. Kept lightweight (one indexed table read, no joins) because
// the voice workflow calls it once at the very start of each conversation.
router.get('/jobbot/global-faq', requireJobbotKey, async (req, res) => {
  const facts = await db.prepare('SELECT label, value FROM company_faq ORDER BY sort_order, created_at').all();
  res.json({ title: 'Company FAQ', slug: 'global-faq', facts });
});

// 2. Facts for one job, WITH the general facts merged in (job-specific first,
// then general) — matching the UI copy "JobBot includes these alongside each
// job's own facts" and the existing /jobinfo/lookup behavior. 404 if unknown.
router.get('/jobbot/jobs/:titleOrSlug', requireJobbotKey, async (req, res) => {
  const job = await resolveJobByTitleOrSlug(req.params.titleOrSlug);
  if (!job) {
    return res.status(404).json({ error: 'job not found', titleOrSlug: req.params.titleOrSlug });
  }
  const own = await db.prepare('SELECT label, value FROM job_info_facts WHERE job_id = ? ORDER BY sort_order, created_at').all(job.id);
  res.json({
    title: job.name,
    slug: jobSlug(job.name),
    ashby_job_id: job.ashby_job_id || null,
    generalFactsMerged: true,
    facts: [...own, ...(await generalFacts())],
  });
});

// ================= UNANSWERED QUESTIONS (Suggested additions) =================
// JobBot reports questions it couldn't answer here; recruiters triage them in
// the "Suggested additions" view and either turn them into Job Info facts or
// dismiss them. See the unanswered_questions table in db/index.js.

// Normalize question text for exact-match aggregation: trimmed + lower-cased.
// v1 is deliberately exact-match only — fuzzy/semantic clustering is a v2
// concern (see the task brief), so this mirrors the case-insensitive/trimmed
// matching used elsewhere (e.g. job-name lookup) rather than anything smarter.
function normalizeQuestion(s) {
  return String(s || '').trim().toLowerCase();
}

// Coerce a caller-supplied timestamp into SQLite's UTC "YYYY-MM-DD HH:MM:SS"
// format so it sorts and renders exactly like datetime('now') rows. Returns
// null when absent/unparseable, in which case the column default is used.
function toSqliteUtc(ts) {
  if (ts === undefined || ts === null || ts === '') return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// POST /jobbot/unanswered-questions  — write-only, guarded by requireUnansweredKey.
// Body: { role_label?, question, timestamp? }. Records ONE unanswered question.
// Always the only thing this key can do.
router.post('/jobbot/unanswered-questions', requireUnansweredKey, async (req, res) => {
  const { role_label, question, timestamp } = req.body || {};
  if (!question || !String(question).trim()) {
    return res.status(400).json({ error: 'question is required' });
  }
  const id = uuid();
  const createdAt = toSqliteUtc(timestamp);
  const label = role_label && String(role_label).trim() ? String(role_label).trim() : null;
  if (createdAt) {
    await db.prepare(`
      INSERT INTO unanswered_questions (id, role_label, question_text, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, label, String(question).trim(), createdAt, createdAt);
  } else {
    await db.prepare(`
      INSERT INTO unanswered_questions (id, role_label, question_text)
      VALUES (?, ?, ?)
    `).run(id, label, String(question).trim());
  }
  res.status(201).json(await db.prepare('SELECT id, role_label, question_text, status, created_at FROM unanswered_questions WHERE id = ?').get(id));
});

// GET /unanswered-questions?status=open  — recruiter-facing (browser). Groups
// rows by normalized question text and ranks by frequency (count desc, then
// most-recent). Each group carries every row id in it so the actions below can
// resolve/dismiss the whole cluster of duplicates at once.
router.get('/unanswered-questions', async (req, res) => {
  const status = (req.query.status || 'open').trim();
  if (!['open', 'resolved', 'dismissed'].includes(status)) {
    return res.status(400).json({ error: "status must be one of open, resolved, dismissed" });
  }
  const rows = await db.prepare(
    'SELECT id, role_label, question_text, created_at FROM unanswered_questions WHERE status = ? ORDER BY created_at DESC'
  ).all(status);

  const groups = new Map();
  for (const r of rows) {
    const key = normalizeQuestion(r.question_text);
    if (!groups.has(key)) {
      groups.set(key, {
        // Representative text = the most recent row's original casing (rows are
        // pre-sorted newest-first, so the first one we see wins).
        question_text: r.question_text,
        count: 0,
        ids: [],
        role_labels: [],
        first_seen: r.created_at,
        last_seen: r.created_at,
      });
    }
    const g = groups.get(key);
    g.count += 1;
    g.ids.push(r.id);
    if (r.role_label && !g.role_labels.includes(r.role_label)) g.role_labels.push(r.role_label);
    if (r.created_at < g.first_seen) g.first_seen = r.created_at;
    if (r.created_at > g.last_seen) g.last_seen = r.created_at;
  }

  const list = [...groups.values()].sort(
    (a, b) => b.count - a.count || b.last_seen.localeCompare(a.last_seen)
  );
  res.json({ status, total_rows: rows.length, total_groups: list.length, groups: list });
});

// Guard: pull a clean, de-duplicated list of ids from a request body.
function readIds(body) {
  const ids = body && body.ids;
  if (!Array.isArray(ids)) return null;
  const clean = [...new Set(ids.map((x) => String(x)).filter(Boolean))];
  return clean.length ? clean : null;
}

async function markStatus(ids, status) {
  return await db.transaction(async (txDb) => {
    let n = 0;
    for (const id of ids) {
      n += (await txDb.prepare("UPDATE unanswered_questions SET status = ?, updated_at = datetime('now') WHERE id = ? AND status = 'open'").run(status, id)).changes;
    }
    return n;
  });
}

// POST /unanswered-questions/dismiss  — { ids: [...] } → status = dismissed.
router.post('/unanswered-questions/dismiss', async (req, res) => {
  const ids = readIds(req.body);
  if (!ids) return res.status(400).json({ error: 'ids must be a non-empty array' });
  const dismissed = await markStatus(ids, 'dismissed');
  res.json({ dismissed });
});

// POST /unanswered-questions/add-to-job-info
// Body: { ids: [...], job_id: <id | 'general'>, label, value }
// Creates a Job Info fact in the given folder (job_id 'general' or null =
// General facts) AND marks the supplied open questions resolved — atomically,
// so a fact is never created without clearing the questions and vice-versa.
router.post('/unanswered-questions/add-to-job-info', async (req, res) => {
  const { job_id, label, value } = req.body || {};
  const ids = readIds(req.body);
  if (!ids) return res.status(400).json({ error: 'ids must be a non-empty array' });
  if (!label || !String(label).trim()) return res.status(400).json({ error: 'label is required' });
  if (value === undefined || value === null || !String(value).trim()) return res.status(400).json({ error: 'value is required' });

  const jobId = job_id === 'general' || job_id === undefined || job_id === null || job_id === '' ? null : job_id;
  if (jobId !== null && !(await db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(jobId))) {
    return res.status(404).json({ error: 'job not found' });
  }

  const factId = uuid();
  const resolved = await db.transaction(async (txDb) => {
    const nextRow = jobId === null
      ? await txDb.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM job_info_facts WHERE job_id IS NULL').get()
      : await txDb.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM job_info_facts WHERE job_id = ?').get(jobId);
    await txDb.prepare('INSERT INTO job_info_facts (id, job_id, label, value, sort_order) VALUES (?, ?, ?, ?, ?)')
      .run(factId, jobId, String(label).trim(), String(value).trim(), nextRow.n);
    let n = 0;
    for (const id of ids) {
      n += (await txDb.prepare("UPDATE unanswered_questions SET status = 'resolved', updated_at = datetime('now') WHERE id = ? AND status = 'open'").run(id)).changes;
    }
    return n;
  });

  res.status(201).json({
    fact: await db.prepare('SELECT * FROM job_info_facts WHERE id = ?').get(factId),
    resolved,
  });
});

// ---------- CONSOLIDATED CONFIG: what Happy Robot consumes to evaluate a candidate ----------
router.get('/jobs/:jobId/evaluation-config', requireInternalKey, async (req, res) => {
  const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });

  // Recruiter-authored criteria (is_fixed = false). Model B: a variant (child)
  // folder inherits its parent "role" folder's criteria. For a top-level folder
  // (parent_id NULL) parentParams is empty -> behaviour identical to before.
  // All the reads below are independent, so fire them concurrently (one round-trip's
  // worth of DB latency instead of six sequential ones). The FIXED parameter (the
  // Ashby job-description block) takes an ABSOLUTE share of the score: its weight is
  // a PERCENTAGE (0-100). e.g. weight=20 -> the job description is 20% of the final
  // score and the recruiter criteria split the remaining 80%. Use the folder's own
  // fixed param; if it has none, inherit the parent's (variants inherit the role).
  const noRows = Promise.resolve([]);
  const noRow = Promise.resolve(undefined);
  const [generalParams, parentParams, jobParams, parentKillers, ownKillers, ownFixed, parentFixed] = await Promise.all([
    db.prepare('SELECT name, weight, added_by FROM parameters WHERE job_id IS NULL AND is_fixed = false').all(),
    job.parent_id ? db.prepare('SELECT name, weight, added_by FROM parameters WHERE job_id = ? AND is_fixed = false').all(job.parent_id) : noRows,
    db.prepare('SELECT name, weight, added_by FROM parameters WHERE job_id = ? AND is_fixed = false').all(job.id),
    job.parent_id ? db.prepare('SELECT question, added_by FROM killer_questions WHERE job_id = ?').all(job.parent_id) : noRows,
    db.prepare('SELECT question, added_by FROM killer_questions WHERE job_id = ?').all(job.id),
    db.prepare('SELECT name, weight, body FROM parameters WHERE job_id = ? AND is_fixed = true').get(job.id),
    job.parent_id ? db.prepare('SELECT name, weight, body FROM parameters WHERE job_id = ? AND is_fixed = true').get(job.parent_id) : noRow,
  ]);
  const killerQuestions = [...parentKillers, ...ownKillers];
  const fixedRow = ownFixed || parentFixed || null;
  const jobDescPct = fixedRow ? Math.min(100, Math.max(0, Number(fixedRow.weight) || 0)) : 0;
  const jobDescFrac = jobDescPct / 100;

  // The recruiter criteria are normalized among THEMSELVES and then scaled to the
  // remaining share (1 - jobDescFrac), so the whole set (criteria + job description)
  // sums to 1. With no fixed param jobDescFrac = 0 -> identical to the old behaviour.
  const allParams = [...generalParams, ...parentParams, ...jobParams];
  const weightTotal = allParams.reduce((sum, p) => sum + p.weight, 0);
  const normalsPresent = weightTotal > 0;
  const criteriaShare = 1 - jobDescFrac; // portion of the score for recruiter criteria
  const withEffective = (p) => ({
    ...p,
    effective_weight: normalsPresent ? (p.weight / weightTotal) * criteriaShare : 0,
  });
  // If there are no recruiter criteria, the job description takes the whole score.
  const jobDescEffective = fixedRow ? (normalsPresent ? jobDescFrac : 1) : 0;

  const jobDescription = fixedRow ? {
    name: fixedRow.name,
    text: fixedRow.body || '',
    weight_pct: jobDescPct,
    effective_weight: jobDescEffective,
  } : null;

  // Combined, ready-to-use list: recruiter criteria (scaled) + the job description as
  // one more weighted criterion (score the CV's overall fit to `description`).
  const combined = allParams.map(withEffective);
  if (jobDescription) {
    combined.push({
      name: jobDescription.name,
      is_fixed: true,
      description: jobDescription.text,
      weight_pct: jobDescription.weight_pct,
      effective_weight: jobDescription.effective_weight,
    });
  }

  res.json({
    job: { id: job.id, name: job.name, ashby_job_id: job.ashby_job_id, mode: job.mode, parent_id: job.parent_id },
    // Top-level too so the Prescreening workflow can read these directly. It must
    // only score folders whose mode === 'production'; a gate node can branch on
    // is_production (true/false) to skip the rest.
    mode: job.mode,
    is_production: job.mode === 'production',
    weight_total: weightTotal,
    // The job description's absolute share of the score (percentage). The recruiter
    // criteria below share the remaining (100 - job_description_pct)%.
    job_description_pct: jobDescPct,
    job_description: jobDescription, // { name, text, weight_pct, effective_weight } | null
    general_parameters: generalParams.map(withEffective),
    parent_parameters: parentParams.map(withEffective),
    // job_parameters carries the parent role's params + this folder's own, so the
    // existing Prescreening workflows (which read job_parameters + general_parameters)
    // apply the full role+variant inheritance without any workflow change. For a
    // top-level folder parentParams is empty, so this equals its own params.
    job_parameters: [...parentParams, ...jobParams].map(withEffective),
    // Combined list: recruiter criteria (scaled) + the job description criterion.
    parameters: combined,
    killer_questions: killerQuestions,
  });
});

// ---------- SCORE INGESTION (Happy Robot -> this app -> Ashby) ----------
router.post('/candidates/score', requireInternalKey, async (req, res) => {
  const {
    job_id,
    ashby_candidate_id,
    ashby_application_id,
    score,
    status,
    breakdown,
    sync_to_ashby = true,
  } = req.body;

  if (score === undefined || Number.isNaN(Number(score))) {
    return res.status(400).json({ error: 'score is required and must be numeric' });
  }

  const id = uuid();
  await db.prepare(`
    INSERT INTO score_log (id, job_id, ashby_candidate_id, ashby_application_id, score, status, breakdown, synced_to_ashby)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `).run(id, job_id || null, ashby_candidate_id || null, ashby_application_id || null, Number(score), status || null, JSON.stringify(breakdown || null));

  let syncResult = null;
  if (sync_to_ashby) {
    try {
      const fieldId = process.env.ASHBY_SCORE_FIELD_ID;
      const objectType = process.env.ASHBY_SCORE_OBJECT_TYPE || 'Application';
      const objectId = objectType === 'Candidate' ? ashby_candidate_id : ashby_application_id;
      if (!fieldId) throw new Error('ASHBY_SCORE_FIELD_ID is not configured');
      if (!objectId) throw new Error(`Missing ${objectType === 'Candidate' ? 'ashby_candidate_id' : 'ashby_application_id'} in the request`);

      await ashby.setCustomFieldScore({ objectId, objectType, fieldId, value: Number(score) });
      await db.prepare('UPDATE score_log SET synced_to_ashby = 1 WHERE id = ?').run(id);
      syncResult = { synced: true };
    } catch (err) {
      await db.prepare('UPDATE score_log SET sync_error = ? WHERE id = ?').run(err.message, id);
      syncResult = { synced: false, error: err.message };
    }
  }

  res.status(201).json({ log_id: id, sync: syncResult });
});

router.get('/score-log', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM score_log ORDER BY created_at DESC LIMIT 200').all();
  res.json(rows);
});

// ================= DEVELOPMENT SANDBOX (Prescreening Testing) =================
// A folder in 'development' mode is tuned here: the recruiter uploads a test CV,
// the cloned "Prescreening Testing" workflow scores it with the SAME scoring agent
// as production (so the number is IDENTICAL) and adds a per-parameter rationale,
// then POSTs the result back to POST /jobs/:id/dev/result. Nothing here touches
// Ashby. Each run is one dev_test_runs row: created 'pending' by /dev/run,
// completed by /dev/result. The pass/fail verdict is NOT computed by the workflow;
// the dashboard derives it from the current pass_threshold at read time.

function safeParseJson(str, fallback) {
  if (str == null) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

// Shape a dev run row for the UI: booleans/JSON parsed, verdict derived live.
async function presentDevRun(r) {
  if (!r) return r;
  const threshold = await getPassThreshold();
  return {
    ...r,
    score: r.score == null ? null : Number(r.score),
    passed: r.score == null ? null : Number(r.score) >= threshold,
    pass_threshold: threshold,
    parameter_breakdown: r.parameter_breakdown || null,
    parameter_reasoning: safeParseJson(r.parameter_reasoning, []),
    config_snapshot: safeParseJson(r.config_snapshot, null),
  };
}

// pdf-parse bundles a very old pdf.js (v1.10.100) whose fake-worker sets up
// lazily on the first parse of a fresh process; that first call can lose a race
// and throw "bad XRef entry" even on a perfectly valid PDF, while an immediate
// retry on the same bytes succeeds (the classic "fails once, then works"). Retry
// a few times, copying the buffer each attempt because a failed parse can detach
// the underlying ArrayBuffer, so a cold first run never surfaces to the user.
async function parsePdfWithRetry(buffer, attempts = 3) {
  const pdfParse = require('pdf-parse');
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const data = await pdfParse(Buffer.from(buffer));
      return data.text || '';
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw lastErr;
}

// Convert an uploaded resume document to plain text. The dashboard does this so
// the workflow receives text directly (no OCR needed). Pure-JS parsers only.
async function extractCvText(file) {
  const name = (file.originalname || '').toLowerCase();
  const mime = file.mimetype || '';
  if (mime.includes('pdf') || name.endsWith('.pdf')) {
    return await parsePdfWithRetry(file.buffer);
  }
  if (name.endsWith('.docx') || mime.includes('officedocument.wordprocessingml')) {
    const mammoth = require('mammoth');
    const { value } = await mammoth.extractRawText({ buffer: file.buffer });
    return value || '';
  }
  if (mime.startsWith('text/') || name.endsWith('.txt') || name.endsWith('.md')) {
    return file.buffer.toString('utf8');
  }
  throw new Error('unsupported file type — upload a PDF, DOCX, or TXT');
}

// UI -> dashboard: upload a test CV and kick off a dev run. Parses the document to
// text here, snapshots the current criteria, creates a 'pending' row, and fires the
// cloned "Prescreening Testing" workflow. The workflow scores + explains and calls
// back POST /dev/result. Only allowed while the folder is in 'development' mode.
router.post('/jobs/:id/dev/run', uploadCv.single('cv'), async (req, res) => {
  const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  if (job.mode !== 'development') {
    return res.status(409).json({ error: "folder must be in 'development' mode to run the sandbox" });
  }
  if (!req.file) return res.status(400).json({ error: 'a CV file is required (form field: cv)' });

  let cvText;
  try {
    cvText = (await extractCvText(req.file)).trim();
  } catch (err) {
    return res.status(400).json({ error: `could not read CV: ${err.message}` });
  }
  if (!cvText) return res.status(400).json({ error: 'the CV appears to be empty or unreadable' });

  const candidateName = String(req.body.candidate_name || req.file.originalname || 'Test candidate').trim();

  // Snapshot the criteria used for this run (general + job-specific + killer qs).
  // The fixed parameter (job description) takes an absolute % of the score; the
  // recruiter criteria split the rest — same model as /evaluation-config.
  const devFixed = (await db.prepare('SELECT name, weight, body FROM parameters WHERE job_id = ? AND is_fixed = true').get(job.id))
    || (job.parent_id ? await db.prepare('SELECT name, weight, body FROM parameters WHERE job_id = ? AND is_fixed = true').get(job.parent_id) : null);
  const configSnapshot = {
    general_parameters: await db.prepare('SELECT name, weight, added_by FROM parameters WHERE job_id IS NULL AND is_fixed = false').all(),
    job_parameters: await db.prepare('SELECT name, weight, added_by FROM parameters WHERE job_id = ? AND is_fixed = false').all(job.id),
    job_description: devFixed
      ? { name: devFixed.name, text: devFixed.body || '', weight_pct: Math.min(100, Math.max(0, Number(devFixed.weight) || 0)) }
      : null,
    killer_questions: await db.prepare('SELECT question, expected_answer, added_by FROM killer_questions WHERE job_id = ?').all(job.id),
  };

  const runId = uuid();
  await db.prepare(`
    INSERT INTO dev_test_runs (id, job_id, candidate_name, cv_filename, cv_text, status, config_snapshot, created_by)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(runId, job.id, candidateName, req.file.originalname || null, cvText, JSON.stringify(configSnapshot), req.body.created_by || null);

  // Fire the published "Prescreening Dev" HappyRobot webhook. Defaults to the live
  // hook so it works out of the box; override with PRESCREENING_TESTING_TRIGGER_URL
  // (e.g. if the workflow is re-published under a new slug). If the run can't be
  // started, mark it 'error' so the UI shows why instead of hanging.
  const triggerUrl = process.env.PRESCREENING_TESTING_TRIGGER_URL
    || 'https://workflows.platform.happyrobot.ai/hooks/s7tv6b29ya03';
  const markError = async (msg) => await db.prepare("UPDATE dev_test_runs SET status='error', error=?, updated_at=datetime('now') WHERE id=?").run(msg, runId);

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.PRESCREENING_TESTING_TRIGGER_KEY) headers['x-api-key'] = process.env.PRESCREENING_TESTING_TRIGGER_KEY;
    const resp = await fetch(triggerUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ run_id: runId, job_id: job.id, candidate_name: candidateName, cv_text: cvText }),
    });
    if (!resp.ok) throw new Error(`trigger responded ${resp.status}`);
  } catch (err) {
    await markError(`failed to trigger workflow: ${err.message}`);
    return res.status(502).json({ error: `could not start the dev run: ${err.message}`, run: await presentDevRun(await db.prepare('SELECT * FROM dev_test_runs WHERE id = ?').get(runId)) });
  }

  res.status(201).json(await presentDevRun(await db.prepare('SELECT * FROM dev_test_runs WHERE id = ?').get(runId)));
});

// Workflow -> dashboard: store the scored result for a dev run. Guarded by the
// internal key (same credential the workflow already uses for /evaluation-config).
router.post('/jobs/:id/dev/result', requireInternalKey, async (req, res) => {
  const { run_id, candidate_name, score, rationale, parameter_breakdown, parameter_reasoning } = req.body;
  if (!run_id) return res.status(400).json({ error: 'run_id is required' });
  const run = await db.prepare('SELECT * FROM dev_test_runs WHERE id = ? AND job_id = ?').get(run_id, req.params.id);
  if (!run) return res.status(404).json({ error: 'dev run not found for this job' });

  await db.prepare(`
    UPDATE dev_test_runs SET
      status = 'done',
      candidate_name = COALESCE(?, candidate_name),
      score = ?,
      rationale = ?,
      parameter_breakdown = ?,
      parameter_reasoning = ?,
      error = NULL,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    candidate_name || null,
    score == null || Number.isNaN(Number(score)) ? null : Number(score),
    rationale || null,
    parameter_breakdown == null ? null : String(parameter_breakdown),
    JSON.stringify(parameter_reasoning || []),
    run_id,
  );

  res.json({ ok: true, run: await presentDevRun(await db.prepare('SELECT * FROM dev_test_runs WHERE id = ?').get(run_id)) });
});

// UI -> dashboard: list recent dev runs for a folder (most recent first).
router.get('/jobs/:id/dev/results', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM dev_test_runs WHERE job_id = ? ORDER BY created_at DESC LIMIT 50').all(req.params.id);
  res.json(await Promise.all(rows.map(presentDevRun)));
});

// UI -> dashboard: fetch a single dev run (for polling while it's 'pending').
router.get('/jobs/:id/dev/results/:runId', async (req, res) => {
  const run = await db.prepare('SELECT * FROM dev_test_runs WHERE id = ? AND job_id = ?').get(req.params.runId, req.params.id);
  if (!run) return res.status(404).json({ error: 'dev run not found' });
  res.json(await presentDevRun(run));
});

// UI -> dashboard: delete a dev run (clean up the sandbox).
router.delete('/jobs/:id/dev/results/:runId', async (req, res) => {
  await db.prepare('DELETE FROM dev_test_runs WHERE id = ? AND job_id = ?').run(req.params.runId, req.params.id);
  res.status(204).end();
});

// ================= AGENT INTERVIEW (Phase 2) =================
// This backend only scores, stores, and syncs custom fields. It never changes
// the Ashby stage or archives anything — the Happy Robot workflow does that
// based on the `passed` flag returned by POST /interview/results.

async function localJobByAshbyJobId(ashbyJobId) {
  if (!ashbyJobId) return null;
  return await db.prepare('SELECT * FROM jobs WHERE ashby_job_id = ?').get(ashbyJobId);
}

// Resolve the local job FOLDER for an Ashby application object. Folders are now
// one-per-role (location-agnostic): try the legacy real-UUID anchor first, then
// the canonical role key so an application from ANY country lands on its role folder.
async function localJobForApp(app) {
  const ashbyJobId = (app && app.job && app.job.id) || (app && app.jobId) || null;
  let job = await localJobByAshbyJobId(ashbyJobId);
  if (!job) {
    const rawTitle = (app && app.job && app.job.title) || (app && app.jobTitle) || null;
    if (rawTitle) {
      const { canonicalTitle, roleKey } = canonicalizeRole(rawTitle);
      job =
        (await db.prepare('SELECT * FROM jobs WHERE ashby_job_id = ?').get(roleKey)) ||
        (await db.prepare('SELECT * FROM jobs WHERE LOWER(name) = LOWER(?)').get(canonicalTitle));
    }
  }
  return job || null;
}

// Resolve the local job for an application: an explicit hint wins, then a value
// cached from a previous interview interaction, then a live Ashby lookup.
async function resolveJobIdForApplication(applicationId, hintedJobId) {
  if (hintedJobId) {
    const job = await db.prepare('SELECT id FROM jobs WHERE id = ?').get(hintedJobId);
    if (job) return job.id;
  }
  const state = await db.prepare('SELECT job_id FROM interview_state WHERE application_id = ?').get(applicationId);
  if (state && state.job_id) return state.job_id;
  const info = await ashby.getApplicationInfo(applicationId);
  const app = (info && info.results) || info || {};
  const job = await localJobForApp(app);
  return job ? job.id : null;
}

// Upsert interview state. stage_entered_at is only stamped on first insert (our
// fallback for Ashby's native stage-entry time); job_id is backfilled if empty.
async function touchInterviewState(applicationId, jobId) {
  await db.prepare(`
    INSERT INTO interview_state (application_id, job_id, stage_entered_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(application_id) DO UPDATE SET
      job_id = COALESCE(interview_state.job_id, excluded.job_id)
  `).run(applicationId, jobId || null);
}

// Deterministic weighted score over the questions that were actually asked.
// answers: [{ question_id, answer: true | false | null }]. null = not asked.
// A question passes when its answer matches its expected_answer (see scoring.js).
async function computeInterviewScore(answers) {
  const questionMap = {};
  for (const a of answers) {
    if (!(a.question_id in questionMap)) {
      const q = await db.prepare('SELECT weight, expected_answer FROM killer_questions WHERE id = ?').get(a.question_id);
      if (q) questionMap[a.question_id] = { weight: q.weight, expected_answer: q.expected_answer };
    }
  }
  return scoreAnswers(answers, questionMap);
}

// GET /interview/questions?applicationId=...[&jobId=...]
// Returns the job's killer questions for the voice agent to ask.
router.get('/interview/questions', requireInternalKey, async (req, res) => {
  const applicationId = (req.query.applicationId || '').trim();
  if (!applicationId) return res.status(400).json({ error: 'applicationId is required' });
  try {
    const jobId = await resolveJobIdForApplication(applicationId, (req.query.jobId || '').trim() || null);
    if (!jobId) return res.status(404).json({ error: 'could not resolve a job for this application' });
    await touchInterviewState(applicationId, jobId);
    const state = await db.prepare('SELECT stage_entered_at FROM interview_state WHERE application_id = ?').get(applicationId);
    const questions = await db.prepare('SELECT id, question AS text, weight FROM killer_questions WHERE job_id = ? ORDER BY created_at').all(jobId);
    res.json({ applicationId, jobId, stageEnteredAt: state ? state.stage_entered_at : null, questions });
  } catch (err) {
    res.status(502).json({ error: `failed to resolve questions: ${err.message}` });
  }
});

// POST /interview/attempts/:applicationId/increment
// Atomically bumps the zero-engagement (no answers captured) counter. Returns
// the configured limit and whether it's been reached, so the Happy Robot
// workflow can archive "unreachable" applications from settings instead of a
// hardcoded number.
router.post('/interview/attempts/:applicationId/increment', requireInternalKey, async (req, res) => {
  const row = await db.prepare(`
    INSERT INTO interview_state (application_id, attempts, stage_entered_at)
    VALUES (?, 1, datetime('now'))
    ON CONFLICT(application_id) DO UPDATE SET attempts = interview_state.attempts + 1
    RETURNING attempts
  `).get(req.params.applicationId);
  const maxAttempts = await getMaxCallAttempts();
  res.json({ attempts: row.attempts, maxAttempts, limitReached: row.attempts >= maxAttempts });
});

// POST /interview/results
// Scores the call server-side, stores the raw payload + result, syncs the
// score and coverage to Ashby, and returns { score, passed }.
router.post('/interview/results', requireInternalKey, async (req, res) => {
  const { applicationId, callConnected, answers, callbackRequested, callNotes } = req.body || {};
  if (!applicationId) return res.status(400).json({ error: 'applicationId is required' });
  if (!Array.isArray(answers)) return res.status(400).json({ error: 'answers must be an array' });

  const { score, asked } = await computeInterviewScore(answers);
  const passed = score >= await getPassThreshold();

  // Derive the job (for coverage total) from the answered questions, falling
  // back to cached interview state.
  let jobId = null;
  for (const a of answers) {
    const q = await db.prepare('SELECT job_id FROM killer_questions WHERE id = ?').get(a.question_id);
    if (q) { jobId = q.job_id; break; }
  }
  if (!jobId) {
    const state = await db.prepare('SELECT job_id FROM interview_state WHERE application_id = ?').get(applicationId);
    if (state) jobId = state.job_id;
  }
  const coverageTotal = jobId
    ? (await db.prepare('SELECT COUNT(*) AS n FROM killer_questions WHERE job_id = ?').get(jobId)).n
    : answers.length;

  const id = uuid();
  await db.prepare(`
    INSERT INTO interview_results
      (id, application_id, job_id, call_connected, answers, callback_requested, call_notes, score, passed, coverage_asked, coverage_total, synced_to_ashby)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    id, applicationId, jobId,
    callConnected ? 1 : 0,
    JSON.stringify(answers),
    callbackRequested ? 1 : 0,
    callNotes || null,
    score, passed ? 1 : 0, asked, coverageTotal,
  );

  // Best-effort sync to Ashby custom fields (same pattern as the prescreen score).
  let syncResult = null;
  try {
    const scoreFieldId = process.env.ASHBY_INTERVIEW_SCORE_FIELD_ID;
    const coverageFieldId = process.env.ASHBY_INTERVIEW_COVERAGE_FIELD_ID;
    const objectType = process.env.ASHBY_INTERVIEW_OBJECT_TYPE || 'Application';
    if (!scoreFieldId) {
      console.warn(`[interview] ASHBY_INTERVIEW_SCORE_FIELD_ID not set — stored score ${score} for application ${applicationId} locally, skipped Ashby sync`);
      syncResult = { synced: false, skipped: 'ASHBY_INTERVIEW_SCORE_FIELD_ID not configured' };
    } else {
      await ashby.setCustomFieldScore({ objectId: applicationId, objectType, fieldId: scoreFieldId, value: score });
      if (coverageFieldId) {
        await ashby.setCustomFieldScore({ objectId: applicationId, objectType, fieldId: coverageFieldId, value: `${asked} of ${coverageTotal}` });
      }
      await db.prepare('UPDATE interview_results SET synced_to_ashby = 1 WHERE id = ?').run(id);
      syncResult = { synced: true };
    }
  } catch (err) {
    await db.prepare('UPDATE interview_results SET sync_error = ? WHERE id = ?').run(err.message, id);
    syncResult = { synced: false, error: err.message };
  }

  res.status(201).json({ score, passed, coverage: { asked, total: coverageTotal }, log_id: id, sync: syncResult });
});

// ---------- Phone lookup for the inbound/outbound voice agent ----------
function normalizePhone(p) {
  return (p || '').replace(/\D/g, '');
}
function phoneMatches(a, b) {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  if (!na || !nb) return false;
  const short = na.length <= nb.length ? na : nb;
  const long = na.length <= nb.length ? nb : na;
  return short.length >= 7 && long.endsWith(short);
}

// GET /interview/lookup?phone=...
// Best-effort live match of a caller to a pending application in the Agent
// Interview stage. Returns { matched: false } when nothing is found.
router.get('/interview/lookup', requireInternalKey, async (req, res) => {
  const phone = (req.query.phone || '').trim();
  if (!phone) return res.status(400).json({ error: 'phone is required' });

  const agentStageId = process.env.ASHBY_AGENT_INTERVIEW_STAGE_ID || null;
  const agentStageName = (process.env.ASHBY_AGENT_INTERVIEW_STAGE_NAME || 'Agent Interview').toLowerCase();
  const recordingEnabled = await getRecordingEnabled();

  try {
    const candidates = await ashby.searchCandidatesByPhone(phone);
    for (const cand of candidates) {
      const phones = (cand.phoneNumbers || []).map((p) => (p && (p.value || p.phoneNumber)) || p);
      if (phones.length && !phones.some((pn) => phoneMatches(pn, phone))) continue;

      for (const app of cand.applications || []) {
        const stage = app.currentInterviewStage || {};
        const inAgentStage = agentStageId
          ? stage.id === agentStageId
          : (stage.title || stage.name || '').toLowerCase().includes(agentStageName);
        const active = app.status ? !['Archived', 'Hired'].includes(app.status) : true;
        if (!inAgentStage || !active) continue;

        const localJob = await localJobForApp(app);
        const questions = localJob
          ? await db.prepare('SELECT id, question AS text, weight FROM killer_questions WHERE job_id = ? ORDER BY created_at').all(localJob.id)
          : [];
        return res.json({
          matched: true,
          applicationId: app.id,
          jobId: localJob ? localJob.id : null,
          candidateName: cand.name || null,
          jobTitle: (app.job && app.job.title) || (localJob && localJob.name) || null,
          companyName: (app.job && app.job.department && app.job.department.name) || cand.company || null,
          candidateLanguage: cand.primaryLanguage || cand.language || null,
          recordingEnabled,
          killerQuestions: questions,
        });
      }
    }
    return res.json({ matched: false });
  } catch (err) {
    return res.status(502).json({ matched: false, error: err.message });
  }
});

// ================= HISTORY (recruiter-facing, read-only) =================
function extractRationale(breakdown) {
  if (!breakdown) return null;
  if (typeof breakdown === 'string') return breakdown;
  return breakdown.rationale || breakdown.reason || null;
}

// GET /history — list of applications that have any evaluation, most recent first.
router.get('/history', async (req, res) => {
  const prescreens = await db.prepare(`
    SELECT ashby_application_id AS application_id, job_id, score, status, created_at
    FROM score_log
    WHERE ashby_application_id IS NOT NULL
    ORDER BY created_at DESC LIMIT 500
  `).all();
  const interviews = await db.prepare(`
    SELECT application_id, job_id, score, passed, coverage_asked, coverage_total, created_at
    FROM interview_results
    ORDER BY created_at DESC LIMIT 500
  `).all();

  const byApp = new Map();
  const ensure = (appId) => {
    if (!byApp.has(appId)) {
      byApp.set(appId, { application_id: appId, job_id: null, prescreen: null, interview: null, last_activity: null });
    }
    return byApp.get(appId);
  };
  for (const p of prescreens) {
    const e = ensure(p.application_id);
    if (!e.prescreen) e.prescreen = { score: p.score, status: p.status, date: p.created_at };
    e.job_id = e.job_id || p.job_id;
    if (!e.last_activity || p.created_at > e.last_activity) e.last_activity = p.created_at;
  }
  for (const iv of interviews) {
    const e = ensure(iv.application_id);
    if (!e.interview) {
      e.interview = {
        score: iv.score, passed: !!iv.passed,
        coverage: { asked: iv.coverage_asked, total: iv.coverage_total }, date: iv.created_at,
      };
    }
    e.job_id = e.job_id || iv.job_id;
    if (!e.last_activity || iv.created_at > e.last_activity) e.last_activity = iv.created_at;
  }

  const jobName = Object.fromEntries((await db.prepare('SELECT id, name FROM jobs').all()).map((j) => [j.id, j.name]));
  const list = [...byApp.values()]
    .map((e) => ({ ...e, job_name: e.job_id ? (jobName[e.job_id] || null) : null }))
    .sort((a, b) => (b.last_activity || '').localeCompare(a.last_activity || ''));
  res.json(list);
});

// GET /applications/:applicationId/history — full detail for one application.
router.get('/applications/:applicationId/history', async (req, res) => {
  const applicationId = req.params.applicationId;
  const prescreen = await db.prepare(`
    SELECT job_id, ashby_candidate_id, score, status, breakdown, created_at
    FROM score_log WHERE ashby_application_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(applicationId);
  const interview = await db.prepare(`
    SELECT job_id, call_connected, answers, callback_requested, call_notes, score, passed, coverage_asked, coverage_total, created_at
    FROM interview_results WHERE application_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(applicationId);
  const stateRow = await db.prepare('SELECT attempts, stage_entered_at FROM interview_state WHERE application_id = ?').get(applicationId);

  const jobId = (interview && interview.job_id) || (prescreen && prescreen.job_id) || null;
  const job = jobId ? await db.prepare('SELECT id, name FROM jobs WHERE id = ?').get(jobId) : null;
  const questions = jobId
    ? await db.prepare('SELECT id, question AS text, weight, expected_answer FROM killer_questions WHERE job_id = ? ORDER BY created_at').all(jobId)
    : [];

  let answers = [];
  if (interview && interview.answers) {
    try { answers = JSON.parse(interview.answers) || []; } catch { answers = []; }
  }
  const answerByQ = Object.fromEntries(answers.map((a) => [a.question_id, a.answer]));
  const questionResults = questions.map((q) => ({
    id: q.id, text: q.text, weight: q.weight,
    expected_answer: q.expected_answer === null || q.expected_answer === undefined ? true : !!q.expected_answer,
    answer: q.id in answerByQ ? answerByQ[q.id] : null,
  }));
  // Preserve answers whose question was deleted after the call (expected unknown).
  for (const a of answers) {
    if (!questions.some((q) => q.id === a.question_id)) {
      questionResults.push({ id: a.question_id, text: '(question removed)', weight: null, expected_answer: null, answer: a.answer });
    }
  }

  let breakdown = null;
  if (prescreen && prescreen.breakdown) {
    try { breakdown = JSON.parse(prescreen.breakdown); } catch { breakdown = prescreen.breakdown; }
  }

  res.json({
    application_id: applicationId,
    job: job ? { id: job.id, name: job.name } : null,
    candidate_id: prescreen ? prescreen.ashby_candidate_id : null,
    attempts: stateRow ? stateRow.attempts : 0,
    stage_entered_at: stateRow ? stateRow.stage_entered_at : null,
    prescreen: prescreen ? {
      score: prescreen.score,
      status: prescreen.status,
      rationale: extractRationale(breakdown),
      breakdown,
      date: prescreen.created_at,
    } : null,
    interview: interview ? {
      score: interview.score,
      passed: !!interview.passed,
      call_connected: !!interview.call_connected,
      callback_requested: !!interview.callback_requested,
      call_notes: interview.call_notes,
      coverage: { asked: interview.coverage_asked, total: interview.coverage_total },
      date: interview.created_at,
    } : null,
    questions: questionResults,
  });
});

// ================= ANALYTICS (recruiter-facing, read-only) =================
// GET /analytics/funnel?job=<jobId>  (omit job for all jobs)
// Aggregates the funnel + secondary metrics from data this app already stores:
// prescreen results (score_log) and Agent Interview results (interview_results /
// interview_state). Later Ashby stages (Recruiter Interview / Hired / Archived)
// are not synced back into this DB, so they're not part of the funnel.
router.get('/analytics/funnel', async (req, res) => {
  const jobFilter = (req.query.job || '').trim() || null;
  const threshold = await getPassThreshold();

  // Latest prescreen per application.
  const prescreens = await db.prepare(`
    SELECT ashby_application_id AS app, job_id, score, created_at
    FROM score_log WHERE ashby_application_id IS NOT NULL
    ORDER BY created_at DESC
  `).all();
  // Latest interview per application.
  const interviews = await db.prepare(`
    SELECT application_id AS app, job_id, score, passed, created_at
    FROM interview_results ORDER BY created_at DESC
  `).all();
  const states = await db.prepare('SELECT application_id AS app, job_id, attempts FROM interview_state').all();

  // Build one aggregate row per application (latest values win).
  const apps = new Map();
  const ensure = (app) => {
    if (!apps.has(app)) apps.set(app, { job_id: null, prescreenScore: null, reached: false, interviewPassed: null, interviewScore: null, attempts: null });
    return apps.get(app);
  };
  for (const p of prescreens) { const e = ensure(p.app); if (e.prescreenScore === null) e.prescreenScore = p.score; e.job_id = e.job_id || p.job_id; }
  for (const iv of interviews) { const e = ensure(iv.app); e.reached = true; if (e.interviewPassed === null) { e.interviewPassed = !!iv.passed; e.interviewScore = iv.score; } e.job_id = e.job_id || iv.job_id; }
  for (const s of states) { const e = ensure(s.app); e.reached = true; if (e.attempts === null) e.attempts = s.attempts; e.job_id = e.job_id || s.job_id; }

  const all = [...apps.values()];
  const rows = jobFilter ? all.filter((a) => a.job_id === jobFilter) : all;

  const avg = (nums) => (nums.length ? Math.round((nums.reduce((s, n) => s + n, 0) / nums.length) * 100) / 100 : null);
  const rate = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null); // one decimal %

  function funnelFor(list) {
    const applied = list.length;
    const withPrescreen = list.filter((a) => a.prescreenScore !== null);
    const prescreenPassed = withPrescreen.filter((a) => a.prescreenScore >= threshold).length;
    const reached = list.filter((a) => a.reached).length;
    const interviewPassed = list.filter((a) => a.interviewPassed === true).length;
    return {
      stages: [
        { key: 'applied', label: 'Applied', count: applied },
        { key: 'prescreen_passed', label: `Prescreen passed (≥ ${threshold})`, count: prescreenPassed, conversion: rate(prescreenPassed, applied) },
        { key: 'interview_reached', label: 'Agent Interview reached', count: reached, conversion: rate(reached, prescreenPassed) },
        { key: 'interview_passed', label: 'Agent Interview passed', count: interviewPassed, conversion: rate(interviewPassed, reached) },
      ],
      metrics: {
        avg_prescreen_score: avg(withPrescreen.map((a) => a.prescreenScore)),
        avg_interview_score: avg(list.filter((a) => a.interviewScore !== null).map((a) => a.interviewScore)),
        avg_attempts: avg(list.filter((a) => a.attempts !== null).map((a) => a.attempts)),
        prescreen_pass_rate: rate(prescreenPassed, withPrescreen.length),
        interview_pass_rate: rate(interviewPassed, reached),
      },
    };
  }

  const jobName = Object.fromEntries((await db.prepare('SELECT id, name FROM jobs').all()).map((j) => [j.id, j.name]));
  const main = funnelFor(rows);

  // Per-job pass-rate breakdown (only for the all-jobs view).
  let byJob = null;
  if (!jobFilter) {
    const groups = new Map();
    for (const a of all) {
      const key = a.job_id || '__none__';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }
    byJob = [...groups.entries()].map(([jid, list]) => {
      const f = funnelFor(list);
      return {
        job_id: jid === '__none__' ? null : jid,
        job_name: jid === '__none__' ? '(no job)' : (jobName[jid] || '(unknown)'),
        applied: list.length,
        prescreen_pass_rate: f.metrics.prescreen_pass_rate,
        interview_pass_rate: f.metrics.interview_pass_rate,
      };
    }).sort((a, b) => b.applied - a.applied);
  }

  res.json({
    job: jobFilter ? { id: jobFilter, name: jobName[jobFilter] || '(unknown)' } : null,
    threshold,
    stages: main.stages,
    metrics: main.metrics,
    by_job: byJob,
  });
});

// ================= RECRUITERS =================
// Mirrors the Screening Criteria folder pattern: recruiter_jobs are folders
// (one per job title) and recruiters are the contact entries inside them.
// Persisted in the same SQLite DB as jobs/parameters (see db/index.js).

function isValidEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}
function isValidUrl(s) {
  if (typeof s !== 'string') return false;
  try {
    const u = new URL(s.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// ---------- Recruiter folders (one per job title) ----------
router.get('/recruiter-jobs', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM recruiter_jobs ORDER BY created_at DESC').all();
  res.json(rows);
});

router.post('/recruiter-jobs', async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const id = uuid();
  await db.prepare('INSERT INTO recruiter_jobs (id, name) VALUES (?, ?)').run(id, name.trim());
  res.status(201).json(await db.prepare('SELECT * FROM recruiter_jobs WHERE id = ?').get(id));
});

router.put('/recruiter-jobs/:id', async (req, res) => {
  const { name } = req.body;
  const job = await db.prepare('SELECT * FROM recruiter_jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'recruiter job not found' });
  if (name !== undefined && (!name || !name.trim())) return res.status(400).json({ error: 'name cannot be empty' });
  await db.prepare('UPDATE recruiter_jobs SET name = COALESCE(?, name) WHERE id = ?')
    .run(name ? name.trim() : null, req.params.id);
  res.json(await db.prepare('SELECT * FROM recruiter_jobs WHERE id = ?').get(req.params.id));
});

router.delete('/recruiter-jobs/:id', async (req, res) => {
  await db.prepare('DELETE FROM recruiter_jobs WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// ---------- Recruiter entries (per folder) ----------
router.get('/recruiter-jobs/:jobId/recruiters', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM recruiters WHERE recruiter_job_id = ? ORDER BY created_at').all(req.params.jobId);
  res.json(rows);
});

router.post('/recruiter-jobs/:jobId/recruiters', async (req, res) => {
  const job = await db.prepare('SELECT * FROM recruiter_jobs WHERE id = ?').get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'recruiter job not found' });
  const { name, email, calendar_link, notes } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  if (!isValidEmail(email)) return res.status(400).json({ error: 'a valid email is required' });
  if (!isValidUrl(calendar_link)) return res.status(400).json({ error: 'calendar_link must be a valid URL' });
  const id = uuid();
  await db.prepare('INSERT INTO recruiters (id, recruiter_job_id, name, email, calendar_link, notes) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, req.params.jobId, name.trim(), email.trim(), calendar_link.trim(), (notes || '').trim() || null);
  res.status(201).json(await db.prepare('SELECT * FROM recruiters WHERE id = ?').get(id));
});

router.put('/recruiters/:id', async (req, res) => {
  const existing = await db.prepare('SELECT * FROM recruiters WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'recruiter not found' });
  const { name, email, calendar_link, notes } = req.body;
  if (name !== undefined && (!name || !name.trim())) return res.status(400).json({ error: 'name cannot be empty' });
  if (email !== undefined && !isValidEmail(email)) return res.status(400).json({ error: 'a valid email is required' });
  if (calendar_link !== undefined && !isValidUrl(calendar_link)) return res.status(400).json({ error: 'calendar_link must be a valid URL' });
  await db.prepare(`
    UPDATE recruiters SET
      name = COALESCE(?, name),
      email = COALESCE(?, email),
      calendar_link = COALESCE(?, calendar_link),
      notes = ?
    WHERE id = ?
  `).run(
    name ? name.trim() : null,
    email ? email.trim() : null,
    calendar_link ? calendar_link.trim() : null,
    notes !== undefined ? ((notes || '').trim() || null) : existing.notes,
    req.params.id,
  );
  res.json(await db.prepare('SELECT * FROM recruiters WHERE id = ?').get(req.params.id));
});

router.delete('/recruiters/:id', async (req, res) => {
  await db.prepare('DELETE FROM recruiters WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// ---------- EXTERNAL: primary recruiter contact per job title ----------
// GET /api/recruiters?job={job_title}
// Consumed by an external automation (polled ~every 15 min). Returns the
// primary (first-added) recruiter for the job. Job title matching is
// case-insensitive and trimmed. Always responds 200 with a `found` flag —
// response shape is stable, do not change:
//   found: { "found": true, "recruiterName": string, "recruiterEmail": string, "calendarLink": string }
//   none:  { "found": false }
// 400 { error } only when the `job` query parameter is missing/empty.
router.get('/recruiters', requireInternalKey, async (req, res) => {
  const job = (req.query.job || '').trim();
  if (!job) return res.status(400).json({ error: 'job query parameter is required' });

  const folder = await db.prepare('SELECT id FROM recruiter_jobs WHERE lower(trim(name)) = lower(?)').get(job);
  const recruiter = folder && await db.prepare(
    'SELECT name, email, calendar_link FROM recruiters WHERE recruiter_job_id = ? ORDER BY created_at ASC LIMIT 1'
  ).get(folder.id);
  if (!recruiter) return res.json({ found: false });

  res.json({
    found: true,
    recruiterName: recruiter.name,
    recruiterEmail: recruiter.email,
    calendarLink: recruiter.calendar_link,
  });
});

// ================= SETTINGS =================
// Runtime-editable settings + read-only integration status for the Settings
// page. Like the rest of the recruiter UI, GET/PUT are ungated (this app has no
// user login). Secrets are never returned in full: the internal API key is
// masked server-side and the full value never leaves the process.

function maskSecret(value) {
  if (!value) return null;
  if (value.length <= 8) return '•'.repeat(value.length);
  return `${value.slice(0, 4)}${'•'.repeat(Math.max(4, value.length - 8))}${value.slice(-4)}`;
}

// The only real credentials the app reads (audited from the codebase): the
// x-api-key HappyRobot workflows must send, and the Ashby API key for the app's
// own Ashby integration. Everything else in env is non-secret config (field
// ids, object types, stage names). The raw value is NEVER included in the
// /settings payload — only a masked form; the raw is fetched on explicit reveal.
const SECRETS = [
  {
    key: 'internal_api_key',
    label: 'Internal API key',
    hint: 'Sent by HappyRobot workflow nodes as the x-api-key header on Prescreen / Agent Interview / Job Info calls.',
    env: 'INTERNAL_API_KEY',
  },
  {
    key: 'jobbot_api_key',
    label: 'JobBot API key (read-only)',
    hint: 'Sent by the external JobBot agent as x-api-key on the read-only /api/jobbot/* job-facts lookups. Separate from the internal key to limit blast radius.',
    env: 'JOBBOT_API_KEY',
  },
  {
    key: 'unanswered_questions_api_key',
    label: 'Unanswered-questions API key (write-only)',
    hint: 'Least-privilege key JobBot sends as x-api-key when reporting questions it could not answer (POST /api/jobbot/unanswered-questions). Can only create those rows — no reads, no other writes.',
    env: 'UNANSWERED_QUESTIONS_API_KEY',
  },
  {
    key: 'ashby_api_key',
    label: 'Ashby API key',
    hint: "Used for the app's own Ashby integration — syncing scores and candidate lookups.",
    env: 'ASHBY_API_KEY',
  },
  {
    key: 'ashby_sync_api_key',
    label: 'Ashby sync API key',
    hint: 'Sent by the Ashby→dashboard sync workflow as x-api-key on POST /api/sync/ashby-job. Can create/update job folders and their Job Info facts, but not scoring/interview data — its own key to limit blast radius.',
    env: 'ASHBY_SYNC_API_KEY',
  },
];

// GET /settings — current values + integration status (no live network calls,
// no raw secrets: each secret is reported as configured + masked only).
router.get('/settings', async (req, res) => {
  res.json({
    pass_threshold: await getPassThreshold(),
    max_call_attempts: await getMaxCallAttempts(),
    call_recording_enabled: await getRecordingEnabled(),
    ashby: {
      configured: !!process.env.ASHBY_API_KEY,
      object_type: process.env.ASHBY_INTERVIEW_OBJECT_TYPE || 'Application',
      interview_score_field_id: process.env.ASHBY_INTERVIEW_SCORE_FIELD_ID || null,
      questions_asked_field_id: process.env.ASHBY_INTERVIEW_COVERAGE_FIELD_ID || null,
    },
    secrets: SECRETS.map((s) => {
      const value = process.env[s.env] || '';
      return { key: s.key, label: s.label, hint: s.hint, configured: !!value, masked: maskSecret(value) };
    }),
  });
});

// GET /settings/secrets/:key — reveal the raw value of a single secret. Called
// only when the recruiter explicitly clicks "Reveal", so the raw value is never
// part of the initial page payload. Ungated like the rest of the browser API
// (this internal tool has no user login); returns null when not configured.
router.get('/settings/secrets/:key', (req, res) => {
  const secret = SECRETS.find((s) => s.key === req.params.key);
  if (!secret) return res.status(404).json({ error: 'unknown secret' });
  const value = process.env[secret.env] || '';
  res.json({ key: secret.key, configured: !!value, value: value || null });
});

// GET /settings/ashby-status — best-effort live connectivity check (own call so
// the Settings page can render instantly and load this asynchronously).
router.get('/settings/ashby-status', async (req, res) => {
  if (!process.env.ASHBY_API_KEY) {
    return res.json({ configured: false, connected: false, error: 'ASHBY_API_KEY is not set' });
  }
  try {
    await ashby.listJobs();
    res.json({ configured: true, connected: true, error: null });
  } catch (err) {
    res.json({ configured: true, connected: false, error: err.message });
  }
});

// PUT /settings — update editable settings; validates each field.
router.put('/settings', async (req, res) => {
  const { pass_threshold, max_call_attempts, call_recording_enabled } = req.body || {};

  if (pass_threshold !== undefined) {
    const n = Number(pass_threshold);
    if (!Number.isFinite(n) || n < 0 || n > 10) {
      return res.status(400).json({ error: 'pass_threshold must be a number between 0 and 10' });
    }
    await setSetting('pass_threshold', n);
  }
  if (max_call_attempts !== undefined) {
    const n = Number(max_call_attempts);
    if (!Number.isInteger(n) || n < 1) {
      return res.status(400).json({ error: 'max_call_attempts must be an integer of at least 1' });
    }
    await setSetting('max_call_attempts', n);
  }
  if (call_recording_enabled !== undefined) {
    await setSetting('call_recording_enabled', call_recording_enabled ? '1' : '0');
  }

  res.json({
    pass_threshold: await getPassThreshold(),
    max_call_attempts: await getMaxCallAttempts(),
    call_recording_enabled: await getRecordingEnabled(),
  });
});

module.exports = router;
