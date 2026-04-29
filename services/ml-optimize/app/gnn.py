"""
GraphSAGE-based edge-weight predictor.

Learns a multiplier `m_e` per edge such that
    co2_actual = m_e * baseline_co2(distance, mode)
where `m_e` depends on current conditions (weather, port congestion,
recent traffic) and the topological context of the edge.

Architecture:
  - 2-layer GraphSAGE over node embeddings (hub features)
  - Per-edge MLP head consuming (h_src, h_dst, edge_feature_vector)
  - Output is a non-negative multiplier (exp of a log-multiplier)

Trained with MSE loss against historical (predicted_co2 - actual_co2)
deltas. See scripts/train_gnn.py.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# Torch / torch_geometric are heavy and only required when the GNN
# is actually used. Inference and training paths import them lazily.

NODE_FEATURE_DIM = 8   # hub type one-hot (4) + country bucket (1) + lat/lng (2) + degree (1)
EDGE_FEATURE_DIM = 9   # mode one-hot (5) + distance_km (1) + wind_knots (1) + swell_m (1) + queue_depth (1)
HIDDEN_DIM = 32


def build_model(node_dim: int = NODE_FEATURE_DIM, edge_dim: int = EDGE_FEATURE_DIM, hidden: int = HIDDEN_DIM):
    """Construct an untrained EdgeWeightGNN. Imports torch lazily."""
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    from torch_geometric.nn import SAGEConv

    class EdgeWeightGNN(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.conv1 = SAGEConv(node_dim, hidden)
            self.conv2 = SAGEConv(hidden, hidden)
            self.edge_mlp = nn.Sequential(
                nn.Linear(2 * hidden + edge_dim, hidden),
                nn.ReLU(),
                nn.Linear(hidden, hidden // 2),
                nn.ReLU(),
                nn.Linear(hidden // 2, 1),
            )

        def forward(
            self,
            x: "torch.Tensor",  # noqa: F821
            edge_index: "torch.Tensor",  # noqa: F821
            edge_attr: "torch.Tensor",  # noqa: F821
        ) -> "torch.Tensor":  # noqa: F821
            h = F.relu(self.conv1(x, edge_index))
            h = F.relu(self.conv2(h, edge_index))
            src, dst = edge_index[0], edge_index[1]
            cat = torch.cat([h[src], h[dst], edge_attr], dim=-1)
            log_mul = self.edge_mlp(cat).squeeze(-1)
            # Clamp log-mul so multipliers stay in [0.5, 2.0] - emissions
            # don't realistically vary more than 2x with weather/congestion.
            return torch.exp(torch.clamp(log_mul, min=-0.7, max=0.7))

    return EdgeWeightGNN()


# ---------- Feature encoders ----------

HUB_TYPES = ["port", "airport", "rail", "warehouse"]
TRANSPORT_MODES = ["sea", "air", "rail", "road", "multimodal"]


@dataclass(slots=True)
class HubFeatures:
    type: str
    lat: float
    lng: float
    degree: int
    country_bucket: float = 0.0  # hashed country code in [0,1]


@dataclass(slots=True)
class EdgeContext:
    transport_mode: str
    distance_km: float
    wind_knots: float = 0.0
    swell_m: float = 0.0
    queue_depth: int = 0


def encode_node(f: HubFeatures) -> list[float]:
    type_oh = [1.0 if f.type == t else 0.0 for t in HUB_TYPES]
    return [
        *type_oh,
        f.country_bucket,
        f.lat / 90.0,    # normalize
        f.lng / 180.0,
        f.degree / 50.0, # rough scale for graph density
    ]


def encode_edge(c: EdgeContext) -> list[float]:
    mode_oh = [1.0 if c.transport_mode == m else 0.0 for m in TRANSPORT_MODES]
    return [
        *mode_oh,
        c.distance_km / 10000.0,  # normalize global trade distances
        c.wind_knots / 50.0,
        c.swell_m / 6.0,
        c.queue_depth / 30.0,
    ]


# ---------- Inference helper ----------

def predict_multipliers(
    model: Any,
    node_features: list[list[float]],
    edge_index_pairs: list[tuple[int, int]],
    edge_features: list[list[float]],
):
    """Run a single forward pass. Returns list[float] of multipliers per edge."""
    import torch

    x = torch.tensor(node_features, dtype=torch.float32)
    edge_index = torch.tensor(edge_index_pairs, dtype=torch.long).t().contiguous()
    edge_attr = torch.tensor(edge_features, dtype=torch.float32)
    model.eval()
    with torch.no_grad():
        out = model(x, edge_index, edge_attr)
    return out.cpu().tolist()
