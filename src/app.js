import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { AppError } from "./errors.js";
import { loadSession, sameOriginOnly } from "./middleware.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { meRoutes } from "./routes/me.js";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

/**
 * @param {{
 *   pool: import("pg").Pool,
 *   config: import("./config.js").Config,
 *   log?: (level: string, message: string, fields?: object) => void,
 * }} deps
 */
export function createApp({ pool, config, log = () => {} }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  app.set("query parser", "simple");

  // Access log: no IPs, no query strings, no bodies (payroll data is sensitive).
  app.use((req, res, next) => {
    const requestId = randomUUID();
    res.locals.requestId = requestId;
    res.setHeader("X-Request-Id", requestId);
    const started = process.hrtime.bigint();
    res.on("finish", () => {
      log("info", "request", {
        requestId, method: req.method, path: req.path, status: res.statusCode,
        ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
      });
    });
    next();
  });

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", "data:"],
          fontSrc: ["'self'"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          ...(config.isProduction ? { upgradeInsecureRequests: [] } : {}),
        },
      },
      strictTransportSecurity: config.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
      referrerPolicy: { policy: "no-referrer" },
    })
  );
  app.use((_req, res, next) => {
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    next();
  });

  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: config.globalRateLimitPerMinute,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      handler: (_req, res) => {
        res.status(429).json({ error: { code: "rate_limited", message: "Too many requests. Please slow down." } });
      },
    })
  );

  app.get("/healthz", async (_req, res) => {
    await pool.query("SELECT 1");
    res.setHeader("Cache-Control", "no-store");
    res.json({ status: "ok" });
  });

  // ─── API ────────────────────────────────────────────────────────────────
  const api = express.Router();
  api.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store"); // payroll data must not be cached
    next();
  });
  api.use(sameOriginOnly(config));
  api.use(express.json({ limit: "20kb", strict: true }));
  api.use(loadSession(pool, config));
  api.use("/auth", authRoutes({ pool, config }));
  api.use("/me", meRoutes({ pool }));
  api.use("/admin", adminRoutes({ pool, config }));
  api.use((_req, res) => {
    res.status(404).json({ error: { code: "not_found", message: "Unknown API route." } });
  });
  app.use("/api", api);

  // ─── Pages ──────────────────────────────────────────────────────────────
  app.use(express.static(PUBLIC_DIR, { dotfiles: "deny", extensions: ["html"], maxAge: config.isProduction ? "1h" : 0 }));
  app.use((_req, res) => res.status(404).sendFile(path.join(PUBLIC_DIR, "404.html")));

  // Central error handler: safe messages for known errors, generic 500 otherwise.
  app.use(
    /**
     * @param {any} err
     * @param {import("express").Request} _req
     * @param {import("express").Response} res
     * @param {import("express").NextFunction} _next
     */
    (err, _req, res, _next) => {
      if (err instanceof AppError) {
        return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details ?? {}) } });
      }
      if (err?.type === "entity.parse.failed") {
        return res.status(400).json({ error: { code: "bad_json", message: "The request body is not valid JSON." } });
      }
      if (err?.type === "entity.too.large") {
        return res.status(413).json({ error: { code: "too_large", message: "The request is too large." } });
      }
      log("error", "unhandled error", { requestId: res.locals.requestId, error: err?.stack ?? String(err) });
      res.status(500).json({ error: { code: "internal_error", message: "Something went wrong." } });
    }
  );

  return app;
}
