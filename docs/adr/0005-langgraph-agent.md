# ADR 0005: LangGraph for the agentic reasoning layer (Phase 2)

**Status:** Proposed (Phase 2)
**Date:** 2026-04-29

## Context

The agent in `ml-agent` orchestrates multiple tools — forecast, optimize, similarity search, history queries, simulation — driven by a natural-language goal. State must persist across tool calls (intermediate findings, candidate plans), and intermediate reasoning needs to stream to the user.

A naive `while True: claude.messages.create(tool_use=…)` loop works but loses observability and makes branching plans (e.g. "run forecast in parallel for these 3 suppliers") awkward.

## Decision

Use **LangGraph** to model the agent as a state machine:

- Nodes represent distinct reasoning steps (analyze goal, run forecast, evaluate alternatives, propose plan).
- Edges encode allowable transitions and conditional branching.
- A **typed state** (Pydantic `AgentState`) persists across nodes — every step reads/writes a known shape, so observability and replay work.
- Each node emits an SSE event before yielding control, giving the frontend live feedback.

Claude is invoked via the Anthropic SDK with the tool registry from `app/tools.py`. Tool results feed back into the graph state; the graph terminates when a goal-satisfaction node is reached or step budget exhausted.

## Consequences

**Pros:**
- Deterministic structure around stochastic LLM behavior.
- Easy to add new tools (one new node + one edge).
- The graph is testable independently of the LLM by mocking node implementations.

**Cons:**
- Adds a dependency. Mitigated by the fact that LangGraph is just structure; we can swap it for our own coordinator if it gets in the way.
- Streaming SSE through FastAPI requires care around backpressure — handled by bounded buffers in the SSE generator.

## Alternatives considered

- **Bare Anthropic tool-use loop** — fine for a single-turn workflow; loses out on branching and observability.
- **LangChain agents** — heavier abstraction surface, less explicit control flow.
- **Build our own state machine** — viable, but LangGraph already solved the typed-state-transition problem well.
