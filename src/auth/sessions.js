// Server-side sessions. The browser only holds a random token in an httpOnly
// cookie (JavaScript can't read it, so XSS can't steal it). The database stores
// only a SHA-256 of the token.

import { createHash, randomBytes } from "node:crypto";

/** @param {string} token */
const hashToken = (token) => createHash("sha256").update(token).digest();

/** @param {import("../config.js").Config} config */
export function cookieName(config) {
  // The __Host- prefix makes browsers refuse the cookie unless it is Secure,
  // has Path=/ and no Domain, which blocks subdomain cookie-injection tricks.
  return config.isProduction ? "__Host-sid" : "sid";
}

/**
 * @param {import("pg").Pool | import("pg").PoolClient} db
 * @param {number} userId
 * @param {number} hours
 */
export async function createSession(db, userId, hours) {
  const token = randomBytes(32).toString("base64url");
  await db.query(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))",
    [hashToken(token), userId, hours]
  );
  return token;
}

/**
 * Look up a live session and its user. Expired sessions are treated as absent.
 * @param {import("pg").Pool} db
 * @param {string} token
 */
export async function findSession(db, token) {
  const { rows } = await db.query(
    `UPDATE sessions s SET last_seen_at = now()
       FROM users u
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.id = s.user_id
      RETURNING u.id, u.username, u.role, u.employee_id`,
    [hashToken(token)]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return { id: r.id, username: r.username, role: r.role, employeeId: r.employee_id };
}

/** @param {import("pg").Pool} db @param {string} token */
export async function destroySession(db, token) {
  await db.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
}

/** @param {import("pg").Pool | import("pg").PoolClient} db @param {number} userId */
export async function destroyAllSessionsForUser(db, userId) {
  await db.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
}

/** @param {import("pg").Pool} db */
export async function purgeExpiredSessions(db) {
  await db.query("DELETE FROM sessions WHERE expires_at <= now()");
}

/** Read a cookie value from the raw Cookie header (no extra dependency). */
export function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}
