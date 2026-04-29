# ADR 0007: GraphSAGE-based edge-weight predictor in ml-optimize

**Status:** Accepted (opt-in)
**Date:** 2026-04-29

## Context

Baseline emission factors (kg CO₂ per ton-km per mode) are static and ignore real-world variance. A trans-Pacific sea leg passing through a stormy weather system burns more fuel; a route into a congested port idles ships at anchor. Both push observed CO₂ above the baseline by 30-80%. NSGA-II ranking with a static baseline misses these dynamics.

We want a learned correction factor per edge, conditioned on current conditions and graph context.

## Decision

Train a 2-layer **GraphSAGE** GNN with a per-edge MLP head. Output is a multiplier in `[0.5, 2.0]` applied to baseline CO₂ before NSGA-II ranking.

- **Node features (8-dim):** hub type one-hot, country bucket, normalized lat/lng, degree.
- **Edge features (9-dim):** mode one-hot, normalized distance, wind, swell, queue depth.
- **Training target:** observed CO₂ ÷ baseline CO₂, clamped to `[0.3, 3.0]` to discard outliers.
- **Loss:** MSE on log-multipliers (stability + symmetric treatment of >1× and <1×).
- **Deployment:** opt-in via `useGnn: true` in the request body. When the model file is absent, the predictor returns 1.0 multipliers and the optimizer behaves identically to the baseline.

## Consequences

**Pros:**
- Exposes the model only when there's value to extract (when `useGnn=true`).
- Default behavior unchanged — production stays predictable.
- GraphSAGE captures neighborhood effects (downstream port congestion making upstream legs slower) that a per-edge MLP would miss.
- The model is small (~10k parameters); CPU inference is sub-millisecond per edge.

**Cons:**
- Adds torch + torch_geometric (~700 MB) when actually deployed. Mitigation: split into `requirements-gnn.txt` so the base image stays slim.
- Training requires historical telemetry; the first 30+ days of operation produce baseline-only optimization. Acceptable.
- Multiplier clamping `[0.5, 2.0]` is a guardrail, not an empirical bound. We log when the model wants to exceed the bounds so operators can recalibrate if needed.

## Alternatives considered

- **Per-edge MLP only** — simpler, deploys in <50 MB, but blind to neighborhood context. Tested briefly; underfit on cases where congestion at port B affected sea legs into B.
- **Gradient-boosted trees** (XGBoost) over hand-engineered neighborhood aggregates. Likely competitive; we picked a GNN for the cleaner generalization story when the topology changes.
- **Online learning via the score-update Kafka feedback loop** — promising but operationally risky as the first iteration. Ship batch training first, online second.

## Rollout

1. **Phase 3a:** ship the model + training script, leave `useGnn` defaulting to false. (this commit)
2. **Phase 3b:** flag-flip in staging, monitor MAPE of route-level CO₂ predictions.
3. **Phase 3c:** default `useGnn=true` if MAPE on backtest stays under 8%.
