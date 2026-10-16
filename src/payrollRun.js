import { badRequest } from "./errors.js";
import { computePaystub } from "./payroll.js";

/**
 * Pay every APPROVED timesheet for an exact pay period. Must be called inside
 * a transaction. Approved timesheets are locked with FOR UPDATE, and
 * paystubs.timesheet_id is UNIQUE, so the same timesheet can never be paid
 * twice, even if "Run payroll" is clicked twice at the same moment.
 * @param {import("pg").PoolClient} client
 * @param {{ periodStart: string, periodEnd: string, actorUserId: number | null }} input
 */
export async function runPayroll(client, { periodStart, periodEnd, actorUserId }) {
  const { rows: sheets } = await client.query(
    `SELECT t.id, t.employee_id, t.hours_worked, e.hourly_rate_cents
       FROM timesheets t JOIN employees e ON e.id = t.employee_id
      WHERE t.status = 'APPROVED' AND t.period_start = $1 AND t.period_end = $2
      ORDER BY t.id FOR UPDATE OF t`,
    [periodStart, periodEnd]
  );
  if (sheets.length === 0) throw badRequest("There are no approved, unpaid timesheets for that exact pay period.");

  const stubs = [];
  for (const s of sheets) {
    const { rows: deductions } = await client.query(
      "SELECT deduction_type, label, percent, flat_cents FROM deductions WHERE employee_id = $1 AND is_active ORDER BY id",
      [s.employee_id]
    );
    const { rows: benefits } = await client.query(
      "SELECT benefit_type, plan_name, employee_cost_cents FROM benefits WHERE employee_id = $1 AND is_enrolled ORDER BY id",
      [s.employee_id]
    );
    const stub = computePaystub({
      hoursWorked: s.hours_worked,
      hourlyRateCents: s.hourly_rate_cents,
      deductions: deductions.map((d) => ({ deductionType: d.deduction_type, label: d.label, percent: d.percent, flatCents: d.flat_cents })),
      benefits: benefits.map((b) => ({ benefitType: b.benefit_type, planName: b.plan_name, employeeCostCents: b.employee_cost_cents })),
    });
    stubs.push({ sheet: s, ...stub });
  }

  /** @param {"grossCents" | "taxCents" | "benefitCents" | "netCents"} key */
  // eslint-disable-next-line security/detect-object-injection -- key is one of four fixed names
  const sum = (key) => stubs.reduce((t, s) => t + s[key], 0);
  const { rows } = await client.query(
    `INSERT INTO payroll_runs (period_start, period_end, executed_by_user_id, total_gross_cents, total_deductions_cents, total_net_cents, employee_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [periodStart, periodEnd, actorUserId, sum("grossCents"), sum("taxCents") + sum("benefitCents"), sum("netCents"), stubs.length]
  );
  const run = rows[0];

  for (const s of stubs) {
    await client.query(
      `INSERT INTO paystubs (payroll_run_id, employee_id, timesheet_id, period_start, period_end, hours_worked,
         hourly_rate_cents, gross_cents, tax_cents, benefit_cents, net_cents, breakdown)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [run.id, s.sheet.employee_id, s.sheet.id, periodStart, periodEnd, s.sheet.hours_worked,
        s.sheet.hourly_rate_cents, s.grossCents, s.taxCents, s.benefitCents, s.netCents, JSON.stringify(s.breakdown)]
    );
    await client.query("UPDATE timesheets SET status = 'PAID', paid_at = now() WHERE id = $1", [s.sheet.id]);
  }
  return run;
}
