// Google OAuth 2.0 login for the internal dashboard.
//
// Goal: anyone opening the UI must "Sign in with Google" first, and only
// @happyrobot.ai accounts are allowed in. Machine-to-machine API calls
// (Ashby / HappyRobot / JobBot) are unaffected — they authenticate with their
// own x-api-key headers and never touch these session cookies.
//
// Implementation notes:
//   * Server-side Authorization Code flow. We exchange the code for tokens
//     directly with Google over HTTPS using our client secret, so the returned
//     id_token can be trusted WITHOUT verifying its signature (per Google's
//     docs — a token fetched straight from the token endpoint is already
//     authenticated by the TLS channel + client secret). We still validate
//     aud / iss / email_verified / hosted-domain.
//   * Session state lives in a signed (HMAC-SHA256) httpOnly cookie — no DB
//     table, no extra dependency. Good enough for an internal tool.
const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');

const router = express.Router();

const ALLOWED_DOMAIN = process.env.ALLOWED_EMAIL_DOMAIN || 'happyrobot.ai';
const SESSION_COOKIE = 'hr_session';
const STATE_COOKIE = 'hr_oauth_state';
const SESSION_TTL_SEC = 60 * 60 * 12; // 12h

// Base URL the app is served from, used to build the OAuth redirect_uri.
// On Railway set APP_BASE_URL to https://uirecruitingplatform-production.up.railway.app
function baseUrl() {
  return (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
}
function redirectUri() {
  return `${baseUrl()}/api/auth/callback/google`;
}
function isHttps() {
  return baseUrl().startsWith('https://');
}
function sessionSecret() {
  // Fail loud in prod rather than sign sessions with a guessable key.
  const s = process.env.SESSION_SECRET;
  if (!s) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[auth] SESSION_SECRET is not set');
    }
    return 'dev-insecure-secret';
  }
  return s;
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
  // constant-time compare
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

// Kick off the OAuth dance.
router.get('/auth/login', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(500).send('GOOGLE_CLIENT_ID is not configured');

  const state = crypto.randomBytes(16).toString('hex');
  setCookie(res, STATE_COOKIE, makeToken({ state, exp: Math.floor(Date.now() / 1000) + 600 }), 600);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
    hd: ALLOWED_DOMAIN, // hint Google to show only workspace accounts
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

// Google redirects back here with ?code&state.
router.get('/auth/callback/google', async (req, res) => {
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

    // Exchange the code for tokens.
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri(),
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenResp.json();
    if (!tokenResp.ok || !tokens.id_token) {
      console.error('[auth] token exchange failed:', tokens);
      return res.status(401).send('Google sign-in failed');
    }

    // Decode the id_token payload. Safe to trust without signature verification
    // because it came directly from Google's token endpoint over TLS.
    const claims = JSON.parse(b64urlDecode(tokens.id_token.split('.')[1]));

    if (claims.aud !== process.env.GOOGLE_CLIENT_ID) {
      return res.status(401).send('Token audience mismatch');
    }
    if (claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com') {
      return res.status(401).send('Token issuer mismatch');
    }
    const email = (claims.email || '').toLowerCase();
    const domainOk = claims.hd === ALLOWED_DOMAIN || email.endsWith(`@${ALLOWED_DOMAIN}`);
    if (!claims.email_verified || !domainOk) {
      return res.status(403).send(
        `Access restricted to @${ALLOWED_DOMAIN} accounts. You signed in as ${email || 'an unknown account'}.`,
      );
    }

    // Issue the session cookie.
    const session = {
      email,
      name: claims.name || email,
      picture: claims.picture || null,
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
  res.json({ authenticated: true, email: user.email, name: user.name, picture: user.picture });
});

// Log out.
router.all('/auth/logout', (req, res) => {
  clearCookie(res, SESSION_COOKIE);
  if (req.method === 'GET') return res.redirect('/login');
  res.json({ ok: true });
});

module.exports = { router, getSessionUser, ALLOWED_DOMAIN };
