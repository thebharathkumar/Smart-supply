/**
 * Agent Console - live SSE consumer for ml-agent.
 *
 * User states a goal; events stream in real time:
 *   started -> step -> thought -> tool_call -> tool_result -> ... -> plan -> done
 *
 * The deterministic mode runs without an Anthropic API key. With a key set
 * server-side, Claude drives the loop and we see token usage per step.
 */
import { useCallback, useRef, useState } from 'react';
import { sseStream } from '../lib/sse';
import { env } from '../lib/env';

interface AgentEvent {
  type: string;
  ts: string;
  [k: string]: unknown;
}

const SAMPLE_GOAL =
  'Reduce supplier emissions by 25% next quarter without increasing total transit time more than 10%.';

export function AgentConsole() {
  const [goal, setGoal] = useState(SAMPLE_GOAL);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'llm' | 'deterministic' | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const onRun = useCallback(async () => {
    setEvents([]);
    setError(null);
    setRunning(true);
    setMode(null);
    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const stream = sseStream(
        `${env.apiUrl}/api/agent/run`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ goal, maxSteps: 12 }),
        },
        ac.signal,
      );
      for await (const frame of stream) {
        if (!frame.data) continue;
        try {
          const ev = JSON.parse(frame.data) as AgentEvent;
          if (ev.type === 'started' && typeof ev.mode === 'string') {
            setMode(ev.mode as 'llm' | 'deterministic');
          }
          setEvents((prev) => [...prev, ev]);
          if (ev.type === 'done' || ev.type === 'error') break;
        } catch {
          // ignore malformed frames
        }
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setError((e as Error).message);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [goal]);

  const onStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return (
    <div className="p-6 max-w-5xl mx-auto h-full overflow-y-auto">
      <header className="mb-4 flex items-baseline justify-between">
        <div>
          <div className="stat-label">agent console</div>
          <h2 className="font-mono text-2xl text-accent-400">supply.optimize()</h2>
        </div>
        {mode && (
          <span className="text-xs font-mono text-ink-100/60 px-2 py-1 border border-ink-800 rounded-md">
            mode · {mode}
          </span>
        )}
      </header>

      <div className="panel mb-4">
        <label className="stat-label block mb-2">goal</label>
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={3}
          disabled={running}
          className="w-full bg-ink-950 border border-ink-800 rounded-md px-3 py-2 text-sm font-mono"
        />
        <div className="flex gap-2 mt-3">
          <button onClick={onRun} disabled={running || goal.length < 10} className="btn disabled:opacity-50">
            {running ? 'running…' : 'run agent'}
          </button>
          {running && (
            <button onClick={onStop} className="btn-ghost">
              stop
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="panel border-red-900 text-red-400 text-sm font-mono mb-4">{error}</div>
      )}

      <EventLog events={events} />
      <PlanCard events={events} />
    </div>
  );
}

function EventLog({ events }: { events: AgentEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="panel text-sm text-ink-100/40 text-center py-12">
        Run the agent to see streamed reasoning.
      </div>
    );
  }
  return (
    <div className="space-y-1.5 mb-4">
      {events.map((ev, i) => (
        <EventRow key={i} ev={ev} />
      ))}
    </div>
  );
}

function EventRow({ ev }: { ev: AgentEvent }) {
  const t = ev.type;
  const time = new Date(ev.ts).toLocaleTimeString();
  if (t === 'started') {
    return <Row time={time} icon="●" tone="accent" label="session started" detail={String(ev.sessionId ?? '')} />;
  }
  if (t === 'step') {
    return <Row time={time} icon="→" tone="muted" label={`step ${String(ev.n)}`} detail={String(ev.node)} />;
  }
  if (t === 'thought') {
    return (
      <Row
        time={time}
        icon="✻"
        tone="accent"
        label="thought"
        detail={String(ev.text || '').slice(0, 240)}
        sub={
          ev.inputTokens !== undefined
            ? `${String(ev.inputTokens)} in / ${String(ev.outputTokens)} out tokens`
            : undefined
        }
      />
    );
  }
  if (t === 'tool_call') {
    return (
      <Row
        time={time}
        icon="◐"
        tone="warn"
        label={`tool: ${String(ev.name)}`}
        detail={JSON.stringify(ev.input ?? {}).slice(0, 200)}
      />
    );
  }
  if (t === 'tool_result') {
    return (
      <Row
        time={time}
        icon={ev.error ? '✗' : '✓'}
        tone={ev.error ? 'error' : 'good'}
        label={`result: ${String(ev.name)}`}
        detail={
          ev.error ? String(ev.error) : JSON.stringify(ev.result ?? {}).slice(0, 200)
        }
      />
    );
  }
  if (t === 'plan') {
    const plan = ev.plan as Record<string, unknown> | null;
    return (
      <Row
        time={time}
        icon="✦"
        tone="accent"
        label="plan ready"
        detail={(plan?.summary as string) ?? '(plan synthesized)'}
      />
    );
  }
  if (t === 'done') {
    return <Row time={time} icon="●" tone="muted" label="done" detail={`${String(ev.steps)} steps`} />;
  }
  if (t === 'error') {
    return <Row time={time} icon="✗" tone="error" label="error" detail={String(ev.message)} />;
  }
  return <Row time={time} icon="·" tone="muted" label={t} detail={JSON.stringify(ev).slice(0, 200)} />;
}

function Row({
  time,
  icon,
  tone,
  label,
  detail,
  sub,
}: {
  time: string;
  icon: string;
  tone: 'accent' | 'good' | 'warn' | 'error' | 'muted';
  label: string;
  detail: string;
  sub?: string;
}) {
  const colorByTone = {
    accent: 'text-accent-400',
    good: 'text-emerald-400',
    warn: 'text-yellow-400',
    error: 'text-red-400',
    muted: 'text-ink-100/50',
  } as const;
  return (
    <div className="panel py-2 px-3 flex gap-3 items-start text-sm">
      <span className={`mt-0.5 font-mono ${colorByTone[tone]}`}>{icon}</span>
      <span className="text-xs text-ink-100/40 font-mono w-20">{time}</span>
      <div className="flex-1 min-w-0">
        <div className={`font-mono ${colorByTone[tone]}`}>{label}</div>
        <div className="text-ink-100/80 text-xs font-mono break-words mt-0.5">{detail}</div>
        {sub && <div className="text-[10px] text-ink-100/40 font-mono mt-0.5">{sub}</div>}
      </div>
    </div>
  );
}

function PlanCard({ events }: { events: AgentEvent[] }) {
  const planEv = [...events].reverse().find((e) => e.type === 'plan');
  if (!planEv) return null;
  const plan = planEv.plan as Record<string, unknown> | null;
  if (!plan) return null;
  return (
    <div className="panel border-accent-500/40 mt-4">
      <div className="stat-label mb-2">final plan</div>
      <div className="text-sm font-mono text-ink-50 mb-3">{String(plan.summary ?? '')}</div>
      {Array.isArray(plan.actions) && plan.actions.length > 0 && (
        <div className="space-y-1">
          <div className="stat-label">actions</div>
          {(plan.actions as Array<Record<string, unknown>>).map((a, i) => (
            <div
              key={i}
              className="text-xs font-mono bg-ink-950 border border-ink-800 rounded px-2 py-1"
            >
              {JSON.stringify(a)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
