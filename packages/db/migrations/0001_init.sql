-- Smart Supply initial schema.
-- Designed to be idempotent: running twice should be a no-op.

-- Extensions are created in postgres/init.sql but we ensure them here
-- in case the DB was provisioned without that init script.
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ---------- Enums ----------
DO $$ BEGIN
  CREATE TYPE transport_mode AS ENUM ('sea', 'air', 'rail', 'road', 'multimodal');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hub_type AS ENUM ('port', 'airport', 'rail', 'warehouse');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- Hubs ----------
CREATE TABLE IF NOT EXISTS hubs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT NOT NULL,
  country     VARCHAR(2) NOT NULL,
  type        hub_type NOT NULL,
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS hubs_country_idx ON hubs (country);

-- ---------- Suppliers ----------
CREATE TABLE IF NOT EXISTS suppliers (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                 TEXT NOT NULL,
  country              VARCHAR(2) NOT NULL,
  epa_baseline_factor  DOUBLE PRECISION NOT NULL,
  transport_modes      TEXT[] NOT NULL,
  embedding            vector(384),
  metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,
  active               BOOLEAN NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS suppliers_country_idx ON suppliers (country);
CREATE INDEX IF NOT EXISTS suppliers_active_idx ON suppliers (active);
-- IVFFlat for cosine sim. Build after seeding for best recall.
CREATE INDEX IF NOT EXISTS suppliers_embedding_idx
  ON suppliers USING ivfflat (embedding vector_cosine_ops) WITH (lists = 20);

-- ---------- Routes ----------
CREATE TABLE IF NOT EXISTS routes (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  supplier_id          UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  origin_hub_id        UUID NOT NULL REFERENCES hubs(id),
  destination_hub_id   UUID NOT NULL REFERENCES hubs(id),
  distance_km          DOUBLE PRECISION NOT NULL,
  transport_mode       transport_mode NOT NULL,
  active               BOOLEAN NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS routes_supplier_idx ON routes (supplier_id);
CREATE INDEX IF NOT EXISTS routes_active_idx ON routes (active);

-- ---------- Emissions telemetry (hypertable) ----------
CREATE TABLE IF NOT EXISTS emissions_telemetry (
  time            TIMESTAMPTZ NOT NULL,
  route_id        UUID NOT NULL,
  supplier_id     UUID NOT NULL,
  co2_kg          DOUBLE PRECISION NOT NULL,
  fuel_l          DOUBLE PRECISION NOT NULL,
  distance_km     DOUBLE PRECISION NOT NULL,
  transport_mode  transport_mode NOT NULL,
  PRIMARY KEY (time, route_id)
);
SELECT create_hypertable(
  'emissions_telemetry', 'time',
  chunk_time_interval => INTERVAL '1 day',
  if_not_exists => TRUE
);
CREATE INDEX IF NOT EXISTS emissions_telemetry_route_idx
  ON emissions_telemetry (route_id, time DESC);
CREATE INDEX IF NOT EXISTS emissions_telemetry_supplier_idx
  ON emissions_telemetry (supplier_id, time DESC);

-- ---------- Carbon scores (hypertable) ----------
CREATE TABLE IF NOT EXISTS carbon_scores (
  time              TIMESTAMPTZ NOT NULL,
  route_id          UUID NOT NULL,
  score             DOUBLE PRECISION NOT NULL,
  score_components  JSONB NOT NULL DEFAULT '{}'::jsonb,
  model_version     TEXT NOT NULL DEFAULT 'v1',
  confidence_lower  DOUBLE PRECISION,
  confidence_upper  DOUBLE PRECISION,
  PRIMARY KEY (time, route_id)
);
SELECT create_hypertable(
  'carbon_scores', 'time',
  chunk_time_interval => INTERVAL '1 day',
  if_not_exists => TRUE
);
CREATE INDEX IF NOT EXISTS carbon_scores_route_idx ON carbon_scores (route_id, time DESC);

-- ---------- Continuous aggregate: hourly rollups ----------
CREATE MATERIALIZED VIEW IF NOT EXISTS emissions_hourly
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 hour', time) AS bucket,
  route_id,
  supplier_id,
  AVG(co2_kg)        AS avg_co2_kg,
  SUM(co2_kg)        AS total_co2_kg,
  AVG(fuel_l)        AS avg_fuel_l,
  COUNT(*)           AS samples
FROM emissions_telemetry
GROUP BY bucket, route_id, supplier_id
WITH NO DATA;

-- Refresh policy: keep last 30 days fresh on a 30-min cadence.
SELECT add_continuous_aggregate_policy(
  'emissions_hourly',
  start_offset => INTERVAL '30 days',
  end_offset   => INTERVAL '1 hour',
  schedule_interval => INTERVAL '30 minutes',
  if_not_exists => TRUE
);

-- ---------- Forecasts ----------
CREATE TABLE IF NOT EXISTS forecasts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  forecast_run_id UUID NOT NULL,
  supplier_id     UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  horizon_date    TIMESTAMPTZ NOT NULL,
  predicted_score DOUBLE PRECISION NOT NULL,
  ci_lower        DOUBLE PRECISION NOT NULL,
  ci_upper        DOUBLE PRECISION NOT NULL,
  model           TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS forecasts_supplier_idx ON forecasts (supplier_id, horizon_date);
CREATE INDEX IF NOT EXISTS forecasts_run_idx ON forecasts (forecast_run_id);

-- ---------- Optimization runs ----------
CREATE TABLE IF NOT EXISTS optimization_runs (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  goal               JSONB NOT NULL,
  pareto_solutions   JSONB NOT NULL,
  agent_trace        JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------- Agent sessions ----------
CREATE TABLE IF NOT EXISTS agent_sessions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_goal   TEXT NOT NULL,
  messages    JSONB NOT NULL DEFAULT '[]'::jsonb,
  final_plan  JSONB,
  status      TEXT NOT NULL DEFAULT 'running',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS agent_sessions_status_idx ON agent_sessions (status, created_at DESC);
