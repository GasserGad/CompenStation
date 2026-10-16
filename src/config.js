// Configuration is read and validated once at startup. Bad config stops the
// server with a clear message instead of failing in strange ways later.

/**
 * @param {string | undefined} raw
 * @param {number} fallback
 * @param {string} name
 * @param {number} min
 * @param {number} max
 */
function int(raw, fallback, name, min, max) {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/** @param {NodeJS.ProcessEnv} env */
export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV ?? "development";
  const isProduction = nodeEnv === "production";
  const databaseUrl = env.DATABASE_URL ?? "";
  if (!databaseUrl) throw new Error("DATABASE_URL must be set");

  const publicOrigin = env.PUBLIC_ORIGIN ?? (isProduction ? "" : "http://localhost:3000");
  if (!publicOrigin) throw new Error("PUBLIC_ORIGIN must be set in production (e.g. https://compenstation.onrender.com)");
  let origin;
  try {
    origin = new URL(publicOrigin).origin;
  } catch {
    throw new Error("PUBLIC_ORIGIN must be a full URL like https://example.com");
  }
  if (isProduction && !origin.startsWith("https://")) {
    throw new Error("PUBLIC_ORIGIN must use https in production");
  }

  const trustProxyRaw = env.TRUST_PROXY ?? "";
  const trustProxy = trustProxyRaw === "" || trustProxyRaw === "0" || trustProxyRaw === "false"
    ? false
    : int(trustProxyRaw, 0, "TRUST_PROXY", 1, 5);

  return Object.freeze({
    nodeEnv,
    isProduction,
    port: int(env.PORT, 3000, "PORT", 1, 65535),
    databaseUrl,
    // Neon and most hosted Postgres require TLS; local development usually doesn't.
    databaseSsl: env.DATABASE_SSL === "false" ? false : isProduction || env.DATABASE_SSL === "true",
    publicOrigin: origin,
    trustProxy,
    sessionHours: int(env.SESSION_HOURS, 8, "SESSION_HOURS", 1, 72),
    demoMode: env.DEMO_MODE === "true",
    demoResetHours: int(env.DEMO_RESET_HOURS, 6, "DEMO_RESET_HOURS", 1, 168),
    demoPassword: env.DEMO_PASSWORD ?? "CompenDemo!2026",
    globalRateLimitPerMinute: int(env.GLOBAL_RATE_LIMIT_PER_MINUTE, 300, "GLOBAL_RATE_LIMIT_PER_MINUTE", 10, 100000),
    loginRateLimitPer15Min: int(env.LOGIN_RATE_LIMIT_PER_15_MIN, 10, "LOGIN_RATE_LIMIT_PER_15_MIN", 1, 10000),
  });
}

/** @typedef {ReturnType<typeof loadConfig>} Config */
