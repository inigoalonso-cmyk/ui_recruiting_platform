// One-time data migration: reads the PROD snapshot JSON and inserts it into the
// Postgres DB in DATABASE_URL. Idempotent (ON CONFLICT). Preserves original ids
// and created_at/updated_at so nothing that references them breaks.
//
// Usage: node scripts/db-migrate-from-snapshot.js /path/to/snapshot.json
require('dotenv').config();
const { Client } = require('pg');

const SNAP = process.argv[2];
if (!SNAP) { console.error('pass the snapshot.json path as arg 1'); process.exit(1); }
const snap = require(SNAP);

async function insertRows(client, table, rows, cols, conflict = 'id', updateOnConflict = false) {
  let n = 0;
  for (const row of rows) {
    const vals = cols.map((c) => (row[c] === undefined ? null : row[c]));
    const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
    let sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${ph}) ON CONFLICT (${conflict}) `;
    sql += updateOnConflict
      ? `DO UPDATE SET ${cols.filter((c) => c !== conflict).map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`
      : 'DO NOTHING';
    const r = await client.query(sql, vals);
    n += r.rowCount;
  }
  return n;
}

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  await client.connect();
  await client.query('BEGIN');
  try {
    // 1) jobs (parents first)
    const jobs = snap.jobs || [];
    const nJobs = await insertRows(client, 'jobs', jobs, ['id', 'name', 'ashby_job_id', 'mode', 'created_at']);

    // 2) parameters (general + per-job)
    const params = [...(snap.general.parameters || [])];
    for (const id in snap.per_job) params.push(...(snap.per_job[id].parameters || []));
    const nParams = await insertRows(client, 'parameters', params, ['id', 'job_id', 'name', 'weight', 'added_by', 'created_at']);

    // 3) killer_questions
    const killers = [];
    for (const id in snap.per_job) killers.push(...(snap.per_job[id].killer_questions || []));
    const nKillers = await insertRows(client, 'killer_questions', killers, ['id', 'job_id', 'question', 'weight', 'expected_answer', 'added_by', 'created_at']);

    // 4) job_info_facts (general + per-job)
    const facts = [...(snap.general.job_info || [])];
    for (const id in snap.per_job) facts.push(...(snap.per_job[id].job_info || []));
    const nFacts = await insertRows(client, 'job_info_facts', facts, ['id', 'job_id', 'label', 'value', 'sort_order', 'created_at', 'updated_at']);

    // 5) company_faq
    const nFaq = await insertRows(client, 'company_faq', snap.company_faq || [], ['id', 'label', 'value', 'sort_order', 'created_at', 'updated_at']);

    // 6) recruiter_jobs + recruiters
    const rjobs = (snap.recruiter_jobs || []).map((r) => ({ id: r.id, name: r.name, created_at: r.created_at }));
    const nRjobs = await insertRows(client, 'recruiter_jobs', rjobs, ['id', 'name', 'created_at']);
    const recs = [];
    for (const rj of snap.recruiter_jobs || []) recs.push(...(rj.recruiters || []));
    const nRecs = await insertRows(client, 'recruiters', recs, ['id', 'recruiter_job_id', 'name', 'email', 'calendar_link', 'notes', 'created_at']);

    // 7) settings (key-keyed, update on conflict)
    const st = snap.settings || {};
    const settingsRows = [
      { key: 'pass_threshold', value: String(st.pass_threshold) },
      { key: 'max_call_attempts', value: String(st.max_call_attempts) },
      { key: 'call_recording_enabled', value: st.call_recording_enabled ? '1' : '0' },
    ];
    const nSettings = await insertRows(client, 'settings', settingsRows, ['key', 'value'], 'key', true);

    // 8) unanswered_questions (reconstruct raw rows from the grouped view, ids preserved)
    const unRows = [];
    const groups = (snap.unanswered && snap.unanswered.groups) || [];
    for (const g of groups) {
      (g.ids || []).forEach((rid, i) => unRows.push({
        id: rid,
        role_label: (g.role_labels && g.role_labels[i]) || null,
        question_text: g.question_text,
        status: snap.unanswered.status || 'open',
        created_at: g.first_seen,
        updated_at: g.last_seen || g.first_seen,
      }));
    }
    const nUn = await insertRows(client, 'unanswered_questions', unRows, ['id', 'role_label', 'question_text', 'status', 'created_at', 'updated_at']);

    await client.query('COMMIT');
    console.log('MIGRATION OK (rows inserted):');
    console.log({ jobs: nJobs, parameters: nParams, killer_questions: nKillers, job_info_facts: nFacts, company_faq: nFaq, recruiter_jobs: nRjobs, recruiters: nRecs, settings: nSettings, unanswered_questions: nUn });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('MIGRATION FAILED (rolled back):', e.code || '', e.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
})();
