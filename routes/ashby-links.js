// Model B — folder ↔ Ashby job linking + resolution (Express router).
// A folder links to one or more Ashby jobs via job_ashby_links; each Ashby job id
// is UNIQUE across folders, so a candidate's application.jobId resolves to exactly
// one folder. Separate router module to stay small (project rule: files <500 lines).
// NOTE: routes/ashby.js is a different thing — the Ashby API *helper* functions.
const express = require('express');
const { randomUUID } = require('crypto');
const db = require('../db');

const router = express.Router();

// List the Ashby jobs linked to a folder.
router.get('/jobs/:id/ashby-links', async (req, res) => {
  const rows = await db
    .prepare('SELECT id, job_id, ashby_job_id, ashby_job_title, created_at FROM job_ashby_links WHERE job_id = ? ORDER BY created_at')
    .all(req.params.id);
  res.json(rows);
});

// Link an Ashby job to a folder. Enforces "one Ashby job -> one folder" with a
// clean 409 that names the folder already holding it (no raw constraint 500).
router.post('/jobs/:id/ashby-links', async (req, res) => {
  const job = await db.prepare('SELECT id, name FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'folder not found' });
  const ashbyId = String(req.body.ashby_job_id || '').trim();
  if (!ashbyId) return res.status(400).json({ error: 'ashby_job_id is required' });

  // One Ashby job per folder: a folder maps to exactly one Ashby job.
  const already = await db.prepare('SELECT 1 FROM job_ashby_links WHERE job_id = ? LIMIT 1').get(req.params.id);
  if (already) {
    return res.status(409).json({ error: 'This folder is already linked to an Ashby job. Unlink it first to link a different one.' });
  }

  const clash = await db
    .prepare('SELECT l.id, j.name AS folder_name FROM job_ashby_links l JOIN jobs j ON j.id = l.job_id WHERE l.ashby_job_id = ?')
    .get(ashbyId);
  if (clash) {
    return res.status(409).json({
      error: `That Ashby job is already linked to the folder "${clash.folder_name}". An Ashby job can only be linked to one folder.`,
    });
  }

  const id = randomUUID();
  const title = String(req.body.ashby_job_title || '').trim() || null;
  await db
    .prepare('INSERT INTO job_ashby_links (id, job_id, ashby_job_id, ashby_job_title) VALUES (?, ?, ?, ?)')
    .run(id, job.id, ashbyId, title);
  res
    .status(201)
    .json(await db.prepare('SELECT id, job_id, ashby_job_id, ashby_job_title, created_at FROM job_ashby_links WHERE id = ?').get(id));
});

// Unlink an Ashby job from a folder.
router.delete('/jobs/:id/ashby-links/:linkId', async (req, res) => {
  await db.prepare('DELETE FROM job_ashby_links WHERE id = ? AND job_id = ?').run(req.params.linkId, req.params.id);
  res.status(204).end();
});

// The Ashby job ids of all PRODUCTION folders — what the prescreening workflow
// filters incoming candidates against (application.jobId must be in this set).
router.get('/ashby/production-job-ids', async (req, res) => {
  const rows = await db
    .prepare("SELECT l.ashby_job_id FROM job_ashby_links l JOIN jobs j ON j.id = l.job_id WHERE j.mode = 'production'")
    .all();
  const ids = rows.map((r) => r.ashby_job_id);
  res.json({ ashby_job_ids: ids, count: ids.length });
});

// All links across every folder (ashby_job_id -> folder), so the picker can grey
// out Ashby jobs already linked elsewhere.
router.get('/ashby/links', async (req, res) => {
  const rows = await db
    .prepare('SELECT l.ashby_job_id, l.job_id, j.name AS folder_name FROM job_ashby_links l JOIN jobs j ON j.id = l.job_id')
    .all();
  res.json(rows);
});

// Resolve an Ashby job id -> the folder that owns it (whose criteria apply).
router.get('/ashby/resolve/:ashbyJobId', async (req, res) => {
  const row = await db
    .prepare('SELECT j.id AS job_id, j.name, j.mode, j.parent_id FROM job_ashby_links l JOIN jobs j ON j.id = l.job_id WHERE l.ashby_job_id = ?')
    .get(req.params.ashbyJobId);
  if (!row) return res.status(404).json({ error: 'no folder is linked to this Ashby job' });
  res.json(row);
});

module.exports = router;
