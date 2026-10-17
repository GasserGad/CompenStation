<p align="center">
  <img src="public/img/logo.png" alt="CompenStation logo" width="96">
</p>

<h1 align="center">CompenStation</h1>

<p align="center">
  A payroll system for small teams: employees log their hours, admins approve them,
  and one click turns approved timesheets into paystubs with taxes, deductions and benefits.
</p>

<p align="center">
  <a href="https://github.com/GasserGad/CompenStation/actions/workflows/ci.yml"><img src="https://github.com/GasserGad/CompenStation/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/GasserGad/CompenStation/actions/workflows/codeql.yml"><img src="https://github.com/GasserGad/CompenStation/actions/workflows/codeql.yml/badge.svg" alt="CodeQL"></a>
</p>

> **Demo only.** The live site runs on fictional data that resets every 6 hours.
> Don't enter real names, addresses or pay information. CompenStation is a portfolio
> project, not payroll or tax software.

## Try it

Open the [live demo](https://compenstation.gassergad.com) and pick an account on the login screen (all demo accounts share the password shown there):

| Account | What you can do |
| --- | --- |
| `admin` | Dashboard, approve or reject timesheets, run payroll, add employees, set pay rates, benefits and deductions, view the audit log |
| `jdoe`, `jsmith`, `mgarcia`, `kchen` | Submit timesheets, see paystubs with a full breakdown, view benefits and deductions, update phone and address |

A good first walkthrough: log in as **admin**, approve the two waiting timesheets, run payroll for the latest period, then log in as **jsmith** and open the new paystub.

## Features

- **Employees:** submit hours per pay period (the same period can't be submitted twice), track approval status and rejection reasons, open itemized paystubs and download them as text.
- **Admins:** dashboard with pending approvals and payroll totals; approve/reject with a reason; run payroll per period; manage employees, pay rates, benefits (medical, dental, vision, 401(k)…) and deductions (percentage or flat); full audit log.
- **Correct money math:** all amounts are stored in whole cents, so $0.10 + $0.20 is always $0.30. Net pay can never go negative.
- **Safe payroll runs:** a run is one database transaction with row locks, and the database itself refuses a second paystub for the same timesheet, so double-clicking "Run payroll" can't pay anyone twice.
- Works on phones and desktops, with no frameworks and no tracking.

## Security

Passwords are hashed with scrypt. Sessions use random tokens stored only as hashes, in `HttpOnly` / `SameSite=Strict` cookies. Login is rate-limited, with account lockout. Cross-site requests are blocked, every input is validated against a strict schema, and employees can only ever reach their own records. A strict Content Security Policy is in place, and every admin action goes to an audit log. See [SECURITY.md](SECURITY.md) for the full list and for how to report a vulnerability privately.

## Tech stack

| Layer | Choice |
| --- | --- |
| Server | Node.js 22+, Express 5 |
| Database | PostgreSQL (hosted free on [Neon](https://neon.tech)) with versioned SQL migrations |
| Validation | Zod |
| Security | Helmet, express-rate-limit, Node's built-in `crypto` (scrypt, SHA-256) |
| Front end | Plain HTML, CSS and JavaScript modules; Lora typeface |
| Quality | `node:test` + Supertest against a real PostgreSQL, ESLint with security rules, CodeQL, gitleaks, Dependabot |
| Hosting | Docker Compose on a DigitalOcean server, behind Caddy (automatic HTTPS) |

## Run it locally

You need Node.js 22 or newer and a PostgreSQL database (a local install, Docker, or a free Neon project).

```bash
git clone https://github.com/GasserGad/CompenStation.git
cd CompenStation
npm install
cp .env.example .env        # then set DATABASE_URL
npm run dev                 # creates the tables and demo data, then serves http://localhost:3000
```

Quick database with Docker:

```bash
docker run -d --name compen-db -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=compenstation -p 5432:5432 postgres:16-alpine
```

### Tests

The tests use a separate, disposable database that is wiped on every run:

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/compenstation_test npm test
npm run lint
```

They cover the payroll math, password hashing, validation, login and lockout, cookie flags, cross-site request blocking, every access-control boundary, and the timesheet-to-paystub flow. They also check that simultaneous payroll runs pay each timesheet only once.

## API overview

All endpoints live under `/api`, take and return JSON, and require a session cookie except login.

| Area | Endpoints |
| --- | --- |
| Auth | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/password`, `GET /auth/config` |
| Employee (self) | `GET/PATCH /me/profile`, `GET/POST /me/timesheets`, `GET /me/paystubs`, `GET /me/benefits`, `GET /me/deductions` |
| Admin | `GET /admin/dashboard`, `GET/POST /admin/employees`, `GET/PATCH /admin/employees/:id`, benefits and deductions under `/admin/employees/:id/…`, `GET /admin/timesheets`, `POST /admin/timesheets/:id/approve` and `/reject`, `POST /admin/payroll/run`, `GET /admin/payroll/runs[/:id]`, `GET /admin/audit` |

## Project layout

```
src/
  server.js        start-up, demo resets, graceful shutdown
  app.js           Express app: security headers, rate limits, routes, errors
  config.js        environment variables, checked at start-up
  migrations/      SQL schema
  auth/            password hashing and sessions
  routes/          auth, employee (me) and admin APIs
  payroll.js       paystub math (pure functions)
  payrollRun.js    the payroll transaction
  validation.js    request schemas
  demo.js          fictional demo data
public/            pages, styles, scripts, logo, icons, fonts
test/              unit and API tests
```

## Credits

CompenStation started as a team project at the **CUNY College of Staten Island** (spring 2026). The original repository is [tasnimhanaif/CompenStation](https://github.com/tasnimhanaif/CompenStation).

- **Tasnim Hanaif** and **Jason Dilone**: front end
- **Gasser Gadabdelkader**: backend, API routing and security
- **Mahir Shahriyar** and **Fahad Masood**: SQL database

The design (colors, Lora typeface, logo and icons) and the paystub formulas come from that project. Gasser Gadabdelkader rebuilt it into this deployable version: a PostgreSQL schema, real authentication, the security hardening, the new interface, tests, CI and hosting.

## Reporting problems

- **Bugs and ideas:** [open an issue](https://github.com/GasserGad/CompenStation/issues/new/choose)
- **Security issues:** [report privately](https://github.com/GasserGad/CompenStation/security/advisories/new). Please don't use public issues for these.

## Legal

[Terms of Use](https://github.com/GasserGad/CompenStation/blob/main/public/terms.html) · [Privacy Policy](https://github.com/GasserGad/CompenStation/blob/main/public/privacy.html). Both are also linked from the site footer.

Released under the [MIT License](LICENSE), with the agreement of the whole original team. The Lora typeface is under the [SIL Open Font License](public/fonts/OFL.txt).
