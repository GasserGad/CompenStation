// Employee self-service. Every query is scoped to the employee ID from the
// logged-in session, never to an ID sent by the browser, so one employee can
// never read or change another employee's data.

import { Router } from "express";
import { conflict, forbidden, notFound } from "../errors.js";
import * as map from "../mappers.js";
import { requireRole } from "../middleware.js";
import { parse, schemas } from "../validation.js";

/** @param {{ pool: import("pg").Pool }} deps */
export function meRoutes({ pool }) {
  const router = Router();
  router.use(requireRole("employee"));

  /** @param {import("express").Response} res */
  const myId = (res) => res.locals.user.employeeId;

  router.get("/profile", async (_req, res) => {
    const { rows } = await pool.query("SELECT * FROM employees WHERE id = $1", [myId(res)]);
    if (!rows[0]) throw notFound("Employee");
    res.json(map.employee(rows[0]));
  });

  router.patch("/profile", async (req, res) => {
    const body = parse(schemas.updateMyProfile, req.body);
    const { rows } = await pool.query(
      `UPDATE employees SET
         phone = CASE WHEN $2::boolean THEN $3 ELSE phone END,
         address = CASE WHEN $4::boolean THEN $5 ELSE address END,
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [myId(res), "phone" in body, body.phone ?? null, "address" in body, body.address ?? null]
    );
    res.json(map.employee(rows[0]));
  });

  router.get("/timesheets", async (_req, res) => {
    const { rows } = await pool.query(
      "SELECT * FROM timesheets WHERE employee_id = $1 ORDER BY period_start DESC LIMIT 200",
      [myId(res)]
    );
    res.json(rows.map(map.timesheet));
  });

  router.post("/timesheets", async (req, res) => {
    const t = parse(schemas.submitTimesheet, req.body);
    const { rows: emp } = await pool.query("SELECT is_active FROM employees WHERE id = $1", [myId(res)]);
    if (!emp[0]?.is_active) throw forbidden("Your employee record is inactive.");
    try {
      const { rows } = await pool.query(
        `INSERT INTO timesheets (employee_id, period_start, period_end, hours_worked, notes)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [myId(res), t.periodStart, t.periodEnd, t.hoursWorked, t.notes ?? null]
      );
      res.status(201).json(map.timesheet(rows[0]));
    } catch (err) {
      if (/** @type {any} */ (err).code === "23505") throw conflict("You already submitted a timesheet for this period.");
      throw err;
    }
  });

  router.get("/paystubs", async (_req, res) => {
    const { rows } = await pool.query(
      "SELECT * FROM paystubs WHERE employee_id = $1 ORDER BY period_start DESC LIMIT 100",
      [myId(res)]
    );
    res.json(rows.map(map.paystub));
  });

  router.get("/benefits", async (_req, res) => {
    const { rows } = await pool.query("SELECT * FROM benefits WHERE employee_id = $1 ORDER BY id", [myId(res)]);
    res.json(rows.map(map.benefit));
  });

  router.get("/deductions", async (_req, res) => {
    const { rows } = await pool.query("SELECT * FROM deductions WHERE employee_id = $1 ORDER BY id", [myId(res)]);
    res.json(rows.map(map.deduction));
  });

  return router;
}
