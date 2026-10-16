import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { burnPasswordCheck, hashPassword, verifyPassword } from "../auth/password.js";
import { cookieName, createSession, destroyAllSessionsForUser, destroySession } from "../auth/sessions.js";
import { AppError, forbidden } from "../errors.js";
import { requireAuth } from "../middleware.js";
import { parse, schemas } from "../validation.js";
import { withTransaction } from "../db.js";

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const invalidLogin = () => new AppError(401, "invalid_login", "Wrong username or password.");

/**
 * @param {{ pool: import("pg").Pool, config: import("../config.js").Config }} deps
 */
export function authRoutes({ pool, config }) {
  const router = Router();
  const name = cookieName(config);
  const cookieOptions = {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: /** @type {const} */ ("strict"),
    path: "/",
  };

  // Brute-force protection per IP, on top of per-account lockout below.
  const loginLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: config.loginRateLimitPer15Min,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: { code: "rate_limited", message: "Too many login attempts. Try again in 15 minutes." } });
    },
  });

  // Public: lets the login page show the demo accounts when DEMO_MODE is on.
  router.get("/config", (_req, res) => {
    res.json({
      demoMode: config.demoMode,
      demoAccounts: config.demoMode
        ? { password: config.demoPassword, admin: "admin", employees: ["jdoe", "jsmith", "mgarcia", "kchen"] }
        : null,
    });
  });

  router.post("/login", loginLimiter, async (req, res) => {
    const { username, password } = parse(schemas.login, req.body);
    const { rows } = await pool.query(
      "SELECT id, password_hash, role, failed_logins, locked_until FROM users WHERE username = $1",
      [username]
    );
    const user = rows[0];
    if (!user) {
      await burnPasswordCheck(password); // same timing as a real check
      throw invalidLogin();
    }
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      throw new AppError(423, "locked", `Too many failed attempts. This account is locked for up to ${LOCK_MINUTES} minutes.`);
    }

    if (!(await verifyPassword(password, user.password_hash))) {
      // In the public demo the shared accounts would be easy to lock on purpose,
      // so there we rely on the per-IP rate limit alone.
      if (!config.demoMode) {
        await pool.query(
          `UPDATE users SET failed_logins = failed_logins + 1,
             locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
           WHERE id = $1`,
          [user.id, MAX_FAILED_LOGINS, LOCK_MINUTES]
        );
      }
      throw invalidLogin();
    }

    await pool.query("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1", [user.id]);
    // A fresh token on every login prevents session fixation.
    if (res.locals.sessionToken) await destroySession(pool, res.locals.sessionToken);
    const token = await createSession(pool, user.id, config.sessionHours);
    res.cookie(name, token, { ...cookieOptions, maxAge: config.sessionHours * 3_600_000 });
    res.json({ user: { username, role: user.role } });
  });

  router.post("/logout", async (_req, res) => {
    if (res.locals.sessionToken) await destroySession(pool, res.locals.sessionToken);
    res.clearCookie(name, cookieOptions);
    res.status(204).end();
  });

  // Returns { user: null } (not a 401) when logged out, so pages can check
  // quietly without a failed request in the browser console.
  router.get("/me", async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const u = res.locals.user;
    if (!u) return res.json({ user: null, demoMode: config.demoMode });
    let fullName = u.username;
    if (u.employeeId) {
      const { rows } = await pool.query("SELECT full_name FROM employees WHERE id = $1", [u.employeeId]);
      fullName = rows[0]?.full_name ?? fullName;
    }
    res.json({ user: { username: u.username, role: u.role, fullName }, demoMode: config.demoMode });
  });

  router.post("/password", requireAuth, async (req, res) => {
    if (config.demoMode) throw forbidden("Password changes are turned off in the public demo.");
    const { currentPassword, newPassword } = parse(schemas.changePassword, req.body);
    const u = res.locals.user;
    const { rows } = await pool.query("SELECT password_hash FROM users WHERE id = $1", [u.id]);
    if (!rows[0] || !(await verifyPassword(currentPassword, rows[0].password_hash))) {
      throw new AppError(400, "bad_password", "Your current password is incorrect.");
    }
    const hash = await hashPassword(newPassword);
    const token = await withTransaction(pool, async (client) => {
      await client.query("UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1", [u.id, hash]);
      // Log out every other device, then start a fresh session here.
      await destroyAllSessionsForUser(client, u.id);
      return createSession(client, u.id, config.sessionHours);
    });
    res.cookie(name, token, { ...cookieOptions, maxAge: config.sessionHours * 3_600_000 });
    res.status(204).end();
  });

  return router;
}
