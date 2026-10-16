import { forbidden, unauthorized, AppError } from "./errors.js";
import { cookieName, findSession, readCookie } from "./auth/sessions.js";

/**
 * Attach `req.user` when a valid session cookie is present.
 * @param {import("pg").Pool} pool
 * @param {import("./config.js").Config} config
 * @returns {import("express").RequestHandler}
 */
export function loadSession(pool, config) {
  const name = cookieName(config);
  return async (req, res, next) => {
    const token = readCookie(req.headers.cookie, name);
    if (token && token.length <= 64) {
      res.locals.sessionToken = token;
      res.locals.user = await findSession(pool, token);
    }
    next();
  };
}

/** @type {import("express").RequestHandler} */
export function requireAuth(_req, res, next) {
  if (!res.locals.user) throw unauthorized();
  next();
}

/**
 * @param {"admin" | "employee"} role
 * @returns {import("express").RequestHandler}
 */
export function requireRole(role) {
  return (_req, res, next) => {
    if (!res.locals.user) throw unauthorized();
    if (res.locals.user.role !== role) throw forbidden();
    next();
  };
}

/**
 * CSRF protection. State-changing requests must come from our own site:
 * the browser-set Origin header has to match PUBLIC_ORIGIN, and the body must
 * be JSON (a cross-site HTML form can't send application/json). Combined with
 * SameSite=Strict cookies, a malicious site can't act as a logged-in user.
 * @param {import("./config.js").Config} config
 * @returns {import("express").RequestHandler}
 */
export function sameOriginOnly(config) {
  return (req, _res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
    if (req.headers.origin !== config.publicOrigin) {
      throw new AppError(403, "bad_origin", "Request blocked: it did not come from this site.");
    }
    const hasBody = req.headers["content-length"] && req.headers["content-length"] !== "0";
    if (hasBody && !req.is("application/json")) {
      throw new AppError(415, "unsupported_media_type", "Send JSON.");
    }
    next();
  };
}

/**
 * Record an admin action that affects pay.
 * @param {import("pg").Pool | import("pg").PoolClient} db
 * @param {number | null} actorUserId
 * @param {string} action
 * @param {string} entity
 * @param {number | null} entityId
 * @param {object} [details]
 */
export async function audit(db, actorUserId, action, entity, entityId, details) {
  await db.query(
    "INSERT INTO audit_log (actor_user_id, action, entity, entity_id, details) VALUES ($1, $2, $3, $4, $5)",
    [actorUserId, action, entity, entityId, details ? JSON.stringify(details) : null]
  );
}
