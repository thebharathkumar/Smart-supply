"""
ml-agent: agentic reasoning service.

Phase 1 status: scaffold complete. Service runs, tools register, the
non-LLM `/agent/dry-run` endpoint executes a deterministic plan that
calls forecast + optimize tools in sequence so the integration is
exercisable without an Anthropic API key.

Phase 2 will replace the dry-run with a LangGraph state machine where
Claude selects tools, and intermediate reasoning streams to the client
over Server-Sent Events.
"""
from __future__ import annotations

import json
import os
import time
import uuid
from contextlib import asynccontextmanager
from typing import AsyncIterator

import asyncpg
import httpx
import structlog
from fastapi import FastAPI, HTTPException
from fastapi.responses import PlainTextResponse, StreamingResponse
from prometheus_client import Counter, Histogram, generate_latest, CONTENT_TYPE_LATEST
from pydantic import BaseModel, Field

from .tools import build_tools


structlog.configure(processors=[structlog.processors.JSONRenderer()])
log = structlog.get_logger("ml-agent")

REQ = Counter("agent_requests_total", "Agent requests", ["endpoint", "status"])
LAT = Histogram("agent_request_seconds", "Agent latency", buckets=[0.5, 1, 2, 5, 10, 20, 60])


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    forecast_url = os.environ.get("ML_FORECAST_URL", "http://ml-forecast:8001")
    optimize_url = os.environ.get("ML_OPTIMIZE_URL", "http://ml-optimize:8002")
    db_url = os.environ.get("DATABASE_URL")

    http = httpx.AsyncClient(timeout=30.0)
    pool = await asyncpg.create_pool(db_url, min_size=1, max_size=4) if db_url else None
    tools = build_tools(forecast_url, optimize_url, http)

    app.state.http = http
    app.state.pool = pool
    app.state.tools = tools
    app.state.tools_by_name = {t.name: t for t in tools}
    app.state.anthropic_key_present = bool(os.environ.get("ANTHROPIC_API_KEY"))
    app.state.anthropic_model = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6")
    log.info(
        "ml-agent started",
        forecast_url=forecast_url,
        optimize_url=optimize_url,
        anthropic_key_present=app.state.anthropic_key_present,
    )
    try:
        yield
    finally:
        await http.aclose()
        if pool is not None:
            await pool.close()


app = FastAPI(title="ml-agent", version="0.1.0", lifespan=lifespan)


class AgentRunRequest(BaseModel):
    goal: str = Field(..., min_length=10, max_length=2000)
    constraints: dict[str, float] | None = None


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "ml-agent"}


@app.get("/metrics")
async def metrics() -> PlainTextResponse:
    return PlainTextResponse(generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.get("/tools")
async def list_tools() -> dict:
    """Surface the tool schemas, useful for clients and for the agent prompt."""
    tools = app.state.tools
    return {
        "anthropicKeyPresent": app.state.anthropic_key_present,
        "model": app.state.anthropic_model,
        "tools": [
            {
                "name": t.name,
                "description": t.description,
                "input_schema": t.input_schema,
            }
            for t in tools
        ],
    }


@app.post("/agent/dry-run")
async def dry_run(req: AgentRunRequest) -> dict:
    """
    Deterministic, no-LLM trace that calls forecast + optimize tools.
    Useful for exercising the integration end-to-end without an API key.
    """
    start = time.perf_counter()
    session_id = str(uuid.uuid4())
    pool: asyncpg.Pool | None = app.state.pool
    try:
        steps: list[dict] = [{"step": "received", "goal": req.goal}]
        if pool is None:
            steps.append({"step": "skip_persist", "reason": "no DATABASE_URL"})
            return {"sessionId": session_id, "steps": steps, "plan": None}

        # Pick a sample supplier + hub pair for demonstration.
        supplier_row = await pool.fetchrow(
            "SELECT id FROM suppliers WHERE active = TRUE ORDER BY name LIMIT 1"
        )
        hubs = await pool.fetch("SELECT id FROM hubs LIMIT 2")
        if not supplier_row or len(hubs) < 2:
            raise HTTPException(status_code=503, detail="db not seeded")

        tools_by_name = app.state.tools_by_name

        steps.append({"step": "tool_call", "tool": "forecast_supplier"})
        forecast = await tools_by_name["forecast_supplier"].handler(
            {"supplier_id": str(supplier_row["id"]), "horizon_days": 14}
        )
        steps.append({"step": "tool_result", "tool": "forecast_supplier", "summary": {
            "model": forecast.get("model"),
            "points": len(forecast.get("points", [])),
        }})

        steps.append({"step": "tool_call", "tool": "optimize_route"})
        opt = await tools_by_name["optimize_route"].handler(
            {
                "originHubId": str(hubs[0]["id"]),
                "destinationHubId": str(hubs[1]["id"]),
                "weightCo2": 0.6,
                "weightCost": 0.2,
                "weightTime": 0.2,
                "topK": 3,
            }
        )
        steps.append({"step": "tool_result", "tool": "optimize_route", "summary": {
            "solutions": len(opt.get("solutions", [])),
            "runId": opt.get("runId"),
        }})

        plan = {
            "summary": "Dry-run plan: investigate supplier forecast then propose route changes.",
            "actions": [
                {"type": "review_forecast", "supplierId": str(supplier_row["id"])},
                {"type": "consider_route", "runId": opt.get("runId")},
            ],
        }

        # Persist agent session for audit.
        await pool.execute(
            """
            INSERT INTO agent_sessions (id, user_goal, messages, final_plan, status)
            VALUES ($1::uuid, $2, $3::jsonb, $4::jsonb, 'completed')
            """,
            session_id,
            req.goal,
            json.dumps(steps),
            json.dumps(plan),
        )

        REQ.labels("dry_run", "ok").inc()
        return {"sessionId": session_id, "steps": steps, "plan": plan}
    finally:
        LAT.observe(time.perf_counter() - start)


@app.post("/agent/run")
async def run_agent(req: AgentRunRequest) -> StreamingResponse:
    """
    Phase 2 endpoint. Returns SSE stream of agent reasoning.
    For now: returns 501 if no Anthropic key, else returns a single
    informational SSE event acknowledging Phase 2 status.
    """
    if not app.state.anthropic_key_present:
        raise HTTPException(
            status_code=501,
            detail="LLM agent requires ANTHROPIC_API_KEY (Phase 2 feature)",
        )

    async def gen() -> AsyncIterator[bytes]:
        yield b"event: status\ndata: " + json.dumps({"phase": "2-pending"}).encode() + b"\n\n"
        yield b"event: end\ndata: {}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")
