const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db');
const ashby = require('./ashby');

const router = express.Router();

// ---------- Middleware: proteger endpoints que llaman workflows externos (Happy Robot) ----------
function requireInternalKey(req, res, next) {
  const configured = process.env.INTERNAL_API_KEY;
  if (!configured) return next(); // si no se configuró, no bloqueamos (modo dev)
  const provided = req.header('x-api-key');
  if (provided !== configured) {
    return res.status(401).json({ error: 'x-api-key inválida o ausente' });
  }
  next();
}

// ---------- JOBS (carpetas) ----------
router.get('/jobs', (req, res) => {
  const jobs = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all();
  res.json(jobs);
});

router.post('/jobs', (req, res) => {
  const { name, ashby_job_id } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name es obligatorio' });
  const id = uuid();
  db.prepare('INSERT INTO jobs (id, name, ashby_job_id) VALUES (?, ?, ?)').run(id, name.trim(), ashby_job_id || null);
  res.status(201).json(db.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
});

router.put('/jobs/:id', (req, res) => {
  const { name, ashby_job_id } = req.body;
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'puesto no encontrado' });
  db.prepare('UPDATE jobs SET name = COALESCE(?, name), ashby_job_id = COALESCE(?, ashby_job_id) WHERE id = ?')
    .run(name || null, ashby_job_id || null, req.params.id);
  res.json(db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id));
});

router.delete('/jobs/:id', (req, res) => {
  db.prepare('DELETE FROM jobs WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// ---------- PARÁMETROS (generales si :jobId === 'general', o por puesto) ----------
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
  if (!name || !name.trim()) return res.status(400).json({ error: 'name es obligatorio' });
  const w = Number(weight);
  if (Number.isNaN(w) || w < 0 || w > 10) return res.status(400).json({ error: 'weight debe estar entre 0 y 10' });
  const id = uuid();
  db.prepare('INSERT INTO parameters (id, job_id, name, weight, added_by) VALUES (?, ?, ?, ?, ?)')
    .run(id, jobId, name.trim(), w, added_by || null);
  res.status(201).json(db.prepare('SELECT * FROM parameters WHERE id = ?').get(id));
});

router.put('/parameters/:id', (req, res) => {
  const { name, weight } = req.body;
  const existing = db.prepare('SELECT * FROM parameters WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'parámetro no encontrado' });
  const w = weight !== undefined ? Number(weight) : existing.weight;
  if (Number.isNaN(w) || w < 0 || w > 10) return res.status(400).json({ error: 'weight debe estar entre 0 y 10' });
  db.prepare('UPDATE parameters SET name = COALESCE(?, name), weight = ? WHERE id = ?')
    .run(name || null, w, req.params.id);
  res.json(db.prepare('SELECT * FROM parameters WHERE id = ?').get(req.params.id));
});

router.delete('/parameters/:id', (req, res) => {
  db.prepare('DELETE FROM parameters WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// ---------- KILLER QUESTIONS (por puesto) ----------
router.get('/jobs/:jobId/killer-questions', (req, res) => {
  const rows = db.prepare('SELECT * FROM killer_questions WHERE job_id = ? ORDER BY created_at').all(req.params.jobId);
  res.json(rows);
});

router.post('/jobs/:jobId/killer-questions', (req, res) => {
  const { question, added_by } = req.body;
  if (!question || !question.trim()) return res.status(400).json({ error: 'question es obligatorio' });
  const id = uuid();
  db.prepare('INSERT INTO killer_questions (id, job_id, question, added_by) VALUES (?, ?, ?, ?)')
    .run(id, req.params.jobId, question.trim(), added_by || null);
  res.status(201).json(db.prepare('SELECT * FROM killer_questions WHERE id = ?').get(id));
});

router.delete('/killer-questions/:id', (req, res) => {
  db.prepare('DELETE FROM killer_questions WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// ---------- CONFIG CONSOLIDADA: la que consume Happy Robot para evaluar a un candidato ----------
router.get('/jobs/:jobId/evaluation-config', requireInternalKey, (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'puesto no encontrado' });

  const generalParams = db.prepare('SELECT name, weight, added_by FROM parameters WHERE job_id IS NULL').all();
  const jobParams = db.prepare('SELECT name, weight, added_by FROM parameters WHERE job_id = ?').all(job.id);
  const killerQuestions = db.prepare('SELECT question, added_by FROM killer_questions WHERE job_id = ?').all(job.id);

  res.json({
    job: { id: job.id, name: job.name, ashby_job_id: job.ashby_job_id },
    general_parameters: generalParams,
    job_parameters: jobParams,
    killer_questions: killerQuestions,
  });
});

// ---------- INGESTA DE SCORE (Happy Robot -> esta app -> Ashby) ----------
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
    return res.status(400).json({ error: 'score es obligatorio y debe ser numérico' });
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
      if (!fieldId) throw new Error('ASHBY_SCORE_FIELD_ID no está configurado');
      if (!objectId) throw new Error(`Falta ${objectType === 'Candidate' ? 'ashby_candidate_id' : 'ashby_application_id'} en el request`);

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

module.exports = router;
