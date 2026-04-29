# ADR 0001: Monorepo with pnpm workspaces + standalone Python services

**Status:** Accepted
**Date:** 2026-04-29

## Context

Smart Supply spans three TypeScript apps (frontend, backend, simulator) and three Python services (ml-forecast, ml-optimize, ml-agent). They share Zod schemas, Kafka topic config, and tight coupling on the Postgres schema.

## Decision

- One git repository, one `pnpm-workspace.yaml` covering `apps/*` and `packages/*`.
- Python services live under `services/*` outside the pnpm workspace, each with its own `requirements.txt` and Dockerfile.
- Cross-language type contracts live in `packages/shared-types` (Zod) and are mirrored into Python services as Pydantic models hand-maintained against the same field names. Drift is caught at integration-test time.

## Consequences

**Pros:**
- Shared tsconfig, shared Zod schemas across apps means a contract change is one PR.
- A single CI job graph; build/test/deploy all consistent.
- Easy to refactor across boundaries without juggling versions.

**Cons:**
- Python services don't get automatic schema sync. Mitigation: Phase 2 will generate Pydantic from JSON Schema exported by `shared-types` so the contract is enforced.
- The repo is bigger than any single team would need. Acceptable for a portfolio system.

## Alternatives considered

- **Polyrepo** — rejected: contract churn on day one of any feature.
- **Nx / Turborepo with built-in caching** — overkill for current size; pnpm workspaces give us the boundary we need without the config surface area.
