import { useMemo, useState } from 'react';
import { MapContainer, TileLayer, Marker, Polyline, Popup, CircleMarker } from 'react-leaflet';
import L from 'leaflet';
import { useQuery } from '@tanstack/react-query';
import { api, type RouteRow } from '../lib/api';
import { useWsStore } from '../lib/ws';
import { ScoreSparkline } from '../components/ScoreSparkline';

// Fix default marker icon for bundled environments
delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl:
    'data:image/svg+xml;base64,' +
    btoa(
      `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="36" viewBox="0 0 24 36"><path fill="#43d9b5" stroke="#0f1521" stroke-width="2" d="M12 1c-6 0-11 5-11 11 0 7.5 11 23 11 23s11-15.5 11-23c0-6-5-11-11-11z"/><circle fill="#0f1521" cx="12" cy="12" r="4"/></svg>`,
    ),
  iconSize: [24, 36],
  iconAnchor: [12, 36],
  shadowUrl: '',
});

function colorForScore(score: number | undefined): string {
  if (score === undefined) return '#64748b';
  if (score > 70) return '#43d9b5';
  if (score > 50) return '#fbbf24';
  if (score > 30) return '#f97316';
  return '#ef4444';
}

export function OperationsMap() {
  const { data: routes } = useQuery({ queryKey: ['routes'], queryFn: () => api.routes() });
  const { data: hubs } = useQuery({ queryKey: ['hubs'], queryFn: () => api.hubs() });
  const scores = useWsStore((s) => s.scores);
  const [selected, setSelected] = useState<RouteRow | null>(null);

  const bounds = useMemo(() => {
    if (!hubs || hubs.length === 0) return undefined;
    const lats = hubs.map((h) => h.lat);
    const lngs = hubs.map((h) => h.lng);
    return [
      [Math.min(...lats), Math.min(...lngs)],
      [Math.max(...lats), Math.max(...lngs)],
    ] as L.LatLngBoundsLiteral;
  }, [hubs]);

  return (
    <div className="h-full grid grid-cols-[1fr_360px] gap-0">
      <div className="relative">
        <MapContainer
          bounds={bounds}
          style={{ height: '100%', width: '100%' }}
          center={[20, 0]}
          zoom={2}
          scrollWheelZoom
          worldCopyJump
        >
          <TileLayer
            attribution="&copy; OpenStreetMap"
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {hubs?.map((h) => (
            <CircleMarker
              key={h.id}
              center={[h.lat, h.lng]}
              radius={4}
              pathOptions={{ color: '#43d9b5', fillColor: '#43d9b5', fillOpacity: 0.6 }}
            >
              <Popup>
                <div className="font-mono text-xs">
                  <div className="font-bold">{h.name}</div>
                  <div className="text-slate-500">
                    {h.country} · {h.type}
                  </div>
                </div>
              </Popup>
            </CircleMarker>
          ))}
          {routes?.map((r) => {
            const score = scores[r.id]?.score;
            return (
              <Polyline
                key={r.id}
                positions={[
                  [r.origin_lat, r.origin_lng],
                  [r.destination_lat, r.destination_lng],
                ]}
                pathOptions={{
                  color: colorForScore(score),
                  weight: 2,
                  opacity: 0.8,
                  dashArray: r.transport_mode === 'air' ? '4 6' : undefined,
                }}
                eventHandlers={{ click: () => setSelected(r) }}
              />
            );
          })}
        </MapContainer>
        <div className="absolute top-3 left-3 panel py-2 px-3 text-xs space-y-1">
          <div className="font-mono uppercase tracking-wider">live</div>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-accent-400" /> excellent (&gt;70)
          </div>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-yellow-400" /> moderate (50-70)
          </div>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-orange-500" /> poor (30-50)
          </div>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-red-500" /> critical (&lt;30)
          </div>
        </div>
      </div>
      <RoutePanel route={selected} />
    </div>
  );
}

function RoutePanel({ route }: { route: RouteRow | null }) {
  const score = useWsStore((s) => (route ? s.scores[route.id] : undefined));
  const { data: history } = useQuery({
    queryKey: ['scores', route?.id],
    queryFn: () => api.routeScores(route!.id, 12),
    enabled: !!route,
  });

  if (!route) {
    return (
      <aside className="border-l border-ink-800 bg-ink-900 p-6 text-sm text-ink-100/60">
        <div className="stat-label mb-2">selection</div>
        <div className="font-mono text-base">click a route on the map</div>
      </aside>
    );
  }

  return (
    <aside className="border-l border-ink-800 bg-ink-900 p-6 overflow-y-auto">
      <div className="space-y-1 mb-6">
        <div className="stat-label">route</div>
        <div className="font-mono text-lg">{route.supplier_name}</div>
        <div className="text-sm text-ink-100/60">
          {route.origin_name} → {route.destination_name}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-6">
        <div className="panel">
          <div className="stat-label">live score</div>
          <div className="stat-value">{score?.score?.toFixed(1) ?? '—'}</div>
        </div>
        <div className="panel">
          <div className="stat-label">distance</div>
          <div className="stat-value">{route.distance_km.toFixed(0)} km</div>
        </div>
        <div className="panel">
          <div className="stat-label">mode</div>
          <div className="stat-value text-base uppercase">{route.transport_mode}</div>
        </div>
        <div className="panel">
          <div className="stat-label">last update</div>
          <div className="stat-value text-base">
            {score?.ts ? new Date(score.ts).toLocaleTimeString() : '—'}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="stat-label mb-2">12h score history</div>
        <ScoreSparkline points={history ?? []} />
      </div>
    </aside>
  );
}
