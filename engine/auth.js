// Kaufradar accounts — password hashing, signed session cookies, login throttle.
//
// No dependencies: scrypt and HMAC come from node:crypto. A session is a
// signed `<userId>.<expiry>.<pwTag>` string; pwTag is derived from the stored
// password hash, so changing a password logs the account out everywhere.

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const COOKIE_NAME = 'hl_session';
export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const SCRYPT = { N: 16384, r: 8, p: 1 };

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, 32, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return timingSafeEqual(actual, expected);
}

/** Cookie signing key: env first, else a file in the data dir created on first use. */
export function loadSecret(dataDir, env = process.env) {
  if (env.HOMELANDER_COOKIE_SECRET) return env.HOMELANDER_COOKIE_SECRET;
  if (!dataDir) return randomBytes(32).toString('hex');
  const file = join(dataDir, '.cookie-secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const secret = randomBytes(32).toString('hex');
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

const sign = (secret, payload) => createHmac('sha256', secret).update(payload).digest('base64url');
const pwTag = (secret, user) => sign(secret, `pw|${user.pass_hash}`).slice(0, 12);

export function makeSession(secret, user, now = Date.now()) {
  const payload = `${user.id}.${now + SESSION_MS}.${pwTag(secret, user)}`;
  return `${payload}.${sign(secret, payload)}`;
}

/** The user a cookie header belongs to, or null (bad signature, expired, pw changed, deleted). */
export function userFromCookie(secret, db, cookieHeader, now = Date.now()) {
  const match = String(cookieHeader || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!match) return null;
  const parts = decodeURIComponent(match.slice(COOKIE_NAME.length + 1)).split('.');
  if (parts.length !== 4) return null;
  const [id, exp, tag, sig] = parts;
  const expected = sign(secret, `${id}.${exp}.${tag}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (!(Number(exp) > now)) return null;
  const user = db.getUser(Number(id));
  return user && pwTag(secret, user) === tag ? user : null;
}

export function sessionCookie(value, { secure = false, maxAgeMs = SESSION_MS } = {}) {
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? '; Secure' : ''}`;
}

/** 8 failures per key within the window locks it out until the window passes. */
export function createLoginThrottle({ max = 8, windowMs = 15 * 60 * 1000 } = {}) {
  const fails = new Map();
  const recent = (key, now) => (fails.get(key) || []).filter((t) => now - t < windowMs);
  return {
    blocked(key, now = Date.now()) { return recent(key, now).length >= max; },
    fail(key, now = Date.now()) { fails.set(key, [...recent(key, now), now]); },
    clear(key) { fails.delete(key); },
  };
}

export const DEFAULT_SETTINGS = {
  report: { enabled: false, type: 'both', minSize: 0, minRooms: 0, maxWalkMinutes: 0, region: 'all' },
};

const num = (v, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : 0;
};

/** Validated settings object; unknown keys are dropped, bad values fall back to the defaults. */
export function normalizeSettings(input = {}) {
  const r = input?.report || {};
  const d = DEFAULT_SETTINGS.report;
  return {
    report: {
      enabled: r.enabled === true,
      type: ['flats', 'houses', 'both'].includes(r.type) ? r.type : d.type,
      minSize: num(r.minSize, 2000),
      minRooms: num(r.minRooms, 30),
      maxWalkMinutes: num(r.maxWalkMinutes, 120),
      region: r.region === 'west' ? 'west' : 'all',
    },
  };
}

export function parseSettings(user) {
  try { return normalizeSettings(JSON.parse(user?.settings_json || '{}')); } catch { return normalizeSettings({}); }
}

export const validEmail = (v) => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 200;
export const validName = (v) => typeof v === 'string' && /^[A-Za-z0-9._-]{2,32}$/.test(v);
