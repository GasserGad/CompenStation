// Pure payroll math: no database, no HTTP. Ported from the original team's
// algorithms.js, with one change: all money is handled in integer cents so
// totals never drift from floating-point rounding (0.1 + 0.2 !== 0.3).

/**
 * @typedef {object} DeductionInput
 * @property {string} deductionType
 * @property {string | null} label
 * @property {number | null} percent   percent of gross (e.g. 6.2), or null
 * @property {number | null} flatCents flat amount per pay period, or null
 *
 * @typedef {object} BenefitInput
 * @property {string} benefitType
 * @property {string | null} planName
 * @property {number} employeeCostCents
 */

/**
 * Gross pay in cents for hours worked at an hourly rate.
 * @param {number} hoursWorked e.g. 80.5
 * @param {number} hourlyRateCents e.g. 3500 for $35.00/h
 */
export function grossCents(hoursWorked, hourlyRateCents) {
  // Hours have at most 2 decimals; work in hundredths of an hour to stay exact.
  const hundredths = Math.round(hoursWorked * 100);
  return Math.round((hundredths * hourlyRateCents) / 100);
}

/**
 * Compute one employee's paystub for a period.
 * Steps (from the team's original design):
 *   1. gross = hours x hourly rate
 *   2. taxes and other deductions = active % deductions of gross + flat deductions
 *   3. benefits = employee cost of every enrolled benefit
 *   4. net = gross - taxes - benefits, never below zero
 * @param {{ hoursWorked: number, hourlyRateCents: number, deductions: DeductionInput[], benefits: BenefitInput[] }} input
 */
export function computePaystub({ hoursWorked, hourlyRateCents, deductions, benefits }) {
  const gross = grossCents(hoursWorked, hourlyRateCents);

  const deductionLines = deductions.map((d) => {
    const cents = d.percent != null ? Math.round((gross * d.percent) / 100) : d.flatCents ?? 0;
    return { type: d.deductionType, label: d.label ?? d.deductionType, cents };
  });
  const benefitLines = benefits.map((b) => ({
    type: b.benefitType,
    label: b.planName ?? b.benefitType,
    cents: b.employeeCostCents,
  }));

  const taxCents = deductionLines.reduce((sum, l) => sum + l.cents, 0);
  const benefitCents = benefitLines.reduce((sum, l) => sum + l.cents, 0);
  const netCents = Math.max(0, gross - taxCents - benefitCents);

  return {
    grossCents: gross,
    taxCents,
    benefitCents,
    netCents,
    breakdown: { deductions: deductionLines, benefits: benefitLines },
  };
}

/** @param {number} dollars e.g. 35.5 → 3550 */
export const toCents = (dollars) => Math.round(dollars * 100);
