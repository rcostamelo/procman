'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Users and sessions for the dashboard, kept in one SQLite file next to the
 * rest of the state.
 *
 * The driver is `node:sqlite`, which ships inside Node itself: trading the
 * "zero runtime dependencies" promise for a password table would be a bad deal,
 * and a hand-rolled file format even worse.
 *
 * Passwords are hashed with scrypt (never stored, never recoverable), sessions
 * are random 32-byte tokens with an expiry, and repeated failures lock a name
 * out for a while so the login form cannot be brute-forced at line speed.
 */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };
const MIN_PASSWORD_LENGTH = 8;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const NAME_RE = /^[A-Za-z0-9._-]{2,32}$/;

function sqlite() {
  try {
    return require('node:sqlite');
  } catch (err) {
    const e = new Error(
      'user management needs node:sqlite (Node >= 23.4, or Node 22.5+ with --experimental-sqlite)'
    );
    e.code = 'NO_SQLITE';
    throw e;
  }
}

function checkName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    const err = new Error('user name must be 2-32 chars of letters, digits, dot, dash or underscore');
    err.code = 'BAD_NAME';
    throw err;
  }
  return name;
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    const err = new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    err.code = 'BAD_PASSWORD';
    throw err;
  }
  if (password.length > 1024) {
    const err = new Error('password is too long');
    err.code = 'BAD_PASSWORD';
    throw err;
  }
  return password;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem
  });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

function verifyPassword(stored, password) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  let actual;
  try {
    actual = crypto.scryptSync(password, salt, expected.length, { N, r, p, maxmem: SCRYPT.maxmem });
  } catch (err) {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** A hash to compare against when the name does not exist, so that a wrong
 *  username and a wrong password cost the same time. */
const DUMMY_HASH = hashPassword(crypto.randomBytes(24).toString('hex'));

class Users {
  constructor(file) {
    this.file = file;
    const { DatabaseSync } = sqlite();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    this.db = new DatabaseSync(file);
    // The CLI writes users while the daemon reads them: WAL plus a busy timeout
    // is what keeps the two from stepping on each other.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 3000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
        hash        TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        last_login  INTEGER
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token       TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires_at);
      CREATE TABLE IF NOT EXISTS failures (
        name        TEXT PRIMARY KEY COLLATE NOCASE,
        count       INTEGER NOT NULL,
        until       INTEGER NOT NULL
      );
    `);
    try { fs.chmodSync(file, 0o600); } catch (err) { /* best effort */ }
  }

  count() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  }

  exists(name) {
    return Boolean(this.db.prepare('SELECT 1 AS x FROM users WHERE name = ?').get(name));
  }

  add(name, password) {
    checkName(name);
    checkPassword(password);
    if (this.exists(name)) {
      const err = new Error(`user "${name}" already exists (use: user passwd ${name})`);
      err.code = 'EXISTS';
      throw err;
    }
    this.db.prepare('INSERT INTO users (name, hash, created_at) VALUES (?, ?, ?)')
      .run(name, hashPassword(password), Date.now());
    return { name };
  }

  setPassword(name, password) {
    checkName(name);
    checkPassword(password);
    const result = this.db.prepare('UPDATE users SET hash = ? WHERE name = ?')
      .run(hashPassword(password), name);
    if (!result.changes) {
      const err = new Error(`no such user: ${name}`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    // A password change must not leave old sessions alive.
    this.db.prepare('DELETE FROM sessions WHERE name = ?').run(name);
    this.db.prepare('DELETE FROM failures WHERE name = ?').run(name);
    return { name };
  }

  remove(name) {
    checkName(name);
    const result = this.db.prepare('DELETE FROM users WHERE name = ?').run(name);
    this.db.prepare('DELETE FROM sessions WHERE name = ?').run(name);
    this.db.prepare('DELETE FROM failures WHERE name = ?').run(name);
    if (!result.changes) {
      const err = new Error(`no such user: ${name}`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    return { name };
  }

  /** Never returns the hash: it exists to be checked, not to be printed. */
  list() {
    const rows = this.db.prepare(
      `SELECT u.name, u.created_at, u.last_login,
              (SELECT COUNT(*) FROM sessions s WHERE s.name = u.name AND s.expires_at > ?) AS sessions
         FROM users u ORDER BY u.name`
    ).all(Date.now());
    return rows.map((row) => ({
      name: row.name,
      created_at: row.created_at,
      last_login: row.last_login || null,
      sessions: row.sessions
    }));
  }

  _failure(name) {
    const row = this.db.prepare('SELECT count, until FROM failures WHERE name = ?').get(name);
    const now = Date.now();
    if (!row) return { count: 1, until: now + (1 > MAX_FAILURES - 1 ? LOCKOUT_MS : 0) };
    const count = row.count + 1;
    return { count, until: count >= MAX_FAILURES ? now + LOCKOUT_MS : row.until };
  }

  /**
   * Returns { ok: true, name } or { ok: false, locked, until }.
   * An unknown user still pays one scrypt round, so timing does not leak which
   * names exist, and failures are counted for unknown names too.
   */
  verify(name, password) {
    const now = Date.now();
    const lock = this.db.prepare('SELECT count, until FROM failures WHERE name = ?').get(name);
    if (lock && lock.until > now) {
      // Burn a hash anyway: a locked account should not answer faster.
      verifyPassword(DUMMY_HASH, String(password));
      return { ok: false, locked: true, until: lock.until };
    }

    const row = this.db.prepare('SELECT name, hash FROM users WHERE name = ?').get(name);
    const good = verifyPassword(row ? row.hash : DUMMY_HASH, String(password));
    if (!good || !row) {
      const next = this._failure(name);
      this.db.prepare(
        'INSERT INTO failures (name, count, until) VALUES (?, ?, ?) ' +
        'ON CONFLICT(name) DO UPDATE SET count = excluded.count, until = excluded.until'
      ).run(name, next.count, next.until);
      return { ok: false, locked: next.until > now && next.count >= MAX_FAILURES, until: next.until };
    }

    this.db.prepare('DELETE FROM failures WHERE name = ?').run(name);
    this.db.prepare('UPDATE users SET last_login = ? WHERE name = ?').run(now, row.name);
    return { ok: true, name: row.name };
  }

  createSession(name, ttl = SESSION_TTL_MS) {
    this.pruneSessions();
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.db.prepare('INSERT INTO sessions (token, name, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(token, name, now, now + ttl);
    return { token, expires_at: now + ttl };
  }

  /** The session's user, or null when the token is unknown or expired. */
  sessionUser(token) {
    if (!token) return null;
    const row = this.db.prepare('SELECT name, expires_at FROM sessions WHERE token = ?').get(token);
    if (!row) return null;
    if (row.expires_at <= Date.now()) {
      this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      return null;
    }
    return row.name;
  }

  destroySession(token) {
    if (token) this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  pruneSessions() {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  }

  close() {
    try { this.db.close(); } catch (err) { /* already closed */ }
  }
}

module.exports = {
  Users,
  hashPassword,
  verifyPassword,
  MIN_PASSWORD_LENGTH,
  MAX_FAILURES,
  LOCKOUT_MS,
  SESSION_TTL_MS
};
