require('dotenv').config();
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const tables = ['jobs', 'parameters', 'killer_questions', 'job_info_facts', 'company_faq', 'recruiter_jobs', 'recruiters', 'settings', 'unanswered_questions', 'score_log', 'interview_state', 'interview_results', 'dev_test_runs'];
  for (const t of tables) {
    const r = await c.query(`select count(*)::int n from ${t}`);
    console.log(t.padEnd(22), r.rows[0].n);
  }
  const byMode = await c.query("select mode, count(*)::int n from jobs group by mode order by mode");
  console.log('jobs by mode:', byMode.rows.map((r) => `${r.mode}=${r.n}`).join(', '));
  const sample = await c.query("select id, name, created_at from jobs order by created_at limit 1");
  console.log('sample job created_at (format check):', JSON.stringify(sample.rows[0].created_at));
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
