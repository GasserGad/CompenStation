-- CompenStation schema (PostgreSQL)
-- Money is stored in integer cents to avoid floating-point rounding errors.

CREATE TABLE employees (
  id                BIGSERIAL PRIMARY KEY,
  full_name         TEXT        NOT NULL CHECK (char_length(full_name) BETWEEN 1 AND 120),
  email             TEXT        NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254),
  phone             TEXT        CHECK (char_length(phone) <= 30),
  address           TEXT        CHECK (char_length(address) <= 200),
  department        TEXT        CHECK (char_length(department) <= 80),
  job_title         TEXT        CHECK (char_length(job_title) <= 80),
  hourly_rate_cents INTEGER     NOT NULL CHECK (hourly_rate_cents BETWEEN 0 AND 100000000),
  is_active         BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX employees_email_unique ON employees (lower(email));

CREATE TABLE users (
  id                  BIGSERIAL PRIMARY KEY,
  employee_id         BIGINT      UNIQUE REFERENCES employees(id) ON DELETE CASCADE,
  username            TEXT        NOT NULL CHECK (username ~ '^[a-z0-9._-]{3,32}$'),
  password_hash       TEXT        NOT NULL,
  role                TEXT        NOT NULL CHECK (role IN ('admin', 'employee')),
  failed_logins       INTEGER     NOT NULL DEFAULT 0,
  locked_until        TIMESTAMPTZ,
  password_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Every employee login is tied to an employee record; admins may or may not be.
  CHECK (role = 'admin' OR employee_id IS NOT NULL)
);
CREATE UNIQUE INDEX users_username_unique ON users (username);

-- Only a SHA-256 hash of each session token is stored, so a database leak
-- does not hand out live sessions.
CREATE TABLE sessions (
  token_hash   BYTEA       PRIMARY KEY,
  user_id      BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expires ON sessions (expires_at);

CREATE TABLE benefits (
  id                  BIGSERIAL PRIMARY KEY,
  employee_id         BIGINT      NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  benefit_type        TEXT        NOT NULL CHECK (benefit_type IN ('MEDICAL','DENTAL','VISION','LIFE_INSURANCE','RETIREMENT_401K','OTHER')),
  plan_name           TEXT        CHECK (char_length(plan_name) <= 120),
  employee_cost_cents INTEGER     NOT NULL DEFAULT 0 CHECK (employee_cost_cents BETWEEN 0 AND 10000000),
  employer_cost_cents INTEGER     NOT NULL DEFAULT 0 CHECK (employer_cost_cents BETWEEN 0 AND 10000000),
  is_enrolled         BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX benefits_employee ON benefits (employee_id);

-- A deduction is either a percentage of gross pay or a flat amount per pay period.
CREATE TABLE deductions (
  id             BIGSERIAL PRIMARY KEY,
  employee_id    BIGINT       NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  deduction_type TEXT         NOT NULL CHECK (deduction_type IN ('FEDERAL_TAX','STATE_TAX','LOCAL_TAX','SOCIAL_SECURITY','MEDICARE','GARNISHMENT','OTHER')),
  label          TEXT         CHECK (char_length(label) <= 120),
  percent        NUMERIC(7,4) CHECK (percent BETWEEN 0 AND 100),
  flat_cents     INTEGER      CHECK (flat_cents BETWEEN 0 AND 10000000),
  is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CHECK ((percent IS NULL) <> (flat_cents IS NULL))
);
CREATE INDEX deductions_employee ON deductions (employee_id);

CREATE TABLE timesheets (
  id                  BIGSERIAL PRIMARY KEY,
  employee_id         BIGINT       NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  period_start        DATE         NOT NULL,
  period_end          DATE         NOT NULL,
  hours_worked        NUMERIC(6,2) NOT NULL CHECK (hours_worked > 0 AND hours_worked <= 120),
  notes               TEXT         CHECK (char_length(notes) <= 500),
  status              TEXT         NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','APPROVED','REJECTED','PAID')),
  submitted_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  reviewed_at         TIMESTAMPTZ,
  reviewed_by_user_id BIGINT       REFERENCES users(id) ON DELETE SET NULL,
  rejection_reason    TEXT         CHECK (char_length(rejection_reason) <= 300),
  paid_at             TIMESTAMPTZ,
  CHECK (period_end > period_start),
  UNIQUE (employee_id, period_start, period_end)
);
CREATE INDEX timesheets_status ON timesheets (status);

CREATE TABLE payroll_runs (
  id                     BIGSERIAL PRIMARY KEY,
  period_start           DATE        NOT NULL,
  period_end             DATE        NOT NULL,
  executed_by_user_id    BIGINT      REFERENCES users(id) ON DELETE SET NULL,
  total_gross_cents      BIGINT      NOT NULL,
  total_deductions_cents BIGINT      NOT NULL,
  total_net_cents        BIGINT      NOT NULL,
  employee_count         INTEGER     NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One paystub per paid timesheet. The UNIQUE on timesheet_id makes it
-- impossible to pay the same timesheet twice, even under concurrent requests.
CREATE TABLE paystubs (
  id                BIGSERIAL PRIMARY KEY,
  payroll_run_id    BIGINT       NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  employee_id       BIGINT       NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  timesheet_id      BIGINT       NOT NULL UNIQUE REFERENCES timesheets(id) ON DELETE CASCADE,
  period_start      DATE         NOT NULL,
  period_end        DATE         NOT NULL,
  hours_worked      NUMERIC(6,2) NOT NULL,
  hourly_rate_cents INTEGER      NOT NULL,
  gross_cents       BIGINT       NOT NULL,
  tax_cents         BIGINT       NOT NULL,
  benefit_cents     BIGINT       NOT NULL,
  net_cents         BIGINT       NOT NULL,
  breakdown         JSONB        NOT NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX paystubs_employee ON paystubs (employee_id);

-- Who did what and when, for admin actions that touch pay.
CREATE TABLE audit_log (
  id            BIGSERIAL PRIMARY KEY,
  actor_user_id BIGINT      REFERENCES users(id) ON DELETE SET NULL,
  action        TEXT        NOT NULL,
  entity        TEXT        NOT NULL,
  entity_id     BIGINT,
  details       JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created ON audit_log (created_at DESC);
