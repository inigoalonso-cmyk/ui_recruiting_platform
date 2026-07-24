// Okta (OIDC) login for the internal dashboard.
//
// Goal: anyone opening the UI must sign in through Okta first. WHO is allowed in
// is controlled in Okta itself (only users/groups assigned to this app can get a
// token), so the dashboard doesn't need its own allow-list. Machine-to-machine
// API calls (Ashby / HappyRobot / JobBot) are unaffected — they authenticate
// with their own x-api-key headers and never touch these session cookies.
//
// Implementation notes:
//   * Standard OIDC Authorization Code flow. Endpoints are discovered from the
//     issuer's /.well-known/openid-configuration (works for Okta org and custom
//     authorization servers alike), so we never hard-code provider URLs.
//   * We exchange the code for tokens directly with Okta over HTTPS using our
//     client secret, so the returned id_token can be trusted WITHOUT verifying
//     its signature (it's authenticated by the TLS channel + client secret). We
//     still validate aud / iss.
//   * Session state lives in a signed (HMAC-SHA256) httpOnly cookie — no DB
//     table, no extra dependency.
const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');

const router = express.Router();

const SESSION_COOKIE = 'hr_session';
const STATE_COOKIE = 'hr_oauth_state';
const SESSION_TTL_SEC = 60 * 60 * 12; // 12h

// Optional extra guard: if set, only emails on this domain are accepted even if
// Okta issued a token. Left empty by default — Okta app assignment is the real
// gate. (e.g. ALLOWED_EMAIL_DOMAIN=happyrobot.ai)
const ALLOWED_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || '').trim().toLowerCase();

// Okta issuer, e.g. https://happyrobot.okta.com/oauth2/default (custom auth
// server) or https://happyrobot.okta.com (org auth server). No trailing slash.
function issuer() {
  return (process.env.OKTA_ISSUER || '').replace(/\/+$/, '');
}

// Base URL the app is served from, used to build the OAuth redirect_uri.
// On Railway set APP_BASE_URL to https://uirecruitingplatform-production.up.railway.app
function baseUrl() {
  return (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
}
function redirectUri() {
  return `${baseUrl()}/api/auth/callback/okta`;
}
function isHttps() {
  return baseUrl().startsWith('https://');
}
function sessionSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[auth] SESSION_SECRET is not set');
    }
    return 'dev-insecure-secret';
  }
  return s;
}

// ---- OIDC discovery (cached in-memory) -------------------------------------
let _oidcCache = null;
async function discover() {
  if (_oidcCache) return _oidcCache;
  const iss = issuer();
  if (!iss) throw new Error('OKTA_ISSUER is not configured');
  const resp = await fetch(`${iss}/.well-known/openid-configuration`);
  if (!resp.ok) throw new Error(`OIDC discovery failed (${resp.status})`);
  const cfg = await resp.json();
  _oidcCache = {
    authorization_endpoint: cfg.authorization_endpoint,
    token_endpoint: cfg.token_endpoint,
    end_session_endpoint: cfg.end_session_endpoint || null,
    issuer: cfg.issuer || iss,
  };
  return _oidcCache;
}

// ---- signed-cookie helpers (base64url(payload).hmac) ------------------------
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}
function sign(value) {
  return crypto.createHmac('sha256', sessionSecret()).update(value).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function makeToken(payload) {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}
function readToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = sign(body);
  if (mac.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) {
    return null;
  }
  try {
    const payload = JSON.parse(b64urlDecode(body));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  raw.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}
function setCookie(res, name, value, maxAgeSec) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  if (isHttps()) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}
function clearCookie(res, name) {
  const parts = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isHttps()) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

// ---- current user (used by the gate middleware) ----------------------------
function getSessionUser(req) {
  const cookies = parseCookies(req);
  const payload = readToken(cookies[SESSION_COOKIE]);
  if (!payload || !payload.email) return null;
  return payload;
}

// ---- routes ----------------------------------------------------------------

// Kick off the OIDC dance.
router.get('/auth/login', async (req, res) => {
  try {
    const clientId = process.env.OKTA_CLIENT_ID;
    if (!clientId) return res.status(500).send('OKTA_CLIENT_ID is not configured');
    const oidc = await discover();

    const state = crypto.randomBytes(16).toString('hex');
    setCookie(res, STATE_COOKIE, makeToken({ state, exp: Math.floor(Date.now() / 1000) + 600 }), 600);

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri(),
      response_type: 'code',
      scope: 'openid email profile',
      state,
    });
    res.redirect(`${oidc.authorization_endpoint}?${params.toString()}`);
  } catch (err) {
    console.error('[auth] login error:', err && err.message);
    res.status(500).send('Sign-in is not configured yet');
  }
});

// Okta redirects back here with ?code&state.
router.get('/auth/callback/okta', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('Missing authorization code');

    // Validate state against the signed cookie we set in /auth/login.
    const cookies = parseCookies(req);
    const stateCookie = readToken(cookies[STATE_COOKIE]);
    clearCookie(res, STATE_COOKIE);
    if (!stateCookie || stateCookie.state !== state) {
      return res.status(400).send('Invalid OAuth state');
    }

    const oidc = await discover();

    // Exchange the code for tokens.
    const tokenResp = await fetch(oidc.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.OKTA_CLIENT_ID,
        client_secret: process.env.OKTA_CLIENT_SECRET,
        redirect_uri: redirectUri(),
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenResp.json();
    if (!tokenResp.ok || !tokens.id_token) {
      console.error('[auth] token exchange failed:', tokens);
      return res.status(401).send('Sign-in failed');
    }

    // Decode the id_token payload. Safe to trust without signature verification
    // because it came directly from Okta's token endpoint over TLS.
    const claims = JSON.parse(b64urlDecode(tokens.id_token.split('.')[1]));

    if (claims.aud !== process.env.OKTA_CLIENT_ID) {
      return res.status(401).send('Token audience mismatch');
    }
    if (claims.iss !== oidc.issuer) {
      return res.status(401).send('Token issuer mismatch');
    }
    const email = (claims.email || claims.preferred_username || '').toLowerCase();
    if (!email) return res.status(401).send('No email in token');
    if (ALLOWED_DOMAIN && !email.endsWith(`@${ALLOWED_DOMAIN}`)) {
      return res.status(403).send(`Access restricted to @${ALLOWED_DOMAIN} accounts (signed in as ${email}).`);
    }

    // Issue the session cookie.
    const session = {
      email,
      name: claims.name || email,
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC,
    };
    setCookie(res, SESSION_COOKIE, makeToken(session), SESSION_TTL_SEC);
    res.redirect('/');
  } catch (err) {
    console.error('[auth] callback error:', err && err.message);
    res.status(500).send('Sign-in error');
  }
});

// Who am I? Used by the frontend to show the signed-in user.
router.get('/auth/me', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, email: user.email, name: user.name });
});

// Log out (local session only; the Okta session is left intact).
router.all('/auth/logout', (req, res) => {
  clearCookie(res, SESSION_COOKIE);
  if (req.method === 'GET') return res.redirect('/login');
  res.json({ ok: true });
});

module.exports = { router, getSessionUser };
