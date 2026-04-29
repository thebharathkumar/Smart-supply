"""Coordinator tests using fake tools - no DB, no LLM, no network."""
from __future__ import annotations

import asyncio
import pytest

from app.coordinator import Coordinator, new_session
from app.llm import LLMClient
from app.tools import Tool


class _NoKeyLLM(LLMClient):
    @property
    def available(self) -> bool:
        return False


def _fake_tools() -> list[Tool]:
    async def fake_forecast(args):
        return {"model": "fake", "points": [{"date": "2026-05-01", "predicted": 60}]}

    async def fake_optimize(args):
        return {"runId": "fake-run", "solutions": [{"rank": 1, "routeIds": ["r1"]}]}

    return [
        Tool(
            name="forecast_supplier",
            description="fake",
            input_schema={"type": "object"},
            handler=fake_forecast,
        ),
        Tool(
            name="optimize_route",
            description="fake",
            input_schema={"type": "object"},
            handler=fake_optimize,
        ),
    ]


@pytest.mark.asyncio
async def test_deterministic_with_constraints_runs_both_tools():
    coord = Coordinator(tools=_fake_tools(), llm=_NoKeyLLM())
    state = new_session(
        "Reduce emissions",
        constraints={
            "supplier_id": "00000000-0000-0000-0000-000000000001",
            "origin_hub_id": "00000000-0000-0000-0000-000000000002",
            "destination_hub_id": "00000000-0000-0000-0000-000000000003",
        },
    )
    events = [ev async for ev in coord.run(state)]
    types = [e["type"] for e in events]
    assert "started" in types
    assert "tool_call" in types
    assert "tool_result" in types
    assert "plan" in types
    assert "done" in types
    assert state.plan is not None
    assert state.plan["mode"] == "deterministic"
    # Both tools called.
    names = [tc.name for tc in state.tool_calls]
    assert "forecast_supplier" in names
    assert "optimize_route" in names


@pytest.mark.asyncio
async def test_deterministic_without_constraints_still_emits_plan():
    coord = Coordinator(tools=_fake_tools(), llm=_NoKeyLLM())
    state = new_session("Reduce emissions in some way", constraints={})
    events = [ev async for ev in coord.run(state)]
    assert any(e["type"] == "plan" for e in events)
    assert state.finished is True
    assert state.plan is not None


@pytest.mark.asyncio
async def test_persist_callback_is_invoked():
    persisted: list = []

    async def persist(s):
        persisted.append(s.session_id)

    coord = Coordinator(tools=_fake_tools(), llm=_NoKeyLLM(), on_persist=persist)
    state = new_session("Reduce emissions test")
    [_ async for _ in coord.run(state)]
    assert persisted == [state.session_id]


@pytest.mark.asyncio
async def test_tool_error_propagates_into_event_log():
    async def boom(_args):
        raise RuntimeError("planned failure")

    tools = [
        Tool(
            name="forecast_supplier",
            description="boom",
            input_schema={"type": "object"},
            handler=boom,
        ),
        Tool(
            name="optimize_route",
            description="ok",
            input_schema={"type": "object"},
            handler=lambda _: asyncio.sleep(0, result={}),
        ),
    ]
    coord = Coordinator(tools=tools, llm=_NoKeyLLM())
    state = new_session(
        "force failure path",
        constraints={"supplier_id": "00000000-0000-0000-0000-000000000001"},
    )
    events = [ev async for ev in coord.run(state)]
    error_events = [e for e in events if e["type"] == "tool_result" and e.get("error")]
    assert len(error_events) >= 1
    assert "planned failure" in error_events[0]["error"]
