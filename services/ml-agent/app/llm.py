"""
Thin wrapper around the Anthropic SDK.

Encapsulates:
  - lazy client construction (no network at import time)
  - mapping our internal Tool objects to the Anthropic tool-use schema
  - turning a chat turn into either (text response, tool_uses, stop_reason)

Never reads the API key from disk. ANTHROPIC_API_KEY env is the only source.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

from .tools import Tool


@dataclass(slots=True)
class LLMResult:
    text: str
    tool_uses: list[dict[str, Any]]
    stop_reason: str
    usage_input_tokens: int = 0
    usage_output_tokens: int = 0


class LLMClient:
    """Lazily instantiates the Anthropic client. No-op if key is absent."""

    def __init__(self, model: str = "claude-sonnet-4-6") -> None:
        self.model = model
        self._client: Any = None

    @property
    def available(self) -> bool:
        return bool(os.environ.get("ANTHROPIC_API_KEY"))

    def _ensure(self) -> Any:
        if self._client is not None:
            return self._client
        try:
            from anthropic import AsyncAnthropic
        except ImportError as e:  # pragma: no cover
            raise RuntimeError("anthropic SDK not installed") from e
        # The SDK reads ANTHROPIC_API_KEY from env automatically.
        self._client = AsyncAnthropic()
        return self._client

    @staticmethod
    def render_tools(tools: list[Tool]) -> list[dict[str, Any]]:
        return [
            {
                "name": t.name,
                "description": t.description,
                "input_schema": t.input_schema,
            }
            for t in tools
        ]

    async def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[Tool],
        system: str,
        max_tokens: int = 1024,
    ) -> LLMResult:
        client = self._ensure()
        resp = await client.messages.create(
            model=self.model,
            max_tokens=max_tokens,
            system=system,
            tools=self.render_tools(tools),
            messages=messages,
        )

        text_parts: list[str] = []
        tool_uses: list[dict[str, Any]] = []
        for block in resp.content:
            btype = getattr(block, "type", None)
            if btype == "text":
                text_parts.append(block.text)
            elif btype == "tool_use":
                tool_uses.append(
                    {
                        "id": block.id,
                        "name": block.name,
                        "input": block.input,
                    }
                )

        usage = getattr(resp, "usage", None)
        return LLMResult(
            text="\n".join(text_parts),
            tool_uses=tool_uses,
            stop_reason=getattr(resp, "stop_reason", "end_turn"),
            usage_input_tokens=getattr(usage, "input_tokens", 0) if usage else 0,
            usage_output_tokens=getattr(usage, "output_tokens", 0) if usage else 0,
        )
