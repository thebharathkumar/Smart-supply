# Smart Supply

> Intelligent Supply Chain Carbon Footprint Optimizer.
> Real-time, event-driven, AI-native — designed as a production-grade reference architecture.

Smart Supply ingests live shipment telemetry, scores routes by carbon intensity, forecasts supplier emission trajectories with Prophet, plans Pareto-optimal routes with NSGA-II, and lets operators drive an agentic Claude-powered planner over natural-language goals — all observed end-to-end with OpenTelemetry.

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
        O[ml-optimize<br/>NSGA-II + d3 graph]
        A[ml-agent<br/>State machine + Claude]
    end

    subgraph Frontend
        FE[React<br/>Map + Network + Forecast + Agent]
    end

    subgraph Observability
        J[(Jaeger)]
        P[(Prometheus)]
        G[Grafana]
    end

    SIM -- shipment.position<br/>shipment.fuel<br/>port.congestion<br/>weather --> K
    K --> BE
    BE -- writes hypertables --> PG
    BE -- shipment.score_updated --> K
    BE -- WS fanout --> R
    R -- subscribe --> BE
    BE <-- WS / SSE --> FE
    FE -- REST --> BE
    BE -- proxy --> F
    BE -- proxy --> O
    BE -- proxy --> A
    A -- tool calls --> F
    A -- tool calls --> O
    F -- queries --> PG
    O -- queries --> PG
    A -- queries --> PG
    BE -. OTLP .-> J
    F -. OTLP .-> J
    O -. OTLP .-> J
    A -. OTLP .-> J
    BE -. metrics .-> P
    F -. metrics .-> P
    O -. metrics .-> P
    A -. metrics .-> P
    P --> G
    J --> G
```

### Why each piece

| Layer | Choice | Why |
|---|---|---|
| Storage | Postgres 16 + TimescaleDB + pgvector | One DB for relational + time-series + semantic search ([ADR-0002](docs/adr/0002-timescaledb.md)) |
| Ingest | Kafka (Redpanda dev) + Schema Registry | Durable, replayable, partition-ordered telemetry; schema drift fails at the boundary ([ADR-0004](docs/adr/0004-kafka-vs-redis-pubsub.md), [ADR-0008](docs/adr/0008-schema-registry.md)) |
| Realtime | Redis pub/sub + WebSocket | ms-latency UI fanout decoupled from broker ([ADR-0004](docs/adr/0004-kafka-vs-redis-pubsub.md)) |
| Backend | Fastify v5 + Drizzle + Zod | Strict types end-to-end, fast HTTP, idiomatic TS |
| Forecasting | Prophet + naive seasonal fallback | Honest about uncertainty; backtest MAPE included |
| Optimization | NSGA-II + Pareto front + GraphSAGE | Diverse Pareto-optimal solutions; opt-in GNN learns weather/congestion adjustments ([ADR-0003](docs/adr/0003-pareto-over-single-objective.md), [ADR-0007](docs/adr/0007-gnn-edge-weights.md)) |
| Agent | Hand-rolled async state machine + Claude tool-use | ~250 lines vs LangGraph's 150 MB ([ADR-0005](docs/adr/0005-langgraph-agent.md)) |
| Observability | OpenTelemetry → Jaeger + Prometheus + Grafana | One protocol, vendor-neutral, LLM token usage as span attributes ([ADR-0006](docs/adr/0006-opentelemetry.md)) |
| Frontend | React 18 + Vite + Tailwind + Leaflet + d3-force | SSE for agent stream, WS for live scores |
| Codegen | Zod → JSON Schema → Pydantic v2 | Single source of truth across TS + Python services ([Makefile `make codegen`]) |
| Deploy | Helm chart with HPA + NetworkPolicy + ServiceMonitor | One-command deploys to staging or prod with overlay values |

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

### With observability stack

```bash
# Bring up Jaeger + Prometheus + Grafana
docker compose -f infra/docker-compose.yml -f infra/docker-compose.observability.yml up -d

# Enable OTel exporters (off by default to keep base compose silent)
export OTEL_DISABLED=false
docker compose -f infra/docker-compose.yml -f infra/docker-compose.observability.yml up -d --force-recreate backend ml-forecast ml-optimize ml-agent

# Jaeger:    http://localhost:16686
# Prometheus: http://localhost:9090
# Grafana:   http://localhost:3001  (admin / admin)
#   - "Smart Supply / Overview" dashboard auto-provisioned
```

### Optional: enable the LLM agent

```bash
echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env
docker compose -f infra/docker-compose.yml up -d ml-agent
```

If `ANTHROPIC_API_KEY` is unset, `ml-agent` runs in **deterministic mode**: a pre-scripted forecast → optimize → synthesize toolchain. The Agent Console UI shows which mode is active.

---

## Frontend tour

| View | What it shows |
|---|---|
| `/` Operations Map | Leaflet world map with live route polylines colored by score, hub markers, click-to-inspect side panel with 12h sparkline |
| `/network` | d3-force directed graph of the supply network. Click hub → select origin. Shift+click → destination. Click "Find Pareto routes" → NSGA-II runs and highlights solutions |
| `/forecast` | Per-supplier 30/60/90-day forecast with prediction interval, MAPE backtest score |
| `/agent` | Natural-language goal → live SSE stream of agent reasoning (thoughts, tool calls, tool results, final plan) with token-usage display |

---

## Run the load tests

```bash
docker compose -f infra/docker-compose.yml up -d   # stack must be up + seeded

k6 run -e BASE_URL=http://localhost:4000 infra/k6/rest-baseline.js
k6 run -e BASE_URL=http://localhost:4000 infra/k6/optimize-load.js
k6 run -e BASE_URL=http://localhost:4000 infra/k6/forecast-load.js
k6 run -e BASE_URL=ws://localhost:4000 infra/k6/ws-fanout.js
```

Each script asserts the SLO it tests; thresholds documented in script headers.

| SLO | Target | Verified by |
|---|---|---|
| WS round-trip latency | p95 < 200ms, p99 < 500ms | `ws-fanout.js` |
| NSGA-II optimization | p95 < 800ms, p99 < 1500ms | `optimize-load.js` |
| Forecast (cold) | p95 < 2s | `forecast-load.js` |
| REST reads (routes/suppliers/hubs) | p95 < 150/200/100ms | `rest-baseline.js` |

---

## Run the tests

```bash
# Unit (frontend Vitest + backend Vitest + Python pytest)
make test

# E2E (Playwright on Chromium + Firefox)
make test-e2e

# Regenerate Pydantic types from the Zod source-of-truth
make codegen
```

Unit tests cover NSGA-II primitives, optimizer behavior on small graphs, agent coordinator deterministic mode with mock tools, forecaster's naive fallback, and Zod schema validation across the WS protocol + ML request shapes. GNN feature encoders are tested without requiring torch installed.

E2E tests drive the four core flows (operations map, network graph, agent console, forecast view) against the live stack.

---

## Production deployment

```bash
# Build images and push to your registry
make docker:build && make docker:push

# Install / upgrade with the staging overlay
helm upgrade --install smart-supply infra/helm/smart-supply \
  --namespace smart-supply-staging --create-namespace \
  --values infra/helm/smart-supply/values.staging.yaml \
  --set image.tag=$GIT_SHA

# Promote to prod
helm upgrade --install smart-supply infra/helm/smart-supply \
  --namespace smart-supply-prod --create-namespace \
  --values infra/helm/smart-supply/values.prod.yaml \
  --set image.tag=$GIT_SHA
```

The chart includes:

- HPAs on backend / ml-forecast / ml-optimize keyed on CPU
- NetworkPolicy default-deny + targeted allow rules
- ServiceMonitor objects for Prometheus Operator
- Pre-install Helm hook that runs DB migrations before any service rollout
- Ingress with cert-manager TLS and SSE-friendly nginx annotations
- `ANTHROPIC_API_KEY` pulled from an existing K8s secret with `optional: true` so missing key doesn't fail the deployment

---

## Repository layout

```
smart-supply/
├── apps/
│   ├── frontend/         React + Vite + Tailwind + Leaflet + d3-force
│   ├── backend/          Fastify + WS + stream consumer + OTel
│   └── simulator/        Kafka producer for synthetic telemetry
├── services/
│   ├── ml-forecast/      FastAPI + Prophet (+ tests)
│   ├── ml-optimize/      FastAPI + NSGA-II + NetworkX (+ tests)
│   └── ml-agent/         FastAPI + custom state-machine + Claude (+ tests)
├── packages/
│   ├── db/               Drizzle schema + raw SQL migrations + seed
│   ├── shared-types/     Zod schemas (one source of truth)
│   └── proto/            Kafka topic config + per-topic validators
├── infra/
│   ├── docker-compose.yml
│   ├── docker-compose.observability.yml
│   ├── k6/               Load tests with SLO thresholds
│   ├── grafana/          Dashboards + auto-provisioning
│   ├── postgres/init.sql
│   └── prometheus/
├── docs/adr/             6 ADRs for the architectural decisions
├── Jenkinsfile           Declarative pipeline with parallel stages
└── .github/workflows/ci.yml
```

---

## Implementation status

### Phase 1 — complete

- [x] Monorepo with pnpm workspaces, strict TypeScript, strict Python typing
- [x] Docker Compose with Postgres+TimescaleDB+pgvector, Redis, Redpanda, all healthchecked
- [x] Drizzle schema + raw SQL migrations including hypertables and continuous aggregate
- [x] Deterministic seed: 30 hubs, 80 suppliers across 25 countries, 50 routes, 6 months telemetry
- [x] IVFFlat cosine index on supplier embeddings for semantic search
- [x] Fastify backend with WebSocket hub (Redis-backed multi-instance fanout)
- [x] Stream consumer: 5s tumbling windows over Kafka topics, writes hypertables, emits derived events
- [x] Kafka simulator producing position, fuel, weather, port congestion events
- [x] React frontend: Operations Map, Network Graph (d3-force), Forecast, Agent Console
- [x] WebSocket client with reconnect, exponential backoff, heartbeat, message queue

### Phase 2 — complete

- [x] **`ml-forecast`**: Prophet forecasting + naive seasonal fallback + MAPE backtest
- [x] **`ml-optimize`**: NSGA-II ranking (fast non-dominated sort + crowding distance) + one-generation evolutionary perturbation
- [x] **`ml-agent`**: hand-rolled async state-machine coordinator with Claude tool-use, SSE streaming, deterministic-mode fallback when no API key
- [x] **OpenTelemetry**: traces + metrics across all services, Grafana dashboard, LLM token usage as span attributes
- [x] **k6 load tests** with SLO thresholds for the four perf targets
- [x] **Unit tests**: NSGA-II primitives, optimizer, agent coordinator, forecaster, backend Zod schemas

### Phase 3 — complete

- [x] **GNN edge-weight predictor** (PyTorch Geometric, GraphSAGE + per-edge MLP head). Opt-in via `useGnn:true`; service runs with baseline factors when the checkpoint is absent.
- [x] **Helm chart** under `infra/helm/smart-supply` with values overlays for staging + prod, HPAs, ServiceMonitors, NetworkPolicies, pre-install migration job.
- [x] **Playwright E2E** suite covering operations map, network graph, agent console, forecast view (Chromium + Firefox).
- [x] **Pydantic-from-Zod codegen** pipeline (`make codegen`) so Python services share types with `packages/shared-types` automatically.
- [x] **Schema registry** integration with Redpanda's built-in registry: schema-id headers on every Kafka message, header + Zod validation on every consumer.

### Engineering hygiene

- [x] Jenkinsfile + GitHub Actions CI
- [x] **8 ADRs**: monorepo, TimescaleDB, Pareto, Kafka vs Redis, agent coordinator, OpenTelemetry, GNN, schema registry
- [x] Project Makefile centralizes `codegen / test / test-e2e / lint / format / up / down / migrate / seed`

---

## Performance targets

| Metric | Target | Verified |
|---|---|---|
| WebSocket round-trip (client → backend → Redis → client) | p95 < 200ms, p99 < 500ms | k6 `ws-fanout.js` |
| NSGA-II route optimization (50 routes) | p95 < 800ms | k6 `optimize-load.js` |
| 30-day forecast generation (cold) | p95 < 2s | k6 `forecast-load.js` |
| Agent goal → plan end-to-end | p95 < 15s | timing observed via `agent_request_seconds` histogram |
| Frontend Lighthouse | Performance > 90, A11y > 95 | manual |

---

## Security & secrets

- `.env.example` lists every required variable with placeholders. **Never commit `.env`.**
- `ANTHROPIC_API_KEY` is read from env only; service degrades to deterministic mode when absent. Tests force-clear it.
- Backend uses Zod runtime validation on every input boundary (REST query/body, WS messages).
- Postgres password in `.env.example` is `changeme_dev_only` — replace before any deployment.
- Trivy + npm audit + pip-audit run as Jenkins pipeline stages; HIGH/CRITICAL findings fail the build.

---

## What I'd do differently in production

- **Replace synthetic emission factors** with EPA SmartWay / GLEC factors fetched from an authoritative source on a daily cron.
- **Multi-region Postgres** with logical replication for read-heavy ML workloads.
- **Schema registry** so Kafka consumers fail fast on incompatible producer changes.
- **Bounded autoscaling** on simulator + stream consumer based on consumer lag, not CPU.
- **Dead-letter topics** for malformed events with replay tooling.
- **Cost ceiling on the agent**: token budgets per session, circuit breakers on tool failure loops.
- **Backpressure on WS fanout**: per-socket flow control to prevent slow-client buffer growth.
- **Prophet → DeepAR / TFT** if forecast accuracy plateaus on supplier-specific signals.

---

## License

MIT
