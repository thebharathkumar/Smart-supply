"""
Inference wrapper for the edge-weight GNN.

Loads a trained checkpoint from MODEL_PATH (env var) at startup. Falls
back gracefully when the file is absent so the service still works
without a trained model - the optimizer just uses baseline factors.

Thread-safe: torch.no_grad() forward only, no parameter updates.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import structlog

from .gnn import (
    EDGE_FEATURE_DIM,
    NODE_FEATURE_DIM,
    EdgeContext,
    HubFeatures,
    build_model,
    encode_edge,
    encode_node,
    predict_multipliers,
)


log = structlog.get_logger("ml-optimize.gnn")


class GnnPredictor:
    def __init__(self, model_path: Path | None = None) -> None:
        self.model_path = model_path
        self._model: Any | None = None
        self._loaded: bool = False

    @property
    def available(self) -> bool:
        return self._loaded and self._model is not None

    def load(self) -> None:
        """Idempotent. Loads weights if file exists, else logs and skips."""
        if self._loaded:
            return
        if self.model_path is None or not self.model_path.is_file():
            log.info("gnn weights absent; falling back to baseline factors", path=str(self.model_path))
            self._loaded = True
            return
        try:
            import torch
            self._model = build_model(NODE_FEATURE_DIM, EDGE_FEATURE_DIM)
            state = torch.load(self.model_path, map_location="cpu")
            self._model.load_state_dict(state)
            self._model.eval()
            self._loaded = True
            log.info("gnn loaded", path=str(self.model_path))
        except Exception as exc:  # noqa: BLE001
            log.warning("gnn load failed; falling back", error=str(exc))
            self._model = None
            self._loaded = True

    def adjust_edges(
        self,
        hubs: list[tuple[str, HubFeatures]],
        edges: list[tuple[str, str, str, EdgeContext]],
    ) -> dict[str, float]:
        """
        Run inference for a graph snapshot.

        Args:
          hubs: [(hub_id, HubFeatures)]
          edges: [(route_id, source_hub_id, target_hub_id, EdgeContext)]

        Returns: { route_id -> multiplier in [0.5, 2.0] }. Returns 1.0
        for everything when the model is unavailable.
        """
        if not self.available or self._model is None:
            return {e[0]: 1.0 for e in edges}

        hub_idx = {h_id: i for i, (h_id, _) in enumerate(hubs)}
        node_features = [encode_node(f) for _, f in hubs]
        edge_index_pairs = []
        edge_features = []
        route_ids: list[str] = []
        for route_id, src, dst, ctx in edges:
            if src not in hub_idx or dst not in hub_idx:
                continue
            edge_index_pairs.append((hub_idx[src], hub_idx[dst]))
            edge_features.append(encode_edge(ctx))
            route_ids.append(route_id)

        if not edge_index_pairs:
            return {}

        multipliers = predict_multipliers(
            self._model, node_features, edge_index_pairs, edge_features
        )
        out = {rid: float(m) for rid, m in zip(route_ids, multipliers, strict=False)}
        # Edges we skipped get default 1.0
        for e in edges:
            out.setdefault(e[0], 1.0)
        return out


def from_env() -> GnnPredictor:
    raw = os.environ.get("GNN_MODEL_PATH")
    path = Path(raw) if raw else None
    return GnnPredictor(path)
