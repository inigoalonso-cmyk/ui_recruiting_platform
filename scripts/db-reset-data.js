// Truncate the migrated data tables (fresh cutover). Only the tables we migrate;
// leaves the schema intact. CASCADE handles FK children.
require('dotenv').config();
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query('TRUNCATE jobs, parameters, killer_questions, job_info_facts, company_faq, recruiter_jobs, recruiters, settings, unanswered_questions RESTART IDENTITY CASCADE');
  console.log('Truncated migrated data tables.');
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
