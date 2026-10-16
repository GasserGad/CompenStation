// Admin-only API. Every route here requires an admin session (see router.use).
// Actions that affect pay are written to the audit log.

import { Router } from "express";
import { hashPassword } from "../auth/password.js";
import { destroyAllSessionsForUser } from "../auth/sessions.js";
import { withTransaction } from "../db.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import * as map from "../mappers.js";
import { audit, requireRole } from "../middleware.js";
import { toCents } from "../payroll.js";
import { runPayroll } from "../payrollRun.js";
import { parse, schemas } from "../validation.js";

const DEMO_MAX_EMPLOYEES = 60;

/** @param {{ pool: import("pg").Pool, config: import("../config.js").Config }} deps */
export function adminRoutes({ pool, config }) {
  const router = Router();
  router.use(requireRole("admin"));

  /** @param {import("express").Response} res */
  const actor = (res) => res.locals.user.id;
  /** @param {import("express").Request} req */
  // eslint-disable-next-line security/detect-object-injection -- name is always a literal route param
  const idParam = (req, name = "id") => parse(schemas.id, req.params[name]);

  /** @param {number} id */
  async function requireEmployee(id) {
    const { rows } = await pool.query("SELECT id FROM employees WHERE id = $1", [id]);
    if (!rows[0]) throw notFound("Employee");
  }

  // ─── Dashboard ──────────────────────────────────────────────────────────
  router.get("/dashboard", async (_req, res) => {
    const { rows } = await pool.query(`
      SELECT
        (SELECT count(*) FROM employees WHERE is_active) AS active_employees,
        (SELECT count(*) FROM timesheets WHERE status = 'SUBMITTED') AS pending_timesheets,
        (SELECT count(*) FROM timesheets WHERE status = 'APPROVED') AS approved_unpaid,
        (SELECT coalesce(sum(total_net_cents), 0) FROM payroll_runs) AS total_paid_cents,
        (SELECT count(*) FROM payroll_runs) AS payroll_runs`);
    const r = rows[0];
    res.json({
      activeEmployees: r.active_employees,
      pendingTimesheets: r.pending_timesheets,
      approvedUnpaid: r.approved_unpaid,
      totalPaid: r.total_paid_cents / 100,
      payrollRuns: r.payroll_runs,
    });
  });

  // ─── Employees ──────────────────────────────────────────────────────────
  router.get("/employees", async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT e.*, u.username FROM employees e LEFT JOIN users u ON u.employee_id = e.id
       ORDER BY e.is_active DESC, e.full_name LIMIT 500`
    );
    res.json(rows.map(map.employee));
  });

  router.get("/employees/:id", async (req, res) => {
    const { rows } = await pool.query(
      "SELECT e.*, u.username FROM employees e LEFT JOIN users u ON u.employee_id = e.id WHERE e.id = $1",
      [idParam(req)]
    );
    if (!rows[0]) throw notFound("Employee");
    res.json(map.employee(rows[0]));
  });

  // Creates the employee record and their login together, in one transaction.
  router.post("/employees", async (req, res) => {
    const e = parse(schemas.createEmployee, req.body);
    if (config.demoMode) {
      const { rows } = await pool.query("SELECT count(*) AS n FROM employees");
      if (rows[0].n >= DEMO_MAX_EMPLOYEES) throw forbidden("The demo is full. It resets automatically every few hours.");
    }
    const passwordHash = await hashPassword(e.password);
    try {
      const created = await withTransaction(pool, async (client) => {
        const { rows } = await client.query(
          `INSERT INTO employees (full_name, email, phone, address, department, job_title, hourly_rate_cents)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [e.fullName, e.email, e.phone ?? null, e.address ?? null, e.department ?? null, e.jobTitle ?? null, toCents(e.hourlyRate)]
        );
        await client.query(
          "INSERT INTO users (employee_id, username, password_hash, role) VALUES ($1, $2, $3, 'employee')",
          [rows[0].id, e.username, passwordHash]
        );
        await audit(client, actor(res), "employee.create", "employee", rows[0].id, { hourlyRate: e.hourlyRate });
        return { ...rows[0], username: e.username };
      });
      res.status(201).json(map.employee(created));
    } catch (err) {
      if (/** @type {any} */ (err).code === "23505") throw conflict("That email or username is already taken.");
      throw err;
    }
  });

  router.patch("/employees/:id", async (req, res) => {
    const id = idParam(req);
    const p = parse(schemas.updateEmployee, req.body);
    const sets = [];
    const values = [id];
    /** @param {string} column @param {unknown} value */
    const set = (column, value) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    // Column names below are fixed strings, never taken from the request.
    if (p.fullName !== undefined) set("full_name", p.fullName);
    if (p.email !== undefined) set("email", p.email);
    if ("phone" in p) set("phone", p.phone ?? null);
    if ("address" in p) set("address", p.address ?? null);
    if ("department" in p) set("department", p.department ?? null);
    if ("jobTitle" in p) set("job_title", p.jobTitle ?? null);
    if (p.hourlyRate !== undefined) set("hourly_rate_cents", toCents(p.hourlyRate));
    if (p.isActive !== undefined) set("is_active", p.isActive);
    if (sets.length === 0) throw badRequest("No fields to update.");

    try {
      const updated = await withTransaction(pool, async (client) => {
        const { rows } = await client.query(
          `UPDATE employees SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`,
          values
        );
        if (!rows[0]) throw notFound("Employee");
        if (p.isActive === false) {
          // A deactivated employee is logged out everywhere immediately.
          const { rows: u } = await client.query("SELECT id FROM users WHERE employee_id = $1", [id]);
          if (u[0]) await destroyAllSessionsForUser(client, u[0].id);
        }
        await audit(client, actor(res), "employee.update", "employee", id, { fields: Object.keys(p) });
        return rows[0];
      });
      res.json(map.employee(updated));
    } catch (err) {
      if (/** @type {any} */ (err).code === "23505") throw conflict("That email is already taken.");
      throw err;
    }
  });

  // ─── Benefits ───────────────────────────────────────────────────────────
  router.get("/employees/:id/benefits", async (req, res) => {
    const id = idParam(req);
    await requireEmployee(id);
    const { rows } = await pool.query("SELECT * FROM benefits WHERE employee_id = $1 ORDER BY id", [id]);
    res.json(rows.map(map.benefit));
  });

  router.post("/employees/:id/benefits", async (req, res) => {
    const id = idParam(req);
    const b = parse(schemas.createBenefit, req.body);
    await requireEmployee(id);
    const { rows } = await pool.query(
      `INSERT INTO benefits (employee_id, benefit_type, plan_name, employee_cost_cents, employer_cost_cents, is_enrolled)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, b.benefitType, b.planName ?? null, toCents(b.employeeCost), toCents(b.employerCost), b.isEnrolled]
    );
    await audit(pool, actor(res), "benefit.create", "benefit", rows[0].id, { employeeId: id });
    res.status(201).json(map.benefit(rows[0]));
  });

  router.patch("/employees/:id/benefits/:benefitId", async (req, res) => {
    const id = idParam(req);
    const benefitId = idParam(req, "benefitId");
    const p = parse(schemas.updateBenefit, req.body);
    const { rows } = await pool.query(
      `UPDATE benefits SET
         plan_name = CASE WHEN $3::boolean THEN $4 ELSE plan_name END,
         employee_cost_cents = coalesce($5, employee_cost_cents),
         employer_cost_cents = coalesce($6, employer_cost_cents),
         is_enrolled = coalesce($7, is_enrolled)
       WHERE id = $1 AND employee_id = $2 RETURNING *`,
      [
        benefitId, id, "planName" in p, p.planName ?? null,
        p.employeeCost === undefined ? null : toCents(p.employeeCost),
        p.employerCost === undefined ? null : toCents(p.employerCost),
        p.isEnrolled ?? null,
      ]
    );
    if (!rows[0]) throw notFound("Benefit");
    await audit(pool, actor(res), "benefit.update", "benefit", benefitId, { fields: Object.keys(p) });
    res.json(map.benefit(rows[0]));
  });

  router.delete("/employees/:id/benefits/:benefitId", async (req, res) => {
    const id = idParam(req);
    const benefitId = idParam(req, "benefitId");
    const { rowCount } = await pool.query("DELETE FROM benefits WHERE id = $1 AND employee_id = $2", [benefitId, id]);
    if (!rowCount) throw notFound("Benefit");
    await audit(pool, actor(res), "benefit.delete", "benefit", benefitId, { employeeId: id });
    res.status(204).end();
  });

  // ─── Deductions (taxes, garnishments, etc.) ────────────────────────────
  router.get("/employees/:id/deductions", async (req, res) => {
    const id = idParam(req);
    await requireEmployee(id);
    const { rows } = await pool.query("SELECT * FROM deductions WHERE employee_id = $1 ORDER BY id", [id]);
    res.json(rows.map(map.deduction));
  });

  router.post("/employees/:id/deductions", async (req, res) => {
    const id = idParam(req);
    const d = parse(schemas.createDeduction, req.body);
    await requireEmployee(id);
    const { rows } = await pool.query(
      `INSERT INTO deductions (employee_id, deduction_type, label, percent, flat_cents, is_active)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, d.deductionType, d.label ?? null, d.percent ?? null, d.flatAmount === undefined ? null : toCents(d.flatAmount), d.isActive]
    );
    await audit(pool, actor(res), "deduction.create", "deduction", rows[0].id, { employeeId: id });
    res.status(201).json(map.deduction(rows[0]));
  });

  router.patch("/employees/:id/deductions/:deductionId", async (req, res) => {
    const id = idParam(req);
    const deductionId = idParam(req, "deductionId");
    const p = parse(schemas.updateDeduction, req.body);
    const { rows } = await pool.query(
      `UPDATE deductions SET
         label = CASE WHEN $3::boolean THEN $4 ELSE label END,
         is_active = coalesce($5, is_active)
       WHERE id = $1 AND employee_id = $2 RETURNING *`,
      [deductionId, id, "label" in p, p.label ?? null, p.isActive ?? null]
    );
    if (!rows[0]) throw notFound("Deduction");
    await audit(pool, actor(res), "deduction.update", "deduction", deductionId, { fields: Object.keys(p) });
    res.json(map.deduction(rows[0]));
  });

  router.delete("/employees/:id/deductions/:deductionId", async (req, res) => {
    const id = idParam(req);
    const deductionId = idParam(req, "deductionId");
    const { rowCount } = await pool.query("DELETE FROM deductions WHERE id = $1 AND employee_id = $2", [deductionId, id]);
    if (!rowCount) throw notFound("Deduction");
    await audit(pool, actor(res), "deduction.delete", "deduction", deductionId, { employeeId: id });
    res.status(204).end();
  });

  // ─── Timesheets ─────────────────────────────────────────────────────────
  router.get("/timesheets", async (req, res) => {
    const status = parse(schemas.timesheetStatus, req.query.status ?? "SUBMITTED");
    const { rows } = await pool.query(
      `SELECT t.*, e.full_name FROM timesheets t JOIN employees e ON e.id = t.employee_id
       WHERE t.status = $1 ORDER BY t.period_start DESC, e.full_name LIMIT 500`,
      [status]
    );
    res.json(rows.map(map.timesheet));
  });

  /**
   * Move a SUBMITTED timesheet to APPROVED or REJECTED. The WHERE clause on
   * status makes this safe if two admins click at the same time.
   * @param {number} id @param {"APPROVED" | "REJECTED"} status @param {number} userId @param {string | null} reason
   */
  async function review(id, status, userId, reason) {
    const { rows } = await pool.query(
      `UPDATE timesheets SET status = $2, reviewed_at = now(), reviewed_by_user_id = $3, rejection_reason = $4
       WHERE id = $1 AND status = 'SUBMITTED' RETURNING *`,
      [id, status, userId, reason]
    );
    if (rows[0]) return rows[0];
    const { rows: existing } = await pool.query("SELECT status FROM timesheets WHERE id = $1", [id]);
    if (!existing[0]) throw notFound("Timesheet");
    throw conflict(`This timesheet is already ${existing[0].status.toLowerCase()}.`);
  }

  router.post("/timesheets/:id/approve", async (req, res) => {
    const id = idParam(req);
    const row = await review(id, "APPROVED", actor(res), null);
    await audit(pool, actor(res), "timesheet.approve", "timesheet", id);
    res.json(map.timesheet(row));
  });

  router.post("/timesheets/:id/reject", async (req, res) => {
    const id = idParam(req);
    const { reason } = parse(schemas.rejectTimesheet, req.body);
    const row = await review(id, "REJECTED", actor(res), reason);
    await audit(pool, actor(res), "timesheet.reject", "timesheet", id, { reason });
    res.json(map.timesheet(row));
  });

  // ─── Payroll ────────────────────────────────────────────────────────────
  router.post("/payroll/run", async (req, res) => {
    const { periodStart, periodEnd } = parse(schemas.runPayroll, req.body);
    const run = await withTransaction(pool, async (client) => {
      const created = await runPayroll(client, { periodStart, periodEnd, actorUserId: actor(res) });
      await audit(client, actor(res), "payroll.run", "payroll_run", created.id, {
        periodStart, periodEnd, employees: created.employee_count,
      });
      return created;
    });
    res.status(201).json(map.payrollRun({ ...run, username: res.locals.user.username }));
  });

  router.get("/payroll/runs", async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT r.*, u.username FROM payroll_runs r LEFT JOIN users u ON u.id = r.executed_by_user_id
       ORDER BY r.created_at DESC LIMIT 100`
    );
    res.json(rows.map(map.payrollRun));
  });

  router.get("/payroll/runs/:id", async (req, res) => {
    const id = idParam(req);
    const { rows: runRows } = await pool.query(
      "SELECT r.*, u.username FROM payroll_runs r LEFT JOIN users u ON u.id = r.executed_by_user_id WHERE r.id = $1",
      [id]
    );
    if (!runRows[0]) throw notFound("Payroll run");
    const { rows: stubs } = await pool.query(
      `SELECT p.*, e.full_name FROM paystubs p JOIN employees e ON e.id = p.employee_id
       WHERE p.payroll_run_id = $1 ORDER BY e.full_name`,
      [id]
    );
    res.json({ run: map.payrollRun(runRows[0]), paystubs: stubs.map(map.paystub) });
  });

  // ─── Audit log ──────────────────────────────────────────────────────────
  router.get("/audit", async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT a.id, a.action, a.entity, a.entity_id, a.created_at, u.username
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
        ORDER BY a.created_at DESC, a.id DESC LIMIT 100`
    );
    res.json(rows.map((r) => ({
      id: r.id, action: r.action, entity: r.entity, entityId: r.entity_id, by: r.username, at: r.created_at,
    })));
  });

  return router;
}
