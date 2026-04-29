"""Unit tests for NSGA-II primitives."""
from __future__ import annotations

import numpy as np
import pytest

from app.nsga2 import (
    crowding_distance,
    fast_nondominated_sort,
    nsga2_rank,
)


def test_empty_population():
    assert fast_nondominated_sort(np.empty((0, 2))) == []


def test_single_point():
    fronts = fast_nondominated_sort(np.array([[1.0, 2.0]]))
    assert fronts == [[0]]


def test_two_pareto_points():
    # Both non-dominated.
    pts = np.array([[1.0, 5.0], [5.0, 1.0]])
    fronts = fast_nondominated_sort(pts)
    assert len(fronts) == 1
    assert sorted(fronts[0]) == [0, 1]


def test_dominated_point_in_second_front():
    # (3,3) is dominated by (1,5) and (5,1)? No. (3,3) is dominated by (2,2).
    pts = np.array([[2.0, 2.0], [3.0, 3.0], [1.0, 5.0], [5.0, 1.0]])
    fronts = fast_nondominated_sort(pts)
    # (2,2) and (1,5) and (5,1) form the first front (they don't dominate each other)
    # actually (2,2) dominates (3,3) only, and is non-dominated.
    assert 0 in fronts[0]  # (2,2)
    assert 1 not in fronts[0]  # (3,3) dominated
    assert 1 in fronts[1]


def test_crowding_distance_boundaries_are_infinite():
    pts = np.array([[1.0, 5.0], [3.0, 3.0], [5.0, 1.0]])
    cd = crowding_distance(pts, [0, 1, 2])
    assert np.isinf(cd[0])
    assert np.isinf(cd[2])
    assert cd[1] > 0


def test_crowding_distance_two_points():
    cd = crowding_distance(np.array([[1.0, 5.0], [5.0, 1.0]]), [0, 1])
    assert all(np.isinf(cd))


def test_nsga2_rank_orders_fronts_first_then_crowding():
    pts = np.array([
        [1.0, 5.0],   # front 0, boundary -> inf crowding
        [3.0, 3.0],   # front 0, middle
        [5.0, 1.0],   # front 0, boundary -> inf crowding
        [4.0, 4.0],   # front 1
    ])
    order = nsga2_rank(pts)
    # Front 0 must come first.
    assert set(order[:3]) == {0, 1, 2}
    # Then front 1.
    assert order[3] == 3


def test_strictly_dominating_point_first():
    pts = np.array([
        [1.0, 1.0],   # dominates everything
        [2.0, 5.0],
        [5.0, 2.0],
    ])
    fronts = fast_nondominated_sort(pts)
    assert fronts[0] == [0]
    assert sorted(fronts[1]) == [1, 2]
