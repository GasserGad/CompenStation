# Security Policy

## Reporting a vulnerability

Please report security issues privately through GitHub: open the **Security** tab of this repository and choose **Report a vulnerability**. Do not open a public issue for security problems.

Include what you found, how to reproduce it, and the impact you expect. You can expect a first reply within 7 days. Please give a reasonable time to fix the issue before disclosing it publicly.

The public demo only contains fictional data and is wiped every few hours. Testing that degrades it for other people (load testing, flooding, automated scanning at volume) is not allowed.

## Security measures in this project

| Threat | Mitigation |
| --- | --- |
| Password theft | Passwords hashed with scrypt (random salt per user, constant-time comparison); never logged or returned by the API |
| Session hijacking | Random 256-bit session tokens, stored only as SHA-256 hashes; `HttpOnly`, `Secure`, `SameSite=Strict` cookie with the `__Host-` prefix; new session on every login; sessions expire and are revoked on logout, password change and deactivation |
| Brute-force login | Per-IP login rate limit; account lockout after 5 failures; identical error for unknown users and wrong passwords, with equal timing |
| Cross-site request forgery | `SameSite=Strict` cookie, plus every state-changing request must come from the site's own `Origin` and carry a JSON body |
| Broken access control (IDOR) | Role checks on every route; employee routes take the employee ID from the session, never from the request; nested records (benefits, deductions) are looked up together with their owner |
| Mass assignment | Strict schemas reject unknown fields, so a request can't set `role`, `employeeId` or pay rate |
| SQL injection | Parameterized queries only |
| Cross-site scripting (XSS) | Front end builds pages with `textContent` only (enforced by a lint rule); strict Content Security Policy with no inline scripts or styles |
| Clickjacking | `frame-ancestors 'none'` |
| Double payment | Payroll runs in a transaction with row locks; a database constraint allows only one paystub per timesheet; money is stored in whole cents |
| Information leakage | Generic error messages; no stack traces to clients; `X-Powered-By` removed; API responses use field allow-lists; `Cache-Control: no-store` on API data; logs contain no IPs or passwords |
| Abuse and denial of service | Site-wide per-IP rate limit; 20 KB request body limit; database statement timeout; capped connection pool; request and header timeouts; employee cap in the demo |
| Secrets in git | Configuration only through environment variables; `.env` git-ignored; gitleaks scan in CI |
| Vulnerable dependencies | `npm audit` and CodeQL in CI; Dependabot updates |
| Container escape impact | Docker image runs as the non-root `node` user |
| Accountability | Audit log of every admin action (who, what, when; no sensitive values) |
