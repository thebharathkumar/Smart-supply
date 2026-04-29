"""End-to-end optimizer tests on a small synthetic graph."""
from __future__ import annotations

from app.optimizer import OptimizerInput, build_graph, optimize


def _routes() -> list[dict]:
    # A -> B by sea (slow, low CO2) or air (fast, high CO2)
    # B -> C by rail or road
    return [
        {"id": "r1", "origin_hub_id": "A", "destination_hub_id": "B",
         "distance_km": 8000, "transport_mode": "sea"},
        {"id": "r2", "origin_hub_id": "A", "destination_hub_id": "B",
         "distance_km": 8000, "transport_mode": "air"},
        {"id": "r3", "origin_hub_id": "B", "destination_hub_id": "C",
         "distance_km": 500, "transport_mode": "rail"},
        {"id": "r4", "origin_hub_id": "B", "destination_hub_id": "C",
         "distance_km": 500, "transport_mode": "road"},
    ]


def test_returns_pareto_solutions():
    sols = optimize(_routes(), OptimizerInput("A", "C"), seed=1)
    assert len(sols) > 0
    assert all(s.front == 0 for s in sols), "top-K must be from front 0"


def test_no_path_returns_empty():
    sols = optimize(_routes(), OptimizerInput("X", "Y"), seed=1)
    assert sols == []


def test_explanations_set():
    sols = optimize(_routes(), OptimizerInput("A", "C", top_k=2), seed=1)
    for s in sols:
        assert "front" in s.explanation
        assert s.rank >= 1


def test_build_graph_includes_all_routes():
    g = build_graph(_routes())
    assert g.number_of_edges() == 4
