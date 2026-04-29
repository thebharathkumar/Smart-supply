"""
NSGA-II core primitives: fast non-dominated sort + crowding distance.

Used by the route optimizer to rank candidate paths across (CO2, cost, time)
objectives. Pure NumPy, no pymoo dependency required.

Reference:
  Deb, K. et al. "A fast and elitist multiobjective genetic algorithm:
  NSGA-II." IEEE Transactions on Evolutionary Computation, 2002.
"""
from __future__ import annotations

from typing import Sequence

import numpy as np


def fast_nondominated_sort(objs: np.ndarray) -> list[list[int]]:
    """
    Partition population indices into Pareto fronts (front 0 dominates 1, etc.).

    Args:
        objs: (N, M) array of objective values. All objectives are minimized.

    Returns:
        List of fronts; each front is a list of population indices.
    """
    n = objs.shape[0]
    if n == 0:
        return []

    # dominated_by_count[i] = number of solutions dominating i
    dominated_by_count = np.zeros(n, dtype=np.int64)
    # dominated_set[i] = solutions dominated by i
    dominated_set: list[list[int]] = [[] for _ in range(n)]
    fronts: list[list[int]] = [[]]

    for i in range(n):
        for j in range(i + 1, n):
            if _dominates(objs[i], objs[j]):
                dominated_set[i].append(j)
                dominated_by_count[j] += 1
            elif _dominates(objs[j], objs[i]):
                dominated_set[j].append(i)
                dominated_by_count[i] += 1
        if dominated_by_count[i] == 0:
            fronts[0].append(i)

    k = 0
    while fronts[k]:
        nxt: list[int] = []
        for i in fronts[k]:
            for j in dominated_set[i]:
                dominated_by_count[j] -= 1
                if dominated_by_count[j] == 0:
                    nxt.append(j)
        k += 1
        fronts.append(nxt)
    if not fronts[-1]:
        fronts.pop()
    return fronts


def crowding_distance(objs: np.ndarray, front: Sequence[int]) -> np.ndarray:
    """
    Compute crowding distance for solutions in a single front.

    Higher distance = more isolated in objective space = preferred.
    Boundary solutions get +inf so they're always retained.
    """
    n = len(front)
    if n == 0:
        return np.array([])
    if n <= 2:
        return np.full(n, np.inf)

    distances = np.zeros(n)
    for m in range(objs.shape[1]):
        order = sorted(range(n), key=lambda idx: objs[front[idx], m])
        f_min = objs[front[order[0]], m]
        f_max = objs[front[order[-1]], m]
        if f_max - f_min < 1e-12:
            continue
        distances[order[0]] = np.inf
        distances[order[-1]] = np.inf
        for k in range(1, n - 1):
            prev_v = objs[front[order[k - 1]], m]
            next_v = objs[front[order[k + 1]], m]
            distances[order[k]] += (next_v - prev_v) / (f_max - f_min)
    return distances


def nsga2_rank(objs: np.ndarray) -> list[int]:
    """
    Return population indices sorted by (front index ascending, crowding distance descending).
    Use this directly when you want a top-K with NSGA-II semantics.
    """
    fronts = fast_nondominated_sort(objs)
    ranked: list[int] = []
    for front in fronts:
        cd = crowding_distance(objs, front)
        # Sort within front by descending crowding distance.
        order = sorted(range(len(front)), key=lambda i: -cd[i])
        ranked.extend(front[i] for i in order)
    return ranked


def _dominates(a: np.ndarray, b: np.ndarray) -> bool:
    """a dominates b iff a is no worse on all dims and strictly better on at least one."""
    return bool(np.all(a <= b) and np.any(a < b))
