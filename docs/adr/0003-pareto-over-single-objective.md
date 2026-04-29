# ADR 0003: Pareto front over single-objective optimization

**Status:** Accepted
**Date:** 2026-04-29

## Context

Route selection involves three competing objectives: CO₂ emissions, USD cost, and transit time. A weighted sum collapses them into a single number — easy to reason about but discards information. The "optimal" route at weights (0.5, 0.3, 0.2) is *one* point on a tradeoff curve; users often want to see the curve.

## Decision

`ml-optimize` produces the **strict Pareto front** of candidate routes between two hubs, then ranks the front using a weighted sum so we have a default top-K. The frontend (in Phase 2) will visualize the front so users can pick a different point on the curve interactively.

## Consequences

**Pros:**
- Transparency: users see what they're trading off, not just the answer.
- Robust to weight misspecification — the front itself doesn't change with weights, only the ranking.
- Sets up cleanly for NSGA-II in Phase 2 without changing the API shape.

**Cons:**
- More complex than weighted sum. Acceptable: this is the kind of complexity that improves decisions.
- Worst-case the Pareto front is the full candidate set; we cap K-shortest enumeration to keep latency bounded.

## Alternatives considered

- **Weighted-sum only** — rejected as the headline approach; we still expose it as the ranking step.
- **Goal programming** — interesting but more brittle when constraints conflict.
