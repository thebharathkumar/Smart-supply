# ADR 0006: OpenTelemetry as the single observability protocol

**Status:** Accepted
**Date:** 2026-04-29

## Context

We have four runtime services (backend, ml-forecast, ml-optimize, ml-agent) plus a stream consumer embedded in the backend. Operating these in production requires answering questions like:

- Why did this WebSocket message take 800ms?
- Which tool call in this agent run dominated cost?
- Is the slow forecast on `supplier-X` cache cold or upstream slow?

We need traces, metrics, and structured logs that *correlate* across service boundaries. Picking different APIs per language locks us into vendor-specific tooling.

## Decision

Adopt **OpenTelemetry** as the only observability SDK in every service:

- Node services use `@opentelemetry/sdk-node` with auto-instrumentation for HTTP, postgres, ioredis, kafkajs.
- Python services use `opentelemetry-api` + `opentelemetry-instrumentation-{fastapi,asyncpg,httpx}`.
- All services export traces and metrics over **OTLP HTTP** to a single endpoint configured via `OTEL_EXPORTER_OTLP_ENDPOINT`. Default is `http://jaeger:4318` in compose.
- Custom spans for non-trivial async paths: `withSpan('stream.flush_window', ...)` in the backend, `agent.tool.{name}` in the agent coordinator, `agent.llm.chat` for every Anthropic call.
- LLM token usage attached as span attributes (`llm.usage.input_tokens`, `llm.usage.output_tokens`) so cost is observable per-trace.
- A circuit-breaker env var `OTEL_DISABLED=true` lets tests and standalone runs skip instrumentation entirely.

The observability stack — Jaeger (traces), Prometheus (metrics), Grafana (dashboards) — runs from a separate compose overlay so the base stack stays minimal.

## Consequences

**Pros:**
- One protocol means one debugging mental model across the polyglot.
- Vendor-neutral: pointing OTLP at Honeycomb / Datadog / Grafana Cloud is a config change.
- Auto-instrumentation gets us 80% of the value with near-zero code; targeted manual spans cover the rest.
- LLM cost per session is a first-class signal, not a separate logging stream.

**Cons:**
- Adds dependencies (~10 MB across all services). Acceptable.
- OTLP collector endpoint must exist or exporter retries fail loudly. Mitigation: `OTEL_DISABLED=true` is the default in base compose; flip to false when running with the observability overlay.

## Alternatives considered

- **Vendor SDKs** (Datadog, New Relic) — strong product, but each language gets a separate SDK and changing vendor rewrites everything.
- **OpenTracing / OpenCensus** — both subsumed by OTel. Choosing them in 2026 would be archaeologically interesting.
- **Logs only with correlation IDs** — works for small systems but loses span-level latency breakdown that traces give for free.
