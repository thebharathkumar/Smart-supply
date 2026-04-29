/**
 * Force-directed view of the supply network.
 *
 * Nodes: hubs (sized by traffic, colored by aggregate score)
 * Edges: routes (colored by live score from WS, dashed for air mode)
 * Click a hub -> highlight its routes + show optimization controls.
 * Run optimize between two hubs -> Pareto solutions overlay as
 * highlighted alternative paths.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type ForceLink,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import { select } from 'd3-selection';
import { zoom, type ZoomTransform, zoomIdentity } from 'd3-zoom';
import { useQuery } from '@tanstack/react-query';
import { api, type RouteRow, type Hub } from '../lib/api';
import { useWsStore } from '../lib/ws';
import { env } from '../lib/env';

interface GraphNode extends SimulationNodeDatum {
  id: string;
  name: string;
  country: string;
  type: string;
  degree: number;
}

interface GraphLink extends SimulationLinkDatum<GraphNode> {
  routeId: string;
  source: string | GraphNode;
  target: string | GraphNode;
  transportMode: string;
  distanceKm: number;
}

function colorForScore(score: number | undefined): string {
  if (score === undefined) return '#475569';
  if (score > 70) return '#43d9b5';
  if (score > 50) return '#fbbf24';
  if (score > 30) return '#f97316';
  return '#ef4444';
}

export function NetworkGraph() {
  const { data: hubs } = useQuery({ queryKey: ['hubs'], queryFn: () => api.hubs() });
  const { data: routes } = useQuery({ queryKey: ['routes'], queryFn: () => api.routes() });
  const scores = useWsStore((s) => s.scores);
  const [selectedHub, setSelectedHub] = useState<string | null>(null);
  const [destHub, setDestHub] = useState<string | null>(null);
  const [highlightRouteIds, setHighlightRouteIds] = useState<Set<string>>(new Set());
  const [optimizing, setOptimizing] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [transform, setTransform] = useState<ZoomTransform>(zoomIdentity);

  const { nodes, links } = useGraphData(hubs, routes);

  useGraphLayout(svgRef.current, nodes, links);

  useEffect(() => {
    if (!svgRef.current) return;
    const svg = select(svgRef.current);
    const z = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.3, 4])
      .on('zoom', (ev) => setTransform(ev.transform));
    svg.call(z);
    return () => {
      svg.on('.zoom', null);
    };
  }, []);

  return (
    <div className="h-full grid grid-cols-[1fr_360px]">
      <div className="relative bg-ink-950">
        <svg ref={svgRef} className="w-full h-full">
          <g transform={transform.toString()}>
            {links.map((l) => {
              const s = (l.source as GraphNode) ?? null;
              const t = (l.target as GraphNode) ?? null;
              if (!s || !t || s.x == null || t.x == null) return null;
              const isHi = highlightRouteIds.has(l.routeId);
              const liveScore = scores[l.routeId]?.score;
              return (
                <line
                  key={l.routeId}
                  x1={s.x}
                  y1={s.y}
                  x2={t.x}
                  y2={t.y}
                  stroke={isHi ? '#43d9b5' : colorForScore(liveScore)}
                  strokeWidth={isHi ? 3 : 1}
                  strokeOpacity={isHi ? 1 : 0.5}
                  strokeDasharray={l.transportMode === 'air' ? '4 4' : undefined}
                />
              );
            })}
            {nodes.map((n) => {
              if (n.x == null || n.y == null) return null;
              const sel = n.id === selectedHub || n.id === destHub;
              return (
                <g
                  key={n.id}
                  transform={`translate(${n.x},${n.y})`}
                  className="cursor-pointer"
                  onClick={(ev) => {
                    if (ev.shiftKey) setDestHub(n.id);
                    else setSelectedHub(n.id);
                  }}
                >
                  <circle
                    r={Math.max(4, Math.min(14, 4 + n.degree))}
                    fill={sel ? '#43d9b5' : '#1cc8a3'}
                    fillOpacity={sel ? 0.95 : 0.55}
                    stroke="#0f1521"
                    strokeWidth={1.5}
                  />
                  {sel && (
                    <text
                      y={-12}
                      textAnchor="middle"
                      className="font-mono text-[10px] fill-accent-400"
                      style={{ pointerEvents: 'none' }}
                    >
                      {n.name}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
        <div className="absolute top-3 left-3 panel py-2 px-3 text-xs">
          <div className="font-mono uppercase tracking-wider mb-1">network</div>
          <div className="text-ink-100/60">
            click hub · shift+click for destination · scroll to zoom
          </div>
        </div>
      </div>
      <NetworkSidePanel
        hubs={hubs ?? []}
        routes={routes ?? []}
        selected={selectedHub}
        destination={destHub}
        optimizing={optimizing}
        onOptimize={async () => {
          if (!selectedHub || !destHub) return;
          setOptimizing(true);
          setHighlightRouteIds(new Set());
          try {
            const r = await fetch(`${env.apiUrl}/api/optimize/route`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                originHubId: selectedHub,
                destinationHubId: destHub,
                weightCo2: 0.5,
                weightCost: 0.3,
                weightTime: 0.2,
                topK: 3,
              }),
            });
            if (!r.ok) throw new Error(`${r.status}`);
            const json = (await r.json()) as { solutions: Array<{ routeIds: string[] }> };
            const ids = new Set(json.solutions.flatMap((s) => s.routeIds));
            setHighlightRouteIds(ids);
          } finally {
            setOptimizing(false);
          }
        }}
        onClear={() => {
          setSelectedHub(null);
          setDestHub(null);
          setHighlightRouteIds(new Set());
        }}
      />
    </div>
  );
}

function useGraphData(hubs: Hub[] | undefined, routes: RouteRow[] | undefined) {
  return useMemo(() => {
    if (!hubs || !routes) return { nodes: [] as GraphNode[], links: [] as GraphLink[] };
    const degree = new Map<string, number>();
    for (const r of routes) {
      degree.set(r.origin_hub_id, (degree.get(r.origin_hub_id) ?? 0) + 1);
      degree.set(r.destination_hub_id, (degree.get(r.destination_hub_id) ?? 0) + 1);
    }
    const nodes: GraphNode[] = hubs.map((h) => ({
      id: h.id,
      name: h.name,
      country: h.country,
      type: h.type,
      degree: degree.get(h.id) ?? 0,
    }));
    const links: GraphLink[] = routes.map((r) => ({
      routeId: r.id,
      source: r.origin_hub_id,
      target: r.destination_hub_id,
      transportMode: r.transport_mode,
      distanceKm: r.distance_km,
    }));
    return { nodes, links };
  }, [hubs, routes]);
}

function useGraphLayout(svg: SVGSVGElement | null, nodes: GraphNode[], links: GraphLink[]) {
  const simRef = useRef<Simulation<GraphNode, GraphLink> | null>(null);

  useEffect(() => {
    if (!svg || nodes.length === 0) return;
    const { width, height } = svg.getBoundingClientRect();
    simRef.current?.stop();
    const sim = forceSimulation<GraphNode>(nodes)
      .force(
        'link',
        forceLink<GraphNode, GraphLink>(links)
          .id((d) => d.id)
          .distance(80)
          .strength(0.3),
      )
      .force('charge', forceManyBody().strength(-160))
      .force('center', forceCenter(width / 2, height / 2))
      .force('collide', forceCollide<GraphNode>().radius((d) => 6 + d.degree));
    sim.alpha(0.9).restart();
    simRef.current = sim;
    return () => {
      sim.stop();
    };
  }, [svg, nodes, links]);
}

function NetworkSidePanel({
  hubs,
  routes,
  selected,
  destination,
  optimizing,
  onOptimize,
  onClear,
}: {
  hubs: Hub[];
  routes: RouteRow[];
  selected: string | null;
  destination: string | null;
  optimizing: boolean;
  onOptimize: () => void;
  onClear: () => void;
}) {
  const sel = hubs.find((h) => h.id === selected);
  const dest = hubs.find((h) => h.id === destination);
  const selRoutes = routes.filter(
    (r) => r.origin_hub_id === selected || r.destination_hub_id === selected,
  );

  return (
    <aside className="border-l border-ink-800 bg-ink-900 p-6 overflow-y-auto">
      <div className="stat-label mb-2">selection</div>
      {!sel && <div className="text-sm text-ink-100/40 font-mono">no hub selected</div>}
      {sel && (
        <div className="space-y-1 mb-4">
          <div className="font-mono text-base">{sel.name}</div>
          <div className="text-xs text-ink-100/60">
            {sel.country} · {sel.type}
          </div>
          <div className="text-xs text-ink-100/40">{selRoutes.length} routes</div>
        </div>
      )}

      {dest && (
        <div className="panel mb-3">
          <div className="stat-label">destination</div>
          <div className="font-mono text-sm">{dest.name}</div>
        </div>
      )}

      <div className="flex gap-2 mb-4">
        <button
          disabled={!selected || !destination || optimizing}
          onClick={onOptimize}
          className="btn disabled:opacity-50 flex-1"
        >
          {optimizing ? 'optimizing…' : 'find Pareto routes'}
        </button>
        <button onClick={onClear} className="btn-ghost">
          clear
        </button>
      </div>

      {sel && (
        <div className="panel">
          <div className="stat-label mb-2">routes through this hub</div>
          <div className="space-y-1 max-h-96 overflow-y-auto">
            {selRoutes.slice(0, 30).map((r) => (
              <div
                key={r.id}
                className="text-xs font-mono bg-ink-950 border border-ink-800 rounded px-2 py-1"
              >
                <div>{r.supplier_name}</div>
                <div className="text-ink-100/50">
                  {r.transport_mode} · {r.distance_km.toFixed(0)} km
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}
