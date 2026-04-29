"""
Multi-objective route optimization.

Phase 1 implementation:
  - Build a directed graph from active routes (origin_hub -> destination_hub)
  - Each edge has CO2, cost-USD, time-hours weights derived from
    distance, transport mode, and recent score
  - For each (origin, destination) request:
      1. Enumerate up to K shortest simple paths under each single objective
      2. Combine, deduplicate, and filter to the Pareto front
      3. Rank by weighted sum of normalized objectives, return top-K
  - Returns explanations describing the tradeoff vs. neighbors

Phase 2 will replace the path search with NSGA-II (pymoo) for richer
non-dominated solutions and add a GNN to predict edge weights under
weather / fuel-price conditions absent from training.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from itertools import islice
from typing import Iterable

import networkx as nx
import numpy as np

# Cost (USD/km) and time (hours/km at typical speed) by mode.
MODE_COST_PER_KM = {"sea": 0.05, "rail": 0.08, "road": 0.18, "air": 1.20, "multimodal": 0.12}
MODE_HOURS_PER_KM = {"sea": 0.04, "rail": 0.012, "road": 0.018, "air": 0.0012, "multimodal": 0.025}
MODE_CO2_PER_KM = {"sea": 0.011, "rail": 0.022, "road": 0.062, "air": 0.602, "multimodal": 0.045}


@dataclass(slots=True)
class EdgeMeta:
    route_id: str
    transport_mode: str
    distance_km: float
    co2_kg: float
    cost_usd: float
    time_hours: float


@dataclass(slots=True)
class Solution:
    rank: int
    route_ids: list[str]
    total_co2_kg: float
    total_cost_usd: float
    total_time_hours: float
    explanation: str = ""


@dataclass(slots=True)
class OptimizerInput:
    origin_hub_id: str
    destination_hub_id: str
    weight_co2: float = 0.5
    weight_cost: float = 0.3
    weight_time: float = 0.2
    top_k: int = 3


def build_graph(routes: list[dict]) -> nx.MultiDiGraph:
    """Each row: id, origin_hub_id, destination_hub_id, distance_km, transport_mode."""
    g: nx.MultiDiGraph = nx.MultiDiGraph()
    for r in routes:
        mode = r["transport_mode"]
        dist = float(r["distance_km"])
        meta = EdgeMeta(
            route_id=str(r["id"]),
            transport_mode=mode,
            distance_km=dist,
            co2_kg=dist * MODE_CO2_PER_KM.get(mode, 0.05),
            cost_usd=dist * MODE_COST_PER_KM.get(mode, 0.10),
            time_hours=dist * MODE_HOURS_PER_KM.get(mode, 0.02),
        )
        g.add_edge(
            str(r["origin_hub_id"]),
            str(r["destination_hub_id"]),
            key=meta.route_id,
            meta=meta,
        )
    return g


def _path_objectives(g: nx.MultiDiGraph, path_keys: list[tuple[str, str, str]]) -> tuple[float, float, float, list[str]]:
    co2 = cost = hours = 0.0
    route_ids: list[str] = []
    for u, v, k in path_keys:
        meta: EdgeMeta = g[u][v][k]["meta"]
        co2 += meta.co2_kg
        cost += meta.cost_usd
        hours += meta.time_hours
        route_ids.append(meta.route_id)
    return co2, cost, hours, route_ids


def _k_shortest_by(g: nx.MultiDiGraph, source: str, target: str, weight_fn, k: int) -> Iterable[list[tuple[str, str, str]]]:
    """Yield up to k simple paths sorted by weight_fn(meta), as (u,v,key) edge sequences."""
    # Collapse to a DiGraph by picking the lightest parallel edge for shortest_paths,
    # then re-expand the chosen edge's actual key.
    sg: nx.DiGraph = nx.DiGraph()
    for u, v, k_edge, data in g.edges(keys=True, data=True):
        meta: EdgeMeta = data["meta"]
        w = weight_fn(meta)
        if not sg.has_edge(u, v) or sg[u][v]["weight"] > w:
            sg.add_edge(u, v, weight=w, key=k_edge)
    if source not in sg or target not in sg:
        return []
    try:
        gen = nx.shortest_simple_paths(sg, source, target, weight="weight")
    except nx.NetworkXNoPath:
        return []
    out: list[list[tuple[str, str, str]]] = []
    for nodes in islice(gen, k):
        out.append([(nodes[i], nodes[i + 1], sg[nodes[i]][nodes[i + 1]]["key"]) for i in range(len(nodes) - 1)])
    return out


def _pareto_front(solutions: list[Solution]) -> list[Solution]:
    """Strict Pareto: keep solutions not dominated on (co2, cost, hours)."""
    arr = np.array([[s.total_co2_kg, s.total_cost_usd, s.total_time_hours] for s in solutions])
    keep: list[Solution] = []
    for i, s in enumerate(solutions):
        others = np.delete(arr, i, axis=0)
        if others.size == 0 or not np.any(np.all(others <= arr[i], axis=1) & np.any(others < arr[i], axis=1)):
            keep.append(s)
    return keep


def _normalize_objective(values: list[float]) -> list[float]:
    if not values:
        return []
    lo, hi = min(values), max(values)
    if hi - lo < 1e-9:
        return [0.0 for _ in values]
    return [(v - lo) / (hi - lo) for v in values]


def optimize(routes: list[dict], req: OptimizerInput) -> list[Solution]:
    g = build_graph(routes)
    if req.origin_hub_id not in g or req.destination_hub_id not in g:
        return []

    # Search by each single objective, then merge.
    candidates: list[list[tuple[str, str, str]]] = []
    for fn in (
        lambda m: m.co2_kg,
        lambda m: m.cost_usd,
        lambda m: m.time_hours,
    ):
        candidates.extend(_k_shortest_by(g, req.origin_hub_id, req.destination_hub_id, fn, k=4))

    # Deduplicate by route-id sequence.
    seen: set[tuple[str, ...]] = set()
    unique: list[list[tuple[str, str, str]]] = []
    for path in candidates:
        sig = tuple(k for _, _, k in path)
        if sig in seen:
            continue
        seen.add(sig)
        unique.append(path)

    if not unique:
        return []

    rows: list[Solution] = []
    for path in unique:
        co2, cost, hours, ids = _path_objectives(g, path)
        rows.append(
            Solution(
                rank=0,
                route_ids=ids,
                total_co2_kg=round(co2, 2),
                total_cost_usd=round(cost, 2),
                total_time_hours=round(hours, 2),
            )
        )

    # Filter to Pareto front.
    front = _pareto_front(rows)
    if not front:
        front = rows

    # Weighted-sum ranking on normalized objectives.
    co2s = _normalize_objective([s.total_co2_kg for s in front])
    costs = _normalize_objective([s.total_cost_usd for s in front])
    times = _normalize_objective([s.total_time_hours for s in front])
    scored: list[tuple[float, Solution]] = []
    for i, s in enumerate(front):
        score = (
            req.weight_co2 * co2s[i]
            + req.weight_cost * costs[i]
            + req.weight_time * times[i]
        )
        scored.append((score, s))
    scored.sort(key=lambda t: t[0])

    out: list[Solution] = []
    for rank, (_, s) in enumerate(scored[: req.top_k], start=1):
        s.rank = rank
        s.explanation = _explain(s, scored)
        out.append(s)
    return out


def _explain(s: Solution, neighbors: list[tuple[float, Solution]]) -> str:
    if not neighbors:
        return "single solution"
    others = [o for _, o in neighbors if o is not s]
    if not others:
        return "best across all objectives"
    cmp_co2 = "lowest" if all(s.total_co2_kg <= o.total_co2_kg for o in others) else "competitive"
    cmp_cost = "lowest" if all(s.total_cost_usd <= o.total_cost_usd for o in others) else "competitive"
    cmp_time = "lowest" if all(s.total_time_hours <= o.total_time_hours for o in others) else "competitive"
    return f"co2 {cmp_co2}, cost {cmp_cost}, time {cmp_time}"
