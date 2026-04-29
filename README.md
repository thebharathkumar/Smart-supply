# Smart Supply

> Intelligent Supply Chain Carbon Footprint Optimizer.
> Real-time, event-driven, AI-native — designed as a production-grade reference architecture.

Smart Supply ingests live shipment telemetry, scores routes by carbon intensity, forecasts supplier emission trajectories, and (in Phase 2) lets operators issue natural-language goals to an agent that produces an actionable plan with confidence intervals.

---

## Architecture

```mermaid
flowchart LR
    subgraph Producers
        SIM[simulator<br/>Kafka producer]
    end

    subgraph Bus
        K[(Redpanda / Kafka)]
        R[(Redis<br/>pub/sub + cache)]
    end

    subgraph Backend
        BE[Fastify backend<br/>+ stream consumer]
    end

    subgraph Storage
        PG[(Postgres 16<br/>TimescaleDB + pgvector)]
    end

    subgraph ML
        F[ml-forecast<br/>Prophet]
        O[ml-optimize<br/>Pareto + graph]
        A[ml-agent<br/>LangGraph + Claude]
    end

    subgraph Frontend
        FE[React + Leaflet]
    end

    SIM -- shipment.position<br/>shipment.fuel<br/>port.congestion<br/>weather --> K
    K --> BE
    BE -- writes hypertables --> PG
    BE -- shipment.score_updated --> K
    BE -- WS fanout --> R
    R -- subscribe --> BE
    BE <-- WS --> FE
    FE -- REST --> BE
    BE -- proxy --> F
    BE -- proxy --> O
    A -- tool calls --> F
    A -- tool calls --> O
    F -- queries --> PG
    O -- queries --> PG
    A -- queries --> PG
```

### Why each piece

| Layer | Choice | Why |
|---|---|---|
| Storage | Postgres 16 + TimescaleDB + pgvector | One DB for relational + time-series + semantic search ([ADR-0002](docs/adr/0002-timescaledb.md)) |
| Ingest | Kafka (Redpanda dev) | Durable, replayable, partition-ordered telemetry ([ADR-0004](docs/adr/0004-kafka-vs-redis-pubsub.md)) |
| Realtime | Redis pub/sub + WebSocket | ms-latency UI fanout decoupled from broker ([ADR-0004](docs/adr/0004-kafka-vs-redis-pubsub.md)) |
| Backend | Fastify v5 + Drizzle + Zod | Strict types end-to-end, fast HTTP, idiomatic TS |
| ML/AI | FastAPI + Prophet + NetworkX + LangGraph | Right tool per ML domain, not one monolith |
| Frontend | React 18 + Vite + Tailwind + Leaflet | Production-grade SPA with vector-tile-ready map abstraction |
| Optimization | Pareto front, not weighted sum | Surfaces tradeoffs honestly ([ADR-0003](docs/adr/0003-pareto-over-single-objective.md)) |

---

## Quickstart

```bash
# 1. Bring up data layer
docker compose -f infra/docker-compose.yml up -d postgres redis redpanda

# 2. Migrate + seed (creates 30 hubs, 80 suppliers, 50 routes, 6mo telemetry)
export DATABASE_URL=postgres://smartsupply:changeme_dev_only@localhost:5432/smartsupply
pnpm install
pnpm --filter @smart-supply/db migrate
pnpm --filter @smart-supply/db seed

# 3. Bring up everything else
docker compose -f infra/docker-compose.yml up -d

# 4. Open the UI
open http://localhost:5173
```

The simulator starts publishing telemetry immediately; the operations map should show routes color-coded by live carbon score within ~10 seconds.

### With observability

```bash
docker compose -f infra/docker-compose.yml -f infra/docker-compose.observability.yml up -d
# Jaeger:    http://localhost:16686
# Prometheus: http://localhost:9090
# Grafana:   http://localhost:3001  (admin / admin)
```

### Optional: enable the LLM agent (Phase 2)

```bash
# Provide your own Anthropic API key. Never commit .env.
echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env
docker compose -f infra/docker-compose.yml up -d ml-agent
```

If `ANTHROPIC_API_KEY` is unset, `ml-agent` still runs and exposes `/agent/dry-run` for a no-LLM tool-use trace.

---

## Repository layout

```
smart-supply/
├── apps/
│   ├── frontend/         React + Vite + Tailwind + Leaflet
│   ├── backend/          Fastify + WS + stream consumer
│   └── simulator/        Kafka producer for synthetic telemetry
├── services/
│   ├── ml-forecast/      FastAPI + Prophet
│   ├── ml-optimize/      FastAPI + NetworkX + Pareto front
│   └── ml-agent/         FastAPI + tool registry (LangGraph in Phase 2)
├── packages/
│   ├── db/               Drizzle schema + raw SQL migrations + seed
│   ├── shared-types/     Zod schemas (one source of truth)
│   └── proto/            Kafka topic config + per-topic validators
├── infra/
│   ├── docker-compose.yml
│   ├── docker-compose.observability.yml
│   ├── postgres/init.sql
│   └── prometheus/
├── docs/adr/             Architecture Decision Records
├── Jenkinsfile           Declarative pipeline with parallel stages
└── .github/workflows/ci.yml
```

---

## Implementation status

### Phase 1 — complete

- [x] Monorepo with pnpm workspaces, strict TypeScript, strict Python typing
- [x] Docker Compose with Postgres+TimescaleDB+pgvector, Redis, Redpanda, all healthchecked
- [x] Drizzle schema + raw SQL migrations including hypertables and continuous aggregate
- [x] Deterministic seed: 30 hubs, 80 suppliers across 25 countries with realistic grid intensity, 50 routes, 6 months of synthetic telemetry
- [x] IVFFlat cosine index on supplier embeddings for semantic search
- [x] Fastify backend with WebSocket hub (Redis-backed multi-instance fanout)
- [x] Stream consumer: 5s tumbling windows over Kafka topics, writes hypertables, emits derived events
- [x] Kafka simulator producing position, fuel, weather, and port congestion events
- [x] React frontend: Operations Map, Forecast view (live), Agent Console (Phase 2 placeholder)
- [x] WebSocket client with reconnect, exponential backoff, heartbeat, message queue
- [x] `ml-forecast` with real Prophet forecasting + naive seasonal fallback + MAPE backtest
- [x] `ml-optimize` with real graph-based Pareto-front optimization
- [x] `ml-agent` scaffold with full tool registry + dry-run endpoint
- [x] Jenkinsfile + GitHub Actions CI
- [x] ADRs: monorepo, TimescaleDB, Pareto, Kafka vs Redis, LangGraph

### Phase 2 — explicitly out of scope for this branch

These items have well-defined contracts in the codebase. Implementing them is mechanical, not architectural.

- [ ] **LangGraph + Claude agent**: full state machine, tool selection, SSE streaming. Tool registry and contract are already defined in `services/ml-agent/app/tools.py`.
- [ ] **NSGA-II via pymoo** in `ml-optimize` to replace the Pareto-from-K-shortest implementation; API shape unchanged.
- [ ] **GNN edge-weight predictor** (PyTorch Geometric) trained on historical telemetry to adjust transport-mode emission factors for weather / congestion.
- [ ] **Network Graph view** (force-directed) and **Scenario Simulator** in the frontend. The data layer is ready.
- [ ] **OpenTelemetry tracing** across all services with end-to-end correlation IDs. Observability stack already wired (Jaeger + Prometheus + Grafana); just needs SDK instrumentation in each service.
- [ ] **Helm chart** under `infra/helm/`. Compose covers dev and most demos; Helm becomes essential when running multi-replica.
- [ ] **k6 load tests** verifying p95/p99 latency targets.
- [ ] **Playwright E2E** suite.
- [ ] **Pydantic-from-JSON-Schema** generation so Python services share types with `packages/shared-types` rather than mirroring them.

---

## Performance targets (Phase 2 will verify with k6)

| Metric | Target |
|---|---|
| WebSocket round-trip (client → backend → Redis → client) | p95 < 200ms, p99 < 500ms |
| Pareto route optimization (50-route batch) | p95 < 800ms |
| 30-day forecast generation | p95 < 2s |
| Agent goal → plan end-to-end | p95 < 15s (Phase 2) |
| Frontend Lighthouse | Performance > 90, A11y > 95 |

---

## Security & secrets

- `.env.example` lists every required variable with placeholders. **Never commit `.env`.**
- `ANTHROPIC_API_KEY` is read from env only; service degrades cleanly when absent.
- Backend uses Zod runtime validation on every input boundary (REST query/body, WS messages).
- Postgres password in `.env.example` is `changeme_dev_only` — replace before any deployment.
- The Pareto optimizer and forecast service hold no user data and authenticate at the network boundary (cluster network policy in production).
- Trivy scan + npm/pip audit run as a Jenkins pipeline stage; HIGH/CRITICAL findings fail the build (currently set to `|| true` while we calibrate baseline).

---

## What I'd do differently in production

- **Replace the synthetic emission factors** with EPA SmartWay / GLEC factors fetched from an authoritative source on a daily cron.
- **Multi-region Postgres** with logical replication for read-heavy ML workloads, plus a separate analytics replica that doesn't share the OLTP path.
- **Schema registry** (e.g. Confluent or built-in to Redpanda) so Kafka consumers fail fast on incompatible producer changes rather than at parse time.
- **Bounded autoscaling** on the simulator and stream consumer based on consumer lag, not CPU — Kafka lag is the real signal.
- **Dead-letter topics** for malformed events with replay tooling; right now we silently drop.
- **Per-tenant isolation** if this ever became multi-tenant — schema-per-tenant with shared TimescaleDB hypertables doesn't scale operationally.
- **Cost ceiling on the agent**: Anthropic API costs add up; production needs token budgets per session and circuit breakers when tools repeatedly fail.
- **Backpressure on WS fanout**: today a slow client could grow the per-socket buffer unbounded. Production needs per-socket flow control.

---

## License

MIT
