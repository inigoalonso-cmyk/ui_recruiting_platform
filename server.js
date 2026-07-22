require('dotenv').config();
const express = require('express');
require('express-async-errors'); // lets async route handlers forward rejections to the error middleware
const cors = require('cors');
const path = require('path');
const db = require('./db');
const apiRoutes = require('./routes/api');
const ashbyLinksRoutes = require('./routes/ashby-links');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.use('/api', apiRoutes);
app.use('/api', ashbyLinksRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Static frontend
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Central error handler: async DB/route errors (forwarded by express-async-errors)
// return a clean 500 instead of hanging the request.
app.use((err, req, res, next) => {
  console.error('[api error]', err && err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: (err && err.message) || 'internal error' });
});

// Ensure the Postgres schema exists before we start serving requests.
db.init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Pre-screening platform listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('[startup] database init failed:', err.message);
    process.exit(1);
  });
