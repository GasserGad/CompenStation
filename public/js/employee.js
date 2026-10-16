import { api, busy, day, downloadText, errorText, formValues, h, money, period, render, requireUser, setupTopbar, toast } from "./common.js";

const user = await requireUser("employee");
setupTopbar(user);

const $ = (id) => document.getElementById(id);
let profile;

// ─── Profile ───────────────────────────────────────────────────────────
function showProfile() {
  const rows = [
    ["Name", profile.fullName], ["Job title", profile.jobTitle], ["Department", profile.department],
    ["Email", profile.email], ["Phone", profile.phone], ["Address", profile.address],
    ["Hourly rate", money(profile.hourlyRate)],
  ];
  render($("profile"), rows.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: v || "–" })]));
}

$("edit-profile").addEventListener("click", () => {
  $("phone").value = profile.phone ?? "";
  $("address").value = profile.address ?? "";
  $("profile").hidden = true;
  $("profile-form").hidden = false;
  $("edit-profile").hidden = true;
});
$("cancel-profile").addEventListener("click", closeProfileForm);
function closeProfileForm() {
  $("profile").hidden = false;
  $("profile-form").hidden = true;
  $("edit-profile").hidden = false;
}
$("profile-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const { phone, address } = formValues(e.target);
  busy(e.submitter, async () => {
    try {
      profile = await api("/me/profile", { method: "PATCH", body: { phone, address } });
      showProfile();
      closeProfileForm();
      toast("Your information was updated.");
    } catch (err) {
      toast(errorText(err), "error");
    }
  });
});

// ─── Timesheets ────────────────────────────────────────────────────────
function showTimesheets(rows) {
  if (rows.length === 0) return render($("timesheets"), h("p", { class: "empty" }, "No timesheets yet."));
  render($("timesheets"), h("table", null,
    h("thead", null, h("tr", null, h("th", { text: "Period" }), h("th", { class: "num", text: "Hours" }), h("th", { text: "Status" }))),
    h("tbody", null, rows.map((t) => h("tr", null,
      h("td", null, period(t.periodStart, t.periodEnd),
        t.status === "REJECTED" && t.rejectionReason ? h("div", { class: "hint", text: `Reason: ${t.rejectionReason}` }) : null),
      h("td", { class: "num", text: t.hoursWorked }),
      h("td", null, h("span", { class: `pill ${t.status}`, text: t.status.toLowerCase() })),
    )))));
}

$("timesheet-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = formValues(e.target);
  busy(e.submitter, async () => {
    try {
      await api("/me/timesheets", {
        method: "POST",
        body: { periodStart: v.periodStart, periodEnd: v.periodEnd, hoursWorked: Number(v.hoursWorked), ...(v.notes ? { notes: v.notes } : {}) },
      });
      e.target.reset();
      toast("Timesheet submitted for approval.");
      showTimesheets(await api("/me/timesheets"));
    } catch (err) {
      toast(errorText(err), "error");
    }
  });
});

// ─── Paystubs ──────────────────────────────────────────────────────────
function paystubText(s) {
  const lines = [
    "CompenStation paystub",
    `Employee: ${profile.fullName}`,
    `Pay period: ${period(s.periodStart, s.periodEnd)}`,
    `Hours: ${s.hoursWorked} at ${money(s.hourlyRate)}/hour`,
    "",
    `Gross pay: ${money(s.grossPay)}`,
    ...s.breakdown.deductions.map((d) => `  ${d.label}: -${money(d.amount)}`),
    ...s.breakdown.benefits.map((b) => `  ${b.label}: -${money(b.amount)}`),
    `Net pay: ${money(s.netPay)}`,
  ];
  return lines.join("\n") + "\n";
}

function showPaystubs(stubs) {
  if (stubs.length === 0) return render($("paystubs"), h("p", { class: "empty" }, "No paystubs yet."));
  render($("paystubs"), stubs.map((s, i) => {
    const line = (label, amount, cls) => h("tr", null, h("td", { text: label }), h("td", { class: `num ${cls ?? ""}`, text: amount }));
    return h("details", { class: "stub", open: i === 0 },
      h("summary", null, h("span", { text: period(s.periodStart, s.periodEnd) }), h("span", { class: "pos", text: money(s.netPay) })),
      h("table", { class: "stub-lines" }, h("tbody", null,
        line(`Gross pay (${s.hoursWorked} h × ${money(s.hourlyRate)})`, money(s.grossPay)),
        s.breakdown.deductions.map((d) => line(d.label, `-${money(d.amount)}`, "neg")),
        s.breakdown.benefits.map((b) => line(b.label, `-${money(b.amount)}`, "neg")),
        h("tr", { class: "total" }, h("td", { text: "Net pay" }), h("td", { class: "num pos", text: money(s.netPay) })),
      )),
      h("button", {
        class: "btn btn-secondary btn-small", type: "button",
        onclick: () => downloadText(`paystub-${s.periodStart}.txt`, paystubText(s)),
      }, "Download"));
  }));
}

function showStats(stubs, sheets) {
  const latest = stubs[0];
  const pending = sheets.filter((t) => t.status === "SUBMITTED" || t.status === "APPROVED").length;
  const ytd = stubs.filter((s) => s.periodEnd.slice(0, 4) === new Date().getFullYear().toString()).reduce((t, s) => t + s.netPay, 0);
  const stat = (label, value) => h("div", { class: "stat" }, h("span", { text: label }), h("strong", { text: value }));
  render($("stats"),
    stat("Last net pay", latest ? money(latest.netPay) : "–"),
    stat("Last pay period", latest ? day(latest.periodEnd) : "–"),
    stat("Net pay this year", money(ytd)),
    stat("Timesheets awaiting pay", String(pending)));
}

// ─── Benefits & deductions (read-only for employees) ───────────────────
function showBenefits(rows) {
  if (rows.length === 0) return render($("benefits"), h("p", { class: "empty" }, "No benefits on file."));
  render($("benefits"), h("table", null, h("tbody", null, rows.map((b) => h("tr", null,
    h("td", null, b.planName ?? b.benefitType, h("div", { class: "hint", text: b.benefitType.replace(/_/g, " ").toLowerCase() })),
    h("td", { class: "num", text: `${money(b.employeeCost)} / period` }),
    h("td", null, h("span", { class: `pill ${b.isEnrolled ? "ACTIVE" : "INACTIVE"}`, text: b.isEnrolled ? "enrolled" : "not enrolled" })),
  )))));
}

function showDeductions(rows) {
  if (rows.length === 0) return render($("deductions"), h("p", { class: "empty" }, "No deductions on file."));
  render($("deductions"), h("table", null, h("tbody", null, rows.filter((d) => d.isActive).map((d) => h("tr", null,
    h("td", { text: d.label ?? d.deductionType }),
    h("td", { class: "num", text: d.percent != null ? `${d.percent}% of gross` : `${money(d.flatAmount)} flat` }),
  )))));
}

// ─── Load everything ───────────────────────────────────────────────────
try {
  const [p, sheets, stubs, benefits, deductions] = await Promise.all([
    api("/me/profile"), api("/me/timesheets"), api("/me/paystubs"), api("/me/benefits"), api("/me/deductions"),
  ]);
  profile = p;
  showProfile();
  showTimesheets(sheets);
  showPaystubs(stubs);
  showStats(stubs, sheets);
  showBenefits(benefits);
  showDeductions(deductions);
} catch (err) {
  toast(errorText(err), "error");
}
