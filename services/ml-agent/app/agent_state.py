"""
Typed state container for the agent state machine.

Every node reads from + writes to this state. Pydantic enforces shape so
adding a node never silently breaks downstream consumers.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, Field


NodeName = Literal[
    "analyze_goal",
    "call_tool",
    "synthesize_plan",
    "done",
]


class ToolCall(BaseModel):
    id: str
    name: str
    input: dict[str, Any]
    result: dict[str, Any] | None = None
    error: str | None = None
    started_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    finished_at: str | None = None


class AgentMessage(BaseModel):
    role: Literal["system", "user", "assistant", "tool"]
    content: str | list[dict[str, Any]]


class AgentState(BaseModel):
    session_id: str
    goal: str
    constraints: dict[str, Any] = Field(default_factory=dict)

    # Conversation memory.
    messages: list[AgentMessage] = Field(default_factory=list)

    # Tool execution log.
    tool_calls: list[ToolCall] = Field(default_factory=list)

    # Final synthesized plan (set by synthesize_plan node).
    plan: dict[str, Any] | None = None

    # Control state.
    next_node: NodeName = "analyze_goal"
    step_count: int = 0
    max_steps: int = 12
    finished: bool = False
    error: str | None = None

    def append_message(self, role: str, content: Any) -> None:
        self.messages.append(AgentMessage(role=role, content=content))  # type: ignore[arg-type]

    def append_tool_call(self, call: ToolCall) -> None:
        self.tool_calls.append(call)
