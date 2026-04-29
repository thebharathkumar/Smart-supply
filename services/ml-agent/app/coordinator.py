"""
Hand-rolled state machine that drives the agent.

Why not LangGraph? See ADR-0005. Short version: the framework adds two
heavy dependency trees (langchain + langgraph) for ~150 lines of
coordination logic we can write directly. This implementation has the
same shape - typed state, async nodes, conditional edges - and is
trivial to test in isolation.

The coordinator is an async generator. Each yield emits a structured
event the FastAPI handler turns into an SSE frame, so clients see the
agent's reasoning live rather than waiting for the final plan.

Two modes:
  - LLM-backed: Claude selects the next tool. Requires ANTHROPIC_API_KEY.
  - Deterministic: a fixed forecast -> optimize -> synthesize sequence.
    Used for /agent/dry-run and as the fallback when no API key is set.
"""
from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timezone
from typing import Any, AsyncIterator

from opentelemetry import trace

from .agent_state import AgentState, NodeName, ToolCall
from .llm import LLMClient
from .tools import Tool


SYSTEM_PROMPT = """You are a supply-chain optimization assistant.

You help operators reduce carbon emissions across a supplier network without
breaking cost or transit-time constraints. You have tools that:
- forecast a supplier's emissions trajectory
- find Pareto-optimal routes between two hubs
- look up similar suppliers (semantic search)
- pull historical emissions data

Workflow:
1. Re-state the operator's goal and constraints in your own words.
2. Decide which tool to call next. Call ONE tool per turn.
3. After each tool result, decide if you have enough evidence to
   propose a plan, or if you need another tool call.
4. When ready, stop calling tools and produce a structured plan with:
   - A 2-sentence summary
   - A list of concrete actions
   - Expected impact (CO2, cost, time deltas) with confidence intervals
   - Risks and assumptions

Be honest about uncertainty. Cite the tool results that support each claim.
"""

tracer = trace.get_tracer("ml-agent.coordinator")


class AgentEvent(dict[str, Any]):
    """Plain dict shaped { type, ts, ...payload }. Yielded by run()."""

    def __init__(self, type: str, **payload: Any) -> None:
        super().__init__(
            type=type,
            ts=datetime.now(timezone.utc).isoformat(),
            **payload,
        )


class Coordinator:
    def __init__(
        self,
        tools: list[Tool],
        llm: LLMClient,
        on_persist=None,  # type: ignore[no-untyped-def]
    ) -> None:
        self.tools = tools
        self.tools_by_name = {t.name: t for t in tools}
        self.llm = llm
        self.on_persist = on_persist  # async fn(state) -> None

    async def run(self, state: AgentState) -> AsyncIterator[AgentEvent]:
        """Drive the state machine, yielding events as it advances."""
        with tracer.start_as_current_span("agent.run") as span:
            span.set_attribute("agent.session_id", state.session_id)
            span.set_attribute("agent.mode", "llm" if self.llm.available else "deterministic")

            yield AgentEvent("started", sessionId=state.session_id, mode=("llm" if self.llm.available else "deterministic"))

            try:
                if self.llm.available:
                    async for ev in self._run_llm(state):
                        yield ev
                else:
                    async for ev in self._run_deterministic(state):
                        yield ev
            except Exception as exc:  # noqa: BLE001
                state.error = str(exc)
                state.finished = True
                span.record_exception(exc)
                yield AgentEvent("error", message=str(exc))

            if self.on_persist is not None:
                try:
                    await self.on_persist(state)
                except Exception as exc:  # noqa: BLE001
                    yield AgentEvent("warn", message=f"persist failed: {exc}")

            yield AgentEvent("done", plan=state.plan, steps=state.step_count)

    # ------------------------------------------------------------------
    # LLM-backed loop
    # ------------------------------------------------------------------
    async def _run_llm(self, state: AgentState) -> AsyncIterator[AgentEvent]:
        """ReAct-style loop: Claude decides the next tool until ready to plan."""
        # Seed conversation with the goal.
        state.append_message("user", state.goal)

        while not state.finished and state.step_count < state.max_steps:
            state.step_count += 1
            yield AgentEvent("step", n=state.step_count, node="analyze_goal")

            # Build Anthropic-formatted messages.
            api_messages = self._to_api_messages(state)
            with tracer.start_as_current_span("agent.llm.chat") as s:
                s.set_attribute("agent.step", state.step_count)
                result = await self.llm.chat(
                    messages=api_messages,
                    tools=self.tools,
                    system=SYSTEM_PROMPT,
                )
                s.set_attribute("llm.usage.input_tokens", result.usage_input_tokens)
                s.set_attribute("llm.usage.output_tokens", result.usage_output_tokens)
                s.set_attribute("llm.stop_reason", result.stop_reason)

            yield AgentEvent(
                "thought",
                text=result.text,
                inputTokens=result.usage_input_tokens,
                outputTokens=result.usage_output_tokens,
            )

            # If Claude didn't ask for a tool, treat its text as the plan.
            if not result.tool_uses:
                plan = self._parse_plan(result.text)
                state.plan = plan
                state.append_message("assistant", result.text)
                state.finished = True
                yield AgentEvent("plan", plan=plan)
                break

            # Record assistant turn (with tool_use blocks) into history.
            assistant_blocks: list[dict[str, Any]] = []
            if result.text:
                assistant_blocks.append({"type": "text", "text": result.text})
            for tu in result.tool_uses:
                assistant_blocks.append(
                    {"type": "tool_use", "id": tu["id"], "name": tu["name"], "input": tu["input"]}
                )
            state.append_message("assistant", assistant_blocks)

            # Execute tools sequentially (Claude returns at most a few).
            tool_results: list[dict[str, Any]] = []
            for tu in result.tool_uses:
                call = ToolCall(id=tu["id"], name=tu["name"], input=tu["input"])
                state.append_tool_call(call)
                yield AgentEvent("tool_call", id=tu["id"], name=tu["name"], input=tu["input"])

                with tracer.start_as_current_span(f"agent.tool.{tu['name']}") as ts:
                    ts.set_attribute("agent.tool.name", tu["name"])
                    handler = self.tools_by_name.get(tu["name"])
                    if handler is None:
                        call.error = f"unknown tool: {tu['name']}"
                    else:
                        try:
                            call.result = await handler.handler(tu["input"])
                        except Exception as exc:  # noqa: BLE001
                            call.error = str(exc)
                            ts.record_exception(exc)
                    call.finished_at = datetime.now(timezone.utc).isoformat()

                yield AgentEvent(
                    "tool_result",
                    id=tu["id"],
                    name=tu["name"],
                    error=call.error,
                    result=_summarize_result(call.result),
                )

                tool_results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": tu["id"],
                        "content": json.dumps(call.error or call.result or {})[:8000],
                        "is_error": call.error is not None,
                    }
                )

            # Append tool results as a single user turn.
            state.append_message("user", tool_results)

        # Step budget exhausted without a plan: synthesize from collected tools.
        if not state.finished:
            yield AgentEvent("step", n=state.step_count + 1, node="synthesize_plan")
            state.plan = self._synthesize_from_tools(state)
            state.finished = True
            yield AgentEvent("plan", plan=state.plan)

    @staticmethod
    def _to_api_messages(state: AgentState) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for m in state.messages:
            out.append({"role": m.role, "content": m.content})
        return out

    @staticmethod
    def _parse_plan(text: str) -> dict[str, Any]:
        """Extract a structured plan from Claude's free-form text."""
        # Best-effort: look for fenced JSON. Otherwise wrap the text as summary.
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end > start:
            try:
                return json.loads(text[start : end + 1])
            except json.JSONDecodeError:
                pass
        return {"summary": text.strip()[:1000], "actions": [], "structured": False}

    @staticmethod
    def _synthesize_from_tools(state: AgentState) -> dict[str, Any]:
        """Last-ditch plan when step budget is exhausted: list tool findings."""
        return {
            "summary": "Step budget exhausted. Findings collected from tool calls below.",
            "actions": [
                {"type": tc.name, "input": tc.input, "ok": tc.error is None}
                for tc in state.tool_calls
            ],
            "structured": False,
        }

    # ------------------------------------------------------------------
    # Deterministic loop (used when no API key is configured)
    # ------------------------------------------------------------------
    async def _run_deterministic(self, state: AgentState) -> AsyncIterator[AgentEvent]:
        """Pre-scripted: forecast a sample supplier, then optimize a sample route."""
        goal_summary = f"Goal received ({len(state.goal)} chars). Running deterministic toolchain."
        yield AgentEvent("thought", text=goal_summary)

        # Step 1: pick a default supplier and hubs from constraints if provided.
        supplier_id = state.constraints.get("supplier_id")
        origin = state.constraints.get("origin_hub_id")
        destination = state.constraints.get("destination_hub_id")

        if supplier_id:
            yield AgentEvent(
                "tool_call", id="t1", name="forecast_supplier", input={"supplier_id": supplier_id, "horizon_days": 14}
            )
            tool = self.tools_by_name["forecast_supplier"]
            try:
                fc = await tool.handler({"supplier_id": supplier_id, "horizon_days": 14})
                state.append_tool_call(ToolCall(id="t1", name="forecast_supplier", input={"supplier_id": supplier_id}, result=fc))
                yield AgentEvent("tool_result", id="t1", name="forecast_supplier", result=_summarize_result(fc))
            except Exception as exc:  # noqa: BLE001
                yield AgentEvent("tool_result", id="t1", name="forecast_supplier", error=str(exc))

        if origin and destination:
            yield AgentEvent(
                "tool_call",
                id="t2",
                name="optimize_route",
                input={"originHubId": origin, "destinationHubId": destination, "topK": 3},
            )
            tool = self.tools_by_name["optimize_route"]
            try:
                opt = await tool.handler(
                    {"originHubId": origin, "destinationHubId": destination, "topK": 3}
                )
                state.append_tool_call(
                    ToolCall(id="t2", name="optimize_route", input={"originHubId": origin}, result=opt)
                )
                yield AgentEvent("tool_result", id="t2", name="optimize_route", result=_summarize_result(opt))
            except Exception as exc:  # noqa: BLE001
                yield AgentEvent("tool_result", id="t2", name="optimize_route", error=str(exc))

        state.plan = {
            "summary": "Deterministic mode plan: review forecast and consider Pareto-optimal alternatives.",
            "actions": [
                {"type": tc.name, "ok": tc.error is None}
                for tc in state.tool_calls
            ],
            "structured": True,
            "mode": "deterministic",
        }
        state.finished = True
        yield AgentEvent("plan", plan=state.plan)


def _summarize_result(result: dict[str, Any] | None) -> dict[str, Any]:
    """Trim heavy result payloads for SSE event size."""
    if result is None:
        return {}
    out: dict[str, Any] = {}
    for k, v in result.items():
        if isinstance(v, list):
            out[k] = {"_list_count": len(v)}
        elif isinstance(v, dict):
            out[k] = {"_keys": list(v.keys())[:10]}
        else:
            out[k] = v
    return out


def new_session(goal: str, constraints: dict[str, Any] | None = None, max_steps: int = 12) -> AgentState:
    return AgentState(
        session_id=str(uuid.uuid4()),
        goal=goal,
        constraints=constraints or {},
        max_steps=max_steps,
    )


# Re-exposed for tests
__all__ = ["Coordinator", "AgentEvent", "new_session", "SYSTEM_PROMPT"]


# Silence an unused-import warning when asyncio isn't directly used here.
_ = asyncio
