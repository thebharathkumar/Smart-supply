"""
ml-optimize: multi-objective route optimization service.

Endpoints:
  GET  /health
  POST /optimize/route - Pareto-optimal routes between two hubs
"""
from __future__ import annotations

import os
import time
import uuid
from contextlib import asynccontextmanager
from typing import AsyncIterator

import asyncpg
import structlog
from fastapi import FastAPI, HTTPException
from fastapi.responses import PlainTextResponse
from prometheus_client import Counter, Histogram, generate_latest, CONTENT_TYPE_LATEST
from pydantic import BaseModel, Field

from .gnn import EdgeContext, HubFeatures
from .gnn_inference import GnnPredictor, from_env as gnn_from_env
from .optimizer import OptimizerInput, optimize
from .telemetry import init_telemetry, instrument_app

init_telemetry("ml-optimize")


structlog.configure(processors=[structlog.processors.JSONRenderer()])
log = structlog.get_logger("ml-optimize")

REQ = Counter("optimize_requests_total", "Optimization requests", ["status"])
LAT = Histogram("optimize_request_seconds", "Optimization latency", buckets=[0.05, 0.1, 0.25, 0.5, 1, 2, 5])


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    dsn = os.environ["DATABASE_URL"]
    pool = await asyncpg.create_pool(dsn, min_size=1, max_size=4)
    app.state.pool = pool
    gnn = gnn_from_env()
    gnn.load()
    app.state.gnn = gnn
    log.info("ml-optimize started", gnn_available=gnn.available)
    try:
        yield
    finally:
        await pool.close()


app = FastAPI(title="ml-optimize", version="0.1.0", lifespan=lifespan)
instrument_app(app)


class OptimizeRequest(BaseModel):
    originHubId: str
    destinationHubId: str
    weightCo2: float = Field(0.5, ge=0, le=1)
    weightCost: float = Field(0.3, ge=0, le=1)
    weightTime: float = Field(0.2, ge=0, le=1)
    topK: int = Field(3, ge=1, le=10)
    # Phase 3: opt-in GNN-adjusted edge weights based on current conditions.
    # When true and a model is loaded, optimizer uses GNN multipliers; otherwise
    # silently falls back to baseline factors.
    useGnn: bool = False


class ParetoSolutionDTO(BaseModel):
    rank: int
    routeIds: list[str]
    totalCo2Kg: float
    totalCostUsd: float
    totalTimeHours: float
    explanation: str


class OptimizeResponse(BaseModel):
    runId: str
    solutions: list[ParetoSolutionDTO]


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "ml-optimize"}


@app.get("/metrics")
async def metrics() -> PlainTextResponse:
    return PlainTextResponse(generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.post("/optimize/route", response_model=OptimizeResponse)
async def optimize_route(req: OptimizeRequest) -> OptimizeResponse:
    start = time.perf_counter()
    try:
        for f in (req.originHubId, req.destinationHubId):
            try:
                uuid.UUID(f)
            except ValueError as e:
                raise HTTPException(status_code=400, detail="invalid hub id") from e

        pool: asyncpg.Pool = app.state.pool
        rows = await pool.fetch(
            """
            SELECT id, origin_hub_id, destination_hub_id, distance_km, transport_mode
            FROM routes WHERE active = TRUE
            """
        )
        if not rows:
            raise HTTPException(status_code=503, detail="no active routes")

        edge_multipliers: dict[str, float] | None = None
        gnn: GnnPredictor = app.state.gnn
        if req.useGnn and gnn.available:
            hub_rows = await pool.fetch(
                "SELECT id::text AS id, type::text AS type, lat, lng, country FROM hubs"
            )
            # Compute degree per hub for the node feature.
            degree: dict[str, int] = {}
            for r in rows:
                degree[str(r["origin_hub_id"])] = degree.get(str(r["origin_hub_id"]), 0) + 1
                degree[str(r["destination_hub_id"])] = degree.get(str(r["destination_hub_id"]), 0) + 1
            hubs_input = [
                (
                    h["id"],
                    HubFeatures(
                        type=h["type"],
                        lat=h["lat"],
                        lng=h["lng"],
                        degree=degree.get(h["id"], 0),
                        country_bucket=(hash(h["country"]) % 256) / 256.0,
                    ),
                )
                for h in hub_rows
            ]
            edges_input = [
                (
                    str(r["id"]),
                    str(r["origin_hub_id"]),
                    str(r["destination_hub_id"]),
                    EdgeContext(
                        transport_mode=r["transport_mode"],
                        distance_km=float(r["distance_km"]),
                    ),
                )
                for r in rows
            ]
            edge_multipliers = gnn.adjust_edges(hubs_input, edges_input)

        opt_input = OptimizerInput(
            origin_hub_id=req.originHubId,
            destination_hub_id=req.destinationHubId,
            weight_co2=req.weightCo2,
            weight_cost=req.weightCost,
            weight_time=req.weightTime,
            top_k=req.topK,
            edge_co2_multipliers=edge_multipliers,
        )
        solutions = optimize([dict(r) for r in rows], opt_input)
        if not solutions:
            REQ.labels("no_path").inc()
            raise HTTPException(status_code=404, detail="no path between hubs")

        run_id = str(uuid.uuid4())
        # Persist for observability + future feedback loop.
        await pool.execute(
            """
            INSERT INTO optimization_runs (id, goal, pareto_solutions)
            VALUES ($1::uuid, $2::jsonb, $3::jsonb)
            """,
            run_id,
            req.model_dump_json(),
            "[" + ",".join(
                ParetoSolutionDTO(
                    rank=s.rank,
                    routeIds=s.route_ids,
                    totalCo2Kg=s.total_co2_kg,
                    totalCostUsd=s.total_cost_usd,
                    totalTimeHours=s.total_time_hours,
                    explanation=s.explanation,
                ).model_dump_json()
                for s in solutions
            ) + "]",
        )

        REQ.labels("ok").inc()
        return OptimizeResponse(
            runId=run_id,
            solutions=[
                ParetoSolutionDTO(
                    rank=s.rank,
                    routeIds=s.route_ids,
                    totalCo2Kg=s.total_co2_kg,
                    totalCostUsd=s.total_cost_usd,
                    totalTimeHours=s.total_time_hours,
                    explanation=s.explanation,
                )
                for s in solutions
            ],
        )
    finally:
        LAT.observe(time.perf_counter() - start)
