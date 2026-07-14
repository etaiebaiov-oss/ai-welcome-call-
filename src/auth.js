const crypto = require('crypto');
const { getOrCreateSecret } = require('./db');

const COOKIE_NAME = 'admin_session';

function sessionToken() {
  const password = process.env.ADMIN_PASSWORD || '';
  const secret = process.env.SESSION_SECRET || getOrCreateSecret('session_secret');
  // Deterministic token: changing ADMIN_PASSWORD invalidates all sessions.
  return crypto.createHmac('sha256', secret).update(`admin:${password}`).digest('hex');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function isAuthed(req) {
  return safeEqual(req.cookies[COOKIE_NAME], sessionToken());
}

function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_PASSWORD) {
    return res.status(503).send('Admin dashboard is disabled: set the ADMIN_PASSWORD environment variable.');
  }
  if (!isAuthed(req)) return res.redirect('/admin/login');
  next();
}

function login(res) {
  res.cookie(COOKIE_NAME, sessionToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: (process.env.APP_URL || '').startsWith('https://'),
    maxAge: 1000 * 60 * 60 * 24 * 7,
  });
}

function logout(res) {
  res.clearCookie(COOKIE_NAME);
}

module.exports = { requireAdmin, isAuthed, login, logout, safeEqual };
