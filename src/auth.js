const crypto = require('crypto');
const { getOrCreateSecret } = require('./db');

const COOKIE_NAME = 'admin_session';

// Two levels of access, each with its own password:
//   admin    - everything (records, recordings, scripts, imports)
//   designer - can only mint a welcome-call link and copy it
const ROLE_PASSWORD_ENV = {
  admin: 'ADMIN_PASSWORD',
  designer: 'DESIGNER_PASSWORD',
};

function rolePassword(role) {
  return (process.env[ROLE_PASSWORD_ENV[role]] || '').trim();
}

function sessionToken(role) {
  const secret = process.env.SESSION_SECRET || getOrCreateSecret('session_secret');
  // Deterministic per role: changing that role's password logs it out
  // everywhere, and a designer cookie can never validate as an admin one.
  return crypto.createHmac('sha256', secret).update(`${role}:${rolePassword(role)}`).digest('hex');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// 'admin', 'designer', or null.
function roleOf(req) {
  const cookie = req.cookies[COOKIE_NAME];
  if (!cookie) return null;
  for (const role of Object.keys(ROLE_PASSWORD_ENV)) {
    if (rolePassword(role) && safeEqual(cookie, sessionToken(role))) return role;
  }
  return null;
}

function isAuthed(req) {
  return roleOf(req) === 'admin';
}

function requireAdmin(req, res, next) {
  if (!rolePassword('admin')) {
    return res.status(503).send('Admin dashboard is disabled: set the ADMIN_PASSWORD environment variable.');
  }
  if (roleOf(req) !== 'admin') return res.redirect('/admin/login');
  next();
}

// The link-creation console: designers plus admins.
function requireCreator(req, res, next) {
  if (!roleOf(req)) return res.redirect('/create/login');
  next();
}

function login(res, role) {
  res.cookie(COOKIE_NAME, sessionToken(role), {
    httpOnly: true,
    sameSite: 'lax',
    secure: (process.env.APP_URL || '').startsWith('https://'),
    maxAge: 1000 * 60 * 60 * 24 * 7,
  });
}

function logout(res) {
  res.clearCookie(COOKIE_NAME);
}

module.exports = { requireAdmin, requireCreator, roleOf, isAuthed, login, logout, safeEqual };
