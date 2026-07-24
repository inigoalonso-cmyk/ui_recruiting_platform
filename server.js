require('dotenv').config();
const express = require('express');
require('express-async-errors'); // lets async route handlers forward rejections to the error middleware
const cors = require('cors');
const path = require('path');
const db = require('./db');
const apiRoutes = require('./routes/api');
const ashbyLinksRoutes = require('./routes/ashby-links');
const { router: authRoutes, getSessionUser } = require('./routes/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Behind Railway's proxy: trust it so Secure cookies + req.protocol work.
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Health check + OAuth routes are always open (no session required).
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api', authRoutes);

// The login page and the few assets it needs must be reachable without a session.
const PUBLIC_PATHS = new Set(['/login', '/login.html', '/logo.png', '/favicon.ico']);

// Access gate. Browser traffic needs a valid Google session cookie; machine
// traffic (Ashby / HappyRobot / JobBot) carries its own x-api-key and is left
// to the per-route key guards downstream.
app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path)) return next();

  if (getSessionUser(req)) return next();

  if (req.path.startsWith('/api/')) {
    // Let key-bearing machine calls through to their own validators.
    if (req.headers['x-api-key']) return next();
    return res.status(401).json({ error: 'authentication required' });
  }

  // Unauthenticated browser navigation → send to the login page.
  return res.redirect('/login');
});

app.use('/api', apiRoutes);
app.use('/api', ashbyLinksRoutes);

// Static frontend (only reached once the gate above passes).
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
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
