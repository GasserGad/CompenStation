import { api, busy, errorText, formValues, h, money, period, render, requireUser, setupTopbar, toast, when } from "./common.js";

const user = await requireUser("admin");
setupTopbar(user);

const view = document.getElementById("view");
const BENEFIT_TYPES = ["MEDICAL", "DENTAL", "VISION", "LIFE_INSURANCE", "RETIREMENT_401K", "OTHER"];
const DEDUCTION_TYPES = ["FEDERAL_TAX", "STATE_TAX", "LOCAL_TAX", "SOCIAL_SECURITY", "MEDICARE", "GARNISHMENT", "OTHER"];
const pretty = (s) => s.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

// ─── Small UI builders ─────────────────────────────────────────────────
const card = (title, ...body) => h("section", { class: "card" }, title ? h("h2", { text: title }) : null, ...body);
const stat = (label, value) => h("div", { class: "stat" }, h("span", { text: label }), h("strong", { text: value }));
const pill = (status) => h("span", { class: `pill ${status}`, text: status.toLowerCase() });
const empty = (text) => h("p", { class: "empty", text });
const field = (label, input) => h("div", { class: "field" }, h("label", { for: input.id, text: label }), input);
const input = (name, attrs = {}) => h("input", { id: `f-${name}`, name, ...attrs });
const select = (name, options) =>
  h("select", { id: `f-${name}`, name }, options.map((o) => h("option", { value: o, text: pretty(o) })));

/**
 * @param {string[]} headers
 * @param {Node[]} rows
 * @param {number[]} [numericCols] indexes of right-aligned columns
 */
function table(headers, rows, numericCols = []) {
  return h("div", { class: "table-wrap" }, h("table", null,
    h("thead", null, h("tr", null, headers.map((t, i) => h("th", { class: numericCols.includes(i) ? "num" : null, text: t })))),
    h("tbody", null, rows)));
}

async function refreshBadge() {
  const d = await api("/admin/dashboard");
  const badge = document.getElementById("pending-badge");
  badge.textContent = String(d.pendingTimesheets);
  badge.hidden = d.pendingTimesheets === 0;
  return d;
}

// ─── Dashboard ─────────────────────────────────────────────────────────
async function dashboard() {
  const [d, runs] = await Promise.all([refreshBadge(), api("/admin/payroll/runs")]);
  render(view,
    h("div", { class: "stats" },
      stat("Active employees", String(d.activeEmployees)),
      stat("Timesheets to review", String(d.pendingTimesheets)),
      stat("Approved, not yet paid", String(d.approvedUnpaid)),
      stat("Total paid out (net)", money(d.totalPaid))),
    card("Recent payroll runs", runsTable(runs.slice(0, 5))));
}

function runsTable(runs) {
  if (runs.length === 0) return empty("No payroll runs yet.");
  return table(["Pay period", "Employees", "Gross", "Deductions", "Net", "Run by"], runs.map((r) =>
    h("tr", { class: "clickable", tabindex: "0", onclick: () => { location.hash = `#run/${r.id}`; } },
      h("td", { text: period(r.periodStart, r.periodEnd) }),
      h("td", { class: "num", text: r.employeeCount }),
      h("td", { class: "num", text: money(r.totalGross) }),
      h("td", { class: "num", text: money(r.totalDeductions) }),
      h("td", { class: "num", text: money(r.totalNet) }),
      h("td", { text: r.executedBy ?? "–" }))), [1, 2, 3, 4]);
}

// ─── Timesheet review ──────────────────────────────────────────────────
async function timesheets() {
  const [pending, approved] = await Promise.all([
    api("/admin/timesheets?status=SUBMITTED"), api("/admin/timesheets?status=APPROVED"),
  ]);
  refreshBadge();

  const reviewRow = (t) => {
    const reason = h("input", { "aria-label": `Reason for rejecting ${t.employeeName}'s timesheet`, placeholder: "Reason for rejecting", maxlength: "300", hidden: true });
    const approve = h("button", { class: "btn btn-small", type: "button" }, "Approve");
    const reject = h("button", { class: "btn btn-danger btn-small", type: "button" }, "Reject");
    approve.addEventListener("click", () => busy(approve, async () => {
      try {
        await api(`/admin/timesheets/${t.id}/approve`, { method: "POST" });
        toast(`Approved ${t.employeeName}'s timesheet.`);
        timesheets();
      } catch (err) { toast(errorText(err), "error"); }
    }));
    reject.addEventListener("click", () => {
      if (reason.hidden) { reason.hidden = false; reason.focus(); reject.textContent = "Confirm reject"; return; }
      if (!reason.value.trim()) { toast("Add a reason so the employee knows what to fix.", "error"); reason.focus(); return; }
      busy(reject, async () => {
        try {
          await api(`/admin/timesheets/${t.id}/reject`, { method: "POST", body: { reason: reason.value.trim() } });
          toast(`Rejected ${t.employeeName}'s timesheet.`);
          timesheets();
        } catch (err) { toast(errorText(err), "error"); }
      });
    });
    return h("tr", null,
      h("td", null, t.employeeName, t.notes ? h("div", { class: "hint", text: t.notes }) : null),
      h("td", { text: period(t.periodStart, t.periodEnd) }),
      h("td", { class: "num", text: t.hoursWorked }),
      h("td", null, h("div", { class: "row-actions" }, reason, approve, reject)));
  };

  render(view,
    card("Waiting for review", pending.length ? table(["Employee", "Pay period", "Hours", ""], pending.map(reviewRow), [2]) : empty("Nothing to review right now.")),
    card("Approved and waiting for payroll", approved.length
      ? table(["Employee", "Pay period", "Hours", "Status"], approved.map((t) => h("tr", null,
        h("td", { text: t.employeeName }), h("td", { text: period(t.periodStart, t.periodEnd) }),
        h("td", { class: "num", text: t.hoursWorked }), h("td", null, pill(t.status)))), [2])
      : empty("No approved timesheets waiting.")));
}

// ─── Payroll ───────────────────────────────────────────────────────────
async function payroll() {
  const [approved, runs] = await Promise.all([api("/admin/timesheets?status=APPROVED"), api("/admin/payroll/runs")]);

  // Group approved timesheets by pay period so the admin picks a real period.
  const periods = new Map();
  for (const t of approved) {
    const key = `${t.periodStart}|${t.periodEnd}`;
    const p = periods.get(key) ?? { start: t.periodStart, end: t.periodEnd, sheets: [] };
    p.sheets.push(t);
    periods.set(key, p);
  }

  const runCard = periods.size === 0
    ? card("Run payroll", empty("No approved timesheets yet. Approve timesheets first, then run payroll for their pay period."))
    : card("Run payroll", ...[...periods.values()].map((p) => {
      const button = h("button", { class: "btn", type: "button" }, `Run payroll for ${p.sheets.length} employee${p.sheets.length === 1 ? "" : "s"}`);
      button.addEventListener("click", () => {
        if (!confirm(`Run payroll for ${period(p.start, p.end)}? Paystubs will be created and these timesheets marked as paid.`)) return;
        busy(button, async () => {
          try {
            const run = await api("/admin/payroll/run", { method: "POST", body: { periodStart: p.start, periodEnd: p.end } });
            toast(`Payroll complete: ${money(run.totalNet)} net to ${run.employeeCount} employee(s).`);
            location.hash = `#run/${run.id}`;
          } catch (err) { toast(errorText(err), "error"); }
        });
      });
      return h("div", { class: "stub" },
        h("div", { class: "card-head" }, h("h2", { text: period(p.start, p.end) }), button),
        h("p", { class: "hint", text: p.sheets.map((t) => `${t.employeeName} (${t.hoursWorked} h)`).join(", ") }));
    }));

  render(view, runCard, card("Payroll history", runsTable(runs)));
}

async function runDetail(id) {
  const { run, paystubs } = await api(`/admin/payroll/runs/${id}`);
  render(view,
    h("p", null, h("a", { href: "#payroll", text: "← Back to payroll" })),
    h("h1", { class: "run-title", text: `Payroll for ${period(run.periodStart, run.periodEnd)}` }),
    h("div", { class: "stats" },
      stat("Gross", money(run.totalGross)),
      stat("Deductions", money(run.totalDeductions)),
      stat("Net paid", money(run.totalNet))),
    card(`Paystubs (run by ${run.executedBy ?? "unknown"} on ${when(run.createdAt)})`,
      table(["Employee", "Hours", "Rate", "Gross", "Taxes", "Benefits", "Net"], paystubs.map((s) => h("tr", null,
        h("td", { text: s.employeeName }),
        h("td", { class: "num", text: s.hoursWorked }),
        h("td", { class: "num", text: money(s.hourlyRate) }),
        h("td", { class: "num", text: money(s.grossPay) }),
        h("td", { class: "num neg", text: money(s.taxes) }),
        h("td", { class: "num neg", text: money(s.benefits) }),
        h("td", { class: "num pos", text: money(s.netPay) }))), [1, 2, 3, 4, 5, 6])));
}

// ─── Employees ─────────────────────────────────────────────────────────
async function employees() {
  const list = await api("/admin/employees");
  const search = h("input", { type: "search", placeholder: "Search by name, email or department", "aria-label": "Search employees" });
  const tbody = h("tbody");
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const shown = list.filter((e) => [e.fullName, e.email, e.department, e.jobTitle].some((v) => v?.toLowerCase().includes(q)));
    render(tbody, shown.length ? shown.map((e) => h("tr", { class: "clickable", tabindex: "0", onclick: () => { location.hash = `#employee/${e.id}`; } },
      h("td", null, e.fullName, h("div", { class: "hint", text: e.email })),
      h("td", { text: e.jobTitle ?? "–" }),
      h("td", { text: e.department ?? "–" }),
      h("td", { class: "num", text: money(e.hourlyRate) }),
      h("td", null, pill(e.isActive ? "ACTIVE" : "INACTIVE")))) : h("tr", null, h("td", { colspan: "5", class: "empty", text: "No matching employees." })));
  };
  search.addEventListener("input", draw);
  draw();

  render(view,
    h("section", { class: "card" },
      h("div", { class: "card-head" }, h("h2", { text: "Employees" }), h("a", { class: "btn btn-small", href: "#new-employee", text: "Add employee" })),
      h("div", { class: "field" }, search),
      h("div", { class: "table-wrap" }, h("table", null,
        h("thead", null, h("tr", null, ["Name", "Job title", "Department", "Hourly rate", "Status"].map((t, i) => h("th", { class: i === 3 ? "num" : null, text: t })))),
        tbody))));
}

function newEmployee() {
  const form = h("form", { novalidate: true },
    h("div", { class: "form-grid" },
      field("Full name", input("fullName", { required: true, maxlength: "120", autocomplete: "off" })),
      field("Email", input("email", { type: "email", required: true, maxlength: "254", autocomplete: "off" })),
      field("Phone", input("phone", { maxlength: "30", autocomplete: "off" })),
      field("Address", input("address", { maxlength: "200", autocomplete: "off" })),
      field("Department", input("department", { maxlength: "80" })),
      field("Job title", input("jobTitle", { maxlength: "80" })),
      field("Hourly rate ($)", input("hourlyRate", { type: "number", min: "0", step: "0.01", required: true }))),
    h("h2", { text: "Login" }),
    h("div", { class: "form-grid" },
      field("Username", input("username", { required: true, maxlength: "32", autocomplete: "off", autocapitalize: "none" })),
      field("Starting password (12+ characters)", input("password", { type: "password", required: true, minlength: "12", maxlength: "128", autocomplete: "new-password" }))),
    h("p", { class: "hint", text: "Share the starting password with the employee privately. They can change it after logging in." }),
    h("div", { class: "form-actions" },
      h("button", { class: "btn", type: "submit" }, "Create employee"),
      h("a", { class: "btn btn-secondary", href: "#employees", text: "Cancel" })));

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = formValues(form);
    const body = { ...v, hourlyRate: Number(v.hourlyRate) };
    // Keys come from the fixed list on this line, not from user input.
    // eslint-disable-next-line security/detect-object-injection
    for (const k of ["phone", "address", "department", "jobTitle"]) if (!body[k]) delete body[k];
    busy(e.submitter, async () => {
      try {
        const created = await api("/admin/employees", { method: "POST", body });
        toast(`${created.fullName} was added.`);
        location.hash = `#employee/${created.id}`;
      } catch (err) { toast(errorText(err), "error"); }
    });
  });
  render(view, h("p", null, h("a", { href: "#employees", text: "← All employees" })), card("Add employee", form));
}

async function employeeDetail(id) {
  const [e, benefits, deductions] = await Promise.all([
    api(`/admin/employees/${id}`), api(`/admin/employees/${id}/benefits`), api(`/admin/employees/${id}/deductions`),
  ]);

  // Edit details
  const edit = h("form", { novalidate: true },
    h("div", { class: "form-grid" },
      field("Full name", input("fullName", { value: e.fullName, maxlength: "120" })),
      field("Email", input("email", { type: "email", value: e.email, maxlength: "254" })),
      field("Phone", input("phone", { value: e.phone ?? "", maxlength: "30" })),
      field("Address", input("address", { value: e.address ?? "", maxlength: "200" })),
      field("Department", input("department", { value: e.department ?? "", maxlength: "80" })),
      field("Job title", input("jobTitle", { value: e.jobTitle ?? "", maxlength: "80" })),
      field("Hourly rate ($)", input("hourlyRate", { type: "number", min: "0", step: "0.01", value: e.hourlyRate }))),
    h("div", { class: "form-actions" }, h("button", { class: "btn", type: "submit" }, "Save changes")));
  edit.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const v = formValues(edit);
    busy(ev.submitter, async () => {
      try {
        await api(`/admin/employees/${id}`, { method: "PATCH", body: { ...v, hourlyRate: Number(v.hourlyRate) } });
        toast("Saved.");
        employeeDetail(id);
      } catch (err) { toast(errorText(err), "error"); }
    });
  });

  const toggle = h("button", { class: e.isActive ? "btn btn-danger btn-small" : "btn btn-small", type: "button" }, e.isActive ? "Deactivate" : "Reactivate");
  toggle.addEventListener("click", () => {
    if (e.isActive && !confirm(`Deactivate ${e.fullName}? They will be logged out and can't submit timesheets.`)) return;
    busy(toggle, async () => {
      try {
        await api(`/admin/employees/${id}`, { method: "PATCH", body: { isActive: !e.isActive } });
        employeeDetail(id);
      } catch (err) { toast(errorText(err), "error"); }
    });
  });

  // Benefits
  const removeButton = (label, path) => {
    const b = h("button", { class: "btn btn-danger btn-small", type: "button" }, "Remove");
    b.addEventListener("click", () => {
      if (!confirm(`Remove ${label}?`)) return;
      busy(b, async () => {
        try { await api(path, { method: "DELETE" }); employeeDetail(id); } catch (err) { toast(errorText(err), "error"); }
      });
    });
    return b;
  };
  const benefitForm = h("form", { novalidate: true },
    h("div", { class: "form-grid" },
      field("Type", select("benefitType", BENEFIT_TYPES)),
      field("Plan name", input("planName", { maxlength: "120" })),
      field("Employee cost / period ($)", input("employeeCost", { type: "number", min: "0", step: "0.01", required: true })),
      field("Employer cost / period ($)", input("employerCost", { type: "number", min: "0", step: "0.01", value: "0" }))),
    h("button", { class: "btn btn-secondary btn-small", type: "submit" }, "Add benefit"));
  benefitForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const v = formValues(benefitForm);
    busy(ev.submitter, async () => {
      try {
        await api(`/admin/employees/${id}/benefits`, {
          method: "POST",
          body: { benefitType: v.benefitType, ...(v.planName ? { planName: v.planName } : {}), employeeCost: Number(v.employeeCost), employerCost: Number(v.employerCost || 0) },
        });
        employeeDetail(id);
      } catch (err) { toast(errorText(err), "error"); }
    });
  });

  // Deductions
  const deductionForm = h("form", { novalidate: true },
    h("div", { class: "form-grid" },
      field("Type", select("deductionType", DEDUCTION_TYPES)),
      field("Label", input("label", { maxlength: "120" })),
      field("Percent of gross (%)", input("percent", { type: "number", min: "0", max: "100", step: "0.01" })),
      field("…or flat amount ($)", input("flatAmount", { type: "number", min: "0", step: "0.01" }))),
    h("button", { class: "btn btn-secondary btn-small", type: "submit" }, "Add deduction"));
  deductionForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const v = formValues(deductionForm);
    const body = { deductionType: v.deductionType, ...(v.label ? { label: v.label } : {}) };
    if (v.percent) body.percent = Number(v.percent);
    if (v.flatAmount) body.flatAmount = Number(v.flatAmount);
    busy(ev.submitter, async () => {
      try { await api(`/admin/employees/${id}/deductions`, { method: "POST", body }); employeeDetail(id); } catch (err) { toast(errorText(err), "error"); }
    });
  });

  render(view,
    h("p", null, h("a", { href: "#employees", text: "← All employees" })),
    h("section", { class: "card" },
      h("div", { class: "card-head" },
        h("h2", null, e.fullName, " ", pill(e.isActive ? "ACTIVE" : "INACTIVE")),
        toggle),
      h("p", { class: "hint", text: `Login username: ${e.username ?? "none"}` }),
      edit),
    card("Benefits",
      benefits.length ? table(["Plan", "Employee cost", "Employer cost", ""], benefits.map((b) => h("tr", null,
        h("td", null, b.planName ?? pretty(b.benefitType), h("div", { class: "hint", text: pretty(b.benefitType) })),
        h("td", { class: "num", text: money(b.employeeCost) }),
        h("td", { class: "num", text: money(b.employerCost) }),
        h("td", null, h("div", { class: "row-actions" }, removeButton(b.planName ?? pretty(b.benefitType), `/admin/employees/${id}/benefits/${b.id}`))))), [1, 2]) : empty("No benefits."),
      benefitForm),
    card("Taxes and deductions",
      deductions.length ? table(["Deduction", "Amount", ""], deductions.map((d) => h("tr", null,
        h("td", { text: d.label ?? pretty(d.deductionType) }),
        h("td", { class: "num", text: d.percent != null ? `${d.percent}%` : money(d.flatAmount) }),
        h("td", null, h("div", { class: "row-actions" }, removeButton(d.label ?? pretty(d.deductionType), `/admin/employees/${id}/deductions/${d.id}`))))), [1]) : empty("No deductions."),
      deductionForm));
}

// ─── Audit log ─────────────────────────────────────────────────────────
async function audit() {
  const rows = await api("/admin/audit");
  render(view, card("Audit log (latest 100 actions)", rows.length
    ? table(["When", "Who", "Action", "Record"], rows.map((r) => h("tr", null,
      h("td", { text: when(r.at) }), h("td", { text: r.by ?? "–" }),
      h("td", { text: r.action }), h("td", { text: `${r.entity} #${r.entityId ?? "–"}` }))))
    : empty("No actions recorded yet.")));
}

// ─── Router ────────────────────────────────────────────────────────────
const routes = [
  [/^#?(dashboard)?$/, "dashboard", () => dashboard()],
  [/^#timesheets$/, "timesheets", () => timesheets()],
  [/^#payroll$/, "payroll", () => payroll()],
  [/^#run\/(\d+)$/, "payroll", (m) => runDetail(m[1])],
  [/^#employees$/, "employees", () => employees()],
  [/^#new-employee$/, "employees", () => newEmployee()],
  [/^#employee\/(\d+)$/, "employees", (m) => employeeDetail(m[1])],
  [/^#audit$/, "audit", () => audit()],
];

async function route() {
  const hash = location.hash;
  const match = routes.find(([re]) => re.test(hash)) ?? routes[0];
  const [re, section, show] = match;
  document.querySelectorAll(".sidebar a").forEach((a) => {
    if (a.dataset.section === section) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  try {
    await show(hash.match(re) ?? []);
    view.focus({ preventScroll: true });
  } catch (err) {
    render(view, h("div", { class: "alert error", text: errorText(err) }));
  }
}
window.addEventListener("hashchange", route);
route();
refreshBadge().catch(() => {});
