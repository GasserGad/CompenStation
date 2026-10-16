import { api, busy, errorText, h, render } from "./common.js";

const form = /** @type {HTMLFormElement} */ (document.getElementById("login-form"));
const errorBox = document.getElementById("login-error");
const button = /** @type {HTMLButtonElement} */ (document.getElementById("login-button"));

/** @param {string} role */
const homeFor = (role) => (role === "admin" ? "/admin" : "/employee");

// Already logged in? Skip the form.
api("/auth/me").then((data) => {
  if (data.user) window.location.replace(homeFor(data.user.role));
}).catch(() => {});

// In the public demo, offer one-click demo accounts.
api("/auth/config").then((cfg) => {
  if (!cfg.demoMode) return;
  const { admin, employees, password } = cfg.demoAccounts;
  const fill = (username) => () => {
    form.username.value = username;
    form.password.value = password;
    form.password.focus();
  };
  render(document.getElementById("demo-buttons"),
    h("button", { type: "button", class: "btn btn-secondary btn-small", onclick: fill(admin) }, "Admin"),
    ...employees.map((u) => h("button", { type: "button", class: "btn btn-secondary btn-small", onclick: fill(u) }, `Employee: ${u}`)));
  document.getElementById("demo-password").textContent = password;
  document.getElementById("demo-accounts").hidden = false;
}).catch(() => {});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  const username = form.username.value.trim();
  const password = form.password.value;
  if (!username || !password) {
    errorBox.textContent = "Enter your username and password.";
    errorBox.hidden = false;
    return;
  }
  busy(button, async () => {
    try {
      const { user } = await api("/auth/login", { method: "POST", body: { username, password } });
      window.location.replace(homeFor(user.role));
    } catch (err) {
      errorBox.textContent = errorText(err);
      errorBox.hidden = false;
      form.password.value = "";
    }
  });
});
