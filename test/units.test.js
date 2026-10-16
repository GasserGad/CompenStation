import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashPassword, verifyPassword } from "../src/auth/password.js";
import { readCookie } from "../src/auth/sessions.js";
import { loadConfig } from "../src/config.js";
import { computePaystub, grossCents, toCents } from "../src/payroll.js";
import { parse, schemas } from "../src/validation.js";

describe("payroll math (cents)", () => {
  it("computes gross pay exactly, with no float drift", () => {
    assert.equal(grossCents(80, 3500), 280000);
    assert.equal(grossCents(78.5, 3500), 274750);
    assert.equal(grossCents(0.1 + 0.2, 1000), 300); // 0.30000000000000004 hours
    assert.equal(toCents(19.99), 1999);
  });

  it("applies percentage and flat deductions plus benefits", () => {
    const stub = computePaystub({
      hoursWorked: 80,
      hourlyRateCents: 3500,
      deductions: [
        { deductionType: "FEDERAL_TAX", label: "Federal", percent: 12, flatCents: null },
        { deductionType: "GARNISHMENT", label: "Garnishment", percent: null, flatCents: 2500 },
      ],
      benefits: [{ benefitType: "MEDICAL", planName: "PPO", employeeCostCents: 15000 }],
    });
    assert.equal(stub.grossCents, 280000);
    assert.equal(stub.taxCents, 33600 + 2500);
    assert.equal(stub.benefitCents, 15000);
    assert.equal(stub.netCents, 280000 - 36100 - 15000);
    assert.equal(stub.breakdown.deductions.length, 2);
  });

  it("never produces negative net pay", () => {
    const stub = computePaystub({
      hoursWorked: 1, hourlyRateCents: 1000, deductions: [],
      benefits: [{ benefitType: "MEDICAL", planName: null, employeeCostCents: 50000 }],
    });
    assert.equal(stub.netCents, 0);
  });

  it("matches the demo's John Doe paystub", () => {
    const pct = (p) => ({ deductionType: "OTHER", label: null, percent: p, flatCents: null });
    const stub = computePaystub({
      hoursWorked: 80, hourlyRateCents: 3500,
      deductions: [pct(12), pct(5), pct(6.2), pct(1.45)],
      benefits: [15000, 1500, 5000].map((c) => ({ benefitType: "OTHER", planName: null, employeeCostCents: c })),
    });
    assert.equal(stub.netCents, 189480); // $1,894.80
  });
});

describe("password hashing", () => {
  it("verifies the right password and rejects the wrong one", async () => {
    const hash = await hashPassword("correct horse battery");
    assert.match(hash, /^scrypt\$32768\$8\$1\$/);
    assert.equal(await verifyPassword("correct horse battery", hash), true);
    assert.equal(await verifyPassword("correct horse batterY", hash), false);
  });

  it("salts every hash", async () => {
    assert.notEqual(await hashPassword("same-password-x"), await hashPassword("same-password-x"));
  });

  it("rejects malformed stored hashes", async () => {
    assert.equal(await verifyPassword("x", "plaintext"), false);
  });
});

describe("validation", () => {
  it("rejects unknown fields so clients can't set role or employeeId", () => {
    assert.throws(() => parse(schemas.login, { username: "a", password: "b", role: "admin" }), /invalid/);
  });

  it("requires strong-enough passwords", () => {
    const base = { fullName: "A B", email: "a@b.co", hourlyRate: 20, username: "abc" };
    assert.throws(() => parse(schemas.createEmployee, { ...base, password: "short" }));
    assert.doesNotThrow(() => parse(schemas.createEmployee, { ...base, password: "long-enough-pass" }));
  });

  it("checks timesheet periods and hours", () => {
    const ok = { periodStart: "2026-10-01", periodEnd: "2026-10-14", hoursWorked: 80 };
    assert.doesNotThrow(() => parse(schemas.submitTimesheet, ok));
    assert.throws(() => parse(schemas.submitTimesheet, { ...ok, periodEnd: "2026-09-30" }));
    assert.throws(() => parse(schemas.submitTimesheet, { ...ok, hoursWorked: 121 }));
    assert.throws(() => parse(schemas.submitTimesheet, { ...ok, hoursWorked: 8.123 }));
    assert.throws(() => parse(schemas.submitTimesheet, { ...ok, periodEnd: "2026-12-30" }));
    assert.throws(() => parse(schemas.submitTimesheet, { ...ok, notes: "line1\u0000" }));
  });

  it("requires exactly one of percent or flat amount for deductions", () => {
    assert.throws(() => parse(schemas.createDeduction, { deductionType: "OTHER" }));
    assert.throws(() => parse(schemas.createDeduction, { deductionType: "OTHER", percent: 5, flatAmount: 10 }));
    assert.doesNotThrow(() => parse(schemas.createDeduction, { deductionType: "OTHER", flatAmount: 10 }));
  });
});

describe("config", () => {
  it("requires a database and an https origin in production", () => {
    assert.throws(() => loadConfig({}), /DATABASE_URL/);
    assert.throws(() => loadConfig({ DATABASE_URL: "x", NODE_ENV: "production" }), /PUBLIC_ORIGIN/);
    assert.throws(() => loadConfig({ DATABASE_URL: "x", NODE_ENV: "production", PUBLIC_ORIGIN: "http://a.com" }), /https/);
  });

  it("reads cookies from a header", () => {
    assert.equal(readCookie("a=1; sid=abc%3D; b=2", "sid"), "abc=");
    assert.equal(readCookie(undefined, "sid"), null);
  });
});
