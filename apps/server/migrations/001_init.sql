-- 001_init: core schema. Works on PostgreSQL 13+ and on the embedded PGlite used for local dev/tests.
-- Conventions: timestamps that the engine produces are epoch MILLISECONDS stored as double precision
-- (exact up to 2^53) so the same code path works on pg and PGlite without bigint parsing differences.

-- Singleton JSON documents: settings, bot_state, demo_account, worker_status ...
CREATE TABLE IF NOT EXISTS app_state (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Closed AND open trades. `mode` keeps demo (paper) and live (exchange) completely separate.
CREATE TABLE IF NOT EXISTS trades (
  id              text PRIMARY KEY,
  mode            text NOT NULL CHECK (mode IN ('demo', 'live')),
  status          text NOT NULL CHECK (status IN ('pending_entry', 'open', 'closed', 'failed')),
  side            text NOT NULL CHECK (side IN ('long', 'short')),
  contracts       integer NOT NULL,
  qty_eth         double precision NOT NULL,
  leverage        double precision NOT NULL,
  entry_ts        double precision NOT NULL,
  exit_ts         double precision,
  entry_price     double precision,
  exit_price      double precision,
  exit_reason     text,
  stop_price      double precision,
  target_price    double precision,
  gross_pnl       double precision,
  entry_fee       double precision,
  exit_fee        double precision,
  fees            double precision,
  slippage_cost   double precision,
  funding         double precision,
  net_pnl         double precision,
  net_pnl_inr     double precision,
  hold_ms         double precision,
  mfe             double precision,
  mae             double precision,
  reached_target  boolean,
  regime          text,
  reasons         jsonb,
  meta            jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trades_mode_entry_idx ON trades (mode, entry_ts DESC);
CREATE INDEX IF NOT EXISTS trades_mode_status_idx ON trades (mode, status);

-- References to REAL exchange orders (live mode only). client_order_id is unique => a restart can never
-- re-submit the same entry for the same signal.
CREATE TABLE IF NOT EXISTS live_orders (
  id                 integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_order_id    text NOT NULL UNIQUE,
  exchange_order_id  text,
  trade_id           text NOT NULL,
  purpose            text NOT NULL CHECK (purpose IN ('entry', 'stop', 'target', 'exit', 'breakeven_stop')),
  side               text NOT NULL,
  size               integer NOT NULL,
  price              double precision,
  state              text NOT NULL DEFAULT 'submitted',
  filled_size        integer NOT NULL DEFAULT 0,
  avg_fill_price     double precision,
  commission         double precision,
  raw                jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS live_orders_trade_idx ON live_orders (trade_id);

CREATE TABLE IF NOT EXISTS live_fills (
  fill_id     text PRIMARY KEY,
  order_id    text,
  trade_id    text,
  side        text NOT NULL,
  size        integer NOT NULL,
  price       double precision NOT NULL,
  role        text,
  commission  double precision,
  ts          double precision,
  raw         jsonb
);
CREATE INDEX IF NOT EXISTS live_fills_trade_idx ON live_fills (trade_id);

-- Append-only audit trail (mode changes, live activation, kill switch, settings, credentials, logins).
CREATE TABLE IF NOT EXISTS audit_log (
  id        integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts        timestamptz NOT NULL DEFAULT now(),
  actor     text NOT NULL,
  role      text,
  action    text NOT NULL,
  success   boolean NOT NULL DEFAULT true,
  ip        text,
  details   jsonb
);
CREATE INDEX IF NOT EXISTS audit_ts_idx ON audit_log (ts DESC);
CREATE INDEX IF NOT EXISTS audit_action_idx ON audit_log (action);

CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

CREATE TABLE IF NOT EXISTS equity_snapshots (
  id        integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mode      text NOT NULL CHECK (mode IN ('demo', 'live')),
  ts        double precision NOT NULL,
  equity    double precision NOT NULL,
  balance   double precision NOT NULL,
  unrealized double precision NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS equity_mode_ts_idx ON equity_snapshots (mode, ts DESC);

CREATE TABLE IF NOT EXISTS backtest_runs (
  id           text PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('backtest', 'walkforward')),
  data_source  text NOT NULL,
  status       text NOT NULL DEFAULT 'running',
  params       jsonb NOT NULL,
  summary      jsonb,
  result       jsonb,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);

-- Exchange API credentials, encrypted at rest (AES-256-GCM). One row per exchange environment.
CREATE TABLE IF NOT EXISTS credentials (
  env             text PRIMARY KEY,
  api_key_enc     text NOT NULL,
  api_secret_enc  text NOT NULL,
  fingerprint     text NOT NULL,
  key_hint        text NOT NULL,
  updated_by      text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Single-active-worker lease: prevents two instances from trading the same account.
CREATE TABLE IF NOT EXISTS worker_lease (
  id          integer PRIMARY KEY CHECK (id = 1),
  holder      text NOT NULL,
  expires_at  double precision NOT NULL,
  started_at  double precision NOT NULL,
  info        jsonb
);
