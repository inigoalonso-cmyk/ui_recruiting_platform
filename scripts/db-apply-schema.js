// Apply db/schema.sql to the database in DATABASE_URL. Idempotent.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  await client.connect();
  await client.query(sql);
  const t = await client.query("select table_name from information_schema.tables where table_schema='public' order by table_name");
  console.log('Schema applied. Tables (' + t.rows.length + '):');
  console.log(t.rows.map((r) => '  - ' + r.table_name).join('\n'));
  await client.end();
})().catch((e) => { console.error('SCHEMA ERROR:', e.code || '', e.message); process.exit(1); });
