"""
Multi-objective route optimization with NSGA-II ranking.

Pipeline:
  1. Build directed multigraph from active routes.
  2. Seed population: K-shortest simple paths under each single objective.
  3. Evolve one generation: mutate by swapping a random hop's transport
     mode (e.g. air -> sea on a parallel-edge alternative).
  4. Evaluate (CO2, cost, time) per candidate.
  5. NSGA-II ranking (fast non-dominated sort + crowding distance) over
     the combined parent + offspring population.
  6. Return top-K by ranking. The reported tradeoff explanation is
     derived from each solution's position relative to neighbors.

Why this over plain weighted sum: NSGA-II surfaces *diverse*
Pareto-optimal solutions rather than collapsing the front to a single
"best" point. The weighted sum is still applied as a final tie-breaker
within the top front when topK > front size.
"""
from __future__ import annotations

import random
from dataclasses import dataclass
from itertools import islice
from typing import Iterable

import networkx as nx
import numpy as np

from .nsga2 import crowding_distance, fast_nondominated_sort, nsga2_rank

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
    front: int = 0
    crowding: float = 0.0


@dataclass(slots=True)
class OptimizerInput:
    origin_hub_id: str
    destination_hub_id: str
    weight_co2: float = 0.5
    weight_cost: float = 0.3
    weight_time: float = 0.2
    top_k: int = 3
    # When provided, edge CO2 is multiplied by this map[route_id] before
    # ranking. Produced by gnn_inference.GnnPredictor.adjust_edges().
    edge_co2_multipliers: dict[str, float] | None = None


def build_graph(
    routes: list[dict],
    edge_co2_multipliers: dict[str, float] | None = None,
) -> nx.MultiDiGraph:
    g: nx.MultiDiGraph = nx.MultiDiGraph()
    for r in routes:
        mode = r["transport_mode"]
        dist = float(r["distance_km"])
        rid = str(r["id"])
        baseline_co2 = dist * MODE_CO2_PER_KM.get(mode, 0.05)
        mult = (edge_co2_multipliers or {}).get(rid, 1.0)
        meta = EdgeMeta(
            route_id=rid,
            transport_mode=mode,
            distance_km=dist,
            co2_kg=baseline_co2 * mult,
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


def _k_shortest_by(
    g: nx.MultiDiGraph,
    source: str,
    target: str,
    weight_fn,  # type: ignore[no-untyped-def]
    k: int,
) -> Iterable[list[tuple[str, str, str]]]:
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


def _mutate(
    g: nx.MultiDiGraph,
    path: list[tuple[str, str, str]],
    rng: random.Random,
) -> list[tuple[str, str, str]]:
    """Swap a random edge for a parallel edge with a different transport mode."""
    if not path:
        return path
    idx = rng.randrange(len(path))
    u, v, k = path[idx]
    parallels = list(g[u][v].keys())
    if len(parallels) <= 1:
        return path
    new_key = rng.choice([p for p in parallels if p != k])
    new_path = path.copy()
    new_path[idx] = (u, v, new_key)
    return new_path


def optimize(routes: list[dict], req: OptimizerInput, *, seed: int = 0) -> list[Solution]:
    rng = random.Random(seed)
    g = build_graph(routes, edge_co2_multipliers=req.edge_co2_multipliers)
    if req.origin_hub_id not in g or req.destination_hub_id not in g:
        return []

    # Seed: K-shortest by each objective.
    seeds: list[list[tuple[str, str, str]]] = []
    for fn in (lambda m: m.co2_kg, lambda m: m.cost_usd, lambda m: m.time_hours):
        seeds.extend(_k_shortest_by(g, req.origin_hub_id, req.destination_hub_id, fn, k=4))

    # Evolutionary perturbation: 1 generation of mutation.
    offspring: list[list[tuple[str, str, str]]] = []
    for _ in range(min(20, len(seeds) * 2)):
        if not seeds:
            break
        parent = rng.choice(seeds)
        offspring.append(_mutate(g, parent, rng))

    population = seeds + offspring

    # Deduplicate by route-id sequence.
    seen: set[tuple[str, ...]] = set()
    unique: list[list[tuple[str, str, str]]] = []
    for path in population:
        sig = tuple(k for _, _, k in path)
        if sig in seen:
            continue
        seen.add(sig)
        unique.append(path)

    if not unique:
        return []

    # Evaluate.
    rows: list[Solution] = []
    objs_list: list[list[float]] = []
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
        objs_list.append([co2, cost, hours])

    objs = np.array(objs_list)

    # NSGA-II rank: front + crowding distance.
    fronts = fast_nondominated_sort(objs)
    for fi, front in enumerate(fronts):
        cd = crowding_distance(objs, front)
        for k_idx, idx in enumerate(front):
            rows[idx].front = fi
            rows[idx].crowding = float(cd[k_idx]) if not np.isinf(cd[k_idx]) else 1e9

    ranked_idx = nsga2_rank(objs)

    # If the top front is larger than top_k, break ties with weighted sum
    # over normalized objectives. Otherwise NSGA-II ordering wins.
    top_front = [i for i in ranked_idx if rows[i].front == 0]
    if len(top_front) > req.top_k:
        norm = _normalize(objs[top_front])
        weights = np.array([req.weight_co2, req.weight_cost, req.weight_time])
        scores = (norm * weights).sum(axis=1)
        order = np.argsort(scores)
        chosen = [top_front[i] for i in order[: req.top_k]]
    else:
        chosen = ranked_idx[: req.top_k]

    out: list[Solution] = []
    for rank, idx in enumerate(chosen, start=1):
        s = rows[idx]
        s.rank = rank
        s.explanation = _explain(s, [rows[i] for i in chosen if i != idx])
        out.append(s)
    return out


def _normalize(arr: np.ndarray) -> np.ndarray:
    lo = arr.min(axis=0)
    hi = arr.max(axis=0)
    rng = np.where(hi - lo < 1e-12, 1.0, hi - lo)
    return (arr - lo) / rng


def _explain(s: Solution, others: list[Solution]) -> str:
    if not others:
        return f"single solution (front {s.front})"
    cmp_co2 = "lowest" if all(s.total_co2_kg <= o.total_co2_kg for o in others) else "competitive"
    cmp_cost = "lowest" if all(s.total_cost_usd <= o.total_cost_usd for o in others) else "competitive"
    cmp_time = "lowest" if all(s.total_time_hours <= o.total_time_hours for o in others) else "competitive"
    return f"front {s.front} · co2 {cmp_co2}, cost {cmp_cost}, time {cmp_time}"
