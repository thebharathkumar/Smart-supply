import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip, Area, AreaChart } from 'recharts';
import { api } from '../lib/api';

interface ForecastPoint {
  date: string;
  predicted: number;
  ciLower: number;
  ciUpper: number;
}

interface ForecastResp {
  supplierId: string;
  model: string;
  generatedAt: string;
  horizonDays: number;
  points: ForecastPoint[];
  metrics: { mape: number | null; samples: number };
}

export function ForecastView() {
  const { data: suppliers } = useQuery({
    queryKey: ['suppliers'],
    queryFn: () => api.suppliers({ active: true }),
  });
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [horizon, setHorizon] = useState(30);

  const forecast = useMutation({
    mutationFn: async () => {
      if (!supplierId) throw new Error('no supplier');
      return (await api.forecast(supplierId, horizon)) as ForecastResp;
    },
  });

  return (
    <div className="p-6 grid grid-cols-[320px_1fr] gap-6 h-full overflow-hidden">
      <aside className="panel overflow-y-auto">
        <div className="stat-label mb-3">supplier</div>
        <input
          placeholder="filter..."
          className="w-full mb-3 bg-ink-950 border border-ink-800 rounded-md px-2 py-1 text-sm"
          onChange={(e) => {
            // simple client-side filter: scroll to first match
            const v = e.target.value.toLowerCase();
            const item = document.querySelector<HTMLElement>(`[data-name*="${v}"]`);
            item?.scrollIntoView({ block: 'center' });
          }}
        />
        <div className="space-y-1">
          {suppliers?.map((s) => (
            <button
              key={s.id}
              data-name={s.name.toLowerCase()}
              onClick={() => setSupplierId(s.id)}
              className={`w-full text-left px-2 py-1.5 rounded-md text-sm transition ${
                supplierId === s.id
                  ? 'bg-ink-800 text-accent-400'
                  : 'hover:bg-ink-800/50 text-ink-50'
              }`}
            >
              <div className="font-mono">{s.name}</div>
              <div className="text-xs text-ink-100/50">
                {s.country} · factor {s.epa_baseline_factor.toFixed(3)}
              </div>
            </button>
          ))}
        </div>
      </aside>

      <section className="space-y-4 overflow-y-auto">
        <div className="flex items-center gap-3">
          <label className="text-sm text-ink-100/70">horizon (days)</label>
          <input
            type="number"
            min={7}
            max={180}
            value={horizon}
            onChange={(e) => setHorizon(Number(e.target.value))}
            className="bg-ink-950 border border-ink-800 rounded-md px-2 py-1 text-sm w-20"
          />
          <button
            disabled={!supplierId || forecast.isPending}
            onClick={() => forecast.mutate()}
            className="btn disabled:opacity-50"
          >
            {forecast.isPending ? 'forecasting…' : 'run forecast'}
          </button>
          {forecast.data && (
            <span className="text-xs font-mono text-ink-100/60 ml-auto">
              model: {forecast.data.model} · MAPE:{' '}
              {forecast.data.metrics.mape?.toFixed(2) ?? '—'}%
            </span>
          )}
        </div>

        <div className="panel" style={{ height: 360 }}>
          {forecast.data ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={forecast.data.points}>
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#94a3b8' }} />
                <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} />
                <Tooltip
                  contentStyle={{ background: '#0f1521', border: '1px solid #1a2331' }}
                />
                <Area dataKey="ciUpper" stroke="none" fill="#43d9b5" fillOpacity={0.1} />
                <Area dataKey="ciLower" stroke="none" fill="#0f1521" fillOpacity={1} />
                <Line dataKey="predicted" stroke="#43d9b5" strokeWidth={2} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-full flex items-center justify-center text-ink-100/40 text-sm">
              {supplierId ? 'click "run forecast" to generate' : 'select a supplier'}
            </div>
          )}
        </div>

        {forecast.error && (
          <div className="panel border-red-900 text-red-400 text-sm">
            forecast failed: {(forecast.error as Error).message}
          </div>
        )}
      </section>
    </div>
  );
}
