// Demo data for the public showcase. Every person here is fictional.
// In DEMO_MODE the database is wiped and re-seeded on startup and every few
// hours, so whatever visitors change never sticks around.

import { hashPassword } from "./auth/password.js";
import { withTransaction } from "./db.js";
import { runPayroll } from "./payrollRun.js";

const DAY = 86_400_000;
/** @param {number} ms */
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Three back-to-back two-week pay periods ending yesterday. */
function recentPeriods(now = Date.now()) {
  const today = Math.floor(now / DAY) * DAY;
  return [42, 28, 14].map((daysAgo) => ({
    start: isoDate(today - daysAgo * DAY),
    end: isoDate(today - (daysAgo - 13) * DAY),
  }));
}

const PEOPLE = [
  { username: "jdoe", fullName: "John Doe", email: "john.doe@example.com", phone: "555-0101", address: "123 Main St, Springfield", department: "Engineering", jobTitle: "Software Developer", rate: 3500 },
  { username: "jsmith", fullName: "Jane Smith", email: "jane.smith@example.com", phone: "555-0102", address: "456 Oak Ave, Shelbyville", department: "Human Resources", jobTitle: "HR Coordinator", rate: 2800 },
  { username: "mgarcia", fullName: "Maria Garcia", email: "maria.garcia@example.com", phone: "555-0103", address: "789 Pine Rd, Capital City", department: "Operations", jobTitle: "Project Manager", rate: 4200 },
  { username: "kchen", fullName: "Kevin Chen", email: "kevin.chen@example.com", phone: "555-0104", address: "321 Elm St, Ogdenville", department: "Engineering", jobTitle: "QA Analyst", rate: 3100 },
];

// Per-employee taxes (percent of gross) and benefits (cents per pay period),
// based on the original team's sample data.
const TAXES = [
  ["FEDERAL_TAX", "Federal income tax", 12], ["STATE_TAX", "State income tax", 5],
  ["SOCIAL_SECURITY", "Social Security", 6.2], ["MEDICARE", "Medicare", 1.45],
];
const BENEFITS = {
  jdoe: [["MEDICAL", "Blue Cross PPO", 15000, 40000], ["DENTAL", "Delta Dental", 1500, 3000], ["RETIREMENT_401K", "401(k) plan", 5000, 5000]],
  jsmith: [["MEDICAL", "Blue Cross HMO", 10000, 35000]],
  mgarcia: [["MEDICAL", "Blue Cross PPO", 15000, 40000], ["VISION", "VSP Vision", 800, 1200]],
  kchen: [["DENTAL", "Delta Dental", 1500, 3000]],
};
const HOURS = { jdoe: [80, 80, 78.5], jsmith: [76, 80, 80], mgarcia: [80, 82, 80], kchen: [72, 80, 64] };

/**
 * Wipe everything and load the demo data set.
 * @param {import("pg").Pool} pool
 * @param {string} password shared demo password
 */
export async function resetDemoData(pool, password) {
  const passwordHash = await hashPassword(password);
  const [p0, p1, p2] = recentPeriods();

  await withTransaction(pool, async (client) => {
    await client.query(
      "TRUNCATE audit_log, paystubs, payroll_runs, timesheets, deductions, benefits, sessions, users, employees RESTART IDENTITY CASCADE"
    );
    const { rows: adminRows } = await client.query(
      "INSERT INTO users (username, password_hash, role) VALUES ('admin', $1, 'admin') RETURNING id",
      [passwordHash]
    );
    const adminId = adminRows[0].id;

    for (const person of PEOPLE) {
      const { rows } = await client.query(
        `INSERT INTO employees (full_name, email, phone, address, department, job_title, hourly_rate_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [person.fullName, person.email, person.phone, person.address, person.department, person.jobTitle, person.rate]
      );
      const employeeId = rows[0].id;
      await client.query(
        "INSERT INTO users (employee_id, username, password_hash, role) VALUES ($1, $2, $3, 'employee')",
        [employeeId, person.username, passwordHash]
      );
      for (const [type, label, percent] of TAXES) {
        await client.query(
          "INSERT INTO deductions (employee_id, deduction_type, label, percent) VALUES ($1, $2, $3, $4)",
          [employeeId, type, label, percent]
        );
      }
      for (const [type, plan, employeeCost, employerCost] of BENEFITS[person.username]) {
        await client.query(
          "INSERT INTO benefits (employee_id, benefit_type, plan_name, employee_cost_cents, employer_cost_cents) VALUES ($1, $2, $3, $4, $5)",
          [employeeId, type, plan, employeeCost, employerCost]
        );
      }

      const [h0, h1, h2] = HOURS[person.username];
      // Two older periods: approved, then paid by the payroll runs below.
      for (const [period, hours] of [[p0, h0], [p1, h1]]) {
        await client.query(
          `INSERT INTO timesheets (employee_id, period_start, period_end, hours_worked, status, reviewed_at, reviewed_by_user_id)
           VALUES ($1, $2, $3, $4, 'APPROVED', now(), $5)`,
          [employeeId, period.start, period.end, hours, adminId]
        );
      }
      // Latest period: two approved (ready for payroll), two waiting for review.
      const approved = person.username === "jdoe" || person.username === "mgarcia";
      await client.query(
        `INSERT INTO timesheets (employee_id, period_start, period_end, hours_worked, status, reviewed_at, reviewed_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [employeeId, p2.start, p2.end, h2, approved ? "APPROVED" : "SUBMITTED", approved ? new Date() : null, approved ? adminId : null]
      );
    }

    await runPayroll(client, { periodStart: p0.start, periodEnd: p0.end, actorUserId: adminId });
    await runPayroll(client, { periodStart: p1.start, periodEnd: p1.end, actorUserId: adminId });
  });
}
