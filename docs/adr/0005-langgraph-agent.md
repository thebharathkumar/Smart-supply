# ADR 0005: Hand-rolled state-machine coordinator over LangGraph

**Status:** Accepted (revised from Phase 1 proposal)
**Date:** 2026-04-29

## Context

The agent in `ml-agent` orchestrates multiple tools — forecast, optimize, similarity search, history queries, simulation — driven by a natural-language goal. State must persist across tool calls, and intermediate reasoning needs to stream to the user over SSE.

The original Phase 1 ADR proposed LangGraph for this. While building Phase 2, the reality became clear: LangGraph plus its langchain dependency would be ~150 MB of transitive deps to coordinate ~150 lines of state-machine logic. The framework's value lies in its broader ecosystem (e.g. checkpointing, multi-agent orchestration), none of which we use.

## Decision

Build the coordinator directly:

- **Typed state** in `agent_state.py`: a Pydantic `AgentState` carries the goal, conversation messages, tool-call log, plan, and control fields (`step_count`, `max_steps`, `finished`).
- **Coordinator** in `coordinator.py` is an async generator. Each iteration corresponds to a node in a notional graph (`analyze_goal` → `call_tool` → ... → `synthesize_plan`).
- **Two execution modes**:
  - **LLM-backed**: ReAct loop where Claude (via the Anthropic SDK) chooses the next tool until it produces a plan or hits `max_steps`.
  - **Deterministic**: pre-scripted forecast → optimize → synthesize. Used when `ANTHROPIC_API_KEY` is absent and for `/agent/dry-run`.
- **Streaming**: the coordinator yields `AgentEvent` dicts (`started`, `step`, `thought`, `tool_call`, `tool_result`, `plan`, `done`, `error`). FastAPI turns each yield into one SSE frame so clients see reasoning live.
- **Observability**: every node and tool call opens an OpenTelemetry span, with token usage attached as attributes.

## Consequences

**Pros:**
- Zero framework dependency. Image is smaller, cold start is faster.
- The coordinator is a single ~250-line file a reviewer can read top to bottom.
- Mocking is trivial — pass a fake `LLMClient` and run the generator.
- The deterministic-fallback mode means the service runs end-to-end without an Anthropic key, which is critical for CI and local dev.

**Cons:**
- We don't get LangGraph's checkpointing, branching, or multi-agent primitives. None are needed today; the coordinator interface (`async for ev in coord.run(state)`) is small enough to swap if that changes.
- Token-usage tracking is something we built ourselves rather than inheriting. Acceptable.

## Alternatives considered

- **LangGraph + LangChain** — original plan. Vetoed on dependency weight vs. value delivered.
- **Bare Anthropic tool-use loop** — what we essentially do, with explicit state and edges added.
- **Building atop `anyio` / `Trio`** task supervision — overkill for sequential tool calls.
