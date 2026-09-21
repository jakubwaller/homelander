#!/usr/bin/env node
// Kaufradar account admin — run inside the container:
//   docker exec -it homelander-scanner node engine/users-cli.js <command>
//
//   add <name> [--email <addr>] [--admin] [--password <pw>]   (password is generated when omitted)
//   list
//   passwd <name> [<pw>]                                      (generated when omitted)
//   email <name> <addr>
//   remove <name>
//
// The first account inherits the pre-accounts state: seen/favourite flags, the
// uploads directory, and the weekly report (recipient, thresholds, last-sent
// time) that used to be configured through HOMELANDER_REPORT_* env vars.

import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HomelanderDB } from './db.js';
import { hashPassword, normalizeSettings, parseSettings, validEmail, validName } from './auth.js';
import { adoptLegacyUploads, uploadsRoot } from './uploads.js';
import { legacyReportSettings, readReportState } from './report.js';

const DATA_DIR = process.env.HOMELANDER_DATA_DIR || join(homedir(), '.homelander');

const MIN_PASSWORD = 10;   // same floor as the web form

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

/** `--key value` / `--flag` pairs out of the argument list; the rest stay positional. */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { positional.push(argv[i]); continue; }
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--') && key !== 'admin') { flags[key] = next; i++; } else flags[key] = true;
  }
  return { positional, flags };
}

export function run(db, argv, { dataDir = DATA_DIR, env = process.env, out = console.log } = {}) {
  const [cmd, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);
  const [name, extra] = positional;
  const requireUser = () => db.getUserByName(name) || fail(`No such user: ${name}`);

  if (cmd === 'list') {
    for (const u of db.listUsers()) {
      const r = parseSettings(u).report;
      out(`${u.id}\t${u.name}\t${u.is_admin ? 'admin' : 'user'}\t${u.email || '-'}\treport:${r.enabled ? r.type : 'off'}`);
    }
    return;
  }
  if (cmd === 'add') {
    if (!validName(name)) fail('Name: 2–32 characters of A–Z a–z 0–9 . _ -');
    if (db.getUserByName(name)) fail(`User exists: ${name}`);
    const email = flags.email === true ? '' : (flags.email || '');
    if (email && !validEmail(email)) fail('Invalid --email');
    const password = typeof flags.password === 'string' ? flags.password : randomBytes(9).toString('base64url');
    if (password.length < MIN_PASSWORD) fail(`Password: at least ${MIN_PASSWORD} characters`);
    const first = db.countUsers() === 0;
    // The first account keeps the mail it had before accounts existed.
    let config = {};
    try { config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')); } catch { /* no config.json */ }
    const settings = first ? legacyReportSettings(env, config) : normalizeSettings({});
    const recipient = email || (first ? env.HOMELANDER_REPORT_TO || '' : '');
    const { id } = db.createUser({
      name, passHash: hashPassword(password), email: recipient || null, isAdmin: first || !!flags.admin, settings,
    });
    if (first) {
      const moved = adoptLegacyUploads(dataDir, id);
      const lastSent = readReportState(dataDir);
      if (lastSent) db.updateUser(id, { lastReportAt: lastSent });
      out(`First account: adopted the existing flags, ${moved} upload folder(s)${lastSent ? ' and the report clock' : ''}.`);
    }
    out(`Created ${name} (id ${id}). Password: ${password}`);
    return;
  }
  if (cmd === 'passwd') {
    const user = requireUser();
    const password = extra || randomBytes(9).toString('base64url');
    if (password.length < MIN_PASSWORD) fail(`Password: at least ${MIN_PASSWORD} characters`);
    db.updateUser(user.id, { passHash: hashPassword(password) });
    out(`Password for ${name}: ${password}`);
    return;
  }
  if (cmd === 'email') {
    const user = requireUser();
    if (!validEmail(extra)) fail('Invalid address');
    db.updateUser(user.id, { email: extra });
    out(`Email for ${name} set.`);
    return;
  }
  if (cmd === 'remove') {
    const user = requireUser();
    db.deleteUser(user.id);
    rmSync(uploadsRoot(dataDir, user.id), { recursive: true, force: true });
    out(`Removed ${name} (flags, uploads).`);
    return;
  }
  fail('Usage: users-cli.js add|list|passwd|email|remove …');
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  const db = new HomelanderDB(join(DATA_DIR, 'homelander.db'));
  try { run(db, process.argv.slice(2)); } finally { db.close(); }
}
