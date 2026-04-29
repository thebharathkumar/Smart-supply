#!/usr/bin/env python3
"""
Train the edge-weight GNN against historical telemetry.

Pipeline:
  1. Pull (route, daily window, observed_co2) tuples from emissions_telemetry
  2. Pull route + hub metadata for graph structure
  3. Build per-window snapshots: node features (hub) + edge features
     (mode + distance + observed weather/congestion if available)
  4. Target = observed_co2 / baseline_co2(distance, mode)
  5. Train EdgeWeightGNN with MSE loss on log-multipliers
  6. Save state_dict to <MODEL_OUT>

Usage:
    DATABASE_URL=postgres://... python scripts/train_gnn.py \\
        --epochs 20 --out models/gnn-edge-predictor.pt

Resource note: this is feasible on CPU for the seeded ~50-route graph.
For real-world deployment with thousands of routes and high-frequency
weather joins, run on a single GPU node and increase batch size.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

# Make `from app.gnn import ...` work when run from the service root.
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import asyncpg  # noqa: E402

from app.gnn import (  # noqa: E402
    EDGE_FEATURE_DIM,
    NODE_FEATURE_DIM,
    TRANSPORT_MODES,
    EdgeContext,
    HubFeatures,
    build_model,
    encode_edge,
    encode_node,
)


# Baseline CO2 per ton-km used by the optimizer; matches optimizer.py.
MODE_CO2_PER_KM = {"sea": 0.011, "rail": 0.022, "road": 0.062, "air": 0.602, "multimodal": 0.045}


async def fetch_data(dsn: str) -> tuple[list[dict], list[dict], list[dict]]:
    pool = await asyncpg.create_pool(dsn, min_size=1, max_size=2)
    try:
        hubs = [
            dict(r)
            for r in await pool.fetch(
                "SELECT id::text AS id, type::text AS type, lat, lng FROM hubs"
            )
        ]
        routes = [
            dict(r)
            for r in await pool.fetch(
                "SELECT id::text AS id, origin_hub_id::text AS origin_hub_id, "
                "destination_hub_id::text AS destination_hub_id, distance_km, "
                "transport_mode::text AS transport_mode FROM routes WHERE active = TRUE"
            )
        ]
        # Daily averages over the last 90 days per route.
        history = [
            dict(r)
            for r in await pool.fetch(
                """
                SELECT
                  time_bucket(INTERVAL '1 day', time) AS bucket,
                  route_id::text AS route_id,
                  AVG(co2_kg) AS avg_co2_kg
                FROM emissions_telemetry
                WHERE time >= NOW() - INTERVAL '90 days'
                GROUP BY bucket, route_id
                """
            )
        ]
        return hubs, routes, history
    finally:
        await pool.close()


def build_dataset(hubs: list[dict], routes: list[dict], history: list[dict]):
    """One snapshot per day. Targets = observed / baseline."""
    import torch

    hub_idx = {h["id"]: i for i, h in enumerate(hubs)}
    degrees = {h["id"]: 0 for h in hubs}
    for r in routes:
        degrees[r["origin_hub_id"]] = degrees.get(r["origin_hub_id"], 0) + 1
        degrees[r["destination_hub_id"]] = degrees.get(r["destination_hub_id"], 0) + 1

    node_features = [
        encode_node(
            HubFeatures(
                type=h["type"],
                lat=h["lat"],
                lng=h["lng"],
                degree=degrees[h["id"]],
                country_bucket=(hash(h.get("country", "")) % 256) / 256.0,
            )
        )
        for h in hubs
    ]
    x = torch.tensor(node_features, dtype=torch.float32)

    routes_by_id = {r["id"]: r for r in routes}

    # Group history by bucket for snapshot batches.
    buckets: dict = {}
    for row in history:
        buckets.setdefault(row["bucket"], []).append(row)

    snapshots = []
    for bucket, rows in buckets.items():
        edge_index_pairs: list[tuple[int, int]] = []
        edge_features: list[list[float]] = []
        targets: list[float] = []
        for row in rows:
            r = routes_by_id.get(row["route_id"])
            if not r:
                continue
            mode = r["transport_mode"]
            dist = float(r["distance_km"])
            baseline = dist * MODE_CO2_PER_KM.get(mode, 0.05)
            if baseline <= 0:
                continue
            multiplier = float(row["avg_co2_kg"]) / baseline
            # Clamp absurd outliers.
            multiplier = max(0.3, min(3.0, multiplier))
            edge_index_pairs.append(
                (hub_idx[r["origin_hub_id"]], hub_idx[r["destination_hub_id"]])
            )
            edge_features.append(
                encode_edge(EdgeContext(transport_mode=mode, distance_km=dist))
            )
            targets.append(multiplier)
        if not edge_index_pairs:
            continue
        edge_index = (
            torch.tensor(edge_index_pairs, dtype=torch.long).t().contiguous()
        )
        edge_attr = torch.tensor(edge_features, dtype=torch.float32)
        y = torch.tensor(targets, dtype=torch.float32)
        snapshots.append((x, edge_index, edge_attr, y))
    return snapshots


def train(snapshots: list, epochs: int, lr: float):
    import torch
    from torch import nn

    model = build_model(NODE_FEATURE_DIM, EDGE_FEATURE_DIM)
    opt = torch.optim.Adam(model.parameters(), lr=lr)
    loss_fn = nn.MSELoss()

    for ep in range(1, epochs + 1):
        model.train()
        ep_loss = 0.0
        n_edges = 0
        for x, edge_index, edge_attr, y in snapshots:
            opt.zero_grad()
            pred = model(x, edge_index, edge_attr)
            # Predict in log-space for stability; targets pre-clamped to [0.3, 3].
            loss = loss_fn(torch.log(pred + 1e-6), torch.log(y + 1e-6))
            loss.backward()
            opt.step()
            ep_loss += float(loss.item()) * y.numel()
            n_edges += y.numel()
        avg = ep_loss / max(n_edges, 1)
        print(f"epoch {ep:3d}  loss(log-mse)={avg:.5f}  edges={n_edges}")
    return model


async def amain(args: argparse.Namespace) -> int:
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("DATABASE_URL is required", file=sys.stderr)
        return 1
    print("[train] fetching data...")
    hubs, routes, history = await fetch_data(dsn)
    print(f"[train] {len(hubs)} hubs, {len(routes)} routes, {len(history)} historical points")
    if not history:
        print("[train] no history; aborting")
        return 1

    print("[train] building dataset...")
    snapshots = build_dataset(hubs, routes, history)
    if not snapshots:
        print("[train] no snapshots produced; aborting")
        return 1
    print(f"[train] {len(snapshots)} daily snapshots")

    model = train(snapshots, epochs=args.epochs, lr=args.lr)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    import torch
    torch.save(model.state_dict(), out)
    print(f"[train] wrote {out} ({out.stat().st_size} bytes)")
    return 0


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--epochs", type=int, default=20)
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--out", default="models/gnn-edge-predictor.pt")
    args = p.parse_args()
    return asyncio.run(amain(args))


if __name__ == "__main__":
    raise SystemExit(main())
