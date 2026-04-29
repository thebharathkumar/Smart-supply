"""Feature encoder tests - no torch required."""
from __future__ import annotations

from app.gnn import (
    EDGE_FEATURE_DIM,
    HUB_TYPES,
    NODE_FEATURE_DIM,
    TRANSPORT_MODES,
    EdgeContext,
    HubFeatures,
    encode_edge,
    encode_node,
)


def test_encode_node_dimensionality():
    f = HubFeatures(type="port", lat=10.0, lng=20.0, degree=3, country_bucket=0.5)
    v = encode_node(f)
    assert len(v) == NODE_FEATURE_DIM
    # Type one-hot is the first 4 entries; "port" is index 0.
    assert v[0] == 1.0
    assert sum(v[: len(HUB_TYPES)]) == 1.0


def test_encode_edge_dimensionality():
    c = EdgeContext(transport_mode="sea", distance_km=8000, wind_knots=10, swell_m=2, queue_depth=5)
    v = encode_edge(c)
    assert len(v) == EDGE_FEATURE_DIM
    # Mode one-hot covers the first len(TRANSPORT_MODES) entries.
    assert v[TRANSPORT_MODES.index("sea")] == 1.0
    assert sum(v[: len(TRANSPORT_MODES)]) == 1.0


def test_encode_node_unknown_type():
    f = HubFeatures(type="unknown", lat=0, lng=0, degree=0)
    v = encode_node(f)
    assert sum(v[: len(HUB_TYPES)]) == 0.0  # no one-hot bit set


def test_encode_edge_normalization_within_range():
    c = EdgeContext(transport_mode="sea", distance_km=5000)
    v = encode_edge(c)
    # All numeric features should sit in roughly [0, 1] after normalization.
    for x in v:
        assert -0.01 <= x <= 1.01
