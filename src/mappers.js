// Convert database rows into API objects. Only listed fields leave the server,
// so new columns (or password hashes) can never leak by accident.

const dollars = (cents) => (cents == null ? null : cents / 100);

export const employee = (r) => ({
  id: r.id,
  fullName: r.full_name,
  email: r.email,
  phone: r.phone,
  address: r.address,
  department: r.department,
  jobTitle: r.job_title,
  hourlyRate: dollars(r.hourly_rate_cents),
  isActive: r.is_active,
  username: r.username ?? undefined,
});

export const timesheet = (r) => ({
  id: r.id,
  employeeId: r.employee_id,
  employeeName: r.full_name ?? undefined,
  periodStart: r.period_start,
  periodEnd: r.period_end,
  hoursWorked: r.hours_worked,
  notes: r.notes,
  status: r.status,
  submittedAt: r.submitted_at,
  reviewedAt: r.reviewed_at,
  rejectionReason: r.rejection_reason,
  paidAt: r.paid_at,
});

export const benefit = (r) => ({
  id: r.id,
  benefitType: r.benefit_type,
  planName: r.plan_name,
  employeeCost: dollars(r.employee_cost_cents),
  employerCost: dollars(r.employer_cost_cents),
  isEnrolled: r.is_enrolled,
});

export const deduction = (r) => ({
  id: r.id,
  deductionType: r.deduction_type,
  label: r.label,
  percent: r.percent,
  flatAmount: dollars(r.flat_cents),
  isActive: r.is_active,
});

export const paystub = (r) => ({
  id: r.id,
  payrollRunId: r.payroll_run_id,
  employeeId: r.employee_id,
  employeeName: r.full_name ?? undefined,
  periodStart: r.period_start,
  periodEnd: r.period_end,
  hoursWorked: r.hours_worked,
  hourlyRate: dollars(r.hourly_rate_cents),
  grossPay: dollars(r.gross_cents),
  taxes: dollars(r.tax_cents),
  benefits: dollars(r.benefit_cents),
  netPay: dollars(r.net_cents),
  breakdown: {
    deductions: r.breakdown.deductions.map((l) => ({ type: l.type, label: l.label, amount: dollars(l.cents) })),
    benefits: r.breakdown.benefits.map((l) => ({ type: l.type, label: l.label, amount: dollars(l.cents) })),
  },
  createdAt: r.created_at,
});

export const payrollRun = (r) => ({
  id: r.id,
  periodStart: r.period_start,
  periodEnd: r.period_end,
  executedBy: r.username ?? null,
  totalGross: dollars(r.total_gross_cents),
  totalDeductions: dollars(r.total_deductions_cents),
  totalNet: dollars(r.total_net_cents),
  employeeCount: r.employee_count,
  createdAt: r.created_at,
});
