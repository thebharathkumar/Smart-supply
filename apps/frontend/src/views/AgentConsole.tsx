/**
 * Agent Console - Phase 1 stub.
 *
 * Backed by the ml-agent service. Server-Sent Events streaming is wired
 * but the agent itself is a Phase 2 deliverable. This view shows the UI
 * shape so the architecture is visible end-to-end.
 */
export function AgentConsole() {
  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="panel">
        <div className="stat-label mb-2">agent console (phase 2)</div>
        <p className="text-sm text-ink-100/70 leading-relaxed">
          The agentic reasoning layer streams tool calls and intermediate findings as it
          works toward the goal you provide. Goals are natural-language statements like:
        </p>
        <pre className="mt-3 bg-ink-950 border border-ink-800 rounded-md p-3 text-xs font-mono text-ink-100/80 overflow-x-auto">
{`Reduce total network emissions by 25% next quarter
without increasing transit time by more than 10%.`}
        </pre>
        <p className="text-sm text-ink-100/70 mt-4 leading-relaxed">
          The agent calls forecast / optimize / similarity tools, returns a structured
          plan, and shows the diff vs. current state. Phase 2 implements LangGraph
          orchestration + Claude tool-use + SSE streaming. The interface contract is
          defined in <code className="font-mono text-accent-400">services/ml-agent</code>.
        </p>
      </div>
    </div>
  );
}
