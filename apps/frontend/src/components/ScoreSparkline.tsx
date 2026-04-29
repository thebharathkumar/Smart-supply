import { LineChart, Line, ResponsiveContainer, YAxis, Tooltip } from 'recharts';
import type { ScorePoint } from '../lib/api';

export function ScoreSparkline({ points }: { points: ScorePoint[] }) {
  if (!points || points.length === 0) {
    return <div className="text-xs text-ink-100/40 py-8 text-center">no data</div>;
  }
  const data = points.map((p) => ({ t: new Date(p.time).getTime(), score: p.score }));
  return (
    <div style={{ height: 120 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <YAxis hide domain={[0, 100]} />
          <Tooltip
            contentStyle={{ background: '#0f1521', border: '1px solid #1a2331', fontSize: 12 }}
            labelFormatter={(t) => new Date(t as number).toLocaleString()}
          />
          <Line type="monotone" dataKey="score" stroke="#43d9b5" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
