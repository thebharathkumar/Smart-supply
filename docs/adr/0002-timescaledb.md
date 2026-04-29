# ADR 0002: TimescaleDB for time-series storage

**Status:** Accepted
**Date:** 2026-04-29

## Context

Two of the largest tables (`emissions_telemetry`, `carbon_scores`) are append-mostly time-series with predictable query patterns: "give me the last N hours / days for these route IDs," and rollup aggregates over hour / day buckets.

Vanilla Postgres handles this until it doesn't — at hundreds of millions of rows, the b-tree index on `(route_id, time)` becomes painful and partition management becomes a non-trivial scheduled job.

## Decision

Use TimescaleDB hypertables on the `time` column with 1-day chunk intervals. Use a **continuous aggregate** (`emissions_hourly`) for hourly rollups, refreshed every 30 minutes for the last 30 days.

## Consequences

**Pros:**
- Chunk pruning means time-bounded queries scan only relevant partitions.
- Continuous aggregates make dashboards and the forecasting service cheap.
- Still Postgres — Drizzle, asyncpg, pgvector all work unchanged.

**Cons:**
- Adds an extension dependency in production. Acceptable; image is `timescale/timescaledb-ha:pg16`.
- Some Drizzle operations (creating the hypertable) require raw SQL. We accept that and keep raw migration files in `packages/db/migrations`.

## Alternatives considered

- **Plain Postgres with manual partitioning** — works but requires DIY chunk management.
- **InfluxDB / ClickHouse** — strong on time-series, but introduces a second store the rest of the system would need to query/join with relational data.
- **TimescaleDB Cloud** — when this graduates beyond a portfolio piece.
