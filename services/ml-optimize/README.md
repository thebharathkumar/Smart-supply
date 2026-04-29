# ml-optimize

Multi-objective route optimization with NSGA-II ranking and an optional
GNN edge-weight predictor.

## Architecture

```
[POST /optimize/route]
        │
        ▼
build_graph(routes, edge_co2_multipliers?)
        │
        ▼
seed: K-shortest by each objective
        │
        ▼
mutate one generation (swap parallel edges)
        │
        ▼
fast non-dominated sort  (NSGA-II Deb 2002)
        │
        ▼
crowding distance per front
        │
        ▼
top-K from front 0; weighted-sum tie-break
```

## Optional: GNN edge-weight predictor

`useGnn: true` in the request, *and* a trained checkpoint mounted at
`GNN_MODEL_PATH`, will adjust per-edge CO₂ by a learned multiplier
based on:

- node features: hub type one-hot, country bucket, lat/lng, degree
- edge features: transport-mode one-hot, distance, weather, port congestion

The model is a 2-layer GraphSAGE + per-edge MLP head producing a
multiplier in `[exp(-0.7), exp(0.7)] ≈ [0.5, 2.0]`.

### Training

```bash
pip install -r requirements.txt -r requirements-gnn.txt
DATABASE_URL=postgres://... python scripts/train_gnn.py \
    --epochs 30 --out models/gnn-edge-predictor.pt
```

CPU is fine for the seeded ~50-route graph (~1 min for 30 epochs).
At production scale (thousands of routes, high-frequency weather joins)
run on a single GPU node.

### Deployment

Mount the checkpoint into the container and set the env var:

```yaml
volumeMounts:
  - { name: models, mountPath: /models, readOnly: true }
env:
  - { name: GNN_MODEL_PATH, value: /models/gnn-edge-predictor.pt }
```

If the file is missing, the predictor logs a warning and returns
multipliers of 1.0 — the request still succeeds with baseline factors.

### Why GraphSAGE rather than MLP-per-edge

A pure per-edge MLP can't see neighboring port congestion or upstream
weather. GraphSAGE aggregates neighborhood features, which matters for
edges where the bottleneck isn't the leg itself but something one hop
away (e.g. a downstream port queue makes the upstream sea leg slower
because ships idle).

## Tests

```bash
pytest tests
```

NSGA-II primitives, optimizer behavior on small synthetic graphs,
and explanation generation are all covered.
