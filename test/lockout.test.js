// Account lockout and rate limiting run with DEMO_MODE off, as in a real deployment.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { client, DEMO_PASSWORD, setup } from "./helpers.js";

describe("brute-force protection (non-demo mode)", () => {
  let ctx;
  before(async () => {
    ctx = await setup({ DEMO_MODE: "false", LOGIN_RATE_LIMIT_PER_15_MIN: "8" });
  });
  after(async () => {
    await ctx.pool.end();
  });

  it("locks an account after 5 wrong passwords, even with the right one after", async () => {
    const c = client(ctx.app);
    for (let i = 0; i < 5; i++) {
      await c.post("/api/auth/login").send({ username: "jsmith", password: "wrong" }).expect(401);
    }
    const locked = await c.post("/api/auth/login").send({ username: "jsmith", password: DEMO_PASSWORD }).expect(423);
    assert.equal(locked.body.error.code, "locked");
  });

  it("rate-limits login attempts per IP", async () => {
    const c = client(ctx.app);
    // 6 attempts were used above; the limit is 8 per 15 minutes.
    await c.post("/api/auth/login").send({ username: "kchen", password: "wrong" }).expect(401);
    await c.post("/api/auth/login").send({ username: "kchen", password: "wrong" }).expect(401);
    const limited = await c.post("/api/auth/login").send({ username: "kchen", password: "wrong" }).expect(429);
    assert.equal(limited.body.error.code, "rate_limited");
  });

  it("changing a password logs out other sessions", async () => {
    const fresh = await setup({ DEMO_MODE: "false" });
    try {
      const phone = client(fresh.app);
      const laptop = client(fresh.app);
      await phone.post("/api/auth/login").send({ username: "mgarcia", password: DEMO_PASSWORD }).expect(200);
      await laptop.post("/api/auth/login").send({ username: "mgarcia", password: DEMO_PASSWORD }).expect(200);
      await laptop.post("/api/auth/password").send({ currentPassword: "wrong", newPassword: "brand-new-password" }).expect(400);
      await laptop.post("/api/auth/password").send({ currentPassword: DEMO_PASSWORD, newPassword: "brand-new-password" }).expect(204);
      await phone.get("/api/me/profile").expect(401);
      await laptop.get("/api/me/profile").expect(200);
    } finally {
      await fresh.pool.end();
    }
  });
});
