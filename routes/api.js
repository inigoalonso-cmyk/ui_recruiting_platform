const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db');
const ashby = require('./ashby');
const { scoreAnswers } = require('./scoring');

const router = express.Router();

// ---------- Runtime settings (editable from the Settings page) ----------
const SETTING_DEFAULTS = { pass_threshold: '8', max_call_attempts: '3', call_recording_enabled: '0' };

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : SETTING_DEFAULTS[key];
}
function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, String(value));
}
function getPassThreshold() {
  const n = Number(getSetting('pass_threshold'));
  return Number.isFinite(n) ? n : 8;
}
function getMaxCallAttempts() {
  const n = parseInt(getSetting('max_call_attempts'), 10);
  return Number.isInteger(n) && n > 0 ? n : 3;
}
function getRecordingEnabled() {
  return getSetting('call_recording_enabled') === '1';
}

// ---------- Middleware: protect endpoints called by external workflows (Happy Robot) ----------
function requireInternalKey(req, res, next) {
  const configured = process.env.INTERNAL_API_KEY;
  if (!configured) return next(); // if not configured, we don't block (dev mode)
  const provided = req.header('x-api-key');
  if (provided !== configured) {
    return res.status(401).json({ error: 'invalid or missing x-api-key' });
  }
  next();
}

// ---------- JOBS (folders) ----------
router.get('/jobs', (req, res) => {
  const jobs = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all();
  res.json(jobs);
});

router.post('/jobs', (req, res) => {
  const { name, ashby_job_id } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const id = uuid();
  db.prepare('INSERT INTO jobs (id, name, ashby_job_id) VALUES (?, ?, ?)').run(id, name.trim(), ashby_job_id || null);
  res.status(201).json(db.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
});

router.put('/jobs/:id', (req, res) => {
  const { name, ashby_job_id } = req.body;
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  db.prepare('UPDATE jobs SET name = COALESCE(?, name), ashby_job_id = COALESCE(?, ashby_job_id) WHERE id = ?')
    .run(name || null, ashby_job_id || null, req.params.id);
  res.json(db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id));
});

router.delete('/jobs/:id', (req, res) => {
  db.prepare('DELETE FROM jobs WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// ---------- PARAMETERS (general if :jobId === 'general', or per job) ----------
router.get('/jobs/:jobId/parameters', (req, res) => {
  const jobId = req.params.jobId === 'general' ? null : req.params.jobId;
  const rows = jobId === null
    ? db.prepare('SELECT * FROM parameters WHERE job_id IS NULL ORDER BY created_at').all()
    : db.prepare('SELECT * FROM parameters WHERE job_id = ? ORDER BY created_at').all(jobId);
  res.json(rows);
});

router.post('/jobs/:jobId/parameters', (req, res) => {
  const jobId = req.params.jobId === 'general' ? null : req.params.jobId;
  const { name, weight, added_by } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const w = Number(weight);
  if (Number.isNaN(w) || w < 0) return res.status(400).json({ error: 'weight must be a non-negative number' });
  const id = uuid();
  db.prepare('INSERT INTO parameters (id, job_id, name, weight, added_by) VALUES (?, ?, ?, ?, ?)')
    .run(id, jobId, name.trim(), w, added_by || null);
  res.status(201).json(db.prepare('SELECT * FROM parameters WHERE id = ?').get(id));
});

router.put('/parameters/:id', (req, res) => {
  const { name, weight } = req.body;
  const existing = db.prepare('SELECT * FROM parameters WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'parameter not found' });
  const w = weight !== undefined ? Number(weight) : existing.weight;
  if (Number.isNaN(w) || w < 0) return res.status(400).json({ error: 'weight must be a non-negative number' });
  db.prepare('UPDATE parameters SET name = COALESCE(?, name), weight = ? WHERE id = ?')
    .run(name || null, w, req.params.id);
  res.json(db.prepare('SELECT * FROM parameters WHERE id = ?').get(req.params.id));
});

router.delete('/parameters/:id', (req, res) => {
  db.prepare('DELETE FROM parameters WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// ---------- KILLER QUESTIONS (per job) ----------
router.get('/jobs/:jobId/killer-questions', (req, res) => {
  const rows = db.prepare('SELECT * FROM killer_questions WHERE job_id = ? ORDER BY created_at').all(req.params.jobId);
  res.json(rows);
});

// Coerce a variety of truthy/falsy JSON shapes into 1/0 (defaulting to true).
function toExpected(v) {
  if (v === undefined || v === null || v === '') return 1;
  if (v === true || v === 1 || v === '1' || v === 'true') return 1;
  if (v === false || v === 0 || v === '0' || v === 'false') return 0;
  return 1;
}

router.post('/jobs/:jobId/killer-questions', (req, res) => {
  const { question, added_by, weight, expected_answer } = req.body;
  if (!question || !question.trim()) return res.status(400).json({ error: 'question is required' });
  // weight is optional (defaults to 1); the interview phase uses it for a
  // weighted score, but recruiters don't have to set it.
  const w = weight === undefined || weight === null || weight === '' ? 1 : Number(weight);
  if (Number.isNaN(w) || w < 0) return res.status(400).json({ error: 'weight must be a non-negative number' });
  const expected = toExpected(expected_answer); // defaults to 1 (true)
  const id = uuid();
  db.prepare('INSERT INTO killer_questions (id, job_id, question, weight, expected_answer, added_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, req.params.jobId, question.trim(), w, expected, added_by || null);
  res.status(201).json(db.prepare('SELECT * FROM killer_questions WHERE id = ?').get(id));
});

router.put('/killer-questions/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM killer_questions WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'killer question not found' });
  const { question, added_by, weight, expected_answer } = req.body;
  if (question !== undefined && !question.trim()) return res.status(400).json({ error: 'question cannot be empty' });
  const w = weight === undefined || weight === null || weight === '' ? existing.weight : Number(weight);
  if (Number.isNaN(w) || w < 0) return res.status(400).json({ error: 'weight must be a non-negative number' });
  const expected = expected_answer === undefined ? existing.expected_answer : toExpected(expected_answer);
  db.prepare(`
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
  res.json(db.prepare('SELECT * FROM killer_questions WHERE id = ?').get(req.params.id));
});

router.delete('/killer-questions/:id', (req, res) => {
  db.prepare('DELETE FROM killer_questions WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// ---------- CONSOLIDATED CONFIG: what Happy Robot consumes to evaluate a candidate ----------
router.get('/jobs/:jobId/evaluation-config', requireInternalKey, (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });

  const generalParams = db.prepare('SELECT name, weight, added_by FROM parameters WHERE job_id IS NULL').all();
  const jobParams = db.prepare('SELECT name, weight, added_by FROM parameters WHERE job_id = ?').all(job.id);
  const killerQuestions = db.prepare('SELECT question, added_by FROM killer_questions WHERE job_id = ?').all(job.id);

  // Weights are relative importance, not a fixed /10 scale. Normalize each
  // criterion by the total across all parameters that apply to this job
  // (general + job-specific) so effective_weight is its proportion of the
  // final score and the set sums to 1. Consumers should use effective_weight.
  const weightTotal = [...generalParams, ...jobParams].reduce((sum, p) => sum + p.weight, 0);
  const withEffective = (p) => ({
    ...p,
    effective_weight: weightTotal > 0 ? p.weight / weightTotal : 0,
  });

  res.json({
    job: { id: job.id, name: job.name, ashby_job_id: job.ashby_job_id },
    weight_total: weightTotal,
    general_parameters: generalParams.map(withEffective),
    job_parameters: jobParams.map(withEffective),
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
  db.prepare(`
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
      db.prepare('UPDATE score_log SET synced_to_ashby = 1 WHERE id = ?').run(id);
      syncResult = { synced: true };
    } catch (err) {
      db.prepare('UPDATE score_log SET sync_error = ? WHERE id = ?').run(err.message, id);
      syncResult = { synced: false, error: err.message };
    }
  }

  res.status(201).json({ log_id: id, sync: syncResult });
});

router.get('/score-log', (req, res) => {
  const rows = db.prepare('SELECT * FROM score_log ORDER BY created_at DESC LIMIT 200').all();
  res.json(rows);
});

// ================= AGENT INTERVIEW (Phase 2) =================
// This backend only scores, stores, and syncs custom fields. It never changes
// the Ashby stage or archives anything — the Happy Robot workflow does that
// based on the `passed` flag returned by POST /interview/results.

function localJobByAshbyJobId(ashbyJobId) {
  if (!ashbyJobId) return null;
  return db.prepare('SELECT * FROM jobs WHERE ashby_job_id = ?').get(ashbyJobId);
}

// Resolve the local job for an application: an explicit hint wins, then a value
// cached from a previous interview interaction, then a live Ashby lookup.
async function resolveJobIdForApplication(applicationId, hintedJobId) {
  if (hintedJobId) {
    const job = db.prepare('SELECT id FROM jobs WHERE id = ?').get(hintedJobId);
    if (job) return job.id;
  }
  const state = db.prepare('SELECT job_id FROM interview_state WHERE application_id = ?').get(applicationId);
  if (state && state.job_id) return state.job_id;
  const info = await ashby.getApplicationInfo(applicationId);
  const app = (info && info.results) || info || {};
  const ashbyJobId = (app.job && app.job.id) || app.jobId || null;
  const job = localJobByAshbyJobId(ashbyJobId);
  return job ? job.id : null;
}

// Upsert interview state. stage_entered_at is only stamped on first insert (our
// fallback for Ashby's native stage-entry time); job_id is backfilled if empty.
function touchInterviewState(applicationId, jobId) {
  db.prepare(`
    INSERT INTO interview_state (application_id, job_id, stage_entered_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(application_id) DO UPDATE SET
      job_id = COALESCE(interview_state.job_id, excluded.job_id)
  `).run(applicationId, jobId || null);
}

// Deterministic weighted score over the questions that were actually asked.
// answers: [{ question_id, answer: true | false | null }]. null = not asked.
// A question passes when its answer matches its expected_answer (see scoring.js).
function computeInterviewScore(answers) {
  const questionMap = {};
  for (const a of answers) {
    if (!(a.question_id in questionMap)) {
      const q = db.prepare('SELECT weight, expected_answer FROM killer_questions WHERE id = ?').get(a.question_id);
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
    touchInterviewState(applicationId, jobId);
    const state = db.prepare('SELECT stage_entered_at FROM interview_state WHERE application_id = ?').get(applicationId);
    const questions = db.prepare('SELECT id, question AS text, weight FROM killer_questions WHERE job_id = ? ORDER BY created_at').all(jobId);
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
router.post('/interview/attempts/:applicationId/increment', requireInternalKey, (req, res) => {
  const row = db.prepare(`
    INSERT INTO interview_state (application_id, attempts, stage_entered_at)
    VALUES (?, 1, datetime('now'))
    ON CONFLICT(application_id) DO UPDATE SET attempts = interview_state.attempts + 1
    RETURNING attempts
  `).get(req.params.applicationId);
  const maxAttempts = getMaxCallAttempts();
  res.json({ attempts: row.attempts, maxAttempts, limitReached: row.attempts >= maxAttempts });
});

// POST /interview/results
// Scores the call server-side, stores the raw payload + result, syncs the
// score and coverage to Ashby, and returns { score, passed }.
router.post('/interview/results', requireInternalKey, async (req, res) => {
  const { applicationId, callConnected, answers, callbackRequested, callNotes } = req.body || {};
  if (!applicationId) return res.status(400).json({ error: 'applicationId is required' });
  if (!Array.isArray(answers)) return res.status(400).json({ error: 'answers must be an array' });

  const { score, asked } = computeInterviewScore(answers);
  const passed = score >= getPassThreshold();

  // Derive the job (for coverage total) from the answered questions, falling
  // back to cached interview state.
  let jobId = null;
  for (const a of answers) {
    const q = db.prepare('SELECT job_id FROM killer_questions WHERE id = ?').get(a.question_id);
    if (q) { jobId = q.job_id; break; }
  }
  if (!jobId) {
    const state = db.prepare('SELECT job_id FROM interview_state WHERE application_id = ?').get(applicationId);
    if (state) jobId = state.job_id;
  }
  const coverageTotal = jobId
    ? db.prepare('SELECT COUNT(*) AS n FROM killer_questions WHERE job_id = ?').get(jobId).n
    : answers.length;

  const id = uuid();
  db.prepare(`
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
      db.prepare('UPDATE interview_results SET synced_to_ashby = 1 WHERE id = ?').run(id);
      syncResult = { synced: true };
    }
  } catch (err) {
    db.prepare('UPDATE interview_results SET sync_error = ? WHERE id = ?').run(err.message, id);
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
  const recordingEnabled = getRecordingEnabled();

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

        const localJob = localJobByAshbyJobId((app.job && app.job.id) || app.jobId);
        const questions = localJob
          ? db.prepare('SELECT id, question AS text, weight FROM killer_questions WHERE job_id = ? ORDER BY created_at').all(localJob.id)
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
router.get('/history', (req, res) => {
  const prescreens = db.prepare(`
    SELECT ashby_application_id AS application_id, job_id, score, status, created_at
    FROM score_log
    WHERE ashby_application_id IS NOT NULL
    ORDER BY created_at DESC LIMIT 500
  `).all();
  const interviews = db.prepare(`
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

  const jobName = Object.fromEntries(db.prepare('SELECT id, name FROM jobs').all().map((j) => [j.id, j.name]));
  const list = [...byApp.values()]
    .map((e) => ({ ...e, job_name: e.job_id ? (jobName[e.job_id] || null) : null }))
    .sort((a, b) => (b.last_activity || '').localeCompare(a.last_activity || ''));
  res.json(list);
});

// GET /applications/:applicationId/history — full detail for one application.
router.get('/applications/:applicationId/history', (req, res) => {
  const applicationId = req.params.applicationId;
  const prescreen = db.prepare(`
    SELECT job_id, ashby_candidate_id, score, status, breakdown, created_at
    FROM score_log WHERE ashby_application_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(applicationId);
  const interview = db.prepare(`
    SELECT job_id, call_connected, answers, callback_requested, call_notes, score, passed, coverage_asked, coverage_total, created_at
    FROM interview_results WHERE application_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(applicationId);
  const stateRow = db.prepare('SELECT attempts, stage_entered_at FROM interview_state WHERE application_id = ?').get(applicationId);

  const jobId = (interview && interview.job_id) || (prescreen && prescreen.job_id) || null;
  const job = jobId ? db.prepare('SELECT id, name FROM jobs WHERE id = ?').get(jobId) : null;
  const questions = jobId
    ? db.prepare('SELECT id, question AS text, weight, expected_answer FROM killer_questions WHERE job_id = ? ORDER BY created_at').all(jobId)
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
router.get('/recruiter-jobs', (req, res) => {
  const rows = db.prepare('SELECT * FROM recruiter_jobs ORDER BY created_at DESC').all();
  res.json(rows);
});

router.post('/recruiter-jobs', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const id = uuid();
  db.prepare('INSERT INTO recruiter_jobs (id, name) VALUES (?, ?)').run(id, name.trim());
  res.status(201).json(db.prepare('SELECT * FROM recruiter_jobs WHERE id = ?').get(id));
});

router.put('/recruiter-jobs/:id', (req, res) => {
  const { name } = req.body;
  const job = db.prepare('SELECT * FROM recruiter_jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'recruiter job not found' });
  if (name !== undefined && (!name || !name.trim())) return res.status(400).json({ error: 'name cannot be empty' });
  db.prepare('UPDATE recruiter_jobs SET name = COALESCE(?, name) WHERE id = ?')
    .run(name ? name.trim() : null, req.params.id);
  res.json(db.prepare('SELECT * FROM recruiter_jobs WHERE id = ?').get(req.params.id));
});

router.delete('/recruiter-jobs/:id', (req, res) => {
  db.prepare('DELETE FROM recruiter_jobs WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// ---------- Recruiter entries (per folder) ----------
router.get('/recruiter-jobs/:jobId/recruiters', (req, res) => {
  const rows = db.prepare('SELECT * FROM recruiters WHERE recruiter_job_id = ? ORDER BY created_at').all(req.params.jobId);
  res.json(rows);
});

router.post('/recruiter-jobs/:jobId/recruiters', (req, res) => {
  const job = db.prepare('SELECT * FROM recruiter_jobs WHERE id = ?').get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'recruiter job not found' });
  const { name, email, calendar_link, notes } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  if (!isValidEmail(email)) return res.status(400).json({ error: 'a valid email is required' });
  if (!isValidUrl(calendar_link)) return res.status(400).json({ error: 'calendar_link must be a valid URL' });
  const id = uuid();
  db.prepare('INSERT INTO recruiters (id, recruiter_job_id, name, email, calendar_link, notes) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, req.params.jobId, name.trim(), email.trim(), calendar_link.trim(), (notes || '').trim() || null);
  res.status(201).json(db.prepare('SELECT * FROM recruiters WHERE id = ?').get(id));
});

router.put('/recruiters/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM recruiters WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'recruiter not found' });
  const { name, email, calendar_link, notes } = req.body;
  if (name !== undefined && (!name || !name.trim())) return res.status(400).json({ error: 'name cannot be empty' });
  if (email !== undefined && !isValidEmail(email)) return res.status(400).json({ error: 'a valid email is required' });
  if (calendar_link !== undefined && !isValidUrl(calendar_link)) return res.status(400).json({ error: 'calendar_link must be a valid URL' });
  db.prepare(`
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
  res.json(db.prepare('SELECT * FROM recruiters WHERE id = ?').get(req.params.id));
});

router.delete('/recruiters/:id', (req, res) => {
  db.prepare('DELETE FROM recruiters WHERE id = ?').run(req.params.id);
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
router.get('/recruiters', requireInternalKey, (req, res) => {
  const job = (req.query.job || '').trim();
  if (!job) return res.status(400).json({ error: 'job query parameter is required' });

  const folder = db.prepare('SELECT id FROM recruiter_jobs WHERE lower(trim(name)) = lower(?)').get(job);
  const recruiter = folder && db.prepare(
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

// GET /settings — current values + integration status (no live network calls).
router.get('/settings', (req, res) => {
  const internalKey = process.env.INTERNAL_API_KEY || '';
  res.json({
    pass_threshold: getPassThreshold(),
    max_call_attempts: getMaxCallAttempts(),
    call_recording_enabled: getRecordingEnabled(),
    ashby: {
      configured: !!process.env.ASHBY_API_KEY,
      object_type: process.env.ASHBY_INTERVIEW_OBJECT_TYPE || 'Application',
      interview_score_field_id: process.env.ASHBY_INTERVIEW_SCORE_FIELD_ID || null,
      questions_asked_field_id: process.env.ASHBY_INTERVIEW_COVERAGE_FIELD_ID || null,
    },
    internal_api_key: {
      configured: !!internalKey,
      masked: maskSecret(internalKey),
    },
  });
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
router.put('/settings', (req, res) => {
  const { pass_threshold, max_call_attempts, call_recording_enabled } = req.body || {};

  if (pass_threshold !== undefined) {
    const n = Number(pass_threshold);
    if (!Number.isFinite(n) || n < 0 || n > 10) {
      return res.status(400).json({ error: 'pass_threshold must be a number between 0 and 10' });
    }
    setSetting('pass_threshold', n);
  }
  if (max_call_attempts !== undefined) {
    const n = Number(max_call_attempts);
    if (!Number.isInteger(n) || n < 1) {
      return res.status(400).json({ error: 'max_call_attempts must be an integer of at least 1' });
    }
    setSetting('max_call_attempts', n);
  }
  if (call_recording_enabled !== undefined) {
    setSetting('call_recording_enabled', call_recording_enabled ? '1' : '0');
  }

  res.json({
    pass_threshold: getPassThreshold(),
    max_call_attempts: getMaxCallAttempts(),
    call_recording_enabled: getRecordingEnabled(),
  });
});

module.exports = router;
