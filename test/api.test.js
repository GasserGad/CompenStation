import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import { client, DEMO_PASSWORD, employeeIdOf, loginAs, ORIGIN, setup } from "./helpers.js";

let app;
let pool;

before(async () => {
  ({ app, pool } = await setup());
});
after(async () => {
  await pool.end();
});

describe("authentication", () => {
  it("logs in and sets a hardened session cookie", async () => {
    const res = await client(app).post("/api/auth/login").send({ username: "admin", password: DEMO_PASSWORD }).expect(200);
    const cookie = res.headers["set-cookie"][0];
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\//);
    assert.equal(res.body.user.role, "admin");
    assert.equal(JSON.stringify(res.body).includes("password"), false);
  });

  it("gives the same answer for a wrong password and an unknown user", async () => {
    const wrong = await client(app).post("/api/auth/login").send({ username: "admin", password: "nope" }).expect(401);
    const unknown = await client(app).post("/api/auth/login").send({ username: "ghost", password: "nope" }).expect(401);
    assert.deepEqual(wrong.body, unknown.body);
  });

  it("never stores passwords or session tokens in readable form", async () => {
    const { rows } = await pool.query("SELECT password_hash FROM users WHERE username = 'admin'");
    assert.match(rows[0].password_hash, /^scrypt\$/);
    const res = await client(app).post("/api/auth/login").send({ username: "jdoe", password: DEMO_PASSWORD }).expect(200);
    const token = decodeURIComponent(/sid=([^;]+)/.exec(res.headers["set-cookie"][0])[1]);
    assert.ok(token.length >= 32);
    const { rows: s } = await pool.query(
      "SELECT count(*) AS n FROM sessions WHERE position(convert_to($1, 'UTF8') in token_hash) > 0 OR encode(token_hash, 'hex') = $1",
      [token],
    );
    assert.equal(s[0].n, 0, "raw token must not be stored");
    const { rows: all } = await pool.query("SELECT octet_length(token_hash) AS len FROM sessions LIMIT 1");
    assert.equal(all[0].len, 32, "sessions store a SHA-256 hash");
  });

  it("logs out and the old cookie stops working", async () => {
    const c = await loginAs(app, "jdoe");
    await c.get("/api/me/profile").expect(200);
    await c.post("/api/auth/logout").expect(204);
    await c.get("/api/me/profile").expect(401);
  });

  it("reports logged-out state without an error", async () => {
    const res = await request(app).get("/api/auth/me").expect(200);
    assert.equal(res.body.user, null);
  });

  it("blocks password changes in the public demo", async () => {
    const c = await loginAs(app, "jdoe");
    await c.post("/api/auth/password").send({ currentPassword: DEMO_PASSWORD, newPassword: "another-long-pass" }).expect(403);
  });
});

describe("CSRF protection", () => {
  it("rejects state-changing requests without our Origin", async () => {
    await request(app).post("/api/auth/login").send({ username: "admin", password: DEMO_PASSWORD }).expect(403);
    await request(app).post("/api/auth/login").set("Origin", "https://evil.example").send({ username: "admin", password: DEMO_PASSWORD }).expect(403);
  });

  it("rejects HTML-form style bodies", async () => {
    await request(app).post("/api/auth/login").set("Origin", ORIGIN).type("form").send("username=admin&password=x").expect(415);
  });
});

describe("authorization", () => {
  it("requires login for every API area", async () => {
    for (const path of ["/api/me/profile", "/api/admin/employees", "/api/admin/payroll/runs"]) {
      await request(app).get(path).expect(401);
    }
  });

  it("keeps employees out of admin routes", async () => {
    const c = await loginAs(app, "jdoe");
    await c.get("/api/admin/employees").expect(403);
    await c.post("/api/admin/payroll/run").send({ periodStart: "2026-01-01", periodEnd: "2026-01-14" }).expect(403);
  });

  it("keeps admins out of employee self-service routes", async () => {
    const c = await loginAs(app, "admin");
    await c.get("/api/me/profile").expect(403);
  });

  it("only ever shows an employee their own data", async () => {
    const jdoe = await loginAs(app, "jdoe");
    const profile = await jdoe.get("/api/me/profile").expect(200);
    assert.equal(profile.body.fullName, "John Doe");
    const stubs = await jdoe.get("/api/me/paystubs").expect(200);
    const jdoeId = await employeeIdOf(pool, "jdoe");
    assert.ok(stubs.body.length > 0);
    assert.ok(stubs.body.every((s) => s.employeeId === jdoeId));
  });

  it("ignores attempts to act as another employee", async () => {
    const jdoe = await loginAs(app, "jdoe");
    const other = await employeeIdOf(pool, "jsmith");
    await jdoe.post("/api/me/timesheets")
      .send({ periodStart: "2026-11-01", periodEnd: "2026-11-14", hoursWorked: 10, employeeId: other })
      .expect(400);
    await jdoe.patch("/api/me/profile").send({ hourlyRate: 999 }).expect(400);
  });

  it("scopes benefit edits to the employee in the URL", async () => {
    const admin = await loginAs(app, "admin");
    const jdoe = await employeeIdOf(pool, "jdoe");
    const jsmith = await employeeIdOf(pool, "jsmith");
    const { rows } = await pool.query("SELECT id FROM benefits WHERE employee_id = $1 LIMIT 1", [jdoe]);
    await admin.delete(`/api/admin/employees/${jsmith}/benefits/${rows[0].id}`).expect(404);
  });

  it("logs out a deactivated employee immediately", async () => {
    const kchen = await loginAs(app, "kchen");
    const admin = await loginAs(app, "admin");
    const id = await employeeIdOf(pool, "kchen");
    await admin.patch(`/api/admin/employees/${id}`).send({ isActive: false }).expect(200);
    await kchen.get("/api/me/profile").expect(401);
    await admin.patch(`/api/admin/employees/${id}`).send({ isActive: true }).expect(200);
  });
});

describe("timesheets and payroll", () => {
  it("runs the full flow: submit, approve, pay, paystub", async () => {
    const jsmith = await loginAs(app, "jsmith");
    const admin = await loginAs(app, "admin");
    const created = await jsmith.post("/api/me/timesheets")
      .send({ periodStart: "2026-12-01", periodEnd: "2026-12-14", hoursWorked: 40.5, notes: "Holiday week" })
      .expect(201);
    assert.equal(created.body.status, "SUBMITTED");

    await jsmith.post("/api/me/timesheets")
      .send({ periodStart: "2026-12-01", periodEnd: "2026-12-14", hoursWorked: 10 })
      .expect(409);

    await admin.post(`/api/admin/timesheets/${created.body.id}/approve`).expect(200);
    await admin.post(`/api/admin/timesheets/${created.body.id}/approve`).expect(409);

    const run = await admin.post("/api/admin/payroll/run").send({ periodStart: "2026-12-01", periodEnd: "2026-12-14" }).expect(201);
    assert.equal(run.body.employeeCount, 1);
    assert.equal(run.body.totalGross, 1134); // 40.5 h × $28.00

    await admin.post("/api/admin/payroll/run").send({ periodStart: "2026-12-01", periodEnd: "2026-12-14" }).expect(400);

    const stubs = await jsmith.get("/api/me/paystubs").expect(200);
    const stub = stubs.body.find((s) => s.periodStart === "2026-12-01");
    assert.ok(stub);
    assert.equal(stub.grossPay, 1134);
    assert.equal(stub.netPay, +(1134 - stub.taxes - stub.benefits).toFixed(2));

    const { rows } = await pool.query("SELECT action FROM audit_log WHERE action IN ('timesheet.approve', 'payroll.run')");
    assert.ok(rows.length >= 2);
  });

  it("requires a reason to reject a timesheet and shows it to the employee", async () => {
    const mgarcia = await loginAs(app, "mgarcia");
    const admin = await loginAs(app, "admin");
    const t = await mgarcia.post("/api/me/timesheets").send({ periodStart: "2027-01-01", periodEnd: "2027-01-14", hoursWorked: 90 }).expect(201);
    await admin.post(`/api/admin/timesheets/${t.body.id}/reject`).send({}).expect(400);
    await admin.post(`/api/admin/timesheets/${t.body.id}/reject`).send({ reason: "Hours look too high" }).expect(200);
    const mine = await mgarcia.get("/api/me/timesheets").expect(200);
    assert.equal(mine.body.find((x) => x.id === t.body.id).rejectionReason, "Hours look too high");
  });

  it("never pays a timesheet twice, even with simultaneous payroll runs", async () => {
    const jdoe = await loginAs(app, "jdoe");
    const admin = await loginAs(app, "admin");
    const t = await jdoe.post("/api/me/timesheets").send({ periodStart: "2027-02-01", periodEnd: "2027-02-14", hoursWorked: 8 }).expect(201);
    await admin.post(`/api/admin/timesheets/${t.body.id}/approve`).expect(200);

    const body = { periodStart: "2027-02-01", periodEnd: "2027-02-14" };
    const results = await Promise.all([1, 2, 3].map(() => admin.post("/api/admin/payroll/run").send(body)));
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    const { rows } = await pool.query("SELECT count(*) AS n FROM paystubs WHERE timesheet_id = $1", [t.body.id]);
    assert.equal(rows[0].n, 1);
  });
});

describe("admin employee management", () => {
  it("creates an employee with a login that works", async () => {
    const admin = await loginAs(app, "admin");
    const res = await admin.post("/api/admin/employees").send({
      fullName: "Test Person", email: "Test.Person@Example.com", hourlyRate: 22.5,
      username: "tperson", password: "a-very-long-password",
    }).expect(201);
    assert.equal(res.body.email, "test.person@example.com");
    assert.equal(res.body.hourlyRate, 22.5);
    await loginAs(app, "tperson", "a-very-long-password");
  });

  it("rejects duplicate usernames and emails", async () => {
    const admin = await loginAs(app, "admin");
    await admin.post("/api/admin/employees").send({
      fullName: "Dup", email: "john.doe@example.com", hourlyRate: 10, username: "dup-user", password: "a-very-long-password",
    }).expect(409);
  });

  it("validates IDs in URLs", async () => {
    const admin = await loginAs(app, "admin");
    await admin.get("/api/admin/employees/abc").expect(400);
    await admin.get("/api/admin/employees/999999").expect(404);
    await admin.get("/api/admin/employees/1;DROP TABLE users").expect(400);
  });
});

describe("HTTP hardening", () => {
  it("sets security headers and disables caching of API data", async () => {
    const page = await request(app).get("/").expect(200);
    assert.match(page.headers["content-security-policy"], /default-src 'self'/);
    assert.match(page.headers["content-security-policy"], /frame-ancestors 'none'/);
    assert.equal(page.headers["x-powered-by"], undefined);
    const c = await loginAs(app, "admin");
    const api = await c.get("/api/admin/dashboard").expect(200);
    assert.equal(api.headers["cache-control"], "no-store");
  });

  it("returns safe errors for bad JSON and oversized bodies", async () => {
    const bad = await request(app).post("/api/auth/login").set("Origin", ORIGIN).set("Content-Type", "application/json").send("{bad").expect(400);
    assert.equal(bad.body.error.code, "bad_json");
    await request(app).post("/api/auth/login").set("Origin", ORIGIN).send({ username: "x".repeat(30_000), password: "y" }).expect(413);
  });

  it("does not serve files outside the public folder", async () => {
    for (const path of ["/../package.json", "/%2e%2e/src/config.js", "/.env"]) {
      const res = await request(app).get(path);
      assert.notEqual(res.status, 200, path);
    }
  });
});
