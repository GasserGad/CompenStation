// Shared helpers for every page.
// XSS rule: never use innerHTML. Everything is built with h(), which creates
// elements and sets text with textContent, so data from the server is always
// shown as plain text, never run as code.

/**
 * Create an element.
 * @param {string} tag
 * @param {Record<string, any> | null} [attrs] class, text, on{Event}, data-*, and plain attributes
 * @param {...(Node | string | number | null | undefined | false)} children
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = String(value);
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Replace all children of `target`. */
export function render(target, ...children) {
  target.replaceChildren(...children.flat().filter(Boolean));
}

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `Request failed (${status})`);
    this.status = status;
    this.fields = body?.error?.fields ?? [];
  }
}

/**
 * Call the API. Cookies go along automatically (same origin); the session
 * token itself is httpOnly and never visible to this code.
 * @param {string} path e.g. "/admin/employees"
 * @param {{ method?: string, body?: unknown }} [options]
 */
export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (res.status === 401 && !path.startsWith("/auth/login")) {
    window.location.replace("/");
    throw new ApiError(401, data);
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

/** Explain a failed request in one readable line. */
export function errorText(err) {
  if (err instanceof ApiError && err.fields.length) {
    return `${err.message} ${err.fields.map((f) => `${f.field}: ${f.message}`).join("; ")}`;
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
/** @param {number | null | undefined} n */
export const money = (n) => (n == null ? "–" : usd.format(n));

/** "2026-10-02" → "Oct 2, 2026" (no time-zone shifting). */
export function day(iso) {
  if (!iso) return "–";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
export const period = (start, end) => `${day(start)} – ${day(end)}`;
export const when = (iso) => (iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "–");

export const initials = (name) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join("");

let toastTimer;
/** @param {string} message @param {"ok" | "error"} [kind] */
export function toast(message, kind = "ok") {
  let el = document.getElementById("toast");
  if (!el) {
    el = h("div", { id: "toast", role: "status", "aria-live": "polite" });
    document.body.append(el);
  }
  el.textContent = message;
  el.className = kind === "error" ? "error" : "";
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

/** Disable a button while an async action runs. */
export async function busy(button, fn) {
  button.disabled = true;
  try {
    return await fn();
  } finally {
    button.disabled = false;
  }
}

/**
 * Make sure someone with `role` is logged in; otherwise go to the login page.
 * @param {"admin" | "employee"} role
 */
export async function requireUser(role) {
  const res = await fetch("/api/auth/me", { credentials: "same-origin" });
  const data = res.ok ? await res.json() : { user: null };
  if (!data.user) {
    window.location.replace("/");
    return new Promise(() => {}); // stop the page while redirecting
  }
  if (data.user.role !== role) {
    window.location.replace(data.user.role === "admin" ? "/admin" : "/employee");
    return new Promise(() => {});
  }
  if (data.demoMode) {
    document.body.prepend(h("div", { class: "demo-banner" },
      "Public demo with fictional data. It resets every few hours. Please don't enter real personal information."));
  }
  return data.user;
}

/** Wire up the top bar: name, initials and the logout button. */
export function setupTopbar(user) {
  document.getElementById("user-name").textContent = user.fullName;
  document.getElementById("user-initials").textContent = initials(user.fullName);
  document.getElementById("logout").addEventListener("click", async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    window.location.replace("/");
  });
}

/** Read a form's named fields as an object of trimmed strings. */
export function formValues(form) {
  const out = Object.create(null); // no prototype, so a field named "__proto__" is harmless
  // eslint-disable-next-line security/detect-object-injection
  for (const [key, value] of new FormData(form).entries()) out[key] = String(value).trim();
  return out;
}

/** Trigger a download of a text file generated in the browser. */
export function downloadText(filename, content, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = h("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
