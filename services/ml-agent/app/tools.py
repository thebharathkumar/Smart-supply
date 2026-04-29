"""
Tool registry exposed to the agent.

Each tool is a thin async wrapper that calls one of the other ML services
or queries the database. Schemas are JSON Schema dicts in the format
Anthropic's tool-use API expects.

Phase 2: wire these into a LangGraph state machine where Claude selects
which tool to call next, and intermediate steps stream over SSE.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable

import httpx


@dataclass(slots=True)
class Tool:
    name: str
    description: str
    input_schema: dict[str, Any]
    handler: Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]


def build_tools(
    forecast_url: str,
    optimize_url: str,
    http: httpx.AsyncClient,
) -> list[Tool]:
    async def forecast_supplier(args: dict[str, Any]) -> dict[str, Any]:
        sid = args["supplier_id"]
        horizon = int(args.get("horizon_days", 30))
        r = await http.post(f"{forecast_url}/forecast/supplier/{sid}", params={"horizon_days": horizon})
        r.raise_for_status()
        return r.json()

    async def optimize_route(args: dict[str, Any]) -> dict[str, Any]:
        r = await http.post(f"{optimize_url}/optimize/route", json=args)
        r.raise_for_status()
        return r.json()

    async def get_emissions_history(args: dict[str, Any]) -> dict[str, Any]:
        # Phase 2: query TimescaleDB directly via asyncpg pool.
        return {"todo": "phase 2 - direct DB query for emissions history"}

    async def find_similar_suppliers(args: dict[str, Any]) -> dict[str, Any]:
        # Phase 2: pgvector similarity through backend API.
        return {"todo": "phase 2 - pgvector similarity via /api/suppliers/similar"}

    async def simulate_intervention(args: dict[str, Any]) -> dict[str, Any]:
        # Phase 2: counterfactual scoring of a proposed change.
        return {"todo": "phase 2 - counterfactual simulator"}

    return [
        Tool(
            name="forecast_supplier",
            description="Forecast a supplier's carbon score over the next N days.",
            input_schema={
                "type": "object",
                "properties": {
                    "supplier_id": {"type": "string", "format": "uuid"},
                    "horizon_days": {"type": "integer", "minimum": 1, "maximum": 365},
                },
                "required": ["supplier_id"],
            },
            handler=forecast_supplier,
        ),
        Tool(
            name="optimize_route",
            description="Find Pareto-optimal routes between two hubs given weight tradeoffs.",
            input_schema={
                "type": "object",
                "properties": {
                    "originHubId": {"type": "string", "format": "uuid"},
                    "destinationHubId": {"type": "string", "format": "uuid"},
                    "weightCo2": {"type": "number", "minimum": 0, "maximum": 1},
                    "weightCost": {"type": "number", "minimum": 0, "maximum": 1},
                    "weightTime": {"type": "number", "minimum": 0, "maximum": 1},
                    "topK": {"type": "integer", "minimum": 1, "maximum": 10},
                },
                "required": ["originHubId", "destinationHubId"],
            },
            handler=optimize_route,
        ),
        Tool(
            name="get_emissions_history",
            description="Retrieve historical emissions for a supplier (Phase 2).",
            input_schema={
                "type": "object",
                "properties": {
                    "supplier_id": {"type": "string"},
                    "days": {"type": "integer", "minimum": 1, "maximum": 365},
                },
                "required": ["supplier_id"],
            },
            handler=get_emissions_history,
        ),
        Tool(
            name="find_similar_suppliers",
            description="Find suppliers semantically similar to a reference (Phase 2).",
            input_schema={
                "type": "object",
                "properties": {
                    "reference_supplier_id": {"type": "string"},
                    "top_k": {"type": "integer", "minimum": 1, "maximum": 20},
                },
                "required": ["reference_supplier_id"],
            },
            handler=find_similar_suppliers,
        ),
        Tool(
            name="simulate_intervention",
            description="Simulate the impact of a proposed change (Phase 2).",
            input_schema={
                "type": "object",
                "properties": {
                    "intervention": {"type": "object"},
                },
                "required": ["intervention"],
            },
            handler=simulate_intervention,
        ),
    ]
