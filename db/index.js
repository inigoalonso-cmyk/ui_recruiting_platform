// Postgres (Supabase) data layer. Exposes a small async wrapper that mirrors the
// shape of the old better-sqlite3 API — db.prepare(sql).get/all/run(...params),
// db.exec(sql), db.transaction(fn) — so the route code changes are limited to
// adding `await`. The only SQL dialect differences handled centrally here are:
//   * `?` placeholders     -> `$1, $2, ...`
//   * `datetime('now')`    -> a UTC text timestamp in the SAME 'YYYY-MM-DD HH24:MI:SS'
//                             format the columns store (keeps API date strings identical).
// Everything else (schema, contracts) is unchanged from the SQLite version.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error(
    '[db] DATABASE_URL is not set. Point it at the Supabase Postgres connection ' +
    'string (locally via .env, on Railway via a service variable).',
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX || 10),
});

pool.on('error', (err) => {
  // A pooled idle client dropped by the server — log, don't crash the process.
  console.error('[db] idle client error:', err.message);
});

// UTC text timestamp matching how created_at/updated_at are stored (so the
// frontend's `new Date(iso.replace(' ','T')+'Z')` parsing keeps working).
const NOW_UTC = "to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS')";

// Translate the small set of SQLite-isms this codebase uses into Postgres.
// NOTE: datetime('now') is replaced FIRST (it introduces no placeholders), then
// each remaining `?` becomes $1, $2, ... in order.
function translate(sql) {
  const noDatetime = sql.replace(/datetime\('now'\)/g, NOW_UTC);
  let i = 0;
  return noDatetime.replace(/\?/g, () => `$${++i}`);
}

// Build a prepared-statement-like object bound to a runner (pool or a tx client).
function preparer(runner) {
  return (sql) => {
    const text = translate(sql);
    return {
      // Returns the first row, or undefined when there are none (matches better-sqlite3).
      async get(...params) {
        const r = await runner.query(text, params);
        return r.rows[0];
      },
      async all(...params) {
        const r = await runner.query(text, params);
        return r.rows;
      },
      // Returns { changes } so existing `.run(...).changes` usages keep working.
      async run(...params) {
        const r = await runner.query(text, params);
        return { changes: r.rowCount };
      },
    };
  };
}

const prepare = preparer(pool);

async function exec(sql) {
  await pool.query(translate(sql));
}

// Run fn inside a single transaction. fn receives a mini-db whose prepare() is
// bound to the transaction's client, so all statements inside share the tx.
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const txDb = { prepare: preparer(client), query: (s, p) => client.query(translate(s), p) };
    const result = await fn(txDb);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

// Create the schema (idempotent) and seed defaults on first boot. Call once at startup.
async function init() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);

  // Seed runtime settings (only missing keys — never clobber edited values).
  await pool.query(
    `INSERT INTO settings (key, value) VALUES
       ('pass_threshold', '8'),
       ('max_call_attempts', '3'),
       ('call_recording_enabled', $1)
     ON CONFLICT (key) DO NOTHING`,
    [process.env.INTERVIEW_RECORDING_ENABLED === 'true' ? '1' : '0'],
  );

  // Seed Company FAQ starter content ONLY when the table is completely empty, so
  // GET /api/jobbot/global-faq is never empty on a brand-new DB. Never runs again
  // once any row exists, so it can't clobber edits.
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM company_faq');
  if (rows[0].n === 0) {
    const { randomUUID } = require('crypto');
    const seed = [
      ['Offices', 'San Francisco (HQ), Delaware, and Madrid, Spain.'],
      ['Funding', '~$62M raised total. Series B: $44M in September 2025, led by Base10 Partners (~$500M valuation), with a16z, Y Combinator, Tokio Marine, WaVe-X, and World Innovation Lab participating. Series A: $15.6M in December 2024, led by a16z.'],
      ['Founded', 'Founded in 2023 by Pablo Palafox, Luis Paarup, and Javi Palafox.'],
      ['Values / culture', 'Responsibility (full ownership of what you build, including bugs and uptime), Excellence, Warmth & Approachability, merit-based hiring (ability over seniority), and first-principles thinking.'],
      ['Interview process', 'Placeholder — fill in the standard interview process from the Company FAQ tab.'],
    ];
    for (let i = 0; i < seed.length; i++) {
      await pool.query(
        'INSERT INTO company_faq (id, label, value, sort_order) VALUES ($1, $2, $3, $4)',
        [randomUUID(), seed[i][0], seed[i][1], i],
      );
    }
    console.log(`[db] Seeded Company FAQ with ${seed.length} starter facts (table was empty).`);
  }

  console.log('[db] Postgres schema ready.');
}

module.exports = { prepare, exec, transaction, query: (s, p) => pool.query(translate(s), p), init, pool };
