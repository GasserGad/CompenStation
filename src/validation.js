// Every request body and URL parameter is checked against a strict schema.
// Unknown fields are rejected (`.strict()`), so clients can't sneak in things
// like `role: "admin"` or `employeeId` to act as someone else.

import { z } from "zod";
import { badRequest } from "./errors.js";

// Printable text only: no control characters (they enable log forging and
// confuse spreadsheets/exports).
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const noControlChars = (s) => !/[\u0000-\u001f\u007f]/.test(s);

/** @param {number} max */
const text = (max) =>
  z.string().trim().min(1).max(max).refine(noControlChars, "contains invalid characters");
/** @param {number} max */
const optionalText = (max) =>
  z.string().trim().max(max).refine(noControlChars, "contains invalid characters").optional()
    .transform((v) => (v === "" ? undefined : v));

// True when n has at most 2 decimal places (allowing for float noise like 0.1 + 0.2).
const twoDecimals = (n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
const money = (max) => z.number().finite().min(0).max(max).refine(twoDecimals, "must have at most 2 decimal places");

const date = z.iso.date();
export const BENEFIT_TYPES = ["MEDICAL", "DENTAL", "VISION", "LIFE_INSURANCE", "RETIREMENT_401K", "OTHER"];
export const DEDUCTION_TYPES = ["FEDERAL_TAX", "STATE_TAX", "LOCAL_TAX", "SOCIAL_SECURITY", "MEDICARE", "GARNISHMENT", "OTHER"];

export const username = z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,32}$/, "3-32 characters: letters, numbers, dots, dashes or underscores");
export const newPassword = z.string().min(12, "must be at least 12 characters").max(128);

export const schemas = {
  login: z.object({ username: z.string().trim().toLowerCase().max(64), password: z.string().max(256) }).strict(),

  changePassword: z.object({ currentPassword: z.string().max(256), newPassword }).strict(),

  createEmployee: z.object({
    fullName: text(120),
    email: z.email().max(254).transform((e) => e.toLowerCase()),
    phone: optionalText(30),
    address: optionalText(200),
    department: optionalText(80),
    jobTitle: optionalText(80),
    hourlyRate: money(1_000_000),
    username,
    password: newPassword,
  }).strict(),

  updateEmployee: z.object({
    fullName: text(120).optional(),
    email: z.email().max(254).transform((e) => e.toLowerCase()).optional(),
    phone: optionalText(30),
    address: optionalText(200),
    department: optionalText(80),
    jobTitle: optionalText(80),
    hourlyRate: money(1_000_000).optional(),
    isActive: z.boolean().optional(),
  }).strict().refine((o) => Object.keys(o).length > 0, "no fields to update"),

  updateMyProfile: z.object({ phone: optionalText(30), address: optionalText(200) }).strict()
    .refine((o) => Object.keys(o).length > 0, "no fields to update"),

  submitTimesheet: z.object({
    periodStart: date,
    periodEnd: date,
    hoursWorked: z.number().finite().gt(0).max(120).refine(twoDecimals, "must have at most 2 decimal places"),
    notes: optionalText(500),
  }).strict().refine((t) => t.periodEnd > t.periodStart, { message: "periodEnd must be after periodStart", path: ["periodEnd"] })
    .refine((t) => (Date.parse(t.periodEnd) - Date.parse(t.periodStart)) / 86_400_000 <= 31, {
      message: "a pay period can be at most 31 days", path: ["periodEnd"],
    }),

  rejectTimesheet: z.object({ reason: text(300) }).strict(),

  createBenefit: z.object({
    benefitType: z.enum(BENEFIT_TYPES),
    planName: optionalText(120),
    employeeCost: money(100_000),
    employerCost: money(100_000).default(0),
    isEnrolled: z.boolean().default(true),
  }).strict(),

  updateBenefit: z.object({
    planName: optionalText(120),
    employeeCost: money(100_000).optional(),
    employerCost: money(100_000).optional(),
    isEnrolled: z.boolean().optional(),
  }).strict().refine((o) => Object.keys(o).length > 0, "no fields to update"),

  createDeduction: z.object({
    deductionType: z.enum(DEDUCTION_TYPES),
    label: optionalText(120),
    percent: z.number().finite().min(0).max(100).optional(),
    flatAmount: money(100_000).optional(),
    isActive: z.boolean().default(true),
  }).strict().refine((d) => (d.percent === undefined) !== (d.flatAmount === undefined), {
    message: "provide either percent or flatAmount, not both", path: ["percent"],
  }),

  updateDeduction: z.object({
    label: optionalText(120),
    isActive: z.boolean().optional(),
  }).strict().refine((o) => Object.keys(o).length > 0, "no fields to update"),

  runPayroll: z.object({ periodStart: date, periodEnd: date }).strict()
    .refine((t) => t.periodEnd > t.periodStart, { message: "periodEnd must be after periodStart", path: ["periodEnd"] }),

  timesheetStatus: z.enum(["SUBMITTED", "APPROVED", "REJECTED", "PAID"]),
  id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
};

/**
 * Validate `value` against `schema`; throw a 400 listing the bad fields.
 * @template T
 * @param {z.ZodType<T>} schema
 * @param {unknown} value
 * @returns {T}
 */
export function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) {
    const fields = result.error.issues.map((i) => ({ field: i.path.join(".") || "(body)", message: i.message }));
    throw badRequest("Some fields are invalid.", { fields });
  }
  return result.data;
}
