"""
ml-agent: agentic reasoning service.

POST /agent/run streams the agent's reasoning over Server-Sent Events.
Uses the Anthropic SDK when ANTHROPIC_API_KEY is set; otherwise runs a
deterministic forecast -> optimize toolchain so the integration is
exercisable without an API key.
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
from fastapi import FastAPI
from fastapi.responses import PlainTextResponse, StreamingResponse
from prometheus_client import Counter, Histogram, generate_latest, CONTENT_TYPE_LATEST
from pydantic import BaseModel, Field

from .coordinator import Coordinator, new_session
from .llm import LLMClient
from .telemetry import init_telemetry, instrument_app
from .tools import build_tools

init_telemetry("ml-agent")

structlog.configure(processors=[structlog.processors.JSONRenderer()])
log = structlog.get_logger("ml-agent")

REQ = Counter("agent_requests_total", "Agent requests", ["endpoint", "status"])
LAT = Histogram(
    "agent_request_seconds",
    "Agent latency",
    buckets=[0.5, 1, 2, 5, 10, 20, 60],
)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    forecast_url = os.environ.get("ML_FORECAST_URL", "http://ml-forecast:8001")
    optimize_url = os.environ.get("ML_OPTIMIZE_URL", "http://ml-optimize:8002")
    db_url = os.environ.get("DATABASE_URL")

    http = httpx.AsyncClient(timeout=30.0)
    pool = await asyncpg.create_pool(db_url, min_size=1, max_size=4) if db_url else None
    tools = build_tools(forecast_url, optimize_url, http)
    llm = LLMClient(model=os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6"))

    async def persist(state) -> None:  # type: ignore[no-untyped-def]
        if pool is None:
            return
        await pool.execute(
            """
            INSERT INTO agent_sessions (id, user_goal, messages, final_plan, status)
            VALUES ($1::uuid, $2, $3::jsonb, $4::jsonb, $5)
            ON CONFLICT (id) DO UPDATE
              SET messages = EXCLUDED.messages,
                  final_plan = EXCLUDED.final_plan,
                  status = EXCLUDED.status
            """,
            state.session_id,
            state.goal,
            json.dumps([m.model_dump() for m in state.messages], default=str),
            json.dumps(state.plan) if state.plan else None,
            "completed" if state.finished and not state.error else ("error" if state.error else "running"),
        )

    coordinator = Coordinator(tools=tools, llm=llm, on_persist=persist)

    app.state.http = http
    app.state.pool = pool
    app.state.tools = tools
    app.state.tools_by_name = {t.name: t for t in tools}
    app.state.coordinator = coordinator
    app.state.llm = llm
    app.state.anthropic_key_present = llm.available

    log.info(
        "ml-agent started",
        forecast_url=forecast_url,
        optimize_url=optimize_url,
        anthropic_key_present=llm.available,
    )
    try:
        yield
    finally:
        await http.aclose()
        if pool is not None:
            await pool.close()


app = FastAPI(title="ml-agent", version="0.1.0", lifespan=lifespan)
instrument_app(app)


class AgentRunRequest(BaseModel):
    goal: str = Field(..., min_length=10, max_length=2000)
    constraints: dict | None = None
    max_steps: int = Field(default=12, ge=1, le=30)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "ml-agent"}


@app.get("/metrics")
async def metrics() -> PlainTextResponse:
    return PlainTextResponse(generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.get("/tools")
async def list_tools() -> dict:
    return {
        "anthropicKeyPresent": app.state.anthropic_key_present,
        "model": app.state.llm.model,
        "tools": [
            {"name": t.name, "description": t.description, "input_schema": t.input_schema}
            for t in app.state.tools
        ],
    }


@app.post("/agent/dry-run")
async def dry_run(req: AgentRunRequest) -> dict:
    """
    Synchronous deterministic run that returns the full event log.
    Useful for tests and curl-based exploration.
    """
    start = time.perf_counter()
    try:
        state = new_session(req.goal, req.constraints, max_steps=req.max_steps)
        # Force deterministic by temporarily marking llm unavailable.
        events: list[dict] = []
        # Build a coordinator with a no-LLM client so we always run the deterministic branch.
        from .llm import LLMClient as _LLM

        class _NoKeyLLM(_LLM):
            @property
            def available(self) -> bool:
                return False

        coord = Coordinator(
            tools=app.state.tools,
            llm=_NoKeyLLM(),
            on_persist=app.state.coordinator.on_persist,
        )
        async for ev in coord.run(state):
            events.append(dict(ev))
        REQ.labels("dry_run", "ok").inc()
        return {"sessionId": state.session_id, "events": events, "plan": state.plan}
    finally:
        LAT.observe(time.perf_counter() - start)


@app.post("/agent/run")
async def run_agent(req: AgentRunRequest) -> StreamingResponse:
    """
    Streams agent reasoning as Server-Sent Events.
    Frame format: `event: <type>\\ndata: <json>\\n\\n`.
    """
    state = new_session(req.goal, req.constraints, max_steps=req.max_steps)
    coord: Coordinator = app.state.coordinator

    async def gen() -> AsyncIterator[bytes]:
        start = time.perf_counter()
        try:
            async for ev in coord.run(state):
                etype = ev.get("type", "message")
                payload = json.dumps(dict(ev), default=str)
                yield f"event: {etype}\ndata: {payload}\n\n".encode("utf-8")
            REQ.labels("run", "ok").inc()
        except Exception as exc:  # noqa: BLE001
            REQ.labels("run", "error").inc()
            err = json.dumps({"type": "error", "message": str(exc)})
            yield f"event: error\ndata: {err}\n\n".encode("utf-8")
        finally:
            LAT.observe(time.perf_counter() - start)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # disable nginx buffering
        },
    )


# Public exports for tests.
__all__ = ["app"]


# Avoid unused-import warning when uuid is only used inside lifespan
_ = uuid
